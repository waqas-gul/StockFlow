# StockFlow — Phase 5 Implementation Report

> **Phase:** 5 — Companies + Products + Product Units. **Date:** 2026-09-16. **Status:** implemented and verified. **Awaiting approval.**
> Nothing was committed. Schema is still **1**: no 0002, `0001_initial` unchanged, and no schema defect was found. Phase 6 was not started.

## 1. What was implemented

- **Companies.** List, create, rename, and activate/deactivate. There is no delete.
  - Managed from a small **Manage Companies** dialog.
  - The product form has a **New company** quick-add, which selects the new company.
- **Products.** The Products placeholder is replaced by a real page:
  - Title, **Add Product** and **Manage Companies**.
  - Search, a company filter and a status filter (Active, Inactive, All).
  - Server-side paging, 25 rows per page.
  - Table columns: Code, Product (with its unit names), Company (marked "(inactive)" when it is), Packing, Stock, Wholesale, Retail, Status, and Edit and Deactivate/Activate actions.
- **The Add/Edit Product dialog** has two sections:
  - **Basic Information:** code, name, optional company, packing, low-stock level.
  - **Units & Prices:** editable rows with Unit, Short name, Base qty, Base unit, Sell?, Purchase?, Wholesale, Retail, Default cost and Active.
    - Rows can be moved up and down, added and removed.
    - The base unit row is highlighted, labelled "Base unit", and its base quantity is fixed at 1.
- **Prices:**
  - Amounts are typed normally (`1250`, `1250.50`, `1,250.50`) and parsed with the Phase 2 `parseMoney`.
  - They are stored as integer minor units, and an empty field means "not set".
  - They are shown with the Settings currency symbol and decimal places. Paisa integers are never shown.
- **Price column:** shows the first active, sellable unit with a price (for example "Rs 10.00 / Pcs"), plus "+N more unit". The tooltip lists every price.
- **Stock column:** comes from `v_product_stock` in the product's units ("0 Piece", "2 Box + 5 Piece"). Nothing is invented.
- **Deactivating a product with stock:** a confirmation shows the required warning, and the product is deactivated. Stock and history stay.

## 2. Services / API added

**Main process:**
- `companies.service.ts`: `listCompanies`, `createCompany`, `updateCompany`, `setCompanyActive`.
- `products.service.ts`: `listProducts`, `getProduct`, `createProduct`, `updateProduct`, `setProductActive`, `searchProducts`.

All business logic and SQL are in main, and every service parses its input again (`parseInput`).

**Shared Zod schemas:**
- `src/shared/companies.ts`: company create and update.
- `src/shared/products.ts`: unit, product create and update, list input, search input, and `unitStructureIssues`.
- `src/shared/validation.ts`: id, text, whole-number and money helpers, and `{ id, active }`.

The form uses the same rules for its messages.

**IPC:** 10 new allow-listed calls, validated with the shared schemas at the boundary. There is no generic IPC, SQL or path.

```text
window.api.companies.list() · create({ name }) · update({ id, name }) · setActive({ id, active })
window.api.products.list({ page, pageSize ≤ 100, search, companyId, status }) · get(id)
window.api.products.create(product) · update(product) · setActive({ id, active }) · search({ query, limit ≤ 50, includeInactive })
```

**Errors** use the existing `Result`/`AppError` envelope, with plain messages and field errors. No SQLite text is ever shown.

| Case | Code and message |
|---|---|
| Duplicate company | `DUPLICATE` "A company named "X" already exists." |
| Duplicate product code | `DUPLICATE` "Another product already uses the code "X"." |
| Invalid unit structure | `VALIDATION`, with field errors on each unit field |
| Locked unit change | `UNIT_LOCKED` (new code) |
| Missing product or company | `NOT_FOUND` |
| Currency decimal places changed while the form was open | `CONFLICT` |

## 3. Product / unit rules

- **Unit structure,** using the Phase 2 `validateUnits` with plain messages:
  - exactly one base unit, with base quantity 1;
  - whole base quantities from 1 to 1,000,000;
  - unit names unique regardless of letter case;
  - no two units with the same base quantity;
  - sizes that nest ("Must be a whole multiple of 4 (Pack).");
  - 1 to 10 units, stored in display order.
