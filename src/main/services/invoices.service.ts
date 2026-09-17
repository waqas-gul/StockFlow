import { isWalkInCustomer, type ListPage } from '@shared/customers'
import { localDateString } from '@shared/dates'
import { applyOutflow, formatMoney, sumMinor } from '@shared/domain'
import {
  calculateInvoiceTotals,
  type InvoiceLineTotals,
  type InvoiceTotals
} from '@shared/invoice-totals'
import {
  INVOICE_DISPATCH_FIELDS,
  InvoiceContextInputSchema,
  InvoiceCreateSchema,
  InvoiceDispatchUpdateSchema,
  InvoiceIdSchema,
  InvoiceListInputSchema,
  PRICE_TIER_LABELS,
  WALK_IN_FULL_PAYMENT_MESSAGE,
  WALK_IN_FULL_PAYMENT_RULE,
  formatInvoiceNumber,
  type InvoiceChange,
  type InvoiceContext,
  type InvoiceCreateInput,
  type InvoiceDetail,
  type InvoiceDispatchField,
  type InvoiceDispatchResult,
  type InvoiceLine,
  type InvoicePayment,
  type InvoiceQuantity,
  type InvoiceSaveResult,
  type InvoiceStatus,
  type InvoiceSummary,
  type PriceTier
} from '@shared/invoices'
import type { PaymentMethod, PaymentStatus } from '@shared/payments'
import type { Settings } from '@shared/settings'
import type { Db, SqlValue } from '../db/adapter'
import { AppFailure, parseInput } from '../errors'
import {
  appendLedgerEntry,
  assertCustomerPostingDate,
  customerBalance,
  customerRow,
  latestLedgerDate,
  type CustomerRow
} from './customer-ledger'
import {
  assertPostingDate,
  assertStockInvariants,
  inventoryTransaction,
  latestMovement,
  placeholders,
  quantityText,
  stockPositions,
  unique
} from './inventory'
import { insertPayment } from './payments.service'
import { takeSequenceValue } from './sequences'
import { assertCurrencyDigits, readSettings } from './settings.service'

/*
 * Posting a sales invoice (plan §11.3). Everything happens in one BEGIN IMMEDIATE transaction, so the stock check and
 * the stock deduction can never be separated, and a failure anywhere leaves no trace and uses no number:
 *
 *   request id (a retry returns the saved invoice) → currency → customer (exists; active) → products and units (exist;
 *   active; the unit belongs to the product and can be sold) → posting date (≤ today, ≥ the customer's latest ledger
 *   entry and ≥ the latest stock movement of every product on the invoice) → prices (the configured price of the tier
 *   unless the row is marked as an override; no fallback to the other tier) → totals (invoice-totals.ts, from database
 *   unit sizes and the accepted prices) → the walk-in customer pays exactly the total → stock (Q ≥ paid + free quantity
 *   per product) → COGS → INV- number →
 *   header → per line: item, quantity rows, SALE movement → INVOICE ledger entry (+total, when above zero) → payment
 *   and PAYMENT ledger entry (when money was received) → stock invariants → customer balance check.
 *
 * COGS: each line leaves stock at round_half_up(V × qty ÷ Q) of a running, transaction-local Q/V per product, and the
 * last units take exactly the value left. The cost is frozen on the line and on the SALE movement.
 *
 * After saving (Phase 9A), an invoice is read from its own copies only (never from the current customer, product or
 * unit), and only its dispatch details change, each change logged in invoice_change_log. Anything else is corrected
 * by voiding the invoice (invoice-void.service.ts).
 */

const PAYMENT_REQUEST_PREFIX = 'invoice:'
const MAX_SEARCH_WORDS = 8

/** invoice_change_log.field (the invoices column) → the input key its new value comes from. */
const DISPATCH_INPUT_KEYS: Readonly<
  Record<InvoiceDispatchField, 'biltyNo' | 'transportName' | 'addaName'>
> = {
  bilty_no: 'biltyNo',
  transport_name: 'transportName',
  adda_name: 'addaName'
}

interface ProductRow {
  id: number
  code: string
  name: string
  packing_label: string | null
  is_active: number
  company_name: string | null
}

interface UnitRow {
  id: number
  product_id: number
  name: string
  short_name: string | null
  base_qty: number
  can_sell: number
  is_active: number
  retail_price_minor: number | null
  wholesale_price_minor: number | null
}

/** A request line with its product and the database unit of each quantity row and free quantity. */
interface ResolvedLine {
  readonly input: InvoiceCreateInput['lines'][number]
  readonly product: ProductRow
  readonly units: readonly UnitRow[]
  readonly freeUnits: readonly UnitRow[]
}

