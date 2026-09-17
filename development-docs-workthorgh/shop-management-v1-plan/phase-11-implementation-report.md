# Phase 11 — Reports + Profit & Loss: Implementation Report

Status: implemented and verified. **Nothing committed.**
- **Schema:** still **2**. No migration; `0001`/`0002` are unchanged.
- **Not started:** Phase 12 (release hardening, installer, update workflow, release backups, final acceptance).
- **Untouched:** invoice, stock, payment and customer posting rules. Reports only read.

## 0. Phase 10 fix: expense category group lock

- A category's group (SHOP / GENERAL) may change only while **no expense (active or void) uses it**. After that, `expenseCategories.update` with a different group fails with `FORBIDDEN_STATE` "Expense type cannot be changed after this category has been used." (field error on `group`), and nothing is saved, not even the name sent with it.
- Rename and activate / deactivate stay allowed. Past expenses therefore keep their Shop / General classification without a snapshot column.
- **UI:** in Manage Categories, a used category's group select is disabled and shows that sentence; the footer note explains the rule (it replaces the old "moves its existing expenses" note).
- **Tests:** unused category can move; locked for active and for void use; rename / deactivate still work; totals unchanged after a refused change; IPC refusal; renderer helper and dialog text.

## 1. Report formulas (all derived on request; nothing stored)

Periods are inclusive business dates (`dateFrom ≤ dateTo`, real calendar days): `invoice_date`, `adjustment_date` (the movement date is the same day), `expense_date`. `created_at` is never used.

| Figure | Source |
|---|---|
| Goods Revenue | Σ `invoices.net_minor`, POSTED (after line discounts, schemes and extra discount; freight excluded) |
| Freight Income | Σ `invoices.freight_minor`, POSTED |
| COGS | Σ `invoices.cogs_minor`, POSTED (frozen at posting; tested equal to the posted SALE movement values) |
| Gross Profit | Goods Revenue − COGS |
| Stock Gains | Σ COUNT_SURPLUS movement values |
| Stock Losses | −Σ DAMAGE / EXPIRY / SHORTAGE movement values (shown positive, per reason) |
| Operating Expenses | ACTIVE Shop + Monthly / General expenses, Purchase Cost Correction excluded |
| **Net Operating Profit** | Gross Profit + Freight Income + Stock Gains − Operating Expenses − Stock Losses |
| Purchase Cost Corrections | ACTIVE expenses in the seeded category, by id |
| Inventory Data Corrections | Σ signed movement values of RECEIPT_QTY_CORRECTION, RECEIPT_COST_CORRECTION, OTHER_CORRECTION |
| **Profit After Data Corrections** | Net Operating Profit − Purchase Cost Corrections + inventory corrections net value |

- **Not P&L:** VOID invoices and expenses (whatever their void date), payments and payment voids, OPENING_STOCK (shown only as an information line), receipts and receipt voids. SALE / SALE_VOID are represented only by revenue and frozen COGS.
- **Money:** sums run in SQLite as 64-bit integers; every value is checked to be a safe JavaScript integer and derived figures use the Phase 2 checked helpers. A total too large to show exactly gives `VALIDATION` "The report totals are too large to show exactly." instead of a rounded number (tested).

## 2. Purchase Cost Correction identity

`PURCHASE_COST_CORRECTION_CATEGORY_ID = 4` (`src/shared/reports.ts`). Migration 0001 inserts the four seeded categories in order into the new, empty table, so their ids are always 1–4. 0001 is frozen, there is no delete API, and ids never change. A test pins id 4 to the seeded row. A renamed id 4 is still treated as the correction, and a new category given the old name is a normal expense (tested). No name matching, no migration.

## 3. APIs (typed, allow-listed, read-only)

`reports`:
- `profitLoss({ dateFrom, dateTo })`
- `sales({ dateFrom, dateTo, page, pageSize, status: POSTED|VOID|all })`: status only filters the invoice table; totals are always POSTED.
- `productSales({ dateFrom, dateTo })`
- `stock()`
- `customerBalances()`
- `expenses({ dateFrom, dateTo, page, pageSize, status: ACTIVE|VOID|all })`: status only filters the rows; totals are always ACTIVE.

Strict Zod schemas are checked at the IPC boundary and again in `reports.service.ts`. There is no generic query, SQL or export call (the contract test asserts it), and the renderer runs no SQL.

## 4. Reports UI (`#/reports`, replaces the placeholder)

- **Tabs:** Profit & Loss · Sales · Products · Stock · Customer Balances · Expenses.
- **Period** (dated tabs only): This Month (default), Today, Last Month, This Year, Custom (From / To; an inverted range is refused on screen). Stock and Customer Balances show "Current figures, as of now".
- **Profit & Loss:** four cards and the statement (Revenue / Cost of Goods Sold / Gross Profit / Operating Gains / Operating Expenses / Net Operating Profit / Data Corrections / Profit After Data Corrections).
  - Zero stock-gain / loss lines and an empty corrections section are hidden.
  - Beside it, an expenses-by-category drill-down; below, a table of inventory corrections with the net value effect.
  - The L1 note shows when the period has a receipt cost correction or a Purchase Cost Correction expense; an opening-stock information line shows when relevant.
