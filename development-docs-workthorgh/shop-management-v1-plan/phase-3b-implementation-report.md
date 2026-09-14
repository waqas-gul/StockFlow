# StockFlow — Phase 3B Implementation Report

> **Phase:** 3B — Production V1 database schema (migration `0001_initial`).
> **Date:** 2026-09-14.
> **Status:** Implemented and verified. **Awaiting approval.**
> - Schema only, plus migration integration and tests. No services, IPC calls or screens were added.
> - Phase 4 (backups, restore, settings UI) was not started.
> - Nothing was committed.

---

## 1. Summary

| Area | Result |
|---|---|
| Schema version | **1** (`0001_initial`, registered in `src/main/db/migrations/index.ts`) |
| Objects | **19 STRICT tables, 2 views, 40 explicit indexes, 23 triggers** |
| Seeds | 11 settings, 5 sequences, 4 expense categories, the walk-in customer `C-00001` — nothing else |
| Checksum | `sha256:0cc4eb9837b99f71442ed9e8bbd48723f869bcbc8fb2f4d8b0dcd90bee576cc4`, pinned in the source and recorded in `schema_migrations` |
| Migration metadata | The Phase 3A recorder hook now writes `schema_migrations` inside the migration's own transaction |
| Driver | better-sqlite3 **12.11.1**, exact pin, unchanged (SQLite 3.53.2) |
| Tests | **688 / 688** in 28 files (285 new). Coverage **100%** of every measured file |
| Builds | typecheck, lint (0 problems), test, coverage, build, build:unpack all pass |
| Runtime | Packaged **42 / 42**, dev **41 / 41**, both against a **temporary appData**; the real data folders are byte-for-byte unchanged |

---

## 2. Files

### Created (5)

| File | Lines | Purpose |
|---|---|---|
| `src/main/db/migrations/0001_initial.ts` | 625 | The V1 schema script, its pinned checksum and the migration object |
| `src/main/db/migrations/0001_initial.test.ts` | 320 | Definition, objects, metadata, atomicity, seeds |
| `src/main/db/migrations/0001_constraints.test.ts` | 836 | CHECK / UNIQUE / FK / STRICT constraints directly against SQLite |
| `src/main/db/migrations/0001_immutability.test.ts` | 366 | Append-only tables, REPLACE/UPSERT bypass attempts, saved-document guards |
| `src/main/db/migrations/0001_views_snapshots.test.ts` | 225 | `v_product_stock`, `v_customer_balance`, historical snapshots |

### Changed (11 tracked files; 463 insertions, 37 deletions)

| File | Change |
|---|---|
| `src/main/db/migrations/index.ts` | Registers `0001_initial`; documents the frozen-migration and checksum rules |
| `src/main/db/migrate.ts` | `Migration` gains `readonly checksum: string` (runner logic unchanged) |
| `src/main/db/index.ts` | `recordSchemaMigration(appVersion)`; `initializeDatabase(file, { appVersion })` wires it in |
| `src/main/db/connection.ts` | Adds the connection pragma `recursive_triggers = ON` (set and read back like the others; §9) |
| `src/main/index.ts` | Passes `app.getVersion()` to `initializeDatabase` |
| `src/main/db/test-utils.ts` | Test-only schema fixtures (`createSchemaDatabase`, row builders, `sqlChecksum`) |
| `src/main/db/index.test.ts`, `migrate.test.ts`, `connection.test.ts` | Updated for schema 1, the checksum field and the new pragma |
| `README.md` | Internet wording corrected (§14); schema note |
| `phase-3a-implementation-report.md` | Internet wording corrected in "Needs attention" item 3 (marked as corrected in 3B) |

No renderer, preload, IPC contract, electron-builder, ESLint, Vitest or package changes. `better-sqlite3` is still imported only by `src/main/db/adapter.ts`.

---

## 3. Conventions used by the schema

