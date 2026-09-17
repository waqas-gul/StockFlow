# Dashboard Visual Improvement: Report

The Dashboard is now a read-only overview of the shop in place of the old grid of navigation cards. There are no schema, migration or accounting changes, and nothing is committed.

## 1. Layout implemented

The page runs top to bottom as follows. The shop name, date and quick actions stay visible while figures load.

1. **Header:** the business name from Settings (StockFlow until one is set), "Overview of your shop today.", and **Today** with the business date on the right.
2. **Quick actions:** New Invoice (subtle amber icon), Stock In, Receive Payment and Add Expense. Receive Payment and Add Expense open their page with the form already open.
3. **Getting started (a new shop only):** "Start by adding products and recording stock." with Add Product, Stock In and New Invoice. It shows until there is stock on hand or an invoice.
4. **Six figure cards:** Today Sales, This Month Sales, Receivables, Customer Advances, Inventory Value and Low Stock.
   - Each card has a navy icon and a muted note.
   - Amber appears only on Low Stock when products need attention.
5. **Charts:**
   - **Sales Trend** (about 65% of the width) with 7 Days (default) and 30 Days. Hovering a day shows its date, sales and invoice count.
   - **Expenses This Month** (about 35%): a donut of Shop and Monthly / General, the total and a legend.
6. **Low Stock Products and Top Selling Products:**
   - Low stock lists up to 5 products with the current stock and the level in the product's units ("0 Piece", "Low at 1 Carton"), plus an amber Low or Out of stock badge. The footer has "Showing 5 of N." when there are more, and View All Products.
   - Top products shows 5 products for this month with revenue bars and the quantity sold, and View Sales Report (opens Reports → Products).
7. **Recent Activity:** three cards of 5 rows each, each with View all.
   - **Invoices:** number, customer, amount, Today, Yesterday or the date, and a Void badge. A row opens Invoice Detail.
   - **Payments:** customer, payment number, amount and date. A row opens the payment's details.
   - **Expenses:** category, description, amount and date.

**States**
- **Empty:** every figure is "Rs 0.00", with "No sales recorded for this period.", "No expenses recorded this month.", "No products yet." and similar messages. No chart line or donut slice is drawn without data.
- **Loading:** static grey placeholders, with no spinner and no animation.
- **Error:** the message and a Try Again button.

**Window widths:** the layout follows the width of the content area, not the whole window.
- Figure cards: 3 + 3 on a normal desktop, 6 in one row on a wide screen, and 2 or 1 per row when narrow.
- Charts, and the low-stock and top-products row: side by side, stacking below about 900 px.
- Recent activity: 3 cards per row on a wide screen, then 2 + 1, then 1.

The sidebar and the theme colours are unchanged. There are no gradients, animated counters or new colours.

## 2. Figures and where they come from

Each figure comes from an existing report or list service, called from the main process.

| Figure | Source (same rule as) |
|---|---|
| Today Sales, This Month Sales, invoice counts | `salesReport` for today / this calendar month: **Net Goods Sales** of POSTED invoices (the Reports → Sales headline; freight excluded, void invoices excluded) |
| Sales Trend | New `dailySalesReport`: the same POSTED-invoice net goods sales, grouped by invoice date, for the last 30 days (days without sales are zero) |
| Receivables, Customer Advances, customer counts | `customerBalancesReport` |
| Inventory Value, active product count | `stockReport` (current stock at average cost) |
| Low Stock | Active products with a low-stock level whose stock is at or below it (the Products page rule), taken from `stockReport` rows and listed with the lowest stock first compared with the level |
| Expenses This Month | `expenseReport` for this month: ACTIVE Shop and Monthly / General. Purchase cost corrections are kept apart, as in Reports, and noted under the chart when there are any |
| Top Selling Products | `productSalesReport` for this month, first 5 rows |
| Recent invoices, payments, expenses | `listInvoices`, `listPayments`, `listExpenses`: page 1 of 5, newest first by business date |

- **Payments:** never counted as sales.
- **Voided invoices and expenses:** they appear in the recent lists with a Void badge but never in a total.
- **Low Stock vs Reports:** the Low Stock count follows the Products page rule, so it covers products that are low and also those out of stock that have a low-stock level. Reports → Stock shows Low stock and Out of stock as two separate counts.

## 3. Chart library

None was added. The line and donut are plain SVG and the bars are CSS, about 300 lines in total. For three simple charts this adds no dependency and needs no `npm install`, so no native rebuild of better-sqlite3 was needed. `package.json` and `package-lock.json` are unchanged.

## 4. API added

**The new call:** `window.api.dashboard.get()` returns one typed `DashboardData`, defined in `src/shared/dashboard.ts`:
- `today` and `month`;
- `summary`;
- `salesTrend` and `expenseBreakdown`;
- `lowStock` and `topProducts`;
- `recentInvoices`, `recentPayments` and `recentExpenses`;
- `gettingStarted`.

**How it is built and secured**
- **Contract and handler:** it is added to the typed IPC contract and the contract tests (66 → 67 calls). It takes no input: anything passed is refused. "Today" comes from the main process clock.
- **Service:** `src/main/services/dashboard.service.ts` only calls the report and list services above.
- **Additions to shared code:** `dailySalesReport` in `reports.service.ts`, `quantityFormatter` exported from the same file for the low-stock level text, and `addDays` in `src/shared/dates.ts`.

