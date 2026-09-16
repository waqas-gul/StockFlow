import { localDateString } from '@shared/dates'
import {
  addMinor,
  multiplyMinor,
  mulDivRoundHalfUp,
  sumMinor,
  toBaseQuantity,
  weightedAverageOutflowValue,
  type StockPosition
} from '@shared/domain'
import {
  ADJUSTMENT_NUMBER_PREFIX,
  AdjustmentListInputSchema,
  LATE_COST_CORRECTION_WARNING,
  PostingFloorInputSchema,
  RECEIPT_LOCKED_MESSAGE,
  RECEIPT_NUMBER_PREFIX,
  ReceiptListInputSchema,
  ReceiptVoidInputSchema,
  StockAdjustmentInputSchema,
  StockCardInputSchema,
  StockIdSchema,
  StockReceiptInputSchema,
  adjustmentDirection,
  type AdjustmentDirection,
  type AdjustmentReason,
  type DocumentStatus,
  type PostingFloor,
  type StockAdjustmentInput,
  type StockAdjustmentResult,
  type StockAdjustmentSummary,
  type StockCard,
  type StockCardRow,
  type StockMovementType,
  type StockPage,
  type StockReceiptDetail,
  type StockReceiptInput,
  type StockReceiptLine,
  type StockReceiptSummary,
  type StockSummary
} from '@shared/stock'
import type { Db, SqlValue } from '../db/adapter'
import { AppFailure, parseInput } from '../errors'
import {
  allocateDocumentNumber,
  assertPostingDate,
  assertStockInvariants,
  inventoryTransaction,
  latestMovement,
  placeholders,
  quantityText,
  stockPosition,
  unique
} from './inventory'
import { getProduct } from './products.service'
import { assertCurrencyDigits } from './settings.service'

/*
 * Stock In receipts, receipt voids, stock adjustments and the stock card (plan §8).
 *
 * Every write is one transaction: request id (a retry returns the saved document) → currency and date checks → master
 * data → valuation → document number → rows → movements → assertStockInvariants. Nothing is saved when any step fails.
 *
 * Valuation is the moving weighted average of the Phase 2 helpers: stock leaves at round_half_up(V × n / Q), and the
 * last unit takes exactly what is left. Receipts add their exact line cost; zero-cost stock is valid.
 *
 * A receipt can be voided only while no other document has moved any of its products since its first movement (its own
 * lines never lock it). The void reverses each line's exact quantity and value. A locked receipt is corrected with
 * receipt correction adjustments, which name the exact receipt line (migration 0002).
 */

interface ReceiptRow {
  id: number
  receipt_no: string
  receipt_date: string
  supplier_name: string | null
  reference: string | null
  note: string | null
  total_cost_minor: number
  status: DocumentStatus
  void_reason: string | null
  void_date: string | null
  created_at: string
  line_count: number
}

interface ReceiptItemRow {
  id: number
  receipt_id: number
  line_no: number
  product_id: number
  product_code: string
  product_name: string
  unit_id: number
  unit_name: string
  unit_base_qty: number
  quantity: number
  qty_base: number
  unit_cost_minor: number
  line_cost_minor: number
}

interface CorrectedLine extends ReceiptItemRow {
  receipt_no: string
  receipt_status: DocumentStatus
}

interface UnitRow {
  id: number
  product_id: number
  name: string
  base_qty: number
  can_purchase: number
  is_active: number
}

interface ProductRow {
  id: number
  code: string
  name: string
  is_active: number
}

interface AdjustmentRow {
  id: number
  adjustment_no: string
  adjustment_date: string
  product_id: number
  product_code: string
  product_name: string
  reason_code: AdjustmentReason
  direction: AdjustmentDirection
  unit_name: string | null
  quantity: number | null
  qty_base: number
  value_minor: number
  movement_value: number | null
  receipt_id: number | null
  receipt_no: string | null
  receipt_item_id: number | null
  receipt_line_no: number | null
  reason_note: string
  created_at: string
}

const SELECT_RECEIPTS = `
  SELECT r.id, r.receipt_no, r.receipt_date, r.supplier_name, r.reference, r.note, r.total_cost_minor, r.status,
         r.void_reason, r.void_date, r.created_at,
         (SELECT count(*) FROM stock_receipt_items WHERE receipt_id = r.id) AS line_count
  FROM stock_receipts AS r`