- **Every table is `STRICT`.** Wrong types are rejected (`SQLITE_CONSTRAINT_DATATYPE`); `125.5` cannot enter a money column.
- **Money** is `INTEGER` minor units (`_minor`). **Percentages** are `INTEGER` basis points (`_bps`). **Stock** is `INTEGER` base units (`qty_base`). The script contains no `REAL`/`FLOAT`/`NUMERIC` type (tested).
- **Business dates** are `TEXT 'YYYY-MM-DD'`: `CHECK (x GLOB '[0-9]{4}-[0-9]{2}-[0-9]{2}' AND date(x) IS x)`. The `IS` form matters: `date('2026-13-01')` is NULL, and a plain `=` would let NULL pass the CHECK. `2026-02-30` is refused because SQLite normalises it to another date.
- **Timestamps** are `TEXT` in exactly the `Date.toISOString()` format (`2026-09-14T04:37:42.171Z`), shape-checked plus a `strftime` round trip; `created_at`/`updated_at` default to the current UTC time.
- **Foreign keys** are all `ON DELETE RESTRICT` (tested for every FK). No cascades anywhere.
- **Booleans** are `INTEGER CHECK (x IN (0, 1))`; required codes and names are non-blank; human codes (`code`, `invoice_no`, …) are `COLLATE NOCASE` and unique.
- **Stock and balances are never stored**: they are sums over the append-only ledgers.

---

## 4. Tables (19)

| Table | Key points |
|---|---|
| `companies` | `name` NOCASE UNIQUE, `is_active`, timestamps |
| `products` | `code` NOCASE UNIQUE; `company_id` nullable FK; **`packing_label` verbatim text, never parsed**; `low_stock_threshold_base ≥ 0` |
| `product_units` | `base_qty > 0`; `is_base ⇒ base_qty = 1`; UNIQUE `(product_id, name)`, `(product_id, base_qty)`, partial UNIQUE one base per product; prices nullable and `≥ 0`; `sort_order`; `UNIQUE (id, product_id)` so stock documents can require "unit belongs to product" |
| `customers` | `code` UNIQUE; **names not unique**; name/shop/city NOCASE; no balance column |
| `customer_ledger` | Append-only; 6 types; `amount ≠ 0`; signs: INVOICE/PAYMENT_VOID > 0, PAYMENT/INVOICE_VOID < 0; source rules (INVOICE* need `invoice_id`, PAYMENT* need `payment_id`, OPENING/ADJUSTMENT neither); ADJUSTMENT needs a note; one entry per event (partial UNIQUEs); one OPENING per customer |
| `invoices` | Immutable header snapshot (all fields in §5); UNIQUE `invoice_no`, `seq_no`, `request_id`; POSTED/VOID; RETAIL/WHOLESALE; formula CHECKs; void-metadata CHECK |
| `invoice_items` | Product line snapshot; `qty_base > 0` (includes free goods); `0 ≤ scheme_qty_base ≤ qty_base`; `discount_bps` 0–10000 or NULL; `net = gross − discount − scheme_minor`; `ctn_count` nullable `≥ 0`; frozen `cost_minor`; UNIQUE `(invoice_id, line_no)` |
| `invoice_item_quantities` | One row per unit; unit name/short name/`unit_base_qty` snapshots; `amount = quantity × unit_price`; `qty_base = quantity × unit_base_qty`; UNIQUE `(invoice_item_id, unit_id)` |
| `invoice_change_log` | Append-only audit (`field`, `old_value`, `new_value`, `changed_at`, `note`) |
| `stock_receipts` | UNIQUE `receipt_no`, `request_id`; free-text supplier; POSTED/VOID with reason/date |
| `stock_receipt_items` | Snapshots; `qty_base = quantity × unit_base_qty`; `line_cost = quantity × unit_cost`; composite FK: the unit must belong to the line's product |
| `stock_adjustments` | 8 fixed reason codes; IN/OUT/VALUE; reason↔direction mapping of plan §8.6; VALUE ⇒ `qty_base = 0`, no unit, `value > 0`; IN/OUT ⇒ unit + quantity and `qty_base = quantity × unit size`; receipt link required exactly for the two receipt corrections; `reason_note` required; value stored as a magnitude |
| `stock_movements` | Append-only source of truth; 9 types; sign CHECKs; exactly one source, of the right kind; partial UNIQUEs against duplicate sources |
| `payments` | `amount > 0`; CASH/BANK/CHEQUE/OTHER; `invoice_id` optional (running account); POSTED/VOID with reason/time/date |
| `expense_categories` | `name` NOCASE UNIQUE; SHOP/GENERAL |
| `expenses` | `request_id` UNIQUE; `amount > 0`; ACTIVE/VOID; editable, never deleted |
| `settings` | `key` PK; `value` must be valid JSON (`json_valid`); per-key validation stays in the future service |
| `sequences` | `name` PK; `next_value > 0` |
| `schema_migrations` | `version`, `name`, `applied_at`, `app_version`, `checksum` (must be `sha256:` + 64 lowercase hex); append-only |

