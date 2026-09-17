# Phase 10 — Expenses: Implementation Report

Status: implemented and verified. **Nothing committed.**
- **Schema:** still **2**. No migration; `0001`/`0002` are unchanged.
- **Not started:** Phase 11 (reports, P&L, dashboard cards).
- **Untouched:** invoice, stock and customer accounting.

## 1. Implemented functionality

- **Expenses page** (`#/expenses`, replacing the placeholder):
  - summary cards for Shop Expenses, Monthly / General Expenses and Total Expenses;
  - filters: search, date range, group, status;
  - a 25-row paged table with Edit and Void;
  - Add Expense and Manage Categories buttons.
- **Add / Edit Expense dialog:** Date (default today, max today), Category (active categories with their group), Amount, Description.
  - The chosen category's group is shown underneath ("Shop expense" / "Monthly / General expense").
- **Void Expense confirmation:** shows the date, category (group), amount and description, and says the expense stays as void, leaves the totals and cannot be edited or restored.
- **Manage Categories dialog:** add with name and group; inline edit of name and group; activate or deactivate; the expense count per category. There is no delete.

**Rules (all enforced in the main process)**
- **Amount:** a whole number of minor units above zero. It is typed as "1250", "1250.50" or "1,250.50" and read by the Phase 2 money parser in the currency's decimal places. The amount is sent with those decimal places; a mismatch gets the existing `CONFLICT`. The first expense locks the setting (the Phase 4C lock already counts expenses).
- **Date:**
  - today or earlier by the main process clock;
  - no posting-date floor (expenses touch no other ledger);
  - `DATE_NOT_ALLOWED` "The expense date cannot be after today (17-Sep-2026)." shown under Date.
- **Category:**
  - must exist (`NOT_FOUND`) and be active: `FORBIDDEN_STATE` "This expense category is inactive.";
  - an edit may keep the expense's current category even if it has become inactive, but cannot move it to another inactive one.
- **Idempotent create:** `expenses.request_id` is unique. The same request id returns the saved expense (`replayed: true`) and writes nothing; the dialog keeps one request id per new expense.
- **Edit:** active expenses only; all fields are validated again, and `updated_at` is set. A void expense gives `FORBIDDEN_STATE` "This expense is void, so it can no longer be edited."
- **Void:** active → void. A second void gives `FORBIDDEN_STATE` "Expense is already void."
  - There is no void reason, because the schema has no column for one.
  - The row is never deleted (existing trigger), and a void expense never changes again.
- **Summary:** sums of **ACTIVE** expenses by category group for the page's date range. Void expenses never count. It is not P&L.
- **Freight Paid and Purchase Cost Correction** are ordinary categories:
  - invoice `freight_minor` (freight charged to customers) is not linked to Freight Paid;
  - a Phase 6 receipt-cost correction creates no expense.

## 2. Category / group model

- **Table:** the existing `expense_categories` (`name` NOCASE unique, `grp` SHOP|GENERAL, `is_active`), with the four seeded rows kept:
  - Shop Expenses (SHOP)
  - Monthly / General Expenses (GENERAL)
  - Freight Paid (SHOP)
  - Purchase Cost Correction (GENERAL)
- **Labels:** SHOP = "Shop", GENERAL = "Monthly / General". "Monthly" only names the group; nothing repeats.
- **Names:** trimmed and required (at most 60 characters). Duplicates are refused regardless of letter case with `DUPLICATE` "Another expense category already uses this name." Renaming a category to itself in another case is allowed.
- **No hard delete** (no API). An inactive category stays visible on its expenses (marked "(inactive)") and in Manage Categories.
- **Groups are not copied onto expenses:** changing a category's group moves its existing expenses into that group's totals. The dialog says so.

## 3. APIs and screens

`expenseCategories`:
- `list()`
- `create({ name, group })`
- `update({ id, name, group })`
- `setActive({ id, active })`

`expenses`:
- `list({ page, pageSize, search, group, status, dateFrom, dateTo })`: newest first; search words match the description or the category name
- `summary({ dateFrom, dateTo })`
- `get(id)`
- `create({ requestId, expenseDate, categoryId, amountMinor, description, currencyMinorDigits })`
- `update({ id, … })`
- `void(id)`