interface PricedLine extends ResolvedLine {
  readonly totals: InvoiceLineTotals
}

interface InvoiceRow {
  id: number
  invoice_no: string
  invoice_date: string
  invoice_code: string | null
  status: InvoiceStatus
  customer_id: number
  customer_code: string
  cust_name: string
  cust_shop_name: string | null
  cust_phone: string | null
  cust_address: string | null
  cust_city: string | null
  price_tier: PriceTier
  gross_minor: number
  line_discount_minor: number
  line_scheme_minor: number
  extra_discount_minor: number
  net_minor: number
  freight_minor: number
  total_minor: number
  received_minor: number
  previous_balance_minor: number
  net_outstanding_minor: number
  cogs_minor: number
  bilty_no: string | null
  transport_name: string | null
  adda_name: string | null
  checked_by: string | null
  notes: string | null
  dispatch_updated_at: string | null
  void_reason: string | null
  void_date: string | null
  voided_at: string | null
  created_at: string
}

interface ItemRow {
  id: number
  line_no: number
  product_id: number
  prod_code: string
  prod_name: string
  company_name: string | null
  packing_label: string | null
  qty_base: number
  scheme_qty_base: number
  gross_minor: number
  discount_bps: number | null
  discount_minor: number
  scheme_minor: number
  ctn_count: number | null
  net_minor: number
  cost_minor: number
}

interface QuantityRow {
  id: number
  invoice_item_id: number
  unit_id: number
  unit_name: string
  unit_short_name: string | null
  unit_base_qty: number
  quantity: number
  unit_price_minor: number
  amount_minor: number
  qty_base: number
}