**Stock movement sign rules**

| Types | Quantity | Value | Source |
|---|---|---|---|
| OPENING, ADJUST_IN | > 0 | ≥ 0 | adjustment |
| STOCK_IN | > 0 | ≥ 0 | receipt line |
| SALE_VOID, SALE_RETURN | > 0 | ≥ 0 | invoice line |
| SALE | < 0 | ≤ 0 | invoice line |
| STOCK_IN_VOID | < 0 | ≤ 0 | receipt line |
| ADJUST_OUT | < 0 | ≤ 0 | adjustment |
| COST_CORRECTION | = 0 | ≠ 0 | adjustment |

Unique sources: one STOCK_IN and one STOCK_IN_VOID per receipt line, one SALE and one SALE_VOID per invoice line, one movement per adjustment. SALE_RETURN may repeat (partial returns later).

---

## 5. Ambiguous business fields: how they stay flexible

| Field | Decision | Schema |
|---|---|---|
| A1 Packing | Display/print text only | `products.packing_label`, `invoice_items.packing_label` snapshot. No constraint, view or trigger reads it (tested: arbitrary labels are stored verbatim and create no units) |
| A2 Units | Generic model; names are data | `product_units` with integer `base_qty`; nesting/divisibility left to the service |
| A3 Mixed-unit sales | One line, several quantity rows | `invoice_item_quantities` (tested: 2 Box + 5 Piece = one line, 53 base units) |
| B1 Invoice Code | Unknown meaning | `invoices.invoice_code TEXT NULL`, derived from nothing, stored verbatim |
| B2 Ctn | Informational | `invoice_items.ctn_count INTEGER NULL ≥ 0`; never used in stock math |
| B3 Sch | Both effects possible | `scheme_qty_base` (free goods: inside `qty_base` and COGS, no revenue) **and** `scheme_minor` (money deduction, no stock effect); header `line_scheme_minor` |
| B4 Dispatch | Optional, editable after saving | `bilty_no`, `transport_name`, `adda_name`, `dispatch_updated_at`; the only header columns a trigger lets change; changes go to `invoice_change_log` (the service decides which fields it logs) |
| B5 Discounts | % or fixed | `discount_bps` (NULL for a fixed amount) + final `discount_minor`; header `extra_discount_minor` |
| B6 Totals | V1 formulas | DB CHECKs: `net = gross − line_discount − line_scheme − extra_discount`; `total = net + freight`; `net_outstanding = previous_balance + total − received`. Amount in words is not stored |
| B7 Numbers | Sequence table | `sequences`, settings `invoice.prefix "INV-"`, `invoice.padding 6`, `invoice.startNumber 1`; `invoice_no` and `seq_no` both UNIQUE |

All historical values (customer details, product/company/packing, unit names and sizes, prices, discounts, costs) are snapshots on the document rows.

---

## 6. Views

