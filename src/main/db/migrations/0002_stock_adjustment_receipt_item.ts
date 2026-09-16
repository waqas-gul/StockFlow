import type { Migration } from '../migrate'

/*
 * 0002_stock_adjustment_receipt_item: links a receipt correction to the exact receipt LINE it corrects.
 *
 * FROZEN once shipped, like 0001. Its checksum (SHA-256 of STOCK_ADJUSTMENT_RECEIPT_ITEM_SQL) is pinned below.
 *
 * Why: a receipt may hold the same product on several lines, in different units and at different costs (2 Box @ 2,400
 * and 5 Piece @ 110). 0001 stores only stock_adjustments.receipt_id, so a RECEIPT_QTY_CORRECTION IN could not say
 * which line's cost it adds stock at, and a RECEIPT_COST_CORRECTION could not say which recorded cost it corrects.
 *
 * The change only adds: a nullable receipt_item_id (ON DELETE RESTRICT, like every key), its index, and a trigger
 * that makes each new receipt correction name a line of its own receipt for the same product (and every other
 * adjustment name none). stock_adjustments is append-only, so checking each INSERT covers every row written from now
 * on; rows written before this migration keep receipt_item_id NULL.
 */
export const STOCK_ADJUSTMENT_RECEIPT_ITEM_SQL = `
ALTER TABLE stock_adjustments
  ADD COLUMN receipt_item_id INTEGER REFERENCES stock_receipt_items (id) ON DELETE RESTRICT;

CREATE INDEX idx_stock_adjustments_receipt_item ON stock_adjustments (receipt_item_id);

CREATE TRIGGER trg_stock_adjustments_receipt_item BEFORE INSERT ON stock_adjustments
WHEN CASE
  WHEN NEW.reason_code IN ('RECEIPT_QTY_CORRECTION', 'RECEIPT_COST_CORRECTION') THEN NOT EXISTS (
    SELECT 1 FROM stock_receipt_items AS ri
    WHERE ri.id = NEW.receipt_item_id AND ri.receipt_id = NEW.receipt_id AND ri.product_id = NEW.product_id
  )
  ELSE NEW.receipt_item_id IS NOT NULL
END
BEGIN
  SELECT RAISE(ABORT, 'A receipt correction must name a line of its own receipt for the same product; other adjustments name no receipt line');
END;
`

export const stockAdjustmentReceiptItemMigration: Migration = Object.freeze({
  version: 2,
  name: '0002_stock_adjustment_receipt_item',
  // SHA-256 of STOCK_ADJUSTMENT_RECEIPT_ITEM_SQL. Pinned: never regenerate it (see migrations/index.ts).
  checksum: 'sha256:fb50cb92d9de9f5d2e41866ea02f9192bd5416f2284e33e1e4a7483f6c4a442d',
  up: (db) => db.exec(STOCK_ADJUSTMENT_RECEIPT_ITEM_SQL)
})