const SELECT_ADJUSTMENTS = `
  SELECT a.id, a.adjustment_no, a.adjustment_date, a.product_id, p.code AS product_code, p.name AS product_name,
         a.reason_code, a.direction, a.unit_name, a.quantity, a.qty_base, a.value_minor, m.value_minor AS movement_value,
         a.receipt_id, r.receipt_no, a.receipt_item_id, ri.line_no AS receipt_line_no, a.reason_note, a.created_at
  FROM stock_adjustments AS a
  JOIN products AS p ON p.id = a.product_id
  LEFT JOIN stock_movements AS m ON m.adjustment_id = a.id
  LEFT JOIN stock_receipts AS r ON r.id = a.receipt_id
  LEFT JOIN stock_receipt_items AS ri ON ri.id = a.receipt_item_id`

// --- Stock In ------------------------------------------------------------------------------------------------------

/** Posts a Stock In receipt: one STOCK_IN movement per line, at the line's exact cost. */
export function receiveStock(db: Db, input: unknown, now: Date): StockReceiptDetail {
  const receipt = parseInput(StockReceiptInputSchema, input)
  return inventoryTransaction(db, () => {
    const saved = db.get<{ id: number }>('SELECT id FROM stock_receipts WHERE request_id = ?', [
      receipt.requestId
    ])
    if (saved !== undefined) return readReceipt(db, saved.id)

    assertCurrencyDigits(db, receipt.currencyMinorDigits)
    const productIds = unique(receipt.lines.map((line) => line.productId))
    assertPostingDate(db, {
      date: receipt.receiptDate,
      today: localDateString(now),
      productIds,
      field: 'receiptDate'
    })
    const units = purchasableUnits(db, receipt)
    const lines = receipt.lines.map((line, index) => ({
      ...line,
      unit: units[index],
      qtyBase: toBaseQuantity(line.quantity, units[index].base_qty),
      lineCostMinor: multiplyMinor(line.unitCostMinor, line.quantity)
    }))
    const totalCostMinor = sumMinor(lines.map((line) => line.lineCostMinor))

    const receiptNo = allocateDocumentNumber(db, 'receipt', RECEIPT_NUMBER_PREFIX)
    const id = Number(
      db.run(
        `INSERT INTO stock_receipts (receipt_no, request_id, receipt_date, supplier_name, reference, note, total_cost_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          receiptNo,
          receipt.requestId,
          receipt.receiptDate,
          receipt.supplierName,
          receipt.reference,
          receipt.note,
          totalCostMinor
        ]
      ).lastInsertRowid
    )
    lines.forEach((line, index) => {
      const itemId = Number(
        db.run(
          `INSERT INTO stock_receipt_items (receipt_id, line_no, product_id, unit_id, unit_name, unit_base_qty, quantity,
             qty_base, unit_cost_minor, line_cost_minor)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            index + 1,
            line.productId,
            line.unit.id,
            line.unit.name,
            line.unit.base_qty,
            line.quantity,
            line.qtyBase,
            line.unitCostMinor,
            line.lineCostMinor
          ]
        ).lastInsertRowid
      )
      insertMovement(db, {
        productId: line.productId,
        date: receipt.receiptDate,
        type: 'STOCK_IN',
        qtyBase: line.qtyBase,
        valueMinor: line.lineCostMinor,
        source: ['receipt_item_id', itemId]
      })
    })
    assertStockInvariants(db, productIds)
    return readReceipt(db, id)
  })
}