| View | Columns | Definition |
|---|---|---|
| `v_product_stock` | `product_id, qty_base, value_minor` | `products LEFT JOIN stock_movements`, `coalesce(sum(…), 0)` — products without movements show 0 / 0 |
| `v_customer_balance` | `customer_id, balance_minor` | `customers LEFT JOIN customer_ledger`, `coalesce(sum(…), 0)` — customers without entries show 0 |

---

## 7. Indexes (40 explicit)

- `products`: name, company, active · `product_units`: `ux_product_units_one_base` (partial)
- `customers`: name, shop_name, phone, city
- `customer_ledger`: (customer_id, entry_date, id), entry_date, partial UNIQUEs per invoice event, per payment event, one OPENING per customer
- `invoices`: date, (customer, date), (status, date), invoice_code, bilty_no
- `invoice_items`: product · `invoice_item_quantities`: unit · `invoice_change_log`: (invoice, id)
- `stock_receipts`: date · `stock_receipt_items`: product, (unit, product)
- `stock_adjustments`: product, date, receipt, (unit, product)
- `stock_movements`: (product, id), (product, movement_date), movement_date, (type, movement_date), partial UNIQUEs for receipt-line, invoice-line and adjustment sources
- `payments`: (customer, date), date, invoice · `expenses`: date, (category, date)

UNIQUE table constraints add SQLite's own autoindexes on top of these.

---

## 8. Triggers (23)

| Tables | Rule |
|---|---|
| `customer_ledger`, `stock_movements`, `invoice_items`, `invoice_item_quantities`, `invoice_change_log`, `stock_receipt_items`, `stock_adjustments`, `schema_migrations` | `trg_<table>_no_update`, `trg_<table>_no_delete`: every UPDATE and DELETE is refused (append-only) |
| `invoices` | `trg_invoices_guard_update`: 27 protected columns never change; status/void columns change only on **POSTED → VOID** (the table CHECK then requires reason, `voided_at`, `void_date`); the 4 dispatch columns may change. `trg_invoices_no_delete` |
| `payments` | Guard: only POSTED → VOID with its details; no delete |
| `stock_receipts` | Guard: only POSTED → VOID with reason/date; no delete |
| `expenses` | `trg_expenses_no_delete` (expenses are edited or voided) |

The guards compare with `COLLATE BINARY`, so even a change of letter case is refused. The invoice guard was **not** fragile to implement; a test checks every column of `invoices` is either protected, dispatch or void, so a future column added without updating the guard fails the tests. Master data (companies, products, units, customers, categories, settings) stays editable; referenced rows cannot be deleted (FK RESTRICT).

---

## 9. Change to a Phase 3A file: `recursive_triggers = ON`

SQLite's `INSERT OR REPLACE` deletes a conflicting row **without firing its DELETE triggers** unless `recursive_triggers` is on. That would let anyone silently overwrite a ledger row or swap an invoice line's SALE movement. Demonstrated in the scratchpad:

```
recursive_triggers = OFF: INSERT OR REPLACE succeeded; rows now [{"id":1,"amount":999}]
recursive_triggers = ON:  INSERT OR REPLACE refused (SQLITE_CONSTRAINT_TRIGGER: append-only); rows now [{"id":1,"amount":100}]
```

The pragma is added to `CONNECTION_PRAGMAS`, set on every open and read back like the other four. Our triggers only `RAISE`, so recursion cannot occur. The immutability tests cover REPLACE, UPSERT and `UPDATE OR REPLACE`.

---

## 10. Seed rows

| Table | Rows |
|---|---|
| `settings` (JSON) | `business.name "StockFlow"`, `currency.code "PKR"`, `currency.symbol "Rs"`, `currency.minorDigits 2`, `invoice.prefix "INV-"`, `invoice.padding 6`, `invoice.startNumber 1`, `invoice.paperSize "A4"`, `backup.autoEnabled true`, `backup.keepDaily 14`, `backup.keepMonthly 12`. **No negative-stock setting.** |
| `sequences` | invoice 1, receipt 1, payment 1, adjustment 1, **customer 2** (see §16) |
| `customers` | id 1, `C-00001`, "Cash / Walk-in" |
| `expense_categories` | Shop Expenses (SHOP), Monthly / General Expenses (GENERAL), Freight Paid (SHOP), Purchase Cost Correction (GENERAL) — the ones the plan names (§7.3, D4, §8.5); editable data |

