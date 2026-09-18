import type { Migration } from '../migrate'

/*
 * 0003_supplier_accounts: suppliers and what the shop owes them (supplier payables).
 *
 * FROZEN once shipped, like 0001 and 0002. Its checksum (SHA-256 of SUPPLIER_ACCOUNTS_SQL) is pinned below.
 *
 * Suppliers are the people and firms the shop buys stock from. They are not `companies`, which are the product brands
 * or manufacturers. What the shop owes a supplier is never stored: it is Σ supplier_ledger.amount_minor, where a
 * positive balance means the shop owes the supplier (Due) and a negative one is a supplier advance.
 *
 * The change only adds:
 * - suppliers (code SUP-00001 from the `supplier` sequence; names may repeat);
 * - supplier_payments (SPAY-000001 from the `supplier_payment` sequence): saved once, then only voided;
 * - supplier_ledger: append-only, one row per balance change, with the signs and references its type requires, at most
 *   one entry of each kind per receipt or payment, one OPENING per supplier and only as its first entry, and every
 *   receipt or payment entry on the supplier of that receipt or payment;
 * - stock_receipts.supplier_id (the supplier account) and supplier_bill_no (the supplier's bill number), both nullable
 *   and fixed once the receipt is saved; supplier_name stays the saved name snapshot, so renaming a supplier never
 *   rewrites an old receipt;
 * - v_supplier_balance.
 *
 * Existing receipts keep supplier_id NULL and their free-text supplier_name: nothing is linked, created or posted to a
 * supplier account from them, because money may already have been paid outside StockFlow. A debt to an old supplier
 * is entered as that supplier's opening balance.
 */
