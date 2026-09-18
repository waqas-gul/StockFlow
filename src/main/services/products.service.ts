import {
  DEACTIVATE_WITH_STOCK_WARNING,
  ProductCreateSchema,
  ProductIdSchema,
  ProductListInputSchema,
  ProductSearchInputSchema,
  ProductUpdateSchema,
  type Product,
  type ProductActiveResult,
  type ProductListItem,
  type ProductListPage,
  type ProductSearchItem,
  type ProductUnit,
  type ProductUnitInput
} from '@shared/products'
import { SetActiveSchema } from '@shared/validation'
import type { Db, SqlValue } from '../db/adapter'
import { AppFailure, parseInput } from '../errors'
import { assertCurrencyDigits } from './settings.service'

/*
 * Products and their units over `products`, `product_units` and `v_product_stock` (plan §7.3, §9.2).
 *
 * - A product and its units are saved in one transaction: every unit is saved, or nothing is.
 * - The unit structure (one base unit of size 1, distinct names and sizes, nested sizes) is checked by the shared
 *   schemas before anything is written.
 * - Once any stock movement exists for a product (read from the database, never from the renderer), the base
 *   quantity of its saved units, the choice of base unit and the set of saved units are locked: stock is stored in base
 *   units, so changing them would change the meaning of that stock. Names, short names, prices, costs, flags, active
 *   status and new compatible units remain possible.
 * - A product is never deleted; it is deactivated. The packing label is display text only and is never parsed.
 * - Prices and costs are integer minor units; any price or cost that is set makes `hasMonetaryData` true, so the
 *   Phase 4C currency decimal places lock follows on its own.
 */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
/** Temporary sizes while units swap names or sizes in one save; far above MAX_BASE_QTY. */
const TEMPORARY_BASE_QTY = 1_000_000_000_000
const MAX_SEARCH_WORDS = 8
const LOCKED_FIELD = 'Locked: stock has already been recorded for this product.'

interface ProductRow {
  id: number
  code: string
  name: string
  company_id: number | null
  company_name: string | null
  company_active: number | null
  packing_label: string | null
  low_stock_threshold_base: number
  is_active: number
  created_at: string
  updated_at: string
}

interface UnitRow {
  id: number
  product_id: number
  name: string
  short_name: string | null
  base_qty: number
  is_base: number
  can_sell: number
  can_purchase: number
  wholesale_price_minor: number | null
  retail_price_minor: number | null
  default_cost_minor: number | null
  sort_order: number
  is_active: number
}

const SELECT_PRODUCTS = `
  SELECT p.id, p.code, p.name, p.company_id, c.name AS company_name, c.is_active AS company_active,
         p.packing_label, p.low_stock_threshold_base, p.is_active, p.created_at, p.updated_at
  FROM products AS p
  LEFT JOIN companies AS c ON c.id = p.company_id`