All calls are strict Zod schemas in `src/shared/expenses.ts`, validated at the IPC boundary and again in the services (`expense-categories.service.ts`, `expenses.service.ts`). There is no raw SQL or generic IPC. SQLite messages are never exposed (the existing handler).

**Renderer** (`features/expenses/`): `ExpensesPage`, `ExpenseFormDialog`, `VoidExpenseDialog`, `ExpenseCategoriesDialog`, `expense-form.ts`, `expense-actions.ts`.
- After any change, `refreshAfterExpenseChange` re-reads the expense list, the summary, the categories and settings, and nothing else.

## 4. Tests / build / manual

- `npm test`: **1872/1872 in 92 files** (Phase 9B: 1821 in 88). Typecheck, lint and prettier (src) are clean.
- `npm run build` succeeds:
  - main 327.29 kB
  - preload 7.27 kB
  - renderer JS 2,244.28 kB
- **New tests:**
  - **Service:**
    - seeded categories; create, trim, duplicate (case), blank, bad group; rename and group change; deactivate and reactivate;
    - Shop and General create; replay; future and invalid dates; amount validation; inactive and missing category; currency decimal places and lock;
    - invoice, stock, payment and customer tables unchanged;
    - edit (every field, validation, inactive category kept); void, double void, no edit after void, no delete;
    - list order and pagination; search by description and category; group, status and date filters; summary totals, with void excluded and following edits, voids and group changes.
  - **IPC:** end to end (categories, create, replay, future date, list, summary, update, void, double void, lock) and 11 boundary refusals. The contract test asserts there is no delete call.
  - **Renderer:**
    - amount parsing ("1,250.50", decimals, zero, 0-digit currency), required fields, edit prefill;
    - inactive categories not offered;
    - server field-error mapping, summary range text;
    - save/replay/edit/void messages (raw errors never shown);
    - the refresh invalidates list, summary, categories and settings but not invoices.
  - **UI (SSR):**
    - page cards and table (group labels, "(inactive)", a void row without Edit/Void, filters, pager);
    - Add and Edit form;
    - void confirmation;
    - Manage Categories.
- **Deliberate-break check:** 15 key rules switched off one at a time, all caught; files restored exactly.
- **Manual check** (built app on a temporary appData, real UI through CDP): **20/20**. The real StockFlow folders are unchanged and the temporary data was removed. It covered:
  1. Shop expense.
  2. Monthly / General expense.
  3. Separate totals.
  4. Custom category "Rent": duplicate refused, Freight Paid deactivated and no longer offered, Rent counted as General.
  5. Edit (prefilled "1250.50").
  6. Void with confirmation.
  7. The void expense leaves the totals; a second void is refused.
  8. Filters: status, group, search by description and by category, date range (cards follow it).
  9. A future date refused by the main process.
  10. Invoices, lines, stock, receipts, customer ledger, payments, customers, products and sequences byte-identical.

  Idempotent create was also confirmed through the real IPC call.

## 5. Needs attention

1. **Error codes:**
   - A duplicate category name uses the existing `DUPLICATE` code (as company names and product codes do), not `CONFLICT`.
   - A future date uses the existing `DATE_NOT_ALLOWED`.
   - `CONFLICT` keeps its meaning: currency decimal places changed while a form was open.
2. **No void reason or void date** (the schema has neither). A void expense only has its `updated_at` time.
3. **No edit history** (per the V1 policy): an edit overwrites the expense; only `updated_at` changes.
4. **Category group changes are retroactive:** past expenses move to the new group in totals, and in Phase 11 unless it adds snapshots.
5. **Renaming seeded categories is allowed** (e.g. Freight Paid, Purchase Cost Correction). Phase 11 should identify categories by id or group, not by name.
6. **Default status filter** is Active: a voided expense disappears from the default list (Void / All statuses show it).
7. **Summary range** follows only the page's From/To dates, not the search, group or status filters (the cards always total active expenses by group).
