import type { Migration } from '../migrate'

/*
 * 0001_initial: the StockFlow V1 schema (plan §7, with the approved Phase 3B business defaults).
 *
 * FROZEN once shipped. Never edit this file after a database has recorded it: add 0002_… instead. Its checksum
 * (SHA-256 of INITIAL_SCHEMA_SQL) is pinned below and stored in schema_migrations, and a test fails if the SQL
 * changes. The helpers below only build the SQL text; the checksum covers the text they produce.
 *
 * Conventions (plan §7.1):
 * - Every table is STRICT. Money is INTEGER minor units (`_minor`), percentages INTEGER basis points (`_bps`),
 *   stock INTEGER base units (`qty_base`). Nothing is REAL.
 * - Business dates are TEXT 'YYYY-MM-DD'. Timestamps are TEXT ISO-8601 UTC, exactly as Date.toISOString() writes
 *   them ('YYYY-MM-DDTHH:MM:SS.sssZ').
 * - Every foreign key is ON DELETE RESTRICT: history is never cascade-deleted.
 * - Stock and customer balances are never stored. They are sums over the append-only ledgers
 *   (v_product_stock, v_customer_balance).
 * - packing_label, invoice_code, ctn_count and the dispatch fields are display/print values only: no constraint
 *   or calculation reads them.
 *
 * Rules deliberately left to the services: unit nesting (divisibility) and unit locking after stock activity; that
 * an invoice quantity row's unit belongs to its line's product; header totals = Σ lines; negative-stock
 * prevention; posting-date floors; sequence allocation; and which fields the invoice change log may record.
 */

/** The current UTC time in the Date.toISOString() format. */
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

/** A calendar date: the YYYY-MM-DD shape, and SQLite reads it back unchanged (so 2026-02-30 is refused). */
function date(column: string): string {
  return `CHECK (${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(${column}) IS ${column})`
}

/** A UTC timestamp in exactly the Date.toISOString() format, and a real point in time. */
function timestamp(column: string): string {
  const shape =
    "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'"
  return `CHECK (${column} GLOB ${shape} AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS ${column})`
}

function flag(column: string, initial: 0 | 1): string {
  return `${column} INTEGER NOT NULL DEFAULT ${initial} CHECK (${column} IN (0, 1))`
}

function notBlank(column: string): string {
  return `CHECK (trim(${column}) <> '')`
}

const createdAt = `created_at TEXT NOT NULL DEFAULT (${NOW}) ${timestamp('created_at')}`
const updatedAt = `updated_at TEXT NOT NULL DEFAULT (${NOW}) ${timestamp('updated_at')}`

/** Refuses every UPDATE and DELETE on `table`. */
function appendOnly(table: string): string {
  return `
CREATE TRIGGER trg_${table}_no_update BEFORE UPDATE ON ${table}
BEGIN
  SELECT RAISE(ABORT, '${table} is append-only: its rows cannot be changed');
END;

CREATE TRIGGER trg_${table}_no_delete BEFORE DELETE ON ${table}
BEGIN
  SELECT RAISE(ABORT, '${table} is append-only: its rows cannot be deleted');
END;
`
}

/** True when any of `columns` changes. Compared exactly (BINARY), so a change of letter case counts. */
function anyChanged(columns: readonly string[]): string {
  return columns
    .map((column) => `NEW.${column} IS NOT OLD.${column} COLLATE BINARY`)
    .join('\n    OR ')
}

/**
 * A saved document: its protected columns never change, and its void columns change only on POSTED → VOID (the
 * table's CHECK then requires the void details). Every other change is refused, and so is DELETE.
 */
function savedDocument(
  table: string,
  protectedColumns: readonly string[],
  voidColumns: readonly string[],
  message: string
): string {
  return `
CREATE TRIGGER trg_${table}_guard_update BEFORE UPDATE ON ${table}
WHEN ${anyChanged(protectedColumns)}
    OR ((${anyChanged(voidColumns)}) AND NOT (OLD.status = 'POSTED' AND NEW.status = 'VOID'))
BEGIN
  SELECT RAISE(ABORT, '${message}');
END;

CREATE TRIGGER trg_${table}_no_delete BEFORE DELETE ON ${table}
BEGIN
  SELECT RAISE(ABORT, '${table} rows are never deleted: void the document instead');
END;
`
}

