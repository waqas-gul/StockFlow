# Phase 7 — Customers, Customer Ledger, Payments: Implementation Report

Status: implemented and verified. **Nothing committed. Phase 8 was not started.**
Schema is still **2**: no migration 0003, and `0001`/`0002` are unchanged.

## 1. What was implemented

- **Customer master:**
  - Fields: generated code, name, shop name, phone, address, city, notes, and active/inactive.
  - The name is required. Names and shop names may repeat; only the code is unique.
  - There is no delete: customers are deactivated and reactivated.
- **Customer codes** come from the `customer` sequence inside the create transaction: C-00002, C-00003, …
  - The seeded walk-in customer (C-00001) is untouched.
  - A failed create uses no code.
  - If the next code is somehow already taken, the create is refused with `CONFLICT`.
- **Opening balance (Add only):**
  - The form asks for an amount, **Customer owes us** or **Customer advance**, and a date.
  - A non-zero amount writes one `OPENING` entry in the same transaction (+ for owes us, − for an advance). 0 or blank writes nothing.
- **Payments:**
  - Fields: `RCP-000001` numbering, customer, date, amount, method (Cash, Bank, Cheque, Other), reference and note.
  - One transaction writes the payment row and a `PAYMENT` entry of −amount. `invoice_id` stays null.
- **Overpayment** is allowed. Both before saving and in the toast afterwards, the operator sees the resulting advance.
- **Idempotency:** a retry with the same `request_id` returns the saved payment (`replayed: true`) and creates nothing.
- **Duplicate warning** (soft): when a posted payment has the same customer, date and amount, a dialog appears before saving: "A payment with the same customer, date and amount already exists." It offers **Cancel** or **Continue**.
- **Payment void:**
  - A reason and a confirmation are required.
  - POSTED → VOID sets the void reason, time and date (today), and appends `PAYMENT_VOID` of +amount, in one transaction.
  - A double void is refused, and the original `PAYMENT` entry is never touched.
- **Adjust Balance:**
  - An `ADJUSTMENT` entry: Increase (the customer owes more) or Decrease (owes less).
  - It needs a date, an amount above zero and a reason.
  - It is not called a payment, and no new table was added.

## 2. Balance and ledger rules

- **Balance** = Σ `customer_ledger.amount_minor`, read fresh on every call. There is no stored balance.
  - It is shown as **"Rs 5,000.00 Due"** (positive), **"Settled"** (zero) or **"Rs 750.00 Advance"** (negative), using the existing money formatting.
- **Append-only:** the services only insert ledger rows, and the 0001 triggers are unchanged.
  - An opening balance is allowed only as the customer's first ledger entry, when the customer is created.
  - A later correction uses Adjust Balance.
- **Posting-date floor, per customer:**
  - A date must be ≥ that customer's latest ledger date and ≤ today (the main process's clock).
  - Otherwise the result is `DATE_NOT_ALLOWED`, for example "C-00002 Ali Raza (Ali Traders) has account activity on 16-Sep-2026. Use that date or later.", with details `{ earliestDate, customerId, customerCode }`.
  - Other customers never block.
  - Voids are dated today and also respect the floor, which only matters if the PC clock goes back.
- **Running balance** is ordered by `entry_date`, then `id`.
- **Inactive customers:**
  - A new payment is refused (`FORBIDDEN_STATE`), and Receive Payment is disabled.
  - History stays readable.
  - Void and Adjust Balance still work, and the customer is never reactivated silently.
- **Safety:** if an entry would make a balance larger than a safe whole number, the transaction rolls back (`VALIDATION`).

## 3. APIs and screens

**IPC** (typed and allow-listed; the main process validates again with the same Zod schemas):
- `customers.list`, `get`, `create`, `update` (profile only; a strict schema refuses opening fields), `setActive`, `ledger`, `adjustBalance`, `search`
- `payments.list`, `get`, `create`, `checkDuplicate`, `void`

Errors: `VALIDATION`, `NOT_FOUND`, `DATE_NOT_ALLOWED`, `FORBIDDEN_STATE`, `CONFLICT` (currency decimal places changed, or code taken). No SQLite text is shown.