No products, units, companies, stock, invoices, payments, ledger entries or expenses are seeded (tested and confirmed in both runtime databases).

---

## 11. Migration checksum and metadata

- **How it is generated:** SHA-256 over the UTF-8 bytes of `INITIAL_SCHEMA_SQL` (the exact script `up()` executes), written `sha256:` + 64 lowercase hex digits. The helper functions in the file only build that text; the checksum covers the text they produce.
- **Line endings:** JavaScript template literals always yield LF, so the value does not depend on git's CRLF conversion; a test asserts the script contains no `\r`.
- **Pinned, never regenerated:** the literal lives in `0001_initial.ts`. Two tests guard it: the literal must equal the hash of the script, and a "shipped checksums" table in the test file must still match. Production code never computes a checksum. Prettier reformatted the file after pinning; the tests confirmed the SQL text was unchanged.
- **Metadata:** `recordSchemaMigration(appVersion)` inserts `(version, name, applied_at = UTC now, app_version, checksum)` inside the migration's own `BEGIN IMMEDIATE` transaction, after `up()` and the `user_version` update. Result in the packaged run:

```json
{"version":1,"name":"0001_initial","applied_at":"2026-09-14T04:37:42.171Z","app_version":"1.0.0",
 "checksum":"sha256:0cc4eb9837b99f71442ed9e8bbd48723f869bcbc8fb2f4d8b0dcd90bee576cc4"}
```

---

## 12. Tests

**688 tests in 28 files, all passing** (`npm test`, Electron-as-Node). 403 Phase 0–3A tests remain (the Phase 2 domain suites unchanged); 285 are new.

| File | Tests |
|---|---|
| `0001_constraints.test.ts` | 209 |
| `0001_immutability.test.ts` | 47 |
| `0001_initial.test.ts` | 18 |
| `0001_views_snapshots.test.ts` | 7 |
| `index.test.ts` | 14 (+4) |

Test-first: the new tests were written against the designed schema and seen failing (`no such table: companies`, `recordSchemaMigration is not a function`, 270 failures) before `0001_initial.ts` existed. Two expectations were then corrected, not the schema: the checksum placeholder, and five "delete a referenced master" tests (see §16, item 2).

**Migration** — new DB 0 → 1; `schema_migrations` row with app version and checksum; idempotent second start (no re-migration, no re-seed); atomic: a failure late inside 0001's script leaves no object and schema 0, and a failing recorder rolls 0001 back; exact lists of tables (all STRICT), views, indexes, triggers; every money/quantity/bps column INTEGER, every date/timestamp TEXT, no other types; every FK RESTRICT; `integrity_check` ok and `foreign_key_check` empty; newer database refused; an existing schema-0 database with data is refused and left unchanged.

**Constraints** (directly against SQLite) — company/product/customer code uniqueness (case-insensitive); identical customer names allowed; one base unit; base unit size 1; duplicate unit size/name; negative prices, sizes, flags; packing label verbatim; STRICT type errors; 10 malformed dates and 7 malformed timestamps; duplicate invoice no./seq no./request id (and for receipts, adjustments, payments, expenses); malformed status/tier/method/group/reason/direction; every negative invoice money value with otherwise consistent totals; formula mismatches; advances allowed; void metadata; line and quantity-row arithmetic; zero-cost receipt lines allowed; unit of another product refused; all 14 valid and 19 invalid movement sign cases; missing, double and wrong-kind sources; duplicate sources; ledger signs, sources and one-entry-per-event; payment/expense amounts ≤ 0; JSON settings; sequence values; checksum format; deletes of referenced masters refused.