/** One page of the Products table, by name. */
export function listProducts(db: Db, input: unknown): ProductListPage {
  const { page, pageSize, search, companyId, status } = parseInput(ProductListInputSchema, input)
  const clauses: string[] = []
  const params: SqlValue[] = []
  addSearch(search, clauses, params)
  if (status !== 'all') clauses.push(`p.is_active = ${status === 'active' ? 1 : 0}`)
  if (companyId !== null) {
    clauses.push('p.company_id = ?')
    params.push(companyId)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const total = db.get<{ n: number }>(
    `SELECT count(*) AS n FROM products AS p LEFT JOIN companies AS c ON c.id = p.company_id ${where}`,
    params
  )!.n
  const rows = db.all<ProductRow>(
    `${SELECT_PRODUCTS} ${where} ORDER BY p.name, p.code, p.id LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  )
  return { items: listItems(db, rows), total, page, pageSize }
}

/**
 * Quick lookup for keyboard selection: every word must match the code, name or company name. An exact code comes
 * first, then codes that start with the text, then names that start with it. With nothing typed the whole catalogue
 * comes back by name, so the picker opens on a list to browse instead of on nothing.
 */
export function searchProducts(db: Db, input: unknown): ProductSearchItem[] {
  const { query, limit, includeInactive } = parseInput(ProductSearchInputSchema, input)
  const clauses: string[] = []
  const params: SqlValue[] = []
  addSearch(query, clauses, params)
  if (!includeInactive) clauses.push('p.is_active = 1')
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  if (query === '') {
    return db
      .all<ProductRow>(`${SELECT_PRODUCTS} ${where} ORDER BY p.name, p.code, p.id LIMIT ?`, [limit])
      .map(searchItem)
  }
  const prefix = `${escapeLike(query)}%`
  const rows = db.all<ProductRow & { rank: number }>(
    `SELECT * FROM (
       ${SELECT_PRODUCTS.replace(
         'SELECT p.id,',
         `SELECT CASE WHEN p.code = ? THEN 0 WHEN p.code LIKE ? ESCAPE '\\' THEN 1
                      WHEN p.name LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END AS rank, p.id,`
       )}
       ${where}
     )
     ORDER BY rank, CASE WHEN rank <= 1 THEN code END, name, code, id
     LIMIT ?`,
    [query, prefix, prefix, ...params, limit]
  )
  return rows.map(searchItem)
}

function searchItem(row: ProductRow): ProductSearchItem {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    companyName: row.company_name,
    packingLabel: row.packing_label,
    isActive: row.is_active === 1
  }
}

/** One product with its units, stock and lock state. */
export function getProduct(db: Db, id: unknown): Product {
  return readProduct(db, parseInput(ProductIdSchema, id))
}

export function createProduct(db: Db, input: unknown): Product {
  const product = parseInput(ProductCreateSchema, input)
  return db.transaction(() => {
    assertCurrencyDigits(db, product.currencyMinorDigits)
    assertCompanyUsable(db, product.companyId, null)
    assertCodeFree(db, product.code, null)
    const { lastInsertRowid } = db.run(
      `INSERT INTO products (code, name, company_id, packing_label, low_stock_threshold_base)
       VALUES (?, ?, ?, ?, ?)`,
      [
        product.code,
        product.name,
        product.companyId,
        product.packingLabel,
        product.lowStockThresholdBase
      ]
    )
    const id = Number(lastInsertRowid)
    product.units.forEach((unit, index) => insertUnit(db, id, unit, index))
    return readProduct(db, id)
  })
}

/**
 * Saves the edit form: the product fields and its whole unit list. Saved units keep their id, new units have none,
 * and saved units left out are removed (only while nothing references them and the product has no stock movement).
 */
export function updateProduct(db: Db, input: unknown): Product {
  const product = parseInput(ProductUpdateSchema, input)
  return db.transaction(() => {
    assertCurrencyDigits(db, product.currencyMinorDigits)
    const current = productRow(db, product.id)
    assertCompanyUsable(db, product.companyId, current.company_id)
    assertCodeFree(db, product.code, product.id)
    const existing = new Map(unitRowsOf(db, [product.id]).map((row) => [row.id, row]))
    assertUnitsBelong(product.units, existing)
    const kept = new Set(product.units.map((unit) => unit.id))
    const removed = [...existing.values()].filter((row) => !kept.has(row.id))
    if (hasStockMovements(db, product.id)) assertUnitsUnlocked(product.units, existing, removed)
    else assertRemovable(db, removed)

    db.run(
      `UPDATE products SET code = ?, name = ?, company_id = ?, packing_label = ?, low_stock_threshold_base = ?,
         updated_at = ${NOW}
       WHERE id = ?`,
      [
        product.code,
        product.name,
        product.companyId,
        product.packingLabel,
        product.lowStockThresholdBase,
        product.id
      ]
    )
    saveUnits(db, product.id, product.units, existing, removed)
    return readProduct(db, product.id)
  })
}

/** Activates or deactivates a product. Deactivating one with stock is allowed, with a warning; nothing is removed. */
export function setProductActive(db: Db, input: unknown): ProductActiveResult {
  const { id, active } = parseInput(SetActiveSchema, input)
  return db.transaction(() => {
    const row = productRow(db, id)
    if ((row.is_active === 1) !== active) {
      db.run(`UPDATE products SET is_active = ?, updated_at = ${NOW} WHERE id = ?`, [
        active ? 1 : 0,
        id
      ])
    }
    const stockQtyBase = stockOf(db, [id]).get(id) ?? 0
    return {
      id,
      isActive: active,
      stockQtyBase,
      warning: !active && stockQtyBase > 0 ? DEACTIVATE_WITH_STOCK_WARNING : null
    }
  })
}

function readProduct(db: Db, id: number): Product {
  const row = productRow(db, id)
  const [item] = listItems(db, [row])
  return {
    ...item,
    hasStockMovements: hasStockMovements(db, id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function productRow(db: Db, id: number): ProductRow {
  const row = db.get<ProductRow>(`${SELECT_PRODUCTS} WHERE p.id = ?`, [id])
  if (row === undefined) {
    throw new AppFailure({ code: 'NOT_FOUND', message: 'This product no longer exists.' })
  }
  return row
}

function listItems(db: Db, rows: readonly ProductRow[]): ProductListItem[] {
  const ids = rows.map((row) => row.id)
  const stock = stockOf(db, ids)
  const units = new Map<number, ProductUnit[]>()
  for (const unit of unitRowsOf(db, ids)) {
    const list = units.get(unit.product_id) ?? []
    list.push(toUnit(unit))
    units.set(unit.product_id, list)
  }
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    companyId: row.company_id,
    companyName: row.company_name,
    companyActive: row.company_active === null ? null : row.company_active === 1,
    packingLabel: row.packing_label,
    lowStockThresholdBase: row.low_stock_threshold_base,
    isActive: row.is_active === 1,
    stockQtyBase: stock.get(row.id) ?? 0,
    units: units.get(row.id) ?? []
  }))
}

/** Stock in base units from v_product_stock, for the given products only. */
function stockOf(db: Db, ids: readonly number[]): Map<number, number> {
  if (ids.length === 0) return new Map()
  const rows = db.all<{ product_id: number; qty_base: number }>(
    `SELECT product_id, qty_base FROM v_product_stock WHERE product_id IN (${placeholders(ids)})`,
    ids
  )
  return new Map(rows.map((row) => [row.product_id, row.qty_base]))
}

function unitRowsOf(db: Db, productIds: readonly number[]): UnitRow[] {
  if (productIds.length === 0) return []
  return db.all<UnitRow>(
    `SELECT id, product_id, name, short_name, base_qty, is_base, can_sell, can_purchase, wholesale_price_minor,
            retail_price_minor, default_cost_minor, sort_order, is_active
     FROM product_units WHERE product_id IN (${placeholders(productIds)})
     ORDER BY product_id, sort_order, base_qty, id`,
    productIds
  )
}

function hasStockMovements(db: Db, productId: number): boolean {
  return (
    db.get<{ found: number }>(
      'SELECT EXISTS (SELECT 1 FROM stock_movements WHERE product_id = ?) AS found',
      [productId]
    )?.found === 1
  )
}

/** A new or changed company must exist and be active; a product may keep a company that became inactive. */
function assertCompanyUsable(db: Db, companyId: number | null, currentId: number | null): void {
  if (companyId === null) return
  const row = db.get<{ is_active: number }>('SELECT is_active FROM companies WHERE id = ?', [
    companyId
  ])
  if (row === undefined) throw fieldFailure('companyId', 'This company no longer exists.')
  if (row.is_active === 0 && companyId !== currentId) {
    throw fieldFailure('companyId', 'This company is inactive. Choose an active company or none.')
  }
}

/** Product codes are unique regardless of letter case (the column is NOCASE). */
function assertCodeFree(db: Db, code: string, ownId: number | null): void {
  const taken = db.get('SELECT 1 AS found FROM products WHERE code = ? AND id IS NOT ?', [
    code,
    ownId
  ])
  if (taken !== undefined) {
    const message = `Another product already uses the code "${code}".`
    throw new AppFailure({ code: 'DUPLICATE', message, fieldErrors: { code: [message] } })
  }
}

function assertUnitsBelong(
  units: readonly ProductUnitInput[],
  existing: Map<number, UnitRow>
): void {
  const fieldErrors: Record<string, string[]> = {}
  units.forEach((unit, index) => {
    if (unit.id !== null && !existing.has(unit.id)) {
      fieldErrors[`units.${index}.id`] = ['This unit no longer exists.']
    }
  })
  if (Object.keys(fieldErrors).length > 0) {
    throw new AppFailure({
      code: 'VALIDATION',
      message: 'Check the highlighted fields.',
      fieldErrors
    })
  }
}

/** After a stock movement: no saved unit removed, the same base unit, and the same size for every saved unit. */
function assertUnitsUnlocked(
  units: readonly ProductUnitInput[],
  existing: Map<number, UnitRow>,
  removed: readonly UnitRow[]
): void {
  if (removed.length > 0) {
    throw new AppFailure({
      code: 'UNIT_LOCKED',
      message:
        'This product already has stock history, so its units cannot be removed. Make the unit inactive instead.',
      fieldErrors: {
        units: removed.map((row) => `${row.name}: make the unit inactive instead of removing it.`)
      }
    })
  }
  const lockedFields = (
    field: 'isBase' | 'baseQty',
    changed: (unit: ProductUnitInput) => boolean
  ): Record<string, string[]> =>
    Object.fromEntries(
      units.flatMap((unit, index) =>
        changed(unit) ? [[`units.${index}.${field}`, [LOCKED_FIELD]]] : []
      )
    ) as Record<string, string[]>

  const baseMoved = lockedFields('isBase', (unit) =>
    unit.id === null ? unit.isBase : (existing.get(unit.id)!.is_base === 1) !== unit.isBase
  )
  if (Object.keys(baseMoved).length > 0) {
    throw new AppFailure({
      code: 'UNIT_LOCKED',
      message: 'This product already has stock history, so its base unit cannot change.',
      fieldErrors: baseMoved
    })
  }
  const resized = lockedFields(
    'baseQty',
    (unit) => unit.id !== null && existing.get(unit.id)!.base_qty !== unit.baseQty
  )
  if (Object.keys(resized).length > 0) {
    throw new AppFailure({
      code: 'UNIT_LOCKED',
      message:
        'This product already has stock history, so the base quantity of its units cannot change.',
      fieldErrors: resized
    })
  }
}

/** Before any stock movement, a unit can be removed unless a saved document still refers to it. */
function assertRemovable(db: Db, removed: readonly UnitRow[]): void {
  const used = removed.filter(
    (row) =>
      db.get<{ used: number }>(
        `SELECT EXISTS (SELECT 1 FROM stock_receipt_items WHERE unit_id = ?)
             OR EXISTS (SELECT 1 FROM invoice_item_quantities WHERE unit_id = ?)
             OR EXISTS (SELECT 1 FROM stock_adjustments WHERE unit_id = ?) AS used`,
        [row.id, row.id, row.id]
      )?.used === 1
  )
  if (used.length > 0) {
    throw new AppFailure({
      code: 'UNIT_LOCKED',
      message: 'A unit used by saved documents cannot be removed. Make the unit inactive instead.',
      fieldErrors: {
        units: used.map((row) => `${row.name}: make the unit inactive instead of removing it.`)
      }
    })
  }
}

/**
 * Writes the unit list. Units can swap names, sizes or the base role in one save, and the table's unique indexes are
 * checked row by row, so the saved units whose name, size or base role changes first take temporary values.
 */
function saveUnits(
  db: Db,
  productId: number,
  units: readonly ProductUnitInput[],
  existing: Map<number, UnitRow>,
  removed: readonly UnitRow[]
): void {
  for (const row of removed) db.run('DELETE FROM product_units WHERE id = ?', [row.id])
  const restructured = new Set<number>()
  for (const unit of units) {
    const row = unit.id === null ? undefined : existing.get(unit.id)
    if (row === undefined) continue
    if (
      row.name !== unit.name ||
      row.base_qty !== unit.baseQty ||
      (row.is_base === 1) !== unit.isBase
    ) {
      db.run('UPDATE product_units SET name = ?, base_qty = ?, is_base = 0 WHERE id = ?', [
        `\u0001${row.id}`,
        TEMPORARY_BASE_QTY + row.id,
        row.id
      ])
      restructured.add(row.id)
    }
  }
  units.forEach((unit, index) => {
    const row = unit.id === null ? undefined : existing.get(unit.id)
    if (row === undefined) {
      insertUnit(db, productId, unit, index)
    } else if (restructured.has(row.id) || unitChanged(row, unit, index)) {
      db.run(
        `UPDATE product_units SET name = ?, short_name = ?, base_qty = ?, is_base = ?, can_sell = ?, can_purchase = ?,
           wholesale_price_minor = ?, retail_price_minor = ?, default_cost_minor = ?, sort_order = ?, is_active = ?,
           updated_at = ${NOW}
         WHERE id = ?`,
        [...unitValues(unit, index), row.id]
      )
    }
  })
}

function insertUnit(db: Db, productId: number, unit: ProductUnitInput, index: number): void {
  db.run(
    `INSERT INTO product_units (name, short_name, base_qty, is_base, can_sell, can_purchase, wholesale_price_minor,
       retail_price_minor, default_cost_minor, sort_order, is_active, product_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [...unitValues(unit, index), productId]
  )
}

function unitValues(unit: ProductUnitInput, sortOrder: number): SqlValue[] {
  return [
    unit.name,
    unit.shortName,
    unit.baseQty,
    flag(unit.isBase),
    flag(unit.canSell),
    flag(unit.canPurchase),
    unit.wholesalePriceMinor,
    unit.retailPriceMinor,
    unit.defaultCostMinor,
    sortOrder,
    flag(unit.isActive)
  ]
}

function unitChanged(row: UnitRow, unit: ProductUnitInput, sortOrder: number): boolean {
  const saved = [
    row.name,
    row.short_name,
    row.base_qty,
    row.is_base,
    row.can_sell,
    row.can_purchase,
    row.wholesale_price_minor,
    row.retail_price_minor,
    row.default_cost_minor,
    row.sort_order,
    row.is_active
  ]
  const wanted = unitValues(unit, sortOrder)
  return saved.some((value, index) => value !== wanted[index])
}

function toUnit(row: UnitRow): ProductUnit {
  return {
    id: row.id,
    name: row.name,
    shortName: row.short_name,
    baseQty: row.base_qty,
    isBase: row.is_base === 1,
    canSell: row.can_sell === 1,
    canPurchase: row.can_purchase === 1,
    wholesalePriceMinor: row.wholesale_price_minor,
    retailPriceMinor: row.retail_price_minor,
    defaultCostMinor: row.default_cost_minor,
    sortOrder: row.sort_order,
    isActive: row.is_active === 1
  }
}

/** Every word must match the code, name or company name, as plain text (% and _ have no special meaning). */
function addSearch(text: string, clauses: string[], params: SqlValue[]): void {
  const words = text
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, MAX_SEARCH_WORDS)
  for (const word of words) {
    const pattern = `%${escapeLike(word)}%`
    clauses.push(
      `(p.code LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')`
    )
    params.push(pattern, pattern, pattern)
  }
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

function flag(value: boolean): number {
  return value ? 1 : 0
}

function fieldFailure(field: string, message: string): AppFailure {
  return new AppFailure({
    code: 'VALIDATION',
    message: 'Check the highlighted fields.',
    fieldErrors: { [field]: [message] }
  })
}