export const INITIAL_SCHEMA_SQL = `
-- Master data -----------------------------------------------------------------------------------------------

CREATE TABLE companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE ${notBlank('name')},
  ${flag('is_active', 1)},
  ${createdAt},
  ${updatedAt},
  UNIQUE (name)
) STRICT;

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL COLLATE NOCASE ${notBlank('code')},
  name TEXT NOT NULL COLLATE NOCASE ${notBlank('name')},
  company_id INTEGER REFERENCES companies (id) ON DELETE RESTRICT,
  -- The packing text exactly as written (e.g. 1*12*18): display and print only, never parsed or calculated with.
  packing_label TEXT,
  low_stock_threshold_base INTEGER NOT NULL DEFAULT 0 CHECK (low_stock_threshold_base >= 0),
  ${flag('is_active', 1)},
  ${createdAt},
  ${updatedAt},
  UNIQUE (code)
) STRICT;

CREATE INDEX idx_products_name ON products (name);
CREATE INDEX idx_products_company ON products (company_id);
CREATE INDEX idx_products_active ON products (is_active);

-- The units a product is counted, bought and sold in. Stock is an integer count of the base unit, and base_qty
-- is how many base units one unit holds. Unit names are data.
CREATE TABLE product_units (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  name TEXT NOT NULL COLLATE NOCASE ${notBlank('name')},
  short_name TEXT,
  base_qty INTEGER NOT NULL CHECK (base_qty > 0),
  ${flag('is_base', 0)},
  ${flag('can_sell', 1)},
  ${flag('can_purchase', 1)},
  -- NULL: the unit is not sold at that price tier.
  wholesale_price_minor INTEGER CHECK (wholesale_price_minor >= 0),
  retail_price_minor INTEGER CHECK (retail_price_minor >= 0),
  -- Stock-In form pre-fill only; never used for profit.
  default_cost_minor INTEGER CHECK (default_cost_minor >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  ${flag('is_active', 1)},
  ${createdAt},
  ${updatedAt},
  CHECK (is_base = 0 OR base_qty = 1),
  UNIQUE (product_id, name),
  UNIQUE (product_id, base_qty),
  -- Lets stock documents require that their unit belongs to their product.
  UNIQUE (id, product_id)
) STRICT;

CREATE UNIQUE INDEX ux_product_units_one_base ON product_units (product_id) WHERE is_base = 1;

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL COLLATE NOCASE ${notBlank('code')},
  name TEXT NOT NULL COLLATE NOCASE ${notBlank('name')},
  shop_name TEXT COLLATE NOCASE,
  phone TEXT,
  address TEXT,
  city TEXT COLLATE NOCASE,
  notes TEXT,
  ${flag('is_active', 1)},
  ${createdAt},
  ${updatedAt},
  UNIQUE (code)
) STRICT;

CREATE INDEX idx_customers_name ON customers (name);
CREATE INDEX idx_customers_shop_name ON customers (shop_name);
CREATE INDEX idx_customers_phone ON customers (phone);
CREATE INDEX idx_customers_city ON customers (city);

-- Invoices --------------------------------------------------------------------------------------------------

-- The bill as saved. Customer details are copied, so later changes to the customer never alter an old invoice.
CREATE TABLE invoices (
  id INTEGER PRIMARY KEY,
  invoice_no TEXT NOT NULL COLLATE NOCASE ${notBlank('invoice_no')},
  seq_no INTEGER NOT NULL CHECK (seq_no > 0),
  request_id TEXT NOT NULL ${notBlank('request_id')},
  -- The printed "Invoice Code" (B1). Its meaning is unconfirmed: an optional literal value, derived from nothing.
  invoice_code TEXT,
  invoice_date TEXT NOT NULL ${date('invoice_date')},
  customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  cust_name TEXT NOT NULL,
  cust_shop_name TEXT,
  cust_phone TEXT,
  cust_address TEXT,
  cust_city TEXT,
  -- Dispatch details (B4): no effect on stock, money or balances. The only fields that change after saving.
  bilty_no TEXT,
  transport_name TEXT,
  adda_name TEXT,
  dispatch_updated_at TEXT ${timestamp('dispatch_updated_at')},
  price_tier TEXT NOT NULL CHECK (price_tier IN ('RETAIL', 'WHOLESALE')),
  gross_minor INTEGER NOT NULL CHECK (gross_minor >= 0),
  line_discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (line_discount_minor >= 0),
  line_scheme_minor INTEGER NOT NULL DEFAULT 0 CHECK (line_scheme_minor >= 0),
  extra_discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (extra_discount_minor >= 0),
  -- The printed "Current Invoice" (B6).
  net_minor INTEGER NOT NULL CHECK (net_minor >= 0),
  freight_minor INTEGER NOT NULL DEFAULT 0 CHECK (freight_minor >= 0),
  -- What the invoice adds to the customer's balance.
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  received_minor INTEGER NOT NULL DEFAULT 0 CHECK (received_minor >= 0),
  -- Balances may be negative: the customer has an advance.
  previous_balance_minor INTEGER NOT NULL,
  net_outstanding_minor INTEGER NOT NULL,
  cogs_minor INTEGER NOT NULL CHECK (cogs_minor >= 0),
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),
  void_reason TEXT,
  voided_at TEXT ${timestamp('voided_at')},
  void_date TEXT ${date('void_date')},
  checked_by TEXT,
  notes TEXT,
  ${createdAt},
  CHECK (net_minor = gross_minor - line_discount_minor - line_scheme_minor - extra_discount_minor),
  CHECK (total_minor = net_minor + freight_minor),
  CHECK (net_outstanding_minor = previous_balance_minor + total_minor - received_minor),
  CHECK (
    (status = 'POSTED' AND void_reason IS NULL AND voided_at IS NULL AND void_date IS NULL)
    OR (status = 'VOID' AND trim(coalesce(void_reason, '')) <> '' AND voided_at IS NOT NULL AND void_date IS NOT NULL)
  ),
  UNIQUE (invoice_no),
  UNIQUE (seq_no),
  UNIQUE (request_id)
) STRICT;

CREATE INDEX idx_invoices_date ON invoices (invoice_date);
CREATE INDEX idx_invoices_customer_date ON invoices (customer_id, invoice_date);
CREATE INDEX idx_invoices_status_date ON invoices (status, invoice_date);
CREATE INDEX idx_invoices_invoice_code ON invoices (invoice_code);
CREATE INDEX idx_invoices_bilty_no ON invoices (bilty_no);

-- One row per product line. qty_base is the whole physical quantity leaving stock, free scheme goods included.
CREATE TABLE invoice_items (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices (id) ON DELETE RESTRICT,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  prod_code TEXT NOT NULL,
  prod_name TEXT NOT NULL,
  company_name TEXT,
  packing_label TEXT,
  qty_base INTEGER NOT NULL CHECK (qty_base > 0),
  -- Sch as free goods (B3): part of qty_base and cost_minor, no revenue.
  scheme_qty_base INTEGER NOT NULL DEFAULT 0 CHECK (scheme_qty_base >= 0),
  gross_minor INTEGER NOT NULL CHECK (gross_minor >= 0),
  -- The discount as entered: a percentage in basis points, or NULL for a fixed amount.
  discount_bps INTEGER CHECK (discount_bps BETWEEN 0 AND 10000),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  -- Sch as money (B3): deducted like a discount, no stock effect.
  scheme_minor INTEGER NOT NULL DEFAULT 0 CHECK (scheme_minor >= 0),
  -- The printed "Ctn" (B2): informational only, never used for stock.
  ctn_count INTEGER CHECK (ctn_count >= 0),
  net_minor INTEGER NOT NULL CHECK (net_minor >= 0),
  -- Cost of goods sold for qty_base, frozen when the invoice is saved.
  cost_minor INTEGER NOT NULL CHECK (cost_minor >= 0),
  CHECK (scheme_qty_base <= qty_base),
  CHECK (net_minor = gross_minor - discount_minor - scheme_minor),
  UNIQUE (invoice_id, line_no)
) STRICT;

CREATE INDEX idx_invoice_items_product ON invoice_items (product_id);

-- The quantities of a line, one row per unit (e.g. 2 Box + 5 Piece). The unit details are copied, so an old
-- invoice never depends on the current unit definitions or prices.
CREATE TABLE invoice_item_quantities (
  id INTEGER PRIMARY KEY,
  invoice_item_id INTEGER NOT NULL REFERENCES invoice_items (id) ON DELETE RESTRICT,
  unit_id INTEGER NOT NULL REFERENCES product_units (id) ON DELETE RESTRICT,
  unit_name TEXT NOT NULL,
  unit_short_name TEXT,
  unit_base_qty INTEGER NOT NULL CHECK (unit_base_qty > 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  qty_base INTEGER NOT NULL CHECK (qty_base > 0),
  CHECK (amount_minor = quantity * unit_price_minor),
  CHECK (qty_base = quantity * unit_base_qty),
  UNIQUE (invoice_item_id, unit_id)
) STRICT;

CREATE INDEX idx_invoice_item_quantities_unit ON invoice_item_quantities (unit_id);

-- Every change made to an invoice after it was saved (the dispatch details), old and new value.
CREATE TABLE invoice_change_log (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices (id) ON DELETE RESTRICT,
  field TEXT NOT NULL ${notBlank('field')},
  old_value TEXT,
  new_value TEXT,
  changed_at TEXT NOT NULL DEFAULT (${NOW}) ${timestamp('changed_at')},
  note TEXT
) STRICT;

CREATE INDEX idx_invoice_change_log_invoice ON invoice_change_log (invoice_id, id);

-- Customer money ------------------------------------------------------------------------------------------

-- Money received from customers. V1 keeps a running account: invoice_id is informational only.
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  payment_no TEXT NOT NULL COLLATE NOCASE ${notBlank('payment_no')},
  request_id TEXT NOT NULL ${notBlank('request_id')},
  customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  payment_date TEXT NOT NULL ${date('payment_date')},
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  method TEXT NOT NULL CHECK (method IN ('CASH', 'BANK', 'CHEQUE', 'OTHER')),
  reference TEXT,
  invoice_id INTEGER REFERENCES invoices (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),
  void_reason TEXT,
  voided_at TEXT ${timestamp('voided_at')},
  void_date TEXT ${date('void_date')},
  note TEXT,
  ${createdAt},
  CHECK (
    (status = 'POSTED' AND void_reason IS NULL AND voided_at IS NULL AND void_date IS NULL)
    OR (status = 'VOID' AND trim(coalesce(void_reason, '')) <> '' AND voided_at IS NOT NULL AND void_date IS NOT NULL)
  ),
  UNIQUE (payment_no),
  UNIQUE (request_id)
) STRICT;

CREATE INDEX idx_payments_customer_date ON payments (customer_id, payment_date);
CREATE INDEX idx_payments_date ON payments (payment_date);
CREATE INDEX idx_payments_invoice ON payments (invoice_id);

-- Append-only. A customer's balance is SUM(amount_minor); positive means the customer owes the shop.
CREATE TABLE customer_ledger (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  entry_date TEXT NOT NULL ${date('entry_date')},
  type TEXT NOT NULL CHECK (type IN ('OPENING', 'INVOICE', 'INVOICE_VOID', 'PAYMENT', 'PAYMENT_VOID', 'ADJUSTMENT')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
  invoice_id INTEGER REFERENCES invoices (id) ON DELETE RESTRICT,
  payment_id INTEGER REFERENCES payments (id) ON DELETE RESTRICT,
  note TEXT,
  ${createdAt},
  CHECK (CASE type
    WHEN 'INVOICE' THEN amount_minor > 0
    WHEN 'PAYMENT_VOID' THEN amount_minor > 0
    WHEN 'PAYMENT' THEN amount_minor < 0
    WHEN 'INVOICE_VOID' THEN amount_minor < 0
    ELSE 1
  END),
  CHECK (CASE type
    WHEN 'INVOICE' THEN invoice_id IS NOT NULL AND payment_id IS NULL
    WHEN 'INVOICE_VOID' THEN invoice_id IS NOT NULL AND payment_id IS NULL
    WHEN 'PAYMENT' THEN payment_id IS NOT NULL
    WHEN 'PAYMENT_VOID' THEN payment_id IS NOT NULL
    ELSE invoice_id IS NULL AND payment_id IS NULL
  END),
  CHECK (type <> 'ADJUSTMENT' OR trim(coalesce(note, '')) <> '')
) STRICT;

CREATE INDEX idx_customer_ledger_customer_date ON customer_ledger (customer_id, entry_date, id);
CREATE INDEX idx_customer_ledger_date ON customer_ledger (entry_date);
CREATE UNIQUE INDEX ux_customer_ledger_invoice ON customer_ledger (invoice_id, type)
  WHERE type IN ('INVOICE', 'INVOICE_VOID');
CREATE UNIQUE INDEX ux_customer_ledger_payment ON customer_ledger (payment_id, type)
  WHERE type IN ('PAYMENT', 'PAYMENT_VOID');
CREATE UNIQUE INDEX ux_customer_ledger_opening ON customer_ledger (customer_id) WHERE type = 'OPENING';

-- Stock -----------------------------------------------------------------------------------------------------

CREATE TABLE stock_receipts (
  id INTEGER PRIMARY KEY,
  receipt_no TEXT NOT NULL COLLATE NOCASE ${notBlank('receipt_no')},
  request_id TEXT NOT NULL ${notBlank('request_id')},
  receipt_date TEXT NOT NULL ${date('receipt_date')},
  -- Free text: V1 has no supplier accounts.
  supplier_name TEXT,
  reference TEXT,
  note TEXT,
  total_cost_minor INTEGER NOT NULL CHECK (total_cost_minor >= 0),
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),
  void_reason TEXT,
  void_date TEXT ${date('void_date')},
  ${createdAt},
  CHECK (
    (status = 'POSTED' AND void_reason IS NULL AND void_date IS NULL)
    OR (status = 'VOID' AND trim(coalesce(void_reason, '')) <> '' AND void_date IS NOT NULL)
  ),
  UNIQUE (receipt_no),
  UNIQUE (request_id)
) STRICT;

CREATE INDEX idx_stock_receipts_date ON stock_receipts (receipt_date);

-- One unit per line; the unit details are copied.
CREATE TABLE stock_receipt_items (
  id INTEGER PRIMARY KEY,
  receipt_id INTEGER NOT NULL REFERENCES stock_receipts (id) ON DELETE RESTRICT,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  unit_id INTEGER NOT NULL,
  unit_name TEXT NOT NULL,
  unit_base_qty INTEGER NOT NULL CHECK (unit_base_qty > 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  qty_base INTEGER NOT NULL CHECK (qty_base > 0),
  unit_cost_minor INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
  line_cost_minor INTEGER NOT NULL CHECK (line_cost_minor >= 0),
  CHECK (qty_base = quantity * unit_base_qty),
  CHECK (line_cost_minor = quantity * unit_cost_minor),
  FOREIGN KEY (unit_id, product_id) REFERENCES product_units (id, product_id) ON DELETE RESTRICT,
  UNIQUE (receipt_id, line_no)
) STRICT;

CREATE INDEX idx_stock_receipt_items_product ON stock_receipt_items (product_id);
CREATE INDEX idx_stock_receipt_items_unit ON stock_receipt_items (unit_id, product_id);

-- Stock corrections with a fixed reason code (plan §8.6) and a mandatory note. value_minor is a magnitude: the
-- linked movement carries the sign (ADJUST_IN +, ADJUST_OUT −, COST_CORRECTION ±).
CREATE TABLE stock_adjustments (
  id INTEGER PRIMARY KEY,
  adjustment_no TEXT NOT NULL COLLATE NOCASE ${notBlank('adjustment_no')},
  request_id TEXT NOT NULL ${notBlank('request_id')},
  adjustment_date TEXT NOT NULL ${date('adjustment_date')},
  product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('OPENING_STOCK', 'DAMAGE', 'EXPIRY', 'SHORTAGE',
    'COUNT_SURPLUS', 'RECEIPT_QTY_CORRECTION', 'RECEIPT_COST_CORRECTION', 'OTHER_CORRECTION')),
  direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT', 'VALUE')),
  unit_id INTEGER,
  unit_name TEXT,
  unit_base_qty INTEGER CHECK (unit_base_qty > 0),
  quantity INTEGER,
  qty_base INTEGER NOT NULL,
  value_minor INTEGER NOT NULL CHECK (value_minor >= 0),
  -- The corrected receipt; required for receipt corrections, otherwise NULL.
  receipt_id INTEGER REFERENCES stock_receipts (id) ON DELETE RESTRICT,
  reason_note TEXT NOT NULL ${notBlank('reason_note')},
  ${createdAt},
  CHECK (CASE reason_code
    WHEN 'OPENING_STOCK' THEN direction = 'IN'
    WHEN 'COUNT_SURPLUS' THEN direction = 'IN'
    WHEN 'DAMAGE' THEN direction = 'OUT'
    WHEN 'EXPIRY' THEN direction = 'OUT'
    WHEN 'SHORTAGE' THEN direction = 'OUT'
    WHEN 'RECEIPT_COST_CORRECTION' THEN direction = 'VALUE'
    ELSE direction IN ('IN', 'OUT')
  END),
  CHECK (CASE direction
    WHEN 'VALUE' THEN qty_base = 0 AND value_minor > 0 AND quantity IS NULL
      AND unit_id IS NULL AND unit_name IS NULL AND unit_base_qty IS NULL
    ELSE unit_id IS NOT NULL AND unit_name IS NOT NULL AND unit_base_qty IS NOT NULL
      AND quantity IS NOT NULL AND quantity > 0 AND qty_base = quantity * unit_base_qty
  END),
  CHECK ((reason_code IN ('RECEIPT_QTY_CORRECTION', 'RECEIPT_COST_CORRECTION')) = (receipt_id IS NOT NULL)),
  FOREIGN KEY (unit_id, product_id) REFERENCES product_units (id, product_id) ON DELETE RESTRICT,
  UNIQUE (adjustment_no),
  UNIQUE (request_id)
) STRICT;

CREATE INDEX idx_stock_adjustments_product ON stock_adjustments (product_id);
CREATE INDEX idx_stock_adjustments_date ON stock_adjustments (adjustment_date);
CREATE INDEX idx_stock_adjustments_receipt ON stock_adjustments (receipt_id);
CREATE INDEX idx_stock_adjustments_unit ON stock_adjustments (unit_id, product_id);

-- The inventory source of truth. Append-only: a product's stock is SUM(qty_base) in base units and its inventory
-- value SUM(value_minor). Every movement comes from exactly one source line.
CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  movement_date TEXT NOT NULL ${date('movement_date')},
  type TEXT NOT NULL CHECK (type IN ('OPENING', 'STOCK_IN', 'STOCK_IN_VOID', 'SALE', 'SALE_VOID',
    'SALE_RETURN', 'ADJUST_IN', 'ADJUST_OUT', 'COST_CORRECTION')),
  qty_base INTEGER NOT NULL,
  value_minor INTEGER NOT NULL,
  receipt_item_id INTEGER REFERENCES stock_receipt_items (id) ON DELETE RESTRICT,
  invoice_item_id INTEGER REFERENCES invoice_items (id) ON DELETE RESTRICT,
  adjustment_id INTEGER REFERENCES stock_adjustments (id) ON DELETE RESTRICT,
  note TEXT,
  ${createdAt},
  -- Inflows add stock at a value >= 0 (0 for zero-cost goods), outflows remove it, cost corrections change value only.
  CHECK (CASE
    WHEN type IN ('OPENING', 'STOCK_IN', 'SALE_VOID', 'SALE_RETURN', 'ADJUST_IN')
      THEN qty_base > 0 AND value_minor >= 0
    WHEN type IN ('SALE', 'STOCK_IN_VOID', 'ADJUST_OUT') THEN qty_base < 0 AND value_minor <= 0
    ELSE qty_base = 0 AND value_minor <> 0
  END),
  CHECK ((receipt_item_id IS NOT NULL) + (invoice_item_id IS NOT NULL) + (adjustment_id IS NOT NULL) = 1),
  CHECK (CASE
    WHEN type IN ('STOCK_IN', 'STOCK_IN_VOID') THEN receipt_item_id IS NOT NULL
    WHEN type IN ('SALE', 'SALE_VOID', 'SALE_RETURN') THEN invoice_item_id IS NOT NULL
    ELSE adjustment_id IS NOT NULL
  END)
) STRICT;

CREATE INDEX idx_stock_movements_product_id ON stock_movements (product_id, id);
CREATE INDEX idx_stock_movements_product_date ON stock_movements (product_id, movement_date);
CREATE INDEX idx_stock_movements_date ON stock_movements (movement_date);
CREATE INDEX idx_stock_movements_type_date ON stock_movements (type, movement_date);
CREATE UNIQUE INDEX ux_stock_movements_receipt_item ON stock_movements (receipt_item_id, type)
  WHERE type IN ('STOCK_IN', 'STOCK_IN_VOID');
CREATE UNIQUE INDEX ux_stock_movements_invoice_item ON stock_movements (invoice_item_id, type)
  WHERE type IN ('SALE', 'SALE_VOID');
CREATE UNIQUE INDEX ux_stock_movements_adjustment ON stock_movements (adjustment_id)
  WHERE adjustment_id IS NOT NULL;

-- Expenses --------------------------------------------------------------------------------------------------

CREATE TABLE expense_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE ${notBlank('name')},
  grp TEXT NOT NULL CHECK (grp IN ('SHOP', 'GENERAL')),
  ${flag('is_active', 1)},
  UNIQUE (name)
) STRICT;

-- Exempt from the posting-date floors. Edited in place and voided, never deleted.
CREATE TABLE expenses (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL ${notBlank('request_id')},
  expense_date TEXT NOT NULL ${date('expense_date')},
  category_id INTEGER NOT NULL REFERENCES expense_categories (id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'VOID')),
  ${createdAt},
  ${updatedAt},
  UNIQUE (request_id)
) STRICT;

CREATE INDEX idx_expenses_date ON expenses (expense_date);
CREATE INDEX idx_expenses_category_date ON expenses (category_id, expense_date);

-- Settings, counters, schema history ------------------------------------------------------------------------

-- Values are JSON text; each key is validated by the settings service.
CREATE TABLE settings (
  key TEXT NOT NULL PRIMARY KEY ${notBlank('key')},
  value TEXT NOT NULL CHECK (json_valid(value)),
  ${updatedAt}
) STRICT;

-- Document counters. next_value is the next number to hand out, taken inside the document's own transaction.
CREATE TABLE sequences (
  name TEXT NOT NULL PRIMARY KEY ${notBlank('name')},
  next_value INTEGER NOT NULL CHECK (next_value > 0)
) STRICT;

-- One row per applied migration, written in that migration's transaction. Mirrors PRAGMA user_version.
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL ${notBlank('name')},
  applied_at TEXT NOT NULL ${timestamp('applied_at')},
  app_version TEXT NOT NULL ${notBlank('app_version')},
  checksum TEXT NOT NULL CHECK (length(checksum) = 71 AND substr(checksum, 1, 7) = 'sha256:'
    AND substr(checksum, 8) NOT GLOB '*[^0-9a-f]*')
) STRICT;

-- Views: stock and balances are always computed, never stored ----------------------------------------------

CREATE VIEW v_product_stock AS
SELECT p.id AS product_id,
       coalesce(sum(m.qty_base), 0) AS qty_base,
       coalesce(sum(m.value_minor), 0) AS value_minor
FROM products AS p
LEFT JOIN stock_movements AS m ON m.product_id = p.id
GROUP BY p.id;

CREATE VIEW v_customer_balance AS
SELECT c.id AS customer_id,
       coalesce(sum(l.amount_minor), 0) AS balance_minor
FROM customers AS c
LEFT JOIN customer_ledger AS l ON l.customer_id = c.id
GROUP BY c.id;

-- Immutability ----------------------------------------------------------------------------------------------
${appendOnly('customer_ledger')}${appendOnly('stock_movements')}${appendOnly('invoice_items')}${appendOnly('invoice_item_quantities')}${appendOnly('invoice_change_log')}${appendOnly('stock_receipt_items')}${appendOnly('stock_adjustments')}${appendOnly('schema_migrations')}${savedDocument(
  'invoices',
  [
    'id',
    'invoice_no',
    'seq_no',
    'request_id',
    'invoice_code',
    'invoice_date',
    'customer_id',
    'cust_name',
    'cust_shop_name',
    'cust_phone',
    'cust_address',
    'cust_city',
    'price_tier',
    'gross_minor',
    'line_discount_minor',
    'line_scheme_minor',
    'extra_discount_minor',
    'net_minor',
    'freight_minor',
    'total_minor',
    'received_minor',
    'previous_balance_minor',
    'net_outstanding_minor',
    'cogs_minor',
    'checked_by',
    'notes',
    'created_at'
  ],
  ['status', 'void_reason', 'voided_at', 'void_date'],
  'A saved invoice cannot be changed: only its dispatch details can be updated, or it can be voided'
)}${savedDocument(
  'payments',
  [
    'id',
    'payment_no',
    'request_id',
    'customer_id',
    'payment_date',
    'amount_minor',
    'method',
    'reference',
    'invoice_id',
    'note',
    'created_at'
  ],
  ['status', 'void_reason', 'voided_at', 'void_date'],
  'A saved payment cannot be changed: it can only be voided'
)}${savedDocument(
  'stock_receipts',
  [
    'id',
    'receipt_no',
    'request_id',
    'receipt_date',
    'supplier_name',
    'reference',
    'note',
    'total_cost_minor',
    'created_at'
  ],
  ['status', 'void_reason', 'void_date'],
  'A saved stock receipt cannot be changed: it can only be voided'
)}
CREATE TRIGGER trg_expenses_no_delete BEFORE DELETE ON expenses
BEGIN
  SELECT RAISE(ABORT, 'expenses are never deleted: void the expense instead');
END;

-- Seed data: defaults only. No products, stock, invoices or money ------------------------------------------

INSERT INTO settings (key, value) VALUES
  ('business.name', '"StockFlow"'),
  ('currency.code', '"PKR"'),
  ('currency.symbol', '"Rs"'),
  ('currency.minorDigits', '2'),
  ('invoice.prefix', '"INV-"'),
  ('invoice.padding', '6'),
  ('invoice.startNumber', '1'),
  ('invoice.paperSize', '"A4"'),
  ('backup.autoEnabled', 'true'),
  ('backup.keepDaily', '14'),
  ('backup.keepMonthly', '12');

INSERT INTO customers (code, name) VALUES ('C-00001', 'Cash / Walk-in');

INSERT INTO sequences (name, next_value) VALUES
  ('invoice', 1),
  ('receipt', 1),
  ('payment', 1),
  ('adjustment', 1),
  -- C-00001 is the walk-in customer above, so the first customer created in the app is C-00002.
  ('customer', 2);

INSERT INTO expense_categories (name, grp) VALUES
  ('Shop Expenses', 'SHOP'),
  ('Monthly / General Expenses', 'GENERAL'),
  ('Freight Paid', 'SHOP'),
  ('Purchase Cost Correction', 'GENERAL');
`

export const initialMigration: Migration = Object.freeze({
  version: 1,
  name: '0001_initial',
  // SHA-256 of INITIAL_SCHEMA_SQL. Pinned: never regenerate it (see migrations/index.ts).
  checksum: 'sha256:0cc4eb9837b99f71442ed9e8bbd48723f869bcbc8fb2f4d8b0dcd90bee576cc4',
  up: (db) => db.exec(INITIAL_SCHEMA_SQL)
})