**Append-only** — UPDATE (even a no-op) and DELETE (one row, all rows) refused by SQLite for all 8 append-only tables, rows unchanged; REPLACE, UPSERT and `UPDATE OR REPLACE` cannot bypass; invoice guard: dispatch update and POSTED → VOID allowed, 27 protected columns each refused, letter-case change refused, un-void/re-void refused, void without details refused, delete refused; the same for payments and receipts; expenses editable but not deletable; masters editable.

**Views** — sums of quantity and value (18 base units, 254,000 minor, including a cost correction), 0 for a product without movements, live after new movements; balance 193,000 = the invoice's net outstanding, 0 for the walk-in customer.

**Snapshots** — after changing the customer, company, product (code, name, packing) and units (name, size 24 → 12, prices), the saved invoice header, lines, quantity rows and receipt lines are identical to what was saved.

**Backup boundary** — a hypothetical `0002` against a schema-1 database is refused with `BACKUP_FAILED` by the Phase 3A placeholder; version, objects and `schema_migrations` unchanged.

### Coverage (`npm run test:coverage`)

| Scope | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| **All measured files** | **541/541** | **262/262** | **140/140** | **484/484** |
| `main/db` (incl. migrations) | 138/138 | 47/47 | 44/44 | 132/132 |
| Phase 2 domain library | 313/313 | 185/185 | 70/70 | 271/271 |

---

## 13. Builds