export const SUPPLIER_ACCOUNTS_SQL = `
CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL COLLATE NOCASE CHECK (trim(code) <> ''),
  name TEXT NOT NULL COLLATE NOCASE CHECK (trim(name) <> ''),
  contact_person TEXT COLLATE NOCASE,
  phone TEXT,
  address TEXT,
  city TEXT COLLATE NOCASE,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  UNIQUE (code)
) STRICT;

CREATE INDEX idx_suppliers_name ON suppliers (name);
CREATE INDEX idx_suppliers_contact ON suppliers (contact_person);
CREATE INDEX idx_suppliers_phone ON suppliers (phone);
CREATE INDEX idx_suppliers_city ON suppliers (city);

ALTER TABLE stock_receipts ADD COLUMN supplier_id INTEGER REFERENCES suppliers (id) ON DELETE RESTRICT;
ALTER TABLE stock_receipts ADD COLUMN supplier_bill_no TEXT;

CREATE INDEX idx_stock_receipts_supplier_date ON stock_receipts (supplier_id, receipt_date);

-- A supplier-linked receipt keeps the supplier's name as it was saved.
CREATE TRIGGER trg_stock_receipts_supplier_snapshot BEFORE INSERT ON stock_receipts
WHEN NEW.supplier_id IS NOT NULL AND trim(coalesce(NEW.supplier_name, '')) = ''
BEGIN
  SELECT RAISE(ABORT, 'A supplier-linked stock receipt keeps the supplier name');
END;

-- The supplier account and bill number of a saved receipt never change (0001 protects its other columns).
CREATE TRIGGER trg_stock_receipts_supplier_guard BEFORE UPDATE ON stock_receipts
WHEN NEW.supplier_id IS NOT OLD.supplier_id OR NEW.supplier_bill_no IS NOT OLD.supplier_bill_no COLLATE BINARY
BEGIN
  SELECT RAISE(ABORT, 'A saved stock receipt cannot be changed: it can only be voided');
END;

-- Money paid to suppliers. A payment made with a Stock In receipt ("paid now") names that receipt.
CREATE TABLE supplier_payments (
  id INTEGER PRIMARY KEY,
  payment_no TEXT NOT NULL COLLATE NOCASE CHECK (trim(payment_no) <> ''),
  request_id TEXT NOT NULL CHECK (trim(request_id) <> ''),
  supplier_id INTEGER NOT NULL REFERENCES suppliers (id) ON DELETE RESTRICT,
  payment_date TEXT NOT NULL
    CHECK (payment_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(payment_date) IS payment_date),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  method TEXT NOT NULL CHECK (method IN ('CASH', 'BANK', 'CHEQUE', 'OTHER')),
  reference TEXT,
  stock_receipt_id INTEGER REFERENCES stock_receipts (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),
  void_reason TEXT,
  voided_at TEXT
    CHECK (voided_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', voided_at) IS voided_at),
  void_date TEXT CHECK (void_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(void_date) IS void_date),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (
    (status = 'POSTED' AND void_reason IS NULL AND voided_at IS NULL AND void_date IS NULL)
    OR (status = 'VOID' AND trim(coalesce(void_reason, '')) <> '' AND voided_at IS NOT NULL AND void_date IS NOT NULL)
  ),
  UNIQUE (payment_no),
  UNIQUE (request_id)
) STRICT;

CREATE INDEX idx_supplier_payments_supplier_date ON supplier_payments (supplier_id, payment_date);
CREATE INDEX idx_supplier_payments_date ON supplier_payments (payment_date);
CREATE INDEX idx_supplier_payments_receipt ON supplier_payments (stock_receipt_id);

-- A payment "paid now" with a receipt is for that receipt's supplier.
CREATE TRIGGER trg_supplier_payments_receipt BEFORE INSERT ON supplier_payments
WHEN NEW.stock_receipt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM stock_receipts WHERE id = NEW.stock_receipt_id AND supplier_id IS NEW.supplier_id
)
BEGIN
  SELECT RAISE(ABORT, 'A supplier payment can only name a receipt of the same supplier');
END;

CREATE TRIGGER trg_supplier_payments_guard_update BEFORE UPDATE ON supplier_payments
WHEN NEW.id IS NOT OLD.id COLLATE BINARY
    OR NEW.payment_no IS NOT OLD.payment_no COLLATE BINARY
    OR NEW.request_id IS NOT OLD.request_id COLLATE BINARY
    OR NEW.supplier_id IS NOT OLD.supplier_id COLLATE BINARY
    OR NEW.payment_date IS NOT OLD.payment_date COLLATE BINARY
    OR NEW.amount_minor IS NOT OLD.amount_minor COLLATE BINARY
    OR NEW.method IS NOT OLD.method COLLATE BINARY
    OR NEW.reference IS NOT OLD.reference COLLATE BINARY
    OR NEW.stock_receipt_id IS NOT OLD.stock_receipt_id COLLATE BINARY
    OR NEW.note IS NOT OLD.note COLLATE BINARY
    OR NEW.created_at IS NOT OLD.created_at COLLATE BINARY
    OR ((NEW.status IS NOT OLD.status COLLATE BINARY
      OR NEW.void_reason IS NOT OLD.void_reason COLLATE BINARY
      OR NEW.voided_at IS NOT OLD.voided_at COLLATE BINARY
      OR NEW.void_date IS NOT OLD.void_date COLLATE BINARY) AND NOT (OLD.status = 'POSTED' AND NEW.status = 'VOID'))
BEGIN
  SELECT RAISE(ABORT, 'A saved supplier payment cannot be changed: it can only be voided');
END;

CREATE TRIGGER trg_supplier_payments_no_delete BEFORE DELETE ON supplier_payments
BEGIN
  SELECT RAISE(ABORT, 'supplier_payments rows are never deleted: void the payment instead');
END;

-- Append-only. A supplier's balance is SUM(amount_minor); positive means the shop owes the supplier.
CREATE TABLE supplier_ledger (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers (id) ON DELETE RESTRICT,
  entry_date TEXT NOT NULL
    CHECK (entry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(entry_date) IS entry_date),
  type TEXT NOT NULL
    CHECK (type IN ('OPENING', 'PURCHASE', 'PURCHASE_VOID', 'PAYMENT', 'PAYMENT_VOID', 'ADJUSTMENT')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
  stock_receipt_id INTEGER REFERENCES stock_receipts (id) ON DELETE RESTRICT,
  supplier_payment_id INTEGER REFERENCES supplier_payments (id) ON DELETE RESTRICT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (CASE type
    WHEN 'PURCHASE' THEN amount_minor > 0
    WHEN 'PAYMENT_VOID' THEN amount_minor > 0
    WHEN 'PAYMENT' THEN amount_minor < 0
    WHEN 'PURCHASE_VOID' THEN amount_minor < 0
    ELSE 1
  END),
  CHECK (CASE type
    WHEN 'PURCHASE' THEN stock_receipt_id IS NOT NULL AND supplier_payment_id IS NULL
    WHEN 'PURCHASE_VOID' THEN stock_receipt_id IS NOT NULL AND supplier_payment_id IS NULL
    WHEN 'PAYMENT' THEN supplier_payment_id IS NOT NULL AND stock_receipt_id IS NULL
    WHEN 'PAYMENT_VOID' THEN supplier_payment_id IS NOT NULL AND stock_receipt_id IS NULL
    ELSE stock_receipt_id IS NULL AND supplier_payment_id IS NULL
  END),
  CHECK (type <> 'ADJUSTMENT' OR trim(coalesce(note, '')) <> '')
) STRICT;

CREATE INDEX idx_supplier_ledger_supplier_date ON supplier_ledger (supplier_id, entry_date, id);
CREATE INDEX idx_supplier_ledger_date ON supplier_ledger (entry_date);
CREATE UNIQUE INDEX ux_supplier_ledger_receipt ON supplier_ledger (stock_receipt_id, type)
  WHERE type IN ('PURCHASE', 'PURCHASE_VOID');
CREATE UNIQUE INDEX ux_supplier_ledger_payment ON supplier_ledger (supplier_payment_id, type)
  WHERE type IN ('PAYMENT', 'PAYMENT_VOID');
CREATE UNIQUE INDEX ux_supplier_ledger_opening ON supplier_ledger (supplier_id) WHERE type = 'OPENING';

-- An opening balance is only ever the supplier's first entry; a receipt or payment entry is on its own supplier.
CREATE TRIGGER trg_supplier_ledger_source BEFORE INSERT ON supplier_ledger
WHEN (NEW.type = 'OPENING' AND EXISTS (SELECT 1 FROM supplier_ledger WHERE supplier_id = NEW.supplier_id))
  OR (NEW.stock_receipt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM stock_receipts WHERE id = NEW.stock_receipt_id AND supplier_id IS NEW.supplier_id
  ))
  OR (NEW.supplier_payment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM supplier_payments WHERE id = NEW.supplier_payment_id AND supplier_id IS NEW.supplier_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'A supplier ledger entry must be on the supplier of its receipt or payment, and an opening balance must be the first entry');
END;

CREATE TRIGGER trg_supplier_ledger_no_update BEFORE UPDATE ON supplier_ledger
BEGIN
  SELECT RAISE(ABORT, 'supplier_ledger is append-only: its rows cannot be changed');
END;

CREATE TRIGGER trg_supplier_ledger_no_delete BEFORE DELETE ON supplier_ledger
BEGIN
  SELECT RAISE(ABORT, 'supplier_ledger is append-only: its rows cannot be deleted');
END;

CREATE VIEW v_supplier_balance AS
SELECT s.id AS supplier_id,
       coalesce(sum(l.amount_minor), 0) AS balance_minor
FROM suppliers AS s
LEFT JOIN supplier_ledger AS l ON l.supplier_id = s.id
GROUP BY s.id;

INSERT INTO sequences (name, next_value) VALUES
  ('supplier', 1),
  ('supplier_payment', 1);
`

export const supplierAccountsMigration: Migration = Object.freeze({
  version: 3,
  name: '0003_supplier_accounts',
  // SHA-256 of SUPPLIER_ACCOUNTS_SQL. Pinned: never regenerate it (see migrations/index.ts).
  checksum: 'sha256:5bcbe1726aee3f75a7240faab2c266ece5b6499e80f6e8ed6950870c0eaad0a0',
  up: (db) => db.exec(SUPPLIER_ACCOUNTS_SQL)
})
