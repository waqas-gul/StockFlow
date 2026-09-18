import type { Migration } from '../migrate'

/*
 * 0004_invoice_business_salesman_snapshot: every new invoice keeps the shop and salesman it was posted with.
 *
 * FROZEN once shipped, like 0001–0003. Its checksum (SHA-256 of INVOICE_BUSINESS_SALESMAN_SNAPSHOT_SQL) is pinned below.
 *
 * The shop name and address and the salesman's name and phones are settings, so they can change. An invoice copies them
 * when it is posted, in the same transaction, exactly as it copies the customer's details, so a later change in
 * Settings never alters an old invoice. The change only adds:
 * - five nullable invoice columns: shop_name_snapshot, shop_address_snapshot, salesman_name_snapshot,
 *   salesman_phone1_snapshot and salesman_phone2_snapshot. An empty address or phone is saved as NULL;
 * - the settings business.address (empty), salesman.name, salesman.phone1 and salesman.phone2, and the shop's name in
 *   place of the seeded "StockFlow" (a name the owner already chose is kept);
 * - a trigger that makes every invoice saved from now on keep its shop name and salesman, and one that fixes the five
 *   columns once saved (0001 protects the others).
 *
 * Invoices saved before this migration keep NULL in all five columns: they are never backfilled, because nobody knows
 * which shop name or salesman they were printed with. They open and print as before.
 */
export const INVOICE_BUSINESS_SALESMAN_SNAPSHOT_SQL = `
ALTER TABLE invoices ADD COLUMN shop_name_snapshot TEXT;
ALTER TABLE invoices ADD COLUMN shop_address_snapshot TEXT;
ALTER TABLE invoices ADD COLUMN salesman_name_snapshot TEXT;
ALTER TABLE invoices ADD COLUMN salesman_phone1_snapshot TEXT;
ALTER TABLE invoices ADD COLUMN salesman_phone2_snapshot TEXT;

UPDATE settings SET value = '"Iftikhar and Arshad Traders"', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE key = 'business.name' AND value = '"StockFlow"';

INSERT INTO settings (key, value) VALUES
  ('business.address', '""'),
  ('salesman.name', '"Mansoor Iqbal"'),
  ('salesman.phone1', '"03179927633"'),
  ('salesman.phone2', '"03463820629"')
ON CONFLICT (key) DO NOTHING;

-- Every invoice saved from now on keeps its shop name and salesman; an empty address or phone is NULL, never blank.
CREATE TRIGGER trg_invoices_business_snapshot BEFORE INSERT ON invoices
WHEN trim(coalesce(NEW.shop_name_snapshot, '')) = ''
  OR trim(coalesce(NEW.salesman_name_snapshot, '')) = ''
  OR trim(NEW.shop_address_snapshot) = ''
  OR trim(NEW.salesman_phone1_snapshot) = ''
  OR trim(NEW.salesman_phone2_snapshot) = ''
BEGIN
  SELECT RAISE(ABORT, 'A new invoice keeps its shop name and salesman; an empty address or phone is saved as NULL');
END;

-- The saved shop and salesman never change, and an invoice saved before this migration is never given any.
CREATE TRIGGER trg_invoices_business_snapshot_guard BEFORE UPDATE ON invoices
WHEN NEW.shop_name_snapshot IS NOT OLD.shop_name_snapshot
  OR NEW.shop_address_snapshot IS NOT OLD.shop_address_snapshot
  OR NEW.salesman_name_snapshot IS NOT OLD.salesman_name_snapshot
  OR NEW.salesman_phone1_snapshot IS NOT OLD.salesman_phone1_snapshot
  OR NEW.salesman_phone2_snapshot IS NOT OLD.salesman_phone2_snapshot
BEGIN
  SELECT RAISE(ABORT, 'A saved invoice cannot be changed: only its dispatch details can be updated, or it can be voided');
END;
`

export const invoiceBusinessSalesmanSnapshotMigration: Migration = Object.freeze({
  version: 4,
  name: '0004_invoice_business_salesman_snapshot',
  // SHA-256 of INVOICE_BUSINESS_SALESMAN_SNAPSHOT_SQL. Pinned: never regenerate it (see migrations/index.ts).
  checksum: 'sha256:e5fd33a52cda209d35880ffd4df738cf61e54e993bbe57906da7e6fd989d4174',
  up: (db) => db.exec(INVOICE_BUSINESS_SALESMAN_SNAPSHOT_SQL)
})