**Screens:**
- **Customers** (`/customers`):
  - Table columns: Code, Customer, Shop, Phone, City, Balance, Status and Actions (View, Edit, Deactivate/Reactivate).
  - Search covers code, name, shop, phone (spaces and dashes ignored) and city.
  - Status filter: Active, Inactive or All. 25 per page. Add Customer.
- **Customer detail** (`/customers/:id`):
  - Header: profile, status, and the balance with its meaning.
  - Actions: Receive Payment, Adjust Balance, Edit Customer, Deactivate.
  - **Account Ledger** columns: Date, Type, Reference, Increase (owes more), Decrease (owes less), Balance.
  - A payment reference opens the payment. A voided payment row is marked "(voided)".
- **Payments** (`/payments`):
  - Table columns: Payment No, Date, Customer, Shop, Method, Reference, Amount, Status and Actions (View, and Void on posted rows).
  - Filters: search, From/To dates, status, method.
  - Receive Payment has a customer picker that offers active customers only.
- **Payment detail:** the saved fields and status, plus void date and reason when void. There is no edit.

**Files:**
- **Added:**
  - `shared/customers.ts`, `shared/payments.ts`
  - `services/customers.service.ts`, `payments.service.ts`, `customer-ledger.ts` (shared ledger rules, for Phase 8 to reuse), `sequences.ts`
  - `features/customers/*`, `features/payments/*`
- **Changed:**
  - `ipc-contract.ts`, `ipc/index.ts`, `routes.ts`, `navigation.ts`, `Sidebar.tsx`, `TopBar.tsx`, `app-queries.ts`, `query-keys.ts`, `form-text.ts` (`positiveMoneyText`)
  - `inventory.ts`: number allocation now calls `sequences.ts`; behavior unchanged.
  - `services/test-utils.ts` (`failingWrites`), plus contract, preload, IPC, route and sidebar tests.

## 4. Tests and results

| File | Tests | Covers |
|---|---|---|
| `customers.service.test.ts` | 29 | See below |
| `payments.service.test.ts` | 24 | See below |
| `customer-ledger.test.ts` | 4 | See below |
| `sequences.test.ts` | 2 | Consecutive values, rollback returns the value, the error cases |
| IPC `customers and payments` | 12 | End-to-end calls, clean errors, boundary refusals |
| `customer-forms.test.ts`, `payment-forms.test.ts` | 14 + 10 | Due/Settled/Advance helpers, form schemas, previews, actions |
| `CustomersUi.test.tsx`, `PaymentsUi.test.tsx` | 6 + 6 | See below |
| routes, sidebar, contract, preload | updated | `/customers/:id` routing and highlighting |

- **Customer service:**
  - create; the code sequence after the walk-in; a failed create uses no code; duplicate names and shops; edit; deactivate/reactivate
  - search by code, name, shop, phone and city; pagination
  - opening balance: positive, negative, zero; the atomic rollback; a second opening and an opening after activity are both refused
  - adjustments, including on inactive customers, the floor, and future dates
- **Payment service:**
  - reduces a balance; creates an advance; the four methods; the sequence
  - a failure writing the payment or its ledger entry leaves nothing and uses no number
  - idempotency; the duplicate check; an inactive customer refused
  - the same-customer floor; an unrelated customer does not block; a future date is refused
  - void: restores the amount; the original entry is unchanged; `PAYMENT_VOID` is appended; a double void is refused; void works for an inactive customer
  - an injected failure on the status change or on the void entry rolls back both
  - list filters
- **Ledger:** the Opening → Payment → Adjustment → Payment → Void sequence. After every event, Σ ledger, `v_customer_balance`, `get`, the list and the last running balance all agree. It also covers (entry_date, id) ordering and the balance-overflow guard.
- **UI:** create form and opening-balance UX; Receive Payment; overpayment preview; duplicate warning; void confirmation; running ledger; inactive behavior.