/** Receipts, newest first; `search` matches the receipt number, supplier or reference. */
export function listReceipts(db: Db, input: unknown): StockPage<StockReceiptSummary> {
  const { page, pageSize, search } = parseInput(ReceiptListInputSchema, input)
  const clauses: string[] = []
  const params: SqlValue[] = []
  for (const word of searchWords(search)) {
    clauses.push(
      `(r.receipt_no LIKE ? ESCAPE '\\' OR r.supplier_name LIKE ? ESCAPE '\\' OR r.reference LIKE ? ESCAPE '\\')`
    )
    params.push(word, word, word)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const total = db.get<{ n: number }>(
    `SELECT count(*) AS n FROM stock_receipts AS r ${where}`,
    params
  )!.n
  const rows = db.all<ReceiptRow>(
    `${SELECT_RECEIPTS} ${where} ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  )
  return { items: rows.map((row) => receiptSummary(db, row)), total, page, pageSize }
}

/** One receipt as saved, with its lines, whether it can still be voided, and the adjustments that correct it. */
export function getReceipt(db: Db, id: unknown): StockReceiptDetail {
  return readReceipt(db, parseInput(StockIdSchema, id))
}

/**
 * Voids a receipt that no other stock activity has touched: one STOCK_IN_VOID per line reverses its exact quantity and
 * value, dated today, so each product returns exactly to its position before the receipt.
 */
export function voidReceipt(db: Db, input: unknown, now: Date): StockReceiptDetail {
  const { id, reason } = parseInput(ReceiptVoidInputSchema, input)
  return inventoryTransaction(db, () => {
    const receipt = receiptRow(db, id)
    if (receipt.status === 'VOID') {
      throw new AppFailure({
        code: 'FORBIDDEN_STATE',
        message: `Receipt ${receipt.receipt_no} is already void.`
      })
    }
    const today = localDateString(now)
    const items = db.all<{ id: number; product_id: number }>(
      'SELECT id, product_id FROM stock_receipt_items WHERE receipt_id = ? ORDER BY line_no',
      [id]
    )
    const productIds = unique(items.map((item) => item.product_id))
    assertPostingDate(db, { date: today, today, productIds })
    const locked = laterActivityProducts(db, id)
    if (locked.size > 0) {
      throw new AppFailure({
        code: 'FORBIDDEN_STATE',
        message: RECEIPT_LOCKED_MESSAGE,
        details: { productIds: [...locked] }
      })
    }
    for (const item of items) {
      const original = db.get<{ qty_base: number; value_minor: number }>(
        "SELECT qty_base, value_minor FROM stock_movements WHERE receipt_item_id = ? AND type = 'STOCK_IN'",
        [item.id]
      )
      if (original === undefined) {
        throw new Error('A receipt line has no STOCK_IN movement to reverse.')
      }
      insertMovement(db, {
        productId: item.product_id,
        date: today,
        type: 'STOCK_IN_VOID',
        qtyBase: -original.qty_base,
        valueMinor: negate(original.value_minor),
        source: ['receipt_item_id', item.id]
      })
    }
    db.run(
      "UPDATE stock_receipts SET status = 'VOID', void_reason = ?, void_date = ? WHERE id = ?",
      [reason, today, id]
    )
    assertStockInvariants(db, productIds)
    return readReceipt(db, id)
  })
}

function readReceipt(db: Db, id: number): StockReceiptDetail {
  const row = receiptRow(db, id)
  const later = laterActivityProducts(db, id)
  const items = db.all<ReceiptItemRow>(
    `SELECT ri.id, ri.receipt_id, ri.line_no, ri.product_id, p.code AS product_code, p.name AS product_name, ri.unit_id,
            ri.unit_name, ri.unit_base_qty, ri.quantity, ri.qty_base, ri.unit_cost_minor, ri.line_cost_minor
     FROM stock_receipt_items AS ri JOIN products AS p ON p.id = ri.product_id
     WHERE ri.receipt_id = ? ORDER BY ri.line_no`,
    [id]
  )
  const lines: StockReceiptLine[] = items.map((item) => ({
    id: item.id,
    lineNo: item.line_no,
    productId: item.product_id,
    productCode: item.product_code,
    productName: item.product_name,
    unitId: item.unit_id,
    unitName: item.unit_name,
    unitBaseQty: item.unit_base_qty,
    quantity: item.quantity,
    qtyBase: item.qty_base,
    unitCostMinor: item.unit_cost_minor,
    lineCostMinor: item.line_cost_minor,
    correctedLineCostMinor: correctedLineCost(db, item),
    laterActivity: later.has(item.product_id)
  }))
  const corrections = db
    .all<AdjustmentRow>(`${SELECT_ADJUSTMENTS} WHERE a.receipt_id = ? ORDER BY a.id`, [id])
    .map(toAdjustmentSummary)
  return {
    ...summaryOf(row, row.status === 'POSTED' && later.size === 0),
    note: row.note,
    voidReason: row.void_reason,
    voidDate: row.void_date,
    lines,
    corrections
  }
}

function receiptRow(db: Db, id: number): ReceiptRow {
  const row = db.get<ReceiptRow>(`${SELECT_RECEIPTS} WHERE r.id = ?`, [id])
  if (row === undefined) {
    throw new AppFailure({ code: 'NOT_FOUND', message: 'This receipt no longer exists.' })
  }
  return row
}

function receiptSummary(db: Db, row: ReceiptRow): StockReceiptSummary {
  return summaryOf(row, row.status === 'POSTED' && laterActivityProducts(db, row.id).size === 0)
}

function summaryOf(row: ReceiptRow, voidable: boolean): StockReceiptSummary {
  return {
    id: row.id,
    receiptNo: row.receipt_no,
    receiptDate: row.receipt_date,
    supplierName: row.supplier_name,
    reference: row.reference,
    totalCostMinor: row.total_cost_minor,
    status: row.status,
    lineCount: row.line_count,
    voidable,
    createdAt: row.created_at
  }
}

/**
 * The products of receipt `receiptId` that another document has moved since the receipt's first movement of that
 * product (plan §8.5). The receipt's own movements, including several lines of one product, never count.
 */
function laterActivityProducts(db: Db, receiptId: number): Set<number> {
  const rows = db.all<{ product_id: number }>(
    `SELECT DISTINCT m.product_id
     FROM stock_movements AS m
     JOIN (SELECT sm.product_id, min(sm.id) AS first_id
           FROM stock_movements AS sm
           JOIN stock_receipt_items AS ri ON ri.id = sm.receipt_item_id
           WHERE ri.receipt_id = ? AND sm.type = 'STOCK_IN'
           GROUP BY sm.product_id) AS f
       ON f.product_id = m.product_id AND m.id > f.first_id
     WHERE m.receipt_item_id IS NULL
        OR m.receipt_item_id NOT IN (SELECT id FROM stock_receipt_items WHERE receipt_id = ?)`,
    [receiptId, receiptId]
  )
  return new Set(rows.map((row) => row.product_id))
}

/** The active, purchasable unit of each line, or VALIDATION with the problem of every line. */
function purchasableUnits(db: Db, receipt: StockReceiptInput): UnitRow[] {
  const productIds = unique(receipt.lines.map((line) => line.productId))
  const unitIds = unique(receipt.lines.map((line) => line.unitId))
  const products = new Map(
    db
      .all<ProductRow>(
        `SELECT id, code, name, is_active FROM products WHERE id IN (${placeholders(productIds)})`,
        productIds
      )
      .map((row) => [row.id, row])
  )
  const units = new Map(
    db
      .all<UnitRow>(
        `SELECT id, product_id, name, base_qty, can_purchase, is_active FROM product_units
         WHERE id IN (${placeholders(unitIds)})`,
        unitIds
      )
      .map((row) => [row.id, row])
  )
  const fieldErrors: Record<string, string[]> = {}
  const chosen = receipt.lines.map((line, index) => {
    const product = products.get(line.productId)
    const unit = units.get(line.unitId)
    if (product === undefined) {
      fieldErrors[`lines.${index}.productId`] = ['This product no longer exists.']
    } else if (product.is_active === 0) {
      fieldErrors[`lines.${index}.productId`] = [`${product.name} is inactive.`]
    } else if (unit === undefined || unit.product_id !== line.productId) {
      fieldErrors[`lines.${index}.unitId`] = ['This unit does not belong to the product.']
    } else if (unit.is_active === 0) {
      fieldErrors[`lines.${index}.unitId`] = ['This unit is inactive.']
    } else if (unit.can_purchase === 0) {
      fieldErrors[`lines.${index}.unitId`] = [
        `${unit.name} cannot be purchased. Choose a purchasable unit.`
      ]
    }
    return unit
  })
  if (Object.keys(fieldErrors).length > 0) {
    throw new AppFailure({
      code: 'VALIDATION',
      message: 'Check the highlighted lines.',
      fieldErrors
    })
  }
  return chosen as UnitRow[]
}

// --- Adjustments ---------------------------------------------------------------------------------------------------

/** Posts one stock adjustment with its movement, valued by the rules of its reason (plan §8.6). */
export function adjustStock(db: Db, input: unknown, now: Date): StockAdjustmentResult {
  const adjustment = parseInput(StockAdjustmentInputSchema, input)
  return inventoryTransaction(db, () => {
    const saved = db.get<{ id: number }>('SELECT id FROM stock_adjustments WHERE request_id = ?', [
      adjustment.requestId
    ])
    if (saved !== undefined) return { ...readAdjustment(db, saved.id), warning: null }

    assertCurrencyDigits(db, adjustment.currencyMinorDigits)
    const product = adjustmentProduct(db, adjustment.productId)
    const line =
      adjustment.receiptItemId === null
        ? null
        : correctedReceiptLine(db, adjustment.receiptItemId, product)
    assertPostingDate(db, {
      date: adjustment.adjustmentDate,
      today: localDateString(now),
      productIds: [product.id],
      field: 'adjustmentDate'
    })
    const unit =
      adjustment.unitId === null ? null : adjustmentUnit(db, adjustment.unitId, product, line)
    const effect = valuation(db, adjustment, product, unit, line)

    const adjustmentNo = allocateDocumentNumber(db, 'adjustment', ADJUSTMENT_NUMBER_PREFIX)
    const id = Number(
      db.run(
        `INSERT INTO stock_adjustments (adjustment_no, request_id, adjustment_date, product_id, reason_code, direction,
           unit_id, unit_name, unit_base_qty, quantity, qty_base, value_minor, receipt_id, receipt_item_id, reason_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          adjustmentNo,
          adjustment.requestId,
          adjustment.adjustmentDate,
          product.id,
          adjustment.reason,
          effect.direction,
          unit?.id ?? null,
          unit?.name ?? null,
          unit?.base_qty ?? null,
          adjustment.quantity,
          Math.abs(effect.qtyBase),
          Math.abs(effect.valueMinor),
          line?.receipt_id ?? null,
          line?.id ?? null,
          adjustment.reasonNote
        ]
      ).lastInsertRowid
    )
    insertMovement(db, {
      productId: product.id,
      date: adjustment.adjustmentDate,
      type: effect.type,
      qtyBase: effect.qtyBase,
      valueMinor: effect.valueMinor,
      source: ['adjustment_id', id]
    })
    assertStockInvariants(db, [product.id])
    return { ...readAdjustment(db, id), warning: effect.warning }
  })
}

