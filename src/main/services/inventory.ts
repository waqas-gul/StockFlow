import { formatDisplayDate } from '@shared/dates'
import { DomainError, createUnitSet, formatQuantity, type StockPosition } from '@shared/domain'
import { formatDocumentNumber } from '@shared/stock'
import type { Db } from '../db/adapter'
import { AppFailure } from '../errors'
import { takeSequenceValue } from './sequences'

/*
 * The inventory rules every stock-changing transaction shares (plan §8, §11.5). Receipts and adjustments use them now;
 * invoices and their voids will use the same functions:
 *
 * - stock is never stored: Q = Σ stock_movements.qty_base and V = Σ stock_movements.value_minor per product;
 * - assertStockInvariants(Q ≥ 0, V ≥ 0, Q = 0 ⇒ V = 0) runs at the end of the transaction, so a violation rolls
 *   everything back;
 * - posting dates: never after today, and never before the latest movement of an affected product (activity on other
 *   products never blocks a document);
 * - document numbers come from `sequences`, inside the document's transaction, so a rollback returns the number.
 */

interface ProductLabelRow {
  id: number
  code: string
  name: string
}

/** Q and V of each product (0 and 0 for a product without movements). */
export function stockPositions(db: Db, productIds: readonly number[]): Map<number, StockPosition> {
  const ids = unique(productIds)
  const positions = new Map<number, StockPosition>(
    ids.map((id) => [id, { qtyBase: 0, valueMinor: 0 }])
  )
  if (ids.length === 0) return positions
  const rows = db.all<{ product_id: number; qty_base: number; value_minor: number }>(
    `SELECT product_id, sum(qty_base) AS qty_base, sum(value_minor) AS value_minor
     FROM stock_movements WHERE product_id IN (${placeholders(ids)})
     GROUP BY product_id`,
    ids
  )
  for (const row of rows) {
    positions.set(row.product_id, { qtyBase: row.qty_base, valueMinor: row.value_minor })
  }
  return positions
}

export function stockPosition(db: Db, productId: number): StockPosition {
  return stockPositions(db, [productId]).get(productId)!
}

/**
 * The inventory invariants (plan §8.1) for the given products: Q ≥ 0, V ≥ 0, and no value without stock. Call it last
 * in every transaction that writes stock movements; the thrown failure rolls the transaction back.
 */
export function assertStockInvariants(db: Db, productIds: readonly number[]): void {
  const positions = stockPositions(db, productIds)
  for (const [productId, { qtyBase, valueMinor }] of positions) {
    const safe = Number.isSafeInteger(qtyBase) && Number.isSafeInteger(valueMinor)
    if (safe && qtyBase < 0) {
      throw new AppFailure({
        code: 'INSUFFICIENT_STOCK',
        message: `Not enough stock of ${productLabel(db, productId)}, so nothing was saved.`,
        details: { productId, availableQtyBase: qtyBase }
      })
    }
    if (!safe || valueMinor < 0 || (qtyBase === 0 && valueMinor !== 0)) {
      throw new AppFailure({
        code: 'FORBIDDEN_STATE',
        message: `This change would leave the stock value of ${productLabel(db, productId)} inconsistent, so nothing was saved.`,
        details: { productId }
      })
    }
  }
}

/** The latest movement date among the products, and the product it belongs to; null when none has a movement. */
export function latestMovement(
  db: Db,
  productIds: readonly number[]
): { productId: number; date: string } | null {
  const ids = unique(productIds)
  if (ids.length === 0) return null
  const row = db.get<{ product_id: number; latest: string }>(
    `SELECT product_id, max(movement_date) AS latest FROM stock_movements
     WHERE product_id IN (${placeholders(ids)})
     GROUP BY product_id ORDER BY latest DESC, product_id LIMIT 1`,
    ids
  )
  return row === undefined ? null : { productId: row.product_id, date: row.latest }
}

export interface PostingDateCheck {
  readonly date: string
  /** The main process's calendar day. */
  readonly today: string
  readonly productIds: readonly number[]
  /** The form field the date was entered in, for the field error. */
  readonly field?: string
}

/**
 * A stock document's date must not be later than today, nor earlier than the latest movement of any product it
 * affects (the per-product posting floor, plan §11.5). Otherwise DATE_NOT_ALLOWED names the blocking product and date.
 */
export function assertPostingDate(db: Db, check: PostingDateCheck): void {
  const { date, today, field } = check
  if (date > today) {
    throw dateFailure(`The date cannot be later than today (${formatDisplayDate(today)}).`, field, {
      latestDate: today
    })
  }
  const floor = latestMovement(db, check.productIds)
  if (floor !== null && date < floor.date) {
    throw dateFailure(
      `${productLabel(db, floor.productId)} has stock activity on ${formatDisplayDate(floor.date)}. Use that date or later.`,
      field,
      { earliestDate: floor.date, productId: floor.productId }
    )
  }
}

/**
 * The next number of a document sequence ('receipt' → GRN-000001), taken inside the caller's transaction: if the
 * document is not saved, the number is not used either.
 */
export function allocateDocumentNumber(
  db: Db,
  sequence: 'receipt' | 'adjustment',
  prefix: string
): string {
  return formatDocumentNumber(prefix, takeSequenceValue(db, sequence))
}

/** 'P-001 Tea 950g'. */
export function productLabel(db: Db, productId: number): string {
  const row = db.get<ProductLabelRow>('SELECT id, code, name FROM products WHERE id = ?', [
    productId
  ])
  return row === undefined ? `Product ${productId}` : `${row.code} ${row.name}`
}

/** A base quantity in the product's units ("1 Box + 5 Piece"); the plain number when the units cannot be read. */
export function quantityText(db: Db, productId: number, qtyBase: number): string {
  const units = db.all<{ id: number; name: string; base_qty: number; is_base: number }>(
    'SELECT id, name, base_qty, is_base FROM product_units WHERE product_id = ?',
    [productId]
  )
  const unitSet = createUnitSet(
    units.map((unit) => ({
      id: unit.id,
      name: unit.name,
      baseQty: unit.base_qty,
      isBase: unit.is_base === 1
    }))
  )
  if (!unitSet.ok || qtyBase < 0) return qtyBase.toLocaleString('en-US')
  return formatQuantity(qtyBase, unitSet.unitSet)
}

/**
 * Runs `fn` in one transaction. A calculation that overflows (DomainError OUT_OF_RANGE) becomes a VALIDATION failure
 * the user can act on; nothing is saved either way.
 */
export function inventoryTransaction<T>(db: Db, fn: () => T): T {
  try {
    return db.transaction(fn)
  } catch (error) {
    if (error instanceof DomainError && error.code === 'OUT_OF_RANGE') {
      throw new AppFailure({
        code: 'VALIDATION',
        message: 'The quantities or amounts are too large to save.'
      })
    }
    throw error
  }
}

export function unique(values: readonly number[]): number[] {
  return [...new Set(values)]
}

export function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

function dateFailure(message: string, field: string | undefined, details: unknown): AppFailure {
  return new AppFailure({
    code: 'DATE_NOT_ALLOWED',
    message,
    ...(field === undefined ? {} : { fieldErrors: { [field]: [message] } }),
    details
  })
}