**Small page additions for the Dashboard's links.** Each page reads its parameter once, when it opens. Nothing else on these pages changed.

| Page | Parameter | Opens |
|---|---|---|
| Payments | `?receive=1` | Receive Payment |
| Payments | `?payment=<id>` | That payment's details |
| Expenses | `?add=1` | Add Expense |
| Products | `?add=1` | Add Product |
| Reports | `?tab=<id>` | That report |

## 5. Tests and build

**New tests**
- **Dashboard service:**
  - an empty shop;
  - a worked example checked by hand and against each report (posted vs void, receivables vs advances, inventory value, low stock, recent-list order, payments not being sales);
  - the 5-row limits;
  - month and leap-year boundaries.
- **Report and date helpers:** daily sales (zero days, voids, agreement with the Sales report, invalid period) and `addDays`.
- **IPC:** the contract, the preload bridge and the handler (answers, and refuses any input).
- **Display helpers:** chart scale, axis labels, compact amounts, relative dates, donut slices, plurals and bar widths.
- **Links:** page-link round trips, and Reports opening on the tab named in its link.
- **Dashboard page:** header and quick-action links, the six figures, the 7-day and 30-day trend, the donut, low stock, top products, recent activity, the empty shop, the start message, and loading.

The existing Products page test now renders inside a router, because the page reads its link parameter. No assertion was changed.

**Results**

| Check | Result |
|---|---|
| `npm run typecheck` | Passes |
| `npm run lint` | 0 errors, 21 warnings |
| `npm test` | 101 files, **1,964 tests passed** (1,928 before) |
| `npm run test:coverage` | 99.01% statements, 96.52% branches, 99.29% functions, 99.32% lines (thresholds met) |
| `npm run build` | Passes |

The 21 lint warnings are all "Delete CR" line-ending warnings in `src/renderer/src/lib/unload-guard.test.ts`. That file was not touched in this task: its working copy has Windows line endings from the Git checkout, and Git shows no change in it.

## 6. Bundle size

| Output | Before (Phase 12) | After | Change |
|---|---|---|---|
| main | 347.03 kB | 351.20 kB | +4.2 kB |
| preload | 8.04 kB | 8.31 kB | +0.3 kB |
| renderer JS (unminified) | 2,308.14 kB | 2,343.12 kB | +35.0 kB |
| renderer CSS | not recorded | 75.67 kB | — |

## 7. Screenshots reviewed

**How it was run:** the built app (`electron.exe .` after `npm run build`) against temporary data only, never the real `%APPDATA%\StockFlow` or `StockFlow-dev`. Both folders were fingerprinted before and after and are unchanged. The scripted check passed 50/50.

**A. Empty database**
- The figures, the start message and the empty charts and lists looked intentional.
- The 1440×960 and 1366×768 windows had no horizontal scrolling and no card overflow.
- Receive Payment, Add Expense and Add Product each opened their page with the form open. New Invoice and Stock In opened their pages.
- There were no console errors.

**B. Realistic temporary shop** (15 products, 12 customers, 74 invoices including one void, 39 payments, 11 expenses including one void and a purchase cost correction)
- **Figures:** every figure and list equalled the same report or list call (today, this month, the 7- and 30-day trend totals, balances, stock, low stock, expenses, top products, recent activity). On screen, This Month Sales, Inventory Value, Receivables and Advances matched Reports → Sales, Stock and Customer Balances.
- **Layout:** it was checked at 1440×960, 1920×1080 (6 cards in one row), 1366×768 and 1100×800 (stacked). No size had horizontal scrolling or card overflow.
- **Tooltip and 30-day view:** the tooltip showed "17-Sep-2026 · Rs 7,480.00 · 2 invoices". The 30-day view names every fifth day.
- **Links:** a recent invoice opened Invoice Detail, a recent payment opened its details, and View Sales Report opened Reports → Products. Every sidebar link still works.
- **Speed:** `dashboard.get` took about 5 ms, and the page showed its figures within 15 ms of navigation.
- **Polish from the review:** the expense legend was spreading across narrow windows, so its width is now capped.

**C. Phase 12 performance dataset** (500 products, 500 customers, 2,000 invoices, 1,000 expenses)
- `dashboard.get` had a median of 9 ms over 5 calls, and the page showed within 12 ms.
- There was no overflow and no console errors.

The packaged recovery and printing acceptance runs were not repeated, as instructed.

## 8. Confirmation

- **Schema:** still version 2. No migration was added and no table, view or column changed.
- **Accounting rules:** none added or changed. The Dashboard reuses the report and list services, and the one new report function, `dailySalesReport`, applies the Sales report's own rule per day.
- **Reads only:** the Dashboard changes no data. Its IPC call takes no input and runs no query the renderer chooses.
- **Working modules:** no business feature was redesigned. The sidebar, the theme and every other page's behaviour are unchanged, apart from the link parameters in section 4.
- **Dependencies:** none added or upgraded; `better-sqlite3` is still 12.11.1.
- **Commits:** nothing committed.