/** Adjustments, newest first, optionally for one product. */
export function listAdjustments(db: Db, input: unknown): StockPage<StockAdjustmentSummary> {
  const { page, pageSize, productId } = parseInput(AdjustmentListInputSchema, input)
  const where = productId === null ? '' : 'WHERE a.product_id = ?'
  const params: SqlValue[] = productId === null ? [] : [productId]
  const total = db.get<{ n: number }>(
    `SELECT count(*) AS n FROM stock_adjustments AS a ${where}`,
    params
  )!.n
  const rows = db.all<AdjustmentRow>(
    `${SELECT_ADJUSTMENTS} ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  )
  return { items: rows.map(toAdjustmentSummary), total, page, pageSize }
}

interface AdjustmentEffect {
  readonly direction: AdjustmentDirection
  readonly type: StockMovementType
  /** Signed, as the movement. */
  readonly qtyBase: number
  /** Signed, as the movement. */
  readonly valueMinor: number
  readonly warning: string | null
}

/** What the adjustment does to stock: its movement type, signed quantity and value, and the L1 warning. */
function valuation(
  db: Db,
  adjustment: StockAdjustmentInput,
  product: ProductRow,
  unit: UnitRow | null,
  line: CorrectedLine | null
): AdjustmentEffect {
  const position = stockPosition(db, product.id)
  const direction = adjustmentDirection(adjustment)
  const qtyBase = unit === null ? 0 : toBaseQuantity(adjustment.quantity!, unit.base_qty)
  const effect = (
    type: StockMovementType,
    signedQty: number,
    valueMinor: number,
    warning: string | null = null
  ): AdjustmentEffect => ({ direction, type, qtyBase: signedQty, valueMinor, warning })

  switch (adjustment.reason) {
    case 'OPENING_STOCK':
      if (hasMovements(db, product.id)) {
        throw new AppFailure({
          code: 'FORBIDDEN_STATE',
          message: `${label(product)} already has stock history, so opening stock can no longer be entered. Use Count Surplus or Other Correction instead.`
        })
      }
      return effect(
        'OPENING',
        qtyBase,
        multiplyMinor(adjustment.unitCostMinor!, adjustment.quantity!)
      )
    case 'COUNT_SURPLUS':
      return effect('ADJUST_IN', qtyBase, surplusValue(adjustment, position, qtyBase))
    case 'RECEIPT_COST_CORRECTION':
      return costCorrection(db, adjustment, product, line!, position)
    default:
      break
  }

  if (direction === 'IN') {
    const value =
      adjustment.reason === 'RECEIPT_QTY_CORRECTION'
        ? mulDivRoundHalfUp(correctedLineCost(db, line!), qtyBase, line!.qty_base)
        : multiplyMinor(adjustment.unitCostMinor!, adjustment.quantity!)
    return effect('ADJUST_IN', qtyBase, value)
  }

  if (adjustment.reason === 'RECEIPT_QTY_CORRECTION') {
    const left = lineQuantityLeft(db, line!)
    if (qtyBase > left) {
      throw fieldFailure(
        'quantity',
        `This receipt line has ${quantityText(db, product.id, Math.max(left, 0))} left to correct.`
      )
    }
  }
  if (qtyBase > position.qtyBase) {
    throw new AppFailure({
      code: 'INSUFFICIENT_STOCK',
      message: `Only ${quantityText(db, product.id, position.qtyBase)} of ${label(product)} is in stock; ${quantityText(db, product.id, qtyBase)} cannot be removed.`,
      fieldErrors: {
        quantity: [`Only ${quantityText(db, product.id, position.qtyBase)} is in stock.`]
      },
      details: {
        productId: product.id,
        requiredQtyBase: qtyBase,
        availableQtyBase: position.qtyBase
      }
    })
  }
  return effect('ADJUST_OUT', -qtyBase, negate(weightedAverageOutflowValue(position, qtyBase)))
}

/** A count surplus is valued at the current average; only a product without stock takes an entered cost. */
function surplusValue(
  adjustment: StockAdjustmentInput,
  position: StockPosition,
  qtyBase: number
): number {
  if (position.qtyBase > 0) {
    if (adjustment.unitCostMinor !== null) {
      throw fieldFailure(
        'unitCostMinor',
        'This product has stock, so the surplus is valued at its average cost. Leave the cost empty.'
      )
    }
    return mulDivRoundHalfUp(position.valueMinor, qtyBase, position.qtyBase)
  }
  if (adjustment.unitCostMinor === null) {
    throw fieldFailure(
      'unitCostMinor',
      'This product has no stock, so enter the unit cost of the surplus.'
    )
  }
  return multiplyMinor(adjustment.unitCostMinor, adjustment.quantity!)
}

/**
 * δ = (correct unit cost × the line's quantity) − the line's cost as recorded so far (including earlier corrections).
 * Only while stock is left, and never below zero value. Past COGS is not recalculated (limitation L1).
 */
function costCorrection(
  db: Db,
  adjustment: StockAdjustmentInput,
  product: ProductRow,
  line: CorrectedLine,
  position: StockPosition
): AdjustmentEffect {
  if (position.qtyBase === 0) {
    throw new AppFailure({
      code: 'FORBIDDEN_STATE',
      message: `No stock of ${label(product)} is left, so its inventory cost cannot be corrected. Record the difference as an expense instead.`
    })
  }
  const recorded = correctedLineCost(db, line)
  const delta = multiplyMinor(adjustment.unitCostMinor!, line.quantity) - recorded
  if (delta === 0) throw fieldFailure('unitCostMinor', 'This is already the recorded cost.')
  if (addMinor(position.valueMinor, delta) < 0) {
    throw new AppFailure({
      code: 'FORBIDDEN_STATE',
      message: `This correction would make the stock value of ${label(product)} negative, so it cannot be saved.`
    })
  }
  const warning = laterActivityProducts(db, line.receipt_id).has(product.id)
    ? LATE_COST_CORRECTION_WARNING
    : null
  return { direction: 'VALUE', type: 'COST_CORRECTION', qtyBase: 0, valueMinor: delta, warning }
}

function adjustmentProduct(db: Db, productId: number): ProductRow {
  const row = db.get<ProductRow>('SELECT id, code, name, is_active FROM products WHERE id = ?', [
    productId
  ])
  if (row === undefined) throw fieldFailure('productId', 'This product no longer exists.')
  return row
}

/** A unit of the product: active, or the unit of the corrected receipt line. */
function adjustmentUnit(
  db: Db,
  unitId: number,
  product: ProductRow,
  line: CorrectedLine | null
): UnitRow {
  const unit = db.get<UnitRow>(
    'SELECT id, product_id, name, base_qty, can_purchase, is_active FROM product_units WHERE id = ?',
    [unitId]
  )
  if (unit === undefined || unit.product_id !== product.id) {
    throw fieldFailure('unitId', 'This unit does not belong to the product.')
  }
  if (unit.is_active === 0 && unit.id !== line?.unit_id) {
    throw fieldFailure('unitId', 'This unit is inactive.')
  }
  return unit
}

/** The receipt line a correction names: it must exist, belong to a posted receipt and be for the same product. */
function correctedReceiptLine(db: Db, receiptItemId: number, product: ProductRow): CorrectedLine {
  const line = db.get<CorrectedLine>(
    `SELECT ri.id, ri.receipt_id, ri.line_no, ri.product_id, p.code AS product_code, p.name AS product_name, ri.unit_id,
            ri.unit_name, ri.unit_base_qty, ri.quantity, ri.qty_base, ri.unit_cost_minor, ri.line_cost_minor,
            r.receipt_no, r.status AS receipt_status
     FROM stock_receipt_items AS ri
     JOIN stock_receipts AS r ON r.id = ri.receipt_id
     JOIN products AS p ON p.id = ri.product_id
     WHERE ri.id = ?`,
    [receiptItemId]
  )
  if (line === undefined) throw fieldFailure('receiptItemId', 'This receipt line no longer exists.')
  if (line.receipt_status === 'VOID') {
    throw new AppFailure({
      code: 'FORBIDDEN_STATE',
      message: `Receipt ${line.receipt_no} is void, so it cannot be corrected.`
    })
  }
  if (line.product_id !== product.id) {
    throw fieldFailure(
      'receiptItemId',
      `This receipt line is for ${line.product_code} ${line.product_name}, not this product.`
    )
  }
  return line
}

/** The line's cost after every receipt cost correction of it. */
function correctedLineCost(db: Db, line: Pick<ReceiptItemRow, 'id' | 'line_cost_minor'>): number {
  const corrections = db.get<{ total: number }>(
    `SELECT coalesce(sum(m.value_minor), 0) AS total
     FROM stock_adjustments AS a JOIN stock_movements AS m ON m.adjustment_id = a.id
     WHERE a.receipt_item_id = ? AND a.reason_code = 'RECEIPT_COST_CORRECTION'`,
    [line.id]
  )!.total
  return addMinor(line.line_cost_minor, corrections)
}

/** The line's quantity after every receipt quantity correction of it, in base units. */
function lineQuantityLeft(db: Db, line: CorrectedLine): number {
  const corrections = db.get<{ total: number }>(
    `SELECT coalesce(sum(m.qty_base), 0) AS total
     FROM stock_adjustments AS a JOIN stock_movements AS m ON m.adjustment_id = a.id
     WHERE a.receipt_item_id = ? AND a.reason_code = 'RECEIPT_QTY_CORRECTION'`,
    [line.id]
  )!.total
  return line.qty_base + corrections
}

function readAdjustment(db: Db, id: number): StockAdjustmentSummary {
  return toAdjustmentSummary(db.get<AdjustmentRow>(`${SELECT_ADJUSTMENTS} WHERE a.id = ?`, [id])!)
}

function toAdjustmentSummary(row: AdjustmentRow): StockAdjustmentSummary {
  return {
    id: row.id,
    adjustmentNo: row.adjustment_no,
    adjustmentDate: row.adjustment_date,
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name,
    reason: row.reason_code,
    direction: row.direction,
    unitName: row.unit_name,
    quantity: row.quantity,
    qtyBase: row.qty_base,
    valueMinor:
      row.movement_value ?? (row.direction === 'OUT' ? negate(row.value_minor) : row.value_minor),
    receiptId: row.receipt_id,
    receiptNo: row.receipt_no,
    receiptItemId: row.receipt_item_id,
    receiptLineNo: row.receipt_line_no,
    reasonNote: row.reason_note,
    createdAt: row.created_at
  }
}

// --- Stock card, summary, posting floor ---------------------------------------------------------------------------

/** One page of a product's movements, oldest first, with the running quantity and value after each. */
export function stockCard(db: Db, input: unknown): StockCard {
  const { productId, page, pageSize } = parseInput(StockCardInputSchema, input)
  const product = getProduct(db, productId)
  const totals = db.get<{ total: number; qty: number; value: number }>(
    `SELECT count(*) AS total, coalesce(sum(qty_base), 0) AS qty, coalesce(sum(value_minor), 0) AS value
     FROM stock_movements WHERE product_id = ?`,
    [productId]
  )!
  const current = page ?? Math.max(1, Math.ceil(totals.total / pageSize))
  const rows = db.all<{
    id: number
    movement_date: string
    type: StockMovementType
    qty_base: number
    value_minor: number
    running_qty: number
    running_value: number
    receipt_no: string | null
    line_no: number | null
    adjustment_no: string | null
    reason_code: AdjustmentReason | null
    invoice_no: string | null
  }>(
    `SELECT * FROM (
       SELECT m.id, m.movement_date, m.type, m.qty_base, m.value_minor,
              sum(m.qty_base) OVER running AS running_qty, sum(m.value_minor) OVER running AS running_value,
              r.receipt_no, ri.line_no, a.adjustment_no, a.reason_code, i.invoice_no
       FROM stock_movements AS m
       LEFT JOIN stock_receipt_items AS ri ON ri.id = m.receipt_item_id
       LEFT JOIN stock_receipts AS r ON r.id = ri.receipt_id
       LEFT JOIN stock_adjustments AS a ON a.id = m.adjustment_id
       LEFT JOIN invoice_items AS ii ON ii.id = m.invoice_item_id
       LEFT JOIN invoices AS i ON i.id = ii.invoice_id
       WHERE m.product_id = ?
       WINDOW running AS (ORDER BY m.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
     )
     ORDER BY id LIMIT ? OFFSET ?`,
    [productId, pageSize, (current - 1) * pageSize]
  )
  const cardRows: StockCardRow[] = rows.map((row) => ({
    id: row.id,
    date: row.movement_date,
    type: row.type,
    reason: row.reason_code,
    reference:
      row.receipt_no !== null
        ? `${row.receipt_no} (line ${row.line_no})`
        : (row.adjustment_no ?? row.invoice_no ?? ''),
    qtyInBase: Math.max(row.qty_base, 0),
    qtyOutBase: Math.max(-row.qty_base, 0),
    valueInMinor: Math.max(row.value_minor, 0),
    valueOutMinor: Math.max(-row.value_minor, 0),
    runningQtyBase: row.running_qty,
    runningValueMinor: row.running_value
  }))
  return {
    product: {
      id: product.id,
      code: product.code,
      name: product.name,
      packingLabel: product.packingLabel,
      isActive: product.isActive,
      lowStockThresholdBase: product.lowStockThresholdBase,
      units: product.units
    },
    qtyBase: totals.qty,
    valueMinor: totals.value,
    rows: cardRows,
    total: totals.total,
    page: current,
    pageSize
  }
}

/** A product's current quantity and value, and its latest movement date. */
export function stockSummary(db: Db, productId: unknown): StockSummary {
  const id = parseInput(StockIdSchema, productId)
  const row = db.get<{
    found: number
    n: number
    qty: number
    value: number
    latest: string | null
  }>(
    `SELECT EXISTS (SELECT 1 FROM products WHERE id = ?) AS found, count(*) AS n, coalesce(sum(qty_base), 0) AS qty,
            coalesce(sum(value_minor), 0) AS value, max(movement_date) AS latest
     FROM stock_movements WHERE product_id = ?`,
    [id, id]
  )!
  if (row.found === 0) {
    throw new AppFailure({ code: 'NOT_FOUND', message: 'This product no longer exists.' })
  }
  return {
    productId: id,
    qtyBase: row.qty,
    valueMinor: row.value,
    hasMovements: row.n > 0,
    latestMovementDate: row.latest
  }
}

/** The allowed date range for a stock document of these products: from their latest movement to today. */
export function postingFloor(db: Db, input: unknown, now: Date): PostingFloor {
  const { productIds } = parseInput(PostingFloorInputSchema, input)
  const floor = latestMovement(db, productIds)
  const product =
    floor === null
      ? undefined
      : db.get<ProductRow>('SELECT id, code, name, is_active FROM products WHERE id = ?', [
          floor.productId
        ])
  return {
    today: localDateString(now),
    earliestDate: floor?.date ?? null,
    setBy:
      product === undefined
        ? null
        : { productId: product.id, productCode: product.code, productName: product.name }
  }
}

// --- Helpers -------------------------------------------------------------------------------------------------------

interface MovementInput {
  readonly productId: number
  readonly date: string
  readonly type: StockMovementType
  readonly qtyBase: number
  readonly valueMinor: number
  readonly source: readonly ['receipt_item_id' | 'adjustment_id', number]
}

function insertMovement(db: Db, movement: MovementInput): void {
  const [column, sourceId] = movement.source
  db.run(
    `INSERT INTO stock_movements (product_id, movement_date, type, qty_base, value_minor, ${column})
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      movement.productId,
      movement.date,
      movement.type,
      movement.qtyBase,
      movement.valueMinor,
      sourceId
    ]
  )
}

function hasMovements(db: Db, productId: number): boolean {
  return (
    db.get<{ found: number }>(
      'SELECT EXISTS (SELECT 1 FROM stock_movements WHERE product_id = ?) AS found',
      [productId]
    )?.found === 1
  )
}

/** −value, without producing −0. */
function negate(value: number): number {
  return value === 0 ? 0 : -value
}

function label(product: Pick<ProductRow, 'code' | 'name'>): string {
  return `${product.code} ${product.name}`
}

/** LIKE patterns for each search word, matched as plain text. */
function searchWords(text: string): string[] {
  return text
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, 8)
    .map((word) => `%${word.replace(/[\\%_]/g, (character) => `\\${character}`)}%`)
}

function fieldFailure(field: string, message: string): AppFailure {
  return new AppFailure({
    code: 'VALIDATION',
    message: 'Check the highlighted fields.',
    fieldErrors: { [field]: [message] }
  })
}