- **Atomic saves:** a product and all its units are written in one transaction, and any failure writes nothing. Units can swap names, sizes or the base role in one save (temporary values avoid the row-by-row unique checks).
- **Locking** is read from the database (`stock_movements` for the product), never from the renderer. After any stock movement:
  - an existing unit's base quantity, the choice of base unit, and removing a saved unit are refused (`UNIT_LOCKED`);
  - names, short names, prices, costs, Sell and Purchase flags, and Active remain editable;
  - a new unit that still nests can be added.
- **Before any movement,** base quantities and the base unit can change. A saved unit can be removed unless a saved document refers to it.
- **Packing label:** stored exactly as typed and never parsed or used for units or stock.
- **Companies:**
  - Names are trimmed and unique regardless of case, including non-English letters.
  - An inactive company stays on its products, and a product may keep one. It cannot be chosen for a new product or a change of company.
- **No hard deletes:** products and companies are only deactivated.
- **Currency decimal places lock:** there is no new logic; the Phase 4C `hasMonetaryData` check is reused.
  - Products with no prices or costs leave it unlocked.
  - Any price or cost set, even 0, locks it, as the Phase 4C rule treats a non-NULL amount as financial data.
  - Settings reflects the lock after a save.

## 4. Files changed

| Kind | Files |
|---|---|
| **New (24)** | `src/shared/{companies,products,validation}.ts` |
| | `src/main/services/{companies,products}.service.ts` and their tests |
| | `src/renderer/src/components/ui/{dialog,select,checkbox,table}.tsx` (shadcn, on the existing `radix-ui`; no new dependency) |
| | `src/renderer/src/lib/use-debounced-value.ts` |
| | `src/renderer/src/features/products/`: `ProductsPage`, `ProductsTable`, `ProductForm`, `ProductFormDialog`, `CompaniesDialog`, `product-form`, `product-display`, `product-actions`, and 4 test files |
| **Changed (12)** | `src/shared/ipc-contract.ts` (+ test) |
| | `src/shared/types/result.ts` (`UNIT_LOCKED`) |
| | `src/shared/settings.ts` (uses the shared `wholeNumber`; rules unchanged) |
| | `src/main/errors.ts` (`parseInput`) |
| | `src/main/ipc/index.ts` (+ test) |
| | `src/preload/api.test.ts` |
| | `src/renderer/src/app/routes.ts` (+ test: `/products` goes to the Products page) |
| | `src/renderer/src/lib/{query-keys,app-queries}.ts` |

## 5. Targeted tests

| File | Tests | Covers |
|---|---|---|
| `companies.service.test.ts` | 15 | create; duplicate names (case, spaces, non-English letters); validation; rename; deactivate/reactivate; not found; strict input |
| `products.service.test.ts` | 56 | see below |
| `ipc/index.test.ts` | 8 new | companies and products end to end; clean duplicate, structure and not-found errors; boundary refusals |
| `product-form.test.ts` | 16 | form validation; amounts parsed to minor units; blank means not set; unit structure messages; base unit choice; removability; edit form values; server errors on fields |
| `product-display.test.ts` | 4 | money formatting; compact price choice; stock text |
| `product-actions.test.ts` | 6 | successful create and update flow; **duplicate code shown on the Code field**; IPC failure without raw text; deactivate warning |
| `ProductsUi.test.tsx` | 7 | table content; new-product form; locked form with stock history; unlocked saved product; page with rows and empty state; companies manager |
| `routes.test.ts` | +1 | `/products` goes to the Products page |

The 56 products tests cover:
- **Create:** one base unit and packing kept exactly; multi-unit product with minor-unit prices; company link; duplicate code.
- **Validation:** 13 invalid unit structures, including non-nesting sizes, duplicate names and sizes, and base-unit rules.
- **Atomic failure:** a unit fails mid-transaction and nothing is saved.
- **Companies and currency:** inactive or missing company; currency conflict.
- **The Phase 4C lock:** unpriced products leave it unlocked; wholesale, retail or cost (even 0) lock it; so does a price added later.
- **Edit:** basic fields and prices; own and other codes; unknown unit.
- **Before a stock movement:** resize, rebase, remove, add, and a name/size/base swap.
- **After a stock movement:** size change refused, base change refused, removal refused; names, prices, flags and Active still allowed; compatible unit added and incompatible one refused.
- **Deactivate/reactivate** with and without stock (warning).
- **List and search:** code, part of a code, name, company, several words, and `%`/`_` as plain text; status and company filters; paging; limits; exact code ranked first.