**Deliberate-break check:** I disabled seven rules, one at a time. Each broke at least one test, and restoring the code made them pass. The rules were:
- the posting floor
- idempotency
- the opening-first guard
- the double-void guard
- the inactive-payment guard
- the safe-balance guard
- the running-balance order

**Commands:**
- `npm run typecheck`: clean.
- `npm run lint`: 0 problems.
- `npm test`: **1551/1551 in 73 files** (Phase 6: 1443 in 65).
- `npm run test:coverage` (not required): passes its thresholds. The new services and shared files are at 100%.
- `npm run build`: main 247.61 kB, preload 5.10 kB, renderer 2,032.45 kB (Phase 6: 1,931.71 kB). No new dependency.

## 5. Manual verification (isolated data)

The built app ran with appData redirected to a temporary folder, and I drove its real UI over CDP. **19/19 checks passed.** The real `%APPDATA%\StockFlow` and `StockFlow-dev` were unchanged, and the temporary folder was removed.

1. The walk-in customer C-00001 is listed as Settled.
2. Add Customer with a Rs 5,000 opening, "Customer owes us", saved as C-00002.
3. The list and the detail page show "Rs 5,000.00 Due".
4. Received Rs 2,000 as RCP-000001.
5. The balance shows "Rs 3,000.00 Due".
6. Receiving Rs 4,000 previews "Balance after Rs 1,000.00 Advance" and "…Rs 1,000.00 more than the customer owes. The extra is kept as an advance.", then saves as RCP-000002.
7. The balance shows "Rs 1,000.00 Advance".
8. The ledger's running balances (5,000 Due → 3,000 Due → 1,000 Advance) match the database.
9. RCP-000002 was voided through the ledger link: a reason, then a confirmation.
10. The balance is back to "Rs 3,000.00 Due", and a "Payment voided" row was appended.
11. A Decrease of Rs 500 gives "Rs 2,500.00 Due".
12. Deactivating asks first. Receive Payment becomes disabled, and the main process returns `FORBIDDEN_STATE`.
13. The history stays visible, with 5 rows, and Adjust Balance is still available.
14. Zara's payment dated 10-Sep was refused because of her own entry on 11-Sep. A payment dated 13-Sep saved, even though Bilal paid today.
15. Settings shows decimal places locked. A manual backup is verified, and the integrity check is OK (customer ledger and balances included). Products and Stock In still work.

Also verified:
- The duplicate warning named RCP-000003. Cancel saved nothing; Continue saved RCP-000004.
- The picker does not find the inactive customer.
- In the database, every `v_customer_balance` equals Σ ledger. Sequences: customer 5, payment 6. `invoice_id` is null. Integrity and foreign-key checks are clean.

**Bug caught by the manual run:** the Payments page opened the new payment's detail after every save, which gets in the way of entering several payments. It now closes the form and shows the toast with the number and new balance.

## 6. Decisions and needs attention

1. **No schema change was needed.** One gap is not blocking: `customer_ledger` and `customers` have no `request_id`.
   - So a balance adjustment or a customer create is guarded against double submission only by the disabled Save button.
   - Payments are fully idempotent.
2. **Opening balance** is offered only when a customer is created. There is no separate "add opening balance" call. The service guard and the unique index both enforce one opening entry, as the first entry.
3. **Walk-in customer:** nothing special in Phase 7. It can be edited or deactivated like any customer. **Please confirm** whether Phase 8 should protect it.
4. **The duplicate check** compares against posted payments only. After a lost answer, a retry can show the warning; Continue then returns the saved payment, and nothing is created twice.
5. **Payments keep no copy** of the customer's name. Lists show the current profile, while ledger amounts never change.
6. **Case-insensitive search** folds English letters only (SQLite `LIKE`), as for products.
7. **Customer detail omits "total invoiced / total paid"** (plan §10.3): no financial summaries were requested yet.
8. **The manual check ran the built app unpackaged** (development data folder, redirected), not an installer build. No Electron-specific issue appeared.

## 7. Scope

**Phase 8 was not started:** no invoices, invoice lines, sales stock movements, counter-payment flow, printing or invoice void. Nothing was committed.