- **Sales:** summary (gross, discounts, scheme discounts, net goods, freight, total billed, COGS, gross profit), a void-invoice note, and a 25-row invoice table with a status filter and links to the invoices.
- **Products:** per product (grouped by `product_id`, current code / name / company), quantity sold in units and base units, free scheme quantity, revenue, frozen COGS and gross profit.
  - Totals, plus "Invoice extra discounts (not allocated to products)" so the table reconciles to net goods sales.
- **Stock:** code, product, company, current quantity, unit breakdown, inventory value, Low stock / Out of stock / In stock, active status; a total inventory value card; search and a filter.
- **Customer Balances:** Total Receivables, Total Customer Advances and Net Receivable as separate cards; per customer Due / Advance / Settled; search and a filter.
- **Expenses:** Shop, Monthly / General, Total Operating, Purchase Cost Corrections (separate); category breakdown; 25-row expense table with an Active / Void / All filter.

## 5. Tests / build / manual

- `npm test`: **1922 passed in 95 files** (Phase 10: 1872 in 92). `npm run typecheck`, `npm run lint` and `prettier --check src` are clean.
- `npm run build` succeeds:
  - main 346.10 kB
  - preload 8.04 kB
  - renderer JS 2,306.51 kB
- **New service tests** (`reports.service.test.ts`, 24), using the real posting services on temporary databases with hand-worked figures:
  - P&L A–J: basic, freight vs Freight Paid, damage / expiry / shortage, count surplus, void invoice, void expense, Purchase Cost Correction (renamed / look-alike), inventory corrections counted once, opening stock and receipt / receipt void.
  - Payments are not revenue.
  - Periods: both ends inclusive, month boundaries, business date vs `created_at`, invalid ranges.
  - Sales: discounts, schemes, freight, COGS, void, paging, status filter.
  - Products: multi-unit, free goods, extra discount reconciliation, later price change.
  - Stock: quantity / value, zero stock, low, inactive; equals the ledger.
  - Customers: due, advance and settled; receivables and advances apart.
  - Expenses: groups, Purchase Cost Correction apart, void rows, inactive / renamed categories, group lock.
  - Overflow (including a total no later arithmetic re-checks).
  - **Integrated cross-check:** opening stock, receipt, sale, partial payment, second sale with freight, damage, surplus, Shop / General / PCC expenses, invoice void with the payment still posted, expense void. Independently checked against the stock movement and customer ledgers, and across P&L, sales, product, expense, stock and balance reports.
- **Also:** IPC end-to-end and 10 boundary refusals; contract / preload channel lists; renderer period presets (incl. leap-year February and January → December), P&L statement rows, SSR UI for all six tabs; routes.
- **Deliberate-break check:** 22 key rules switched off one at a time, all caught (the overflow guard only after adding a void-expense overflow test); files restored exactly.
- **Manual check** (built app, temporary appData via the inspector redirect, real UI through CDP): **23/23**. Expected figures were calculated by hand before running.
  1. Goods revenue Rs 5,900.00
  2. COGS Rs 3,900.00
  3. Gross profit Rs 2,000.00
  4. Freight income Rs 200.00
  5. Shop Rs 230.00
  6. General Rs 400.00
  7. Damage Rs 600.00
  8. Surplus Rs 300.00
  9. Net Operating Profit Rs 1,270.00
  10. PCC Rs 50.00 and inventory correction −Rs 600.00 below it; Profit After Data Corrections Rs 620.00
  11. Inventory value Rs 10,200.00
  12. Receivables Rs 4,200.00 and advances Rs 600.00

  It also checked: a custom range, an inverted range refused, sales / products / expenses tabs, the group lock in the dialog, and that viewing reports changed no record. The real StockFlow folders are unchanged and the temporary data was removed.

## 6. Needs attention

1. **Inventory data corrections are included in "Profit After Data Corrections"** (signed value). A receipt cost or quantity correction really adjusts what was owed to the supplier, so you may prefer to show them for information only. It is a one-line change if so.
2. **RECEIPT_COST_CORRECTION's Phase 6 P&L mapping changed** from `NONE` to `INVENTORY_DATA_CORRECTION` in `ADJUSTMENT_REASON_INFO` (used only by reports), per this phase's rules.
3. **Invoice extra discounts are not allocated to products:** product revenue is line net, with a reconciling line. Allocating would need a rounding rule.
4. **Void timing:** a void invoice / expense leaves its original period entirely, even if voided in a later month (no reversal in the void month). This matches "VOID contributes zero".
5. **Product report identification:** it shows the product's current code / name, not the invoice snapshot, when a product was renamed.
6. **Stock and Customer Balances are current-state only:** no "as of date" history.
7. **Presets use the computer's local date** in the renderer (the same clock as the main process on this desktop app).
8. **No export or print of reports** (not requested for this phase).