**Deliberate-break check:** disabling the unit-swap handling and the lock check made 4 tests fail. Restoring the code made them pass.

## 6. Full test result

- `npm run typecheck` ✅
- `npm run lint` ✅ 0 problems
- `npm test` ✅ **1340 / 1340** in 60 files (Phase 4C: 1228 in 54)

## 7. Build result

- `npm run build` ✅ main 178.09 kB, preload 2.87 kB, renderer 1,830 kB (Phase 4C: 1,668 kB).
- `npm run build:unpack` ✅. It was not required; it was used only for the isolated manual check, and no packaging problem appeared.

## 8. Manual verification

The packaged app ran on a **temporary** data folder with dialogs stubbed, and the steps were driven through the real UI with mouse and keyboard events. **24 / 24** checks passed.

| # | Check | Result |
|---|---|---|
| 1 | Add a company (Manage Companies); "ACME foods" refused as a duplicate with a plain message | ✅ |
| 2 | Add a product with one base unit (Kg); no price yet, so decimal places stay unlocked | ✅ |
| 3/4 | Add Piece + Box with company Acme Foods, wholesale and retail prices and a cost; table shows "Rs 10.00 / Pcs +1 more unit"; decimal places locked | ✅ |
| — | Base qty "2.5" refused next to the field; duplicate code "tea-01" refused under Code, dialog stays open | ✅ |
| 5 | Search by code (`tea-0`), name (`SUGAR`) and company (`acme`) | ✅ |
| 6 | Edit Box retail to 1350: stored as 135000; the form showed "1300.00", not paisa | ✅ |
| 7 | Deactivate hides the product from Active; Inactive filter shows it; Activate restores it | ✅ |
| 8 | Table stock is "0 Piece" and "0 Kg" | ✅ |
| 9 | Packing stored exactly ("1*12*18", "1*10"); units only as entered | ✅ |
| 10 | Stock In is still a placeholder; `window.api` has no stock calls; `window.electron` undefined | ✅ |
| 11 | Settings shows decimal places locked; manual backup verified; integrity check OK; recovery mode still offered for a damaged database | ✅ |
| — | Test stock movement of 53 (temporary DB only): table shows "2 Box + 5 Piece"; edit form shows the lock (size and base read-only, remove disabled, names editable); main refuses a size change (`UNIT_LOCKED`) and accepts a rename and price change | ✅ |
| — | Schema 1 with the pinned checksum; log holds no profile path or product data; real `%APPDATA%\StockFlow` and `StockFlow-dev` unchanged | ✅ |

The Products page and the Edit Product dialog were also checked in screenshots.

## 9. Needs attention

1. **Phase 4C is still uncommitted** in the working tree. Phase 5 touches some of the same files: `ipc-contract.ts`, `ipc/index.ts`, `types/result.ts` and `settings.ts`, with their tests.
2. **Case-insensitive matching for non-English letters:**
   - Product **codes** and **search** use SQLite `NOCASE`/`LIKE`, which fold English letters only.
   - Company names are also compared in full lower case in the service.
3. **Rules I added:**
   - The base unit is always active.
   - A saved unit can be removed before stock history only if no document refers to it.
   - After stock history, any new unit that still nests may be added, not only a larger one; stock is in base units, so nothing is reinterpreted.
4. **Saving checks the currency decimal places** against the current setting (`CONFLICT` if they changed while the form was open).
5. **Deferred to later phases:** low-stock level alerts (the level is only stored), and the deactivate-with-stock warning (visible only once Phase 6 creates stock; tested with a test movement).
6. **Amounts use international grouping** ("Rs 1,250.50"); there is no South-Asian grouping setting.
7. **Limits:** code 30, name 120, packing 40, company 80, unit name 30, short name 12; up to 10 units; base quantity up to 1,000,000.
8. **The renderer bundle grew by about 160 kB** (dialog, select and checkbox components). No new dependency.
9. **The manual check was automated UI driving** plus screenshots, not a person clicking.