| Command | Result |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run lint` | ✅ 0 problems |
| `npm test` / `npm run test:coverage` | ✅ 688 / 688, 100% |
| `npm run build` | ✅ main **44.73 kB** (3A: 17.12 kB — the schema text is embedded), preload 1.04 kB, renderer JS 1,247.13 kB, CSS 33.41 kB (unchanged) |
| `npm run build:unpack` | ✅ `app.asar` 7.48 MB; `app.asar.unpacked` 17 files / 1.89 MB; driver binary unchanged (SHA-256 `C9C931F06EAAEF78…`) |

---

## 14. Documentation correction (internet)

`README.md` and item 3 of the Phase 3A report's "Needs attention" now say: internet access is needed on the **developer/build machine** when it installs or rebuilds the native dependencies; the **packaged installer and app already contain the native binary**, so installing and running StockFlow needs no internet.

---

## 15. Runtime verification (temporary appData)

Setting the `APPDATA` variable does **not** move Electron's appData (tested: Electron asks Windows for the known folder). So each run started the app paused (`--inspect-brk`), called `app.setPath('appData', <temp>)` on the paused frame before any app code ran, confirmed the value, and only then resumed; otherwise the app would have been killed while still paused. The app code itself was not modified. Temporary roots: `%TEMP%\stockflow-verify-packaged\Roaming` and `%TEMP%\stockflow-verify-dev\Roaming`, both deleted afterwards.

| Check | Packaged (`StockFlow.exe`) | Dev (`electron-vite dev`) |
|---|---|---|
| Starting point | copy of the Phase 3A schema-0 DB | no database |
| Redirect applied before app code; `userData` = temp `StockFlow` / `StockFlow-dev` | ✅ | ✅ |
| Security: sandbox/contextIsolation/webSecurity on, nodeIntegration off; `window.electron` undefined; `window.api` = only `app.info`, frozen, not replaceable; no Node globals; main handles only `app:info` | ✅ | ✅ |
| Menu / DevTools | none / cannot open ✅ | present / open ✅ |
| `app.info()` → schema **1**, SQLite 3.53.2, better-sqlite3, `%APPDATA%\…\data`, no user path; bad input → `VALIDATION` | ✅ | ✅ |
| CSP, `window.open`, external fetch and navigation blocked | ✅ | ✅ |
| Sidebar 11 links, all routes (placeholders), 404, theme tokens, 224 px sidebar | ✅ | ✅ |
| Settings → About shows **Schema version 1** | ✅ | ✅ |
| Second instance exits (code 0), first keeps working | ✅ | — |
| No unexpected console errors | ✅ | ✅ |
| Clean shutdown: only `shop.db` left | ✅ | ✅ |
| Resulting DB: STFL id, `user_version` 1, WAL, 94 pages; integrity ok; 0 FK violations; 19 STRICT tables, 2 views, 40 indexes, 23 triggers; `schema_migrations` row from this run; seeds as §10; **0 business rows** | ✅ | ✅ |
| Real `%APPDATA%\StockFlow` and `StockFlow-dev` databases byte-for-byte unchanged | ✅ | ✅ |
| **Total** | **42 / 42** | **41 / 41** |

The scripts (`verify-phase3b.mjs`, `cdp.mjs`, `inspect-schema.cjs`) and screenshots are in the session scratchpad, not the project.

---

## 16. Decisions, deviations and risks

1. **`sequences.customer` is seeded as 2, not 1.** The walk-in customer is `C-00001`; a value of 1 would make the first customer the app creates collide with it. Everything else in the sequence table is 1.
2. **FK RESTRICT is reported as a trigger error.** SQLite implements `ON DELETE RESTRICT` with an internal trigger, so a refused delete of a referenced master arrives as `SQLITE_CONSTRAINT_TRIGGER` with the message "FOREIGN KEY constraint failed", not `SQLITE_CONSTRAINT_FOREIGNKEY` (inserts with a missing parent still report `…FOREIGNKEY`). Services (Phase 5+) should check references before deleting, or recognise that message.
3. **`STOCK_IN` allows value 0** (your example said `> 0`). `stock_receipt_items.line_cost_minor ≥ 0` (also your spec) permits zero-cost lines such as supplier bonus goods, and their movement must be recordable. The same applies to OPENING and ADJUST_IN (average cost can be 0). Outflows allow value 0 (COGS of zero-value stock). Changing an append-only ledger's CHECK later would need a table rebuild, so the wider rule is the safer default.
4. **Cost corrections store a magnitude on the adjustment.** As specified, `stock_adjustments.value_minor ≥ 0`; for a VALUE (cost) correction the sign lives only in its `COST_CORRECTION` movement. Phase 6 must write both consistently (one movement per adjustment is enforced).
5. **`previous_balance_minor` and `net_outstanding_minor` may be negative** (customer advance). All other invoice money is `≥ 0`.
6. **A zero-total invoice cannot have a ledger entry** (`amount ≠ 0`, INVOICE > 0). If free-only invoices ever occur, Phase 8 must skip that entry, and the integrity check must allow it.
7. **Added beyond the minimum:** append-only triggers also on `stock_receipt_items`, `stock_adjustments` and `schema_migrations`; POSTED → VOID guards on payments and receipts; no-delete on expenses; composite FKs so a receipt or adjustment unit must belong to its product; `json_valid` on settings; checksum-format CHECK.
8. **Left to services:** unit nesting, unit locking after stock activity, "quantity-row unit belongs to the line's product", header = Σ lines, negative-stock prevention, posting-date floors, sequence allocation, the change-log field list.
9. **The technical DBs on this PC are still schema 0** (untouched by verification). The next normal launch of the packaged app or of `npm run dev` will migrate them to schema 1 (allowed because they are empty). Delete them first if you prefer a fresh file.
10. **Backup boundary:** until Phase 4 replaces the placeholder, any future migration of a schema-1 database is refused — the intended behaviour (tested).
11. **Editing the schema before approval:** the checksum is pinned now; if you ask for schema changes before 0001 ships, the pinned value is updated once, deliberately, in both places.

---

## 17. Confirmation

- Phase 3B is schema + migration integration + tests only.
- **No Phase 4 work:** no backup system, restore UI, automatic backups or settings UI (only the existing About card).
- **No business services, IPC calls or screens:** products, stock, customers, invoices, payments, expenses, reports and printing were not started. `window.api` still exposes only `app.info`.
- better-sqlite3 stays at **12.11.1**, exactly pinned; 13.x was not attempted.
- Phase 0 security, the Phase 1 shell/theme/routes, the Phase 2 domain library and the Phase 3A foundation are preserved and verified.
- The implementation plan was not modified.
- **Nothing was committed.**