/** Posts a sales invoice with its stock movements, ledger entries and counter payment, all or nothing. */
export function createInvoice(db: Db, input: unknown, now: Date): InvoiceSaveResult {
  const invoice = parseInput(InvoiceCreateSchema, input)
  return inventoryTransaction(db, () => {
    const saved = db.get<{ id: number }>('SELECT id FROM invoices WHERE request_id = ?', [
      invoice.requestId
    ])
    if (saved !== undefined) return saveResult(db, saved.id, true)

    const settings = readSettings(db)
    assertCurrencyDigits(db, invoice.currencyMinorDigits)
    const customer = invoiceCustomer(db, invoice.customerId)
    const resolved = resolveLines(db, invoice)
    const productIds = unique(invoice.lines.map((line) => line.productId))
    assertInvoiceDate(db, {
      date: invoice.invoiceDate,
      today: localDateString(now),
      customer,
      productIds
    })
    assertPrices(invoice, resolved, settings)

    const previousBalanceMinor = customerBalance(db, customer.id)
    const totals = invoiceTotals(invoice, resolved, previousBalanceMinor)
    assertWalkInPaidInFull(customer, totals)
    const lines = resolved.map((line, index) => ({ ...line, totals: totals.lines[index] }))
    assertStockAvailable(db, lines)
    const costs = saleCosts(db, lines)
    const { seqNo, invoiceNo } = allocateInvoiceNumber(db, settings)

    const id = Number(
      db.run(
        `INSERT INTO invoices (invoice_no, seq_no, request_id, invoice_code, invoice_date, customer_id, cust_name,
           cust_shop_name, cust_phone, cust_address, cust_city, bilty_no, transport_name, adda_name, price_tier,
           gross_minor, line_discount_minor, line_scheme_minor, extra_discount_minor, net_minor, freight_minor,
           total_minor, received_minor, previous_balance_minor, net_outstanding_minor, cogs_minor, checked_by, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceNo,
          seqNo,
          invoice.requestId,
          invoice.invoiceCode,
          invoice.invoiceDate,
          customer.id,
          customer.name,
          customer.shop_name,
          customer.phone,
          customer.address,
          customer.city,
          invoice.biltyNo,
          invoice.transportName,
          invoice.addaName,
          invoice.priceTier,
          totals.grossMinor,
          totals.lineDiscountMinor,
          totals.lineSchemeMinor,
          totals.extraDiscountMinor,
          totals.netMinor,
          totals.freightMinor,
          totals.totalMinor,
          totals.receivedMinor,
          totals.previousBalanceMinor,
          totals.netOutstandingMinor,
          sumMinor(costs),
          invoice.checkedBy,
          invoice.notes
        ]
      ).lastInsertRowid
    )
    lines.forEach((line, index) =>
      insertLine(db, id, index, line, costs[index], invoice.invoiceDate)
    )

    if (totals.totalMinor > 0) {
      appendLedgerEntry(db, {
        customerId: customer.id,
        date: invoice.invoiceDate,
        type: 'INVOICE',
        amountMinor: totals.totalMinor,
        invoiceId: id
      })
    }
    if (totals.receivedMinor > 0) {
      insertPayment(db, {
        requestId: `${PAYMENT_REQUEST_PREFIX}${invoice.requestId}`,
        customerId: customer.id,
        paymentDate: invoice.invoiceDate,
        amountMinor: totals.receivedMinor,
        method: invoice.paymentMethod!,
        reference: invoice.paymentReference,
        note: null,
        invoiceId: id
      })
    }

    assertStockInvariants(db, productIds)
    if (customerBalance(db, customer.id) !== totals.netOutstandingMinor) {
      throw new Error('The customer balance after the invoice does not match the invoice totals.')
    }
    return saveResult(db, id, false)
  })
}

/** One invoice as saved. */
export function getInvoice(db: Db, id: unknown): InvoiceDetail {
  return readInvoice(db, parseInput(InvoiceIdSchema, id))
}

/** Invoice History: newest first, filtered by search words, date range and status. */
export function listInvoices(db: Db, input: unknown): ListPage<InvoiceSummary> {
  const filters = parseInput(InvoiceListInputSchema, input)
  const { page, pageSize } = filters
  const clauses: string[] = []
  const params: SqlValue[] = []
  const words = filters.search
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, MAX_SEARCH_WORDS)
  // The saved names: an invoice is found by the name it was made out to (and by the customer code, which never changes).
  const columns = ['i.invoice_no', 'c.code', 'i.cust_name', 'i.cust_shop_name']
  for (const word of words) {
    const pattern = `%${word.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
    clauses.push(`(${columns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
    params.push(...columns.map(() => pattern))
  }
  if (filters.status !== 'all') {
    clauses.push('i.status = ?')
    params.push(filters.status)
  }
  if (filters.dateFrom !== null) {
    clauses.push('i.invoice_date >= ?')
    params.push(filters.dateFrom)
  }
  if (filters.dateTo !== null) {
    clauses.push('i.invoice_date <= ?')
    params.push(filters.dateTo)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const from = 'FROM invoices AS i JOIN customers AS c ON c.id = i.customer_id'
  const total = db.get<{ n: number }>(`SELECT count(*) AS n ${from} ${where}`, params)!.n
  const rows = db.all<{
    id: number
    invoice_no: string
    invoice_date: string
    customer_id: number
    customer_code: string
    cust_name: string
    cust_shop_name: string | null
    total_minor: number
    received_minor: number
    net_outstanding_minor: number
    status: InvoiceStatus
  }>(
    `SELECT i.id, i.invoice_no, i.invoice_date, i.customer_id, c.code AS customer_code, i.cust_name, i.cust_shop_name,
            i.total_minor, i.received_minor, i.net_outstanding_minor, i.status
     ${from} ${where}
     ORDER BY i.invoice_date DESC, i.seq_no DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  )
  return {
    items: rows.map((row) => ({
      id: row.id,
      invoiceNo: row.invoice_no,
      invoiceDate: row.invoice_date,
      customerId: row.customer_id,
      customerCode: row.customer_code,
      customerName: row.cust_name,
      customerShopName: row.cust_shop_name,
      totalMinor: row.total_minor,
      receivedMinor: row.received_minor,
      netOutstandingMinor: row.net_outstanding_minor,
      status: row.status
    })),
    total,
    page,
    pageSize
  }
}

/**
 * Sets a posted invoice's dispatch details (Bilty No, Transport, Adda), the only fields that change after saving. Each
 * field that really changes gets one invoice_change_log row with its old and new value and the note; when nothing
 * changes, nothing is written. A void invoice keeps its details.
 */
export function updateInvoiceDispatch(db: Db, input: unknown, now: Date): InvoiceDispatchResult {
  const update = parseInput(InvoiceDispatchUpdateSchema, input)
  return db.transaction(() => {
    const row = db.get<Pick<InvoiceRow, 'invoice_no' | 'status' | InvoiceDispatchField>>(
      'SELECT invoice_no, status, bilty_no, transport_name, adda_name FROM invoices WHERE id = ?',
      [update.id]
    )
    if (row === undefined) throw invoiceNotFound()
    if (row.status === 'VOID') {
      throw new AppFailure({
        code: 'FORBIDDEN_STATE',
        message: `Invoice ${row.invoice_no} is void, so its dispatch details can no longer be changed.`
      })
    }
    const changedFields = INVOICE_DISPATCH_FIELDS.filter(
      (field) => row[field] !== update[DISPATCH_INPUT_KEYS[field]]
    )
    if (changedFields.length > 0) {
      const changedAt = now.toISOString()
      db.run(
        `UPDATE invoices SET bilty_no = ?, transport_name = ?, adda_name = ?, dispatch_updated_at = ?
         WHERE id = ?`,
        [update.biltyNo, update.transportName, update.addaName, changedAt, update.id]
      )
      for (const field of changedFields) {
        db.run(
          `INSERT INTO invoice_change_log (invoice_id, field, old_value, new_value, changed_at, note)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [update.id, field, row[field], update[DISPATCH_INPUT_KEYS[field]], changedAt, update.note]
        )
      }
    }
    return { ...readInvoice(db, update.id), changedFields }
  })
}

/**
 * What the billing screen shows before posting: today, the number the next invoice would get (nothing is reserved), and
 * the earliest date the chosen customer and products allow, with whose activity sets it.
 */
export function invoiceContext(db: Db, input: unknown, now: Date): InvoiceContext {
  const { customerId, productIds } = parseInput(InvoiceContextInputSchema, input)
  const customer = customerId === null ? null : customerRow(db, customerId)
  const customerFloor = customer === null ? null : latestLedgerDate(db, customer.id)
  const productFloor = latestMovement(db, productIds)
  let floor: Pick<InvoiceContext, 'earliestDate' | 'earliestDateSetBy'> = {
    earliestDate: null,
    earliestDateSetBy: null
  }
  // The later floor wins, exactly as posting checks it.
  if (productFloor !== null && (customerFloor === null || productFloor.date > customerFloor)) {
    const product = db.get<{ id: number; code: string; name: string }>(
      'SELECT id, code, name FROM products WHERE id = ?',
      [productFloor.productId]
    )!
    floor = {
      earliestDate: productFloor.date,
      earliestDateSetBy: { kind: 'PRODUCT', id: product.id, code: product.code, name: product.name }
    }
  } else if (customer !== null && customerFloor !== null) {
    floor = {
      earliestDate: customerFloor,
      earliestDateSetBy: {
        kind: 'CUSTOMER',
        id: customer.id,
        code: customer.code,
        name: customer.name
      }
    }
  }
  const settings = readSettings(db)
  return {
    today: localDateString(now),
    nextInvoiceNo: formatInvoiceNumber(
      settings['invoice.prefix'],
      settings['invoice.padding'],
      nextInvoiceSequenceValue(db, settings)
    ),
    ...floor
  }
}

// --- Checks --------------------------------------------------------------------------------------------------------

/** The walk-in customer buys only for cash: exactly the total is received, so its balance stays settled. */
function assertWalkInPaidInFull(customer: CustomerRow, totals: InvoiceTotals): void {
  if (!isWalkInCustomer(customer.code) || totals.receivedMinor === totals.totalMinor) return
  throw new AppFailure({
    code: 'VALIDATION',
    message: WALK_IN_FULL_PAYMENT_MESSAGE,
    fieldErrors: { receivedMinor: [WALK_IN_FULL_PAYMENT_MESSAGE] },
    details: {
      rule: WALK_IN_FULL_PAYMENT_RULE,
      totalMinor: totals.totalMinor,
      receivedMinor: totals.receivedMinor
    }
  })
}

function invoiceCustomer(db: Db, customerId: number): CustomerRow {
  const customer = customerRow(db, customerId, 'customerId')
  if (customer.is_active === 0) {
    throw new AppFailure({
      code: 'FORBIDDEN_STATE',
      message: `${customer.code} ${customer.name} is inactive. Reactivate the customer to make an invoice.`,
      fieldErrors: { customerId: ['This customer is inactive.'] }
    })
  }
  return customer
}

/** Every line's product and units from the database, or VALIDATION with the problem of every line. */
function resolveLines(db: Db, invoice: InvoiceCreateInput): ResolvedLine[] {
  const productIds = unique(invoice.lines.map((line) => line.productId))
  const unitIds = unique(
    invoice.lines.flatMap((line) => [
      ...line.quantities.map((row) => row.unitId),
      ...line.freeQuantities.map((row) => row.unitId)
    ])
  )
  const products = new Map(
    db
      .all<ProductRow>(
        `SELECT p.id, p.code, p.name, p.packing_label, p.is_active, c.name AS company_name
         FROM products AS p LEFT JOIN companies AS c ON c.id = p.company_id
         WHERE p.id IN (${placeholders(productIds)})`,
        productIds
      )
      .map((row) => [row.id, row])
  )
  const units = new Map(
    db
      .all<UnitRow>(
        `SELECT id, product_id, name, short_name, base_qty, can_sell, is_active, retail_price_minor, wholesale_price_minor
         FROM product_units WHERE id IN (${placeholders(unitIds)})`,
        unitIds
      )
      .map((row) => [row.id, row])
  )

  const fieldErrors: Record<string, string[]> = {}
  const lines = invoice.lines.map((line, index): ResolvedLine => {
    const product = products.get(line.productId)
    if (product === undefined) {
      fieldErrors[`lines.${index}.productId`] = ['This product no longer exists.']
    } else if (product.is_active === 0) {
      fieldErrors[`lines.${index}.productId`] = [`${product.code} ${product.name} is inactive.`]
    }
    const saleUnit = (unitId: number, path: string): UnitRow => {
      const row = units.get(unitId)
      if (product === undefined || product.is_active === 0) return row!
      if (row === undefined || row.product_id !== product.id) {
        fieldErrors[path] = ['This unit does not belong to the product.']
      } else if (row.is_active === 0) {
        fieldErrors[path] = [`${row.name} is inactive.`]
      } else if (row.can_sell === 0) {
        fieldErrors[path] = [`${row.name} cannot be sold. Choose a unit that can be sold.`]
      }
      return row!
    }
    return {
      input: line,
      product: product!,
      units: line.quantities.map((row, rowIndex) =>
        saleUnit(row.unitId, `lines.${index}.quantities.${rowIndex}.unitId`)
      ),
      freeUnits: line.freeQuantities.map((row, rowIndex) =>
        saleUnit(row.unitId, `lines.${index}.freeQuantities.${rowIndex}.unitId`)
      )
    }
  })
  if (Object.keys(fieldErrors).length > 0) {
    throw new AppFailure({
      code: 'VALIDATION',
      message: 'Check the highlighted lines.',
      fieldErrors
    })
  }
  return lines
}

interface InvoiceDateCheck {
  readonly date: string
  readonly today: string
  readonly customer: CustomerRow
  readonly productIds: readonly number[]
}

/**
 * An invoice changes a customer balance and stock, so its date must satisfy both posting floors (plan §11.5): the
 * customer's latest ledger entry and the latest movement of every product on it. When both block, the later floor is
 * named, because that is the date the operator needs.
 */
function assertInvoiceDate(db: Db, check: InvoiceDateCheck): void {
  const { date, today, customer, productIds } = check
  const customerFloor = latestLedgerDate(db, customer.id)
  const productFloor = latestMovement(db, productIds)
  const assertCustomer = (): void =>
    assertCustomerPostingDate(db, { date, today, customer, field: 'invoiceDate' })
  const assertProducts = (): void =>
    assertPostingDate(db, { date, today, productIds, field: 'invoiceDate' })
  if (productFloor !== null && (customerFloor === null || productFloor.date > customerFloor)) {
    assertProducts()
    assertCustomer()
  } else {
    assertCustomer()
    assertProducts()
  }
}

/**
 * The price of each quantity row: an override is taken as entered; otherwise it must be the unit's configured price for
 * the invoice's tier. A unit without a price for the tier needs an override (VALIDATION); a price that is no longer the
 * configured one is refused with PRICE_CHANGED, so nothing is saved at a price the operator did not see.
 */
function assertPrices(
  invoice: InvoiceCreateInput,
  lines: readonly ResolvedLine[],
  settings: Settings
): void {
  const tier = PRICE_TIER_LABELS[invoice.priceTier].toLowerCase()
  const money = (amount: number): string =>
    formatMoney(amount, {
      minorDigits: settings['currency.minorDigits'],
      prefix: `${settings['currency.symbol']} `
    })
  const missing: Record<string, string[]> = {}
  const changed: Record<string, string[]> = {}
  const prices: Array<Record<string, number>> = []
  const messages: string[] = []
  lines.forEach((line, lineIndex) => {
    line.input.quantities.forEach((row, quantityIndex) => {
      if (row.priceOverride) return
      const unit = line.units[quantityIndex]
      const configured =
        invoice.priceTier === 'RETAIL' ? unit.retail_price_minor : unit.wholesale_price_minor
      const path = `lines.${lineIndex}.quantities.${quantityIndex}.unitPriceMinor`
      const product = `${line.product.code} ${line.product.name}`
      if (configured === null) {
        missing[path] = [
          `${unit.name} of ${product} has no ${tier} price. Enter the price for this sale.`
        ]
      } else if (configured !== row.unitPriceMinor) {
        changed[path] = [`The ${tier} price is ${money(configured)}.`]
        messages.push(
          `The ${tier} price of ${unit.name} for ${product} is ${money(configured)}, not ${money(row.unitPriceMinor)}. Check the price and save again.`
        )
        prices.push({
          lineIndex,
          quantityIndex,
          productId: line.product.id,
          unitId: unit.id,
          enteredPriceMinor: row.unitPriceMinor,
          configuredPriceMinor: configured
        })
      }
    })
  })
  if (Object.keys(missing).length > 0) {
    throw new AppFailure({
      code: 'VALIDATION',
      message: 'Check the highlighted fields.',
      fieldErrors: missing
    })
  }
  if (prices.length > 0) {
    throw new AppFailure({
      code: 'PRICE_CHANGED',
      message:
        messages.length === 1
          ? messages[0]
          : 'Some prices are no longer the configured prices. Check the highlighted prices and save again.',
      fieldErrors: changed,
      details: { prices }
    })
  }
}

/** The authoritative totals, from database unit sizes and the accepted prices; VALIDATION when impossible. */
function invoiceTotals(
  invoice: InvoiceCreateInput,
  lines: readonly ResolvedLine[],
  previousBalanceMinor: number
): InvoiceTotals {
  const result = calculateInvoiceTotals({
    lines: lines.map((line) => ({
      quantities: line.input.quantities.map((row, index) => ({
        quantity: row.quantity,
        unitBaseQty: line.units[index].base_qty,
        unitPriceMinor: row.unitPriceMinor
      })),
      freeQuantities: line.input.freeQuantities.map((row, index) => ({
        quantity: row.quantity,
        unitBaseQty: line.freeUnits[index].base_qty
      })),
      discount: line.input.discount,
      schemeMinor: line.input.schemeMinor
    })),
    extraDiscountMinor: invoice.extraDiscountMinor,
    freightMinor: invoice.freightMinor,
    receivedMinor: invoice.receivedMinor,
    previousBalanceMinor
  })
  if (!result.ok) {
    const fieldErrors: Record<string, string[]> = {}
    for (const issue of result.issues) (fieldErrors[issue.path] ??= []).push(issue.message)
    throw new AppFailure({
      code: 'VALIDATION',
      message: 'Check the highlighted fields.',
      fieldErrors
    })
  }
  return result.totals
}

/** Every product must have in stock what its line takes out: paid plus free quantity. */
function assertStockAvailable(db: Db, lines: readonly PricedLine[]): void {
  const positions = stockPositions(
    db,
    lines.map((line) => line.product.id)
  )
  const requested = new Map<number, number>()
  for (const line of lines) {
    requested.set(line.product.id, (requested.get(line.product.id) ?? 0) + line.totals.qtyBase)
  }
  const shortages = lines
    .map((line, lineIndex) => ({
      lineIndex,
      productId: line.product.id,
      productCode: line.product.code,
      productName: line.product.name,
      availableQtyBase: positions.get(line.product.id)!.qtyBase,
      requestedQtyBase: requested.get(line.product.id)!
    }))
    .filter((shortage) => shortage.requestedQtyBase > shortage.availableQtyBase)
  if (shortages.length === 0) return

  const available = (shortage: (typeof shortages)[number]): string =>
    quantityText(db, shortage.productId, Math.max(shortage.availableQtyBase, 0))
  const fieldErrors = Object.fromEntries(
    shortages.map((shortage) => [
      `lines.${shortage.lineIndex}.quantities`,
      [`Only ${available(shortage)} in stock.`]
    ])
  )
  const [first] = shortages
  const products = unique(shortages.map((shortage) => shortage.productId)).length
  throw new AppFailure({
    code: 'INSUFFICIENT_STOCK',
    message:
      products === 1
        ? `Not enough stock of ${first.productCode} ${first.productName}: ${available(first)} in stock, ${quantityText(db, first.productId, first.requestedQtyBase)} needed.`
        : `Not enough stock for ${products} products. Check the highlighted lines.`,
    fieldErrors,
    details: { shortages }
  })
}

/**
 * The frozen cost of each line: the moving weighted average of a transaction-local running position per product, so
 * lines are costed in order and the last units take exactly the value left.
 */
function saleCosts(db: Db, lines: readonly PricedLine[]): number[] {
  const positions = stockPositions(
    db,
    lines.map((line) => line.product.id)
  )
  return lines.map((line) => {
    const { outValueMinor, remaining } = applyOutflow(
      positions.get(line.product.id)!,
      line.totals.qtyBase
    )
    positions.set(line.product.id, remaining)
    return outValueMinor
  })
}

/**
 * The next invoice number: the `invoice` sequence with the invoice prefix and padding settings. invoice.startNumber
 * applies only while no invoice number has ever been used. Taken inside the transaction, so a rollback returns it.
 */
function allocateInvoiceNumber(db: Db, settings: Settings): { seqNo: number; invoiceNo: string } {
  const startNumber = settings['invoice.startNumber']
  if (startNumber > 1) {
    db.run(
      `UPDATE sequences SET next_value = ?
       WHERE name = 'invoice' AND next_value = 1 AND NOT EXISTS (SELECT 1 FROM invoices)`,
      [startNumber]
    )
  }
  const seqNo = takeSequenceValue(db, 'invoice')
  const invoiceNo = formatInvoiceNumber(
    settings['invoice.prefix'],
    settings['invoice.padding'],
    seqNo
  )
  const taken = db.get('SELECT 1 AS found FROM invoices WHERE invoice_no = ? OR seq_no = ?', [
    invoiceNo,
    seqNo
  ])
  if (taken !== undefined) {
    throw new AppFailure({
      code: 'CONFLICT',
      message: `The next invoice number, ${invoiceNo}, is already used, so the invoice was not saved.`
    })
  }
  return { seqNo, invoiceNo }
}

/** The sequence value the next invoice takes: invoice.startNumber while no invoice number has been used yet. */
function nextInvoiceSequenceValue(db: Db, settings: Settings): number {
  const row = db.get<{ next_value: number; used: number }>(
    `SELECT next_value, EXISTS (SELECT 1 FROM invoices) AS used FROM sequences WHERE name = 'invoice'`
  )
  if (row === undefined) throw new Error('The invoice sequence is missing.')
  const startNumber = settings['invoice.startNumber']
  return row.next_value === 1 && row.used === 0 && startNumber > 1 ? startNumber : row.next_value
}

// --- Writes --------------------------------------------------------------------------------------------------------

function insertLine(
  db: Db,
  invoiceId: number,
  index: number,
  line: PricedLine,
  costMinor: number,
  date: string
): void {
  const { input, product, units, totals } = line
  const itemId = Number(
    db.run(
      `INSERT INTO invoice_items (invoice_id, line_no, product_id, prod_code, prod_name, company_name, packing_label,
         qty_base, scheme_qty_base, gross_minor, discount_bps, discount_minor, scheme_minor, ctn_count, net_minor,
         cost_minor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceId,
        index + 1,
        product.id,
        product.code,
        product.name,
        product.company_name,
        product.packing_label,
        totals.qtyBase,
        totals.schemeQtyBase,
        totals.grossMinor,
        totals.discountBps,
        totals.discountMinor,
        totals.schemeMinor,
        input.ctnCount,
        totals.netMinor,
        costMinor
      ]
    ).lastInsertRowid
  )
  totals.quantities.forEach((row, rowIndex) => {
    const unit = units[rowIndex]
    db.run(
      `INSERT INTO invoice_item_quantities (invoice_item_id, unit_id, unit_name, unit_short_name, unit_base_qty,
         quantity, unit_price_minor, amount_minor, qty_base)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        itemId,
        unit.id,
        unit.name,
        unit.short_name,
        unit.base_qty,
        row.quantity,
        row.unitPriceMinor,
        row.amountMinor,
        row.qtyBase
      ]
    )
  })
  db.run(
    `INSERT INTO stock_movements (product_id, movement_date, type, qty_base, value_minor, invoice_item_id)
     VALUES (?, ?, 'SALE', ?, ?, ?)`,
    [product.id, date, -totals.qtyBase, costMinor === 0 ? 0 : -costMinor, itemId]
  )
}

// --- Reads ---------------------------------------------------------------------------------------------------------

function saveResult(db: Db, id: number, replayed: boolean): InvoiceSaveResult {
  const invoice = readInvoice(db, id)
  return { ...invoice, balanceAfterMinor: customerBalance(db, invoice.customerId), replayed }
}

/** An invoice exactly as saved, with its counter payment's current status and its dispatch change log. */
export function readInvoice(db: Db, id: number): InvoiceDetail {
  const row = db.get<InvoiceRow>(
    `SELECT i.id, i.invoice_no, i.invoice_date, i.invoice_code, i.status, i.customer_id, c.code AS customer_code,
            i.cust_name, i.cust_shop_name, i.cust_phone, i.cust_address, i.cust_city, i.price_tier, i.gross_minor,
            i.line_discount_minor, i.line_scheme_minor, i.extra_discount_minor, i.net_minor, i.freight_minor,
            i.total_minor, i.received_minor, i.previous_balance_minor, i.net_outstanding_minor, i.cogs_minor,
            i.bilty_no, i.transport_name, i.adda_name, i.checked_by, i.notes, i.dispatch_updated_at, i.void_reason,
            i.void_date, i.voided_at, i.created_at
     FROM invoices AS i JOIN customers AS c ON c.id = i.customer_id
     WHERE i.id = ?`,
    [id]
  )
  if (row === undefined) throw invoiceNotFound()
  const items = db.all<ItemRow>(
    `SELECT id, line_no, product_id, prod_code, prod_name, company_name, packing_label, qty_base, scheme_qty_base,
            gross_minor, discount_bps, discount_minor, scheme_minor, ctn_count, net_minor, cost_minor
     FROM invoice_items WHERE invoice_id = ? ORDER BY line_no`,
    [id]
  )
  const quantities = db.all<QuantityRow>(
    `SELECT q.id, q.invoice_item_id, q.unit_id, q.unit_name, q.unit_short_name, q.unit_base_qty, q.quantity,
            q.unit_price_minor, q.amount_minor, q.qty_base
     FROM invoice_item_quantities AS q JOIN invoice_items AS ii ON ii.id = q.invoice_item_id
     WHERE ii.invoice_id = ? ORDER BY q.id`,
    [id]
  )
  const payment = db.get<{
    id: number
    payment_no: string
    payment_date: string
    amount_minor: number
    method: PaymentMethod
    reference: string | null
    status: PaymentStatus
  }>(
    `SELECT id, payment_no, payment_date, amount_minor, method, reference, status FROM payments
     WHERE invoice_id = ? ORDER BY id LIMIT 1`,
    [id]
  )
  const changes = db.all<{
    id: number
    field: string
    old_value: string | null
    new_value: string | null
    changed_at: string
    note: string | null
  }>(
    `SELECT id, field, old_value, new_value, changed_at, note FROM invoice_change_log
     WHERE invoice_id = ? ORDER BY id`,
    [id]
  )
  return {
    id: row.id,
    invoiceNo: row.invoice_no,
    invoiceDate: row.invoice_date,
    invoiceCode: row.invoice_code,
    status: row.status,
    customerId: row.customer_id,
    customerCode: row.customer_code,
    customerName: row.cust_name,
    customerShopName: row.cust_shop_name,
    customerPhone: row.cust_phone,
    customerAddress: row.cust_address,
    customerCity: row.cust_city,
    priceTier: row.price_tier,
    grossMinor: row.gross_minor,
    lineDiscountMinor: row.line_discount_minor,
    lineSchemeMinor: row.line_scheme_minor,
    extraDiscountMinor: row.extra_discount_minor,
    netMinor: row.net_minor,
    freightMinor: row.freight_minor,
    totalMinor: row.total_minor,
    receivedMinor: row.received_minor,
    previousBalanceMinor: row.previous_balance_minor,
    netOutstandingMinor: row.net_outstanding_minor,
    cogsMinor: row.cogs_minor,
    biltyNo: row.bilty_no,
    transportName: row.transport_name,
    addaName: row.adda_name,
    checkedBy: row.checked_by,
    notes: row.notes,
    dispatchUpdatedAt: row.dispatch_updated_at,
    payment:
      payment === undefined
        ? null
        : ({
            id: payment.id,
            paymentNo: payment.payment_no,
            paymentDate: payment.payment_date,
            amountMinor: payment.amount_minor,
            method: payment.method,
            reference: payment.reference,
            status: payment.status
          } satisfies InvoicePayment),
    lines: items.map((item): InvoiceLine => ({
      id: item.id,
      lineNo: item.line_no,
      productId: item.product_id,
      productCode: item.prod_code,
      productName: item.prod_name,
      companyName: item.company_name,
      packingLabel: item.packing_label,
      qtyBase: item.qty_base,
      schemeQtyBase: item.scheme_qty_base,
      grossMinor: item.gross_minor,
      discountBps: item.discount_bps,
      discountMinor: item.discount_minor,
      schemeMinor: item.scheme_minor,
      ctnCount: item.ctn_count,
      netMinor: item.net_minor,
      costMinor: item.cost_minor,
      quantities: quantities
        .filter((quantity) => quantity.invoice_item_id === item.id)
        .map((quantity): InvoiceQuantity => ({
          id: quantity.id,
          unitId: quantity.unit_id,
          unitName: quantity.unit_name,
          unitShortName: quantity.unit_short_name,
          unitBaseQty: quantity.unit_base_qty,
          quantity: quantity.quantity,
          unitPriceMinor: quantity.unit_price_minor,
          amountMinor: quantity.amount_minor,
          qtyBase: quantity.qty_base
        }))
    })),
    changes: changes.map((change): InvoiceChange => ({
      id: change.id,
      field: change.field,
      oldValue: change.old_value,
      newValue: change.new_value,
      changedAt: change.changed_at,
      note: change.note
    })),
    voidReason: row.void_reason,
    voidDate: row.void_date,
    voidedAt: row.voided_at,
    createdAt: row.created_at
  }
}

export function invoiceNotFound(): AppFailure {
  return new AppFailure({ code: 'NOT_FOUND', message: 'This invoice no longer exists.' })
}
