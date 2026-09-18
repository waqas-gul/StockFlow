# Invoice Shop and Salesman: Implementation Report

The shop name, shop address and the salesman's name and two phone numbers are now settings. Every new customer invoice saves a copy of them when it is posted and shows them on Invoice Detail, the print preview, the printed invoice and the PDF.

Nothing is committed, and the final installer was not rebuilt (`build:win` was not run).

- **Base:** HEAD `96ce7ee`.
- **Schema:** version **4**, from the new migration `0004_invoice_business_salesman_snapshot`.

## 1. Migration and schema version

- **File:** `src/main/db/migrations/0004_invoice_business_salesman_snapshot.ts`, registered fourth in `migrations/index.ts`.
- **Checksum:** `sha256:e5fd33a52cda209d35880ffd4df738cf61e54e993bbe57906da7e6fd989d4174`, pinned in the migration and in the shipped-checksum registry test.
- **0001–0003:** not modified. Their checksums are asserted unchanged.
- **Columns:** five nullable `TEXT` columns are added to `invoices`: `shop_name_snapshot`, `shop_address_snapshot`, `salesman_name_snapshot`, `salesman_phone1_snapshot` and `salesman_phone2_snapshot`.
- **Settings:** the migration seeds `business.address` (empty), `salesman.name` (Mansoor Iqbal), `salesman.phone1` (03179927633) and `salesman.phone2` (03463820629).
  - `business.name` becomes **Iftikhar and Arshad Traders** only while it still holds the seeded default "StockFlow". A shop name the owner already saved is kept.
- **Triggers:**
  - `trg_invoices_business_snapshot` refuses a new invoice without a shop name or salesman. It also refuses a blank address or phone: an empty one must be saved as NULL.
  - `trg_invoices_business_snapshot_guard` refuses any change to the five columns once an invoice is saved. That includes filling them in on an old invoice. Voids and dispatch changes still work.
- **Additive only:** nothing is dropped, renamed or deleted, and no invoice row is updated.
- **Upgrade:** the existing verified pre-migration backup runs first, and the migration runs in one transaction. A second launch migrates nothing.

## 2. Settings

| Key | Settings label | Rule | Default |
| --- | --- | --- | --- |
| `business.name` (existing) | Shop name | required, up to 100 characters | Iftikhar and Arshad Traders |
| `business.address` | Shop address | optional, single line, up to 200 | empty (never hard-coded) |
| `salesman.name` | Salesman name | required, single line, up to 60 | Mansoor Iqbal |
| `salesman.phone1` | Phone 1 | optional, single line, up to 40 | 03179927633 |
| `salesman.phone2` | Phone 2 | optional, single line, up to 40 | 03463820629 |

- **Settings screen:** the fields are in Settings → Business and can be changed at any time; they never lock. The card says that each invoice keeps the details it was posted with.
- **Validation:** the same shared Zod rules check the form and every `settings:update` call in the main process.
- **No salesman module:** there is no salesman table and no new IPC call. The values travel through the existing `settings.get` and `settings.update`.

## 3. Invoice snapshot fields

- **Posting:** `createInvoice` reads the settings inside its existing `BEGIN IMMEDIATE` transaction and writes the five values in the same `INSERT` as the invoice header, using `invoiceBusinessDetails` in `@shared/invoices`.
  - An empty address or phone is saved as NULL.
  - A failure anywhere in posting saves no invoice, no snapshot and uses no number.
  - A retried request returns the saved invoice with its original snapshot.
- **Reading:** `InvoiceDetail.business` holds `{ shopName, shopAddress, salesmanName, salesmanPhone1, salesmanPhone2 }`. It is `null` for an invoice saved before 0004.
- **Invoice calculations:** unchanged.

## 4. New Invoice

A small read-only card, **"Printed on the invoice"**, sits in the empty column next to the totals, where the operator looks before pressing Post:

> **Iftikhar and Arshad Traders**
> [Shop address, when set]
> Salesman: **Mansoor Iqbal**
> Phone: 03179927633 / 03463820629
> *From Settings. Saved with the invoice when it is posted.*

The values come from Settings. An empty address or phone line is left out. The card has no inputs.

## 5. Invoice Detail, print preview, printed invoice and PDF

- **Invoice Detail:** the header card shows **Sold by** (the shop name, with the address below) and **Salesman** (the name, with the phones below), from the saved snapshot.
- **Print preview, printer and PDF:** `readPrintableInvoice` now gives `businessName` (the saved shop name), `businessAddress` and `salesman`, all from the saved snapshot.
  - The header shows the shop name, then the address, then "Salesman: Mansoor Iqbal" and "Phone: 03179927633 / 03463820629", on the left beside the INVOICE title and number.
  - The printer and PDF print that same preview.
- **Settings still used:** only the paper size and the locked currency, as before.
- **Visual check:** the real print document was rendered to PDF with Electron on A4 and A5. The header fits in about four short lines, the page is unchanged below it, and a sample invoice stays on one page.

## 6. Legacy invoices

- **No backfill:** invoices saved before 0004 keep NULL in all five columns, and the guard trigger makes backfilling impossible.
- **Opening:** they open normally. Invoice Detail shows "Shop and salesman: Not saved: this invoice was posted before StockFlow kept them."
- **Printing:** they print exactly as before, with the current shop name at the top (the existing behaviour) and no address, salesman or phone. Nothing is invented.
- **Other actions:** voids, dispatch changes and the invoice list work as before.

## 7. Tests

| File | What it proves |
| --- | --- |
| `0004_invoice_business_salesman_snapshot.test.ts` (new, 13) | Version, registration and pinned checksum; 0001–0003 checksums unchanged; additive SQL only; 3 → 4 upgrade with a verified `_s3` backup keeping every row (old invoices get NULL snapshots) and every older checksum; a custom shop name kept; no backfill possible while voids and dispatch changes still work; idempotent second launch; new database 0 → 4 with the settings; atomic rollback of a failing 0004; the insert and update triggers |
| `invoice-business-snapshot.test.ts` (new, 13) | All five values saved; empty values saved as NULL; a later Settings change leaves an old invoice (and its printout) unchanged while the next invoice gets the new values; a retry returns the original snapshot; void and dispatch changes keep it; posting stays atomic (a failure after the header leaves no invoice, stock change or number); the printable uses the snapshot; a real schema-3 invoice, upgraded, opens and prints as before |
| `settings.service.test.ts` | New defaults, edges, refusals (blank salesman, too long, line breaks, wrong type) and trimmed saves |
| `settings-form.test.ts`, `SettingsForm.test.tsx` | Field mapping, messages and editable fields |
| `InvoicesUi.test.tsx` | The read-only New Invoice card, with and without an address or phones |
| `InvoicePrintUi.test.tsx` | Printed header markup; phones only when saved; the legacy print unchanged; Invoice Detail with the snapshot and with a legacy invoice |
| `invoices.test.ts` (shared) | `invoiceBusinessDetails` and `salesmanPhoneText` |
| Updated | `0001_initial`, `0003` (pinned to schema 3), `db/index`, `ipc/index`, `invoices.service`, `invoice-print.service`, `stock.service`, and nine UI settings fixtures |

**Test helpers:**
- `test-utils` gained `INVOICE_BUSINESS_SNAPSHOT` and `invoiceRow(db, m)`.
- Fixtures that insert invoices directly now include the snapshot on schema 4, because the new trigger requires it.

**Results:**
- **Typecheck:** exit 0.
- **Lint:** 0 errors. The 1,362 line-ending warnings are unchanged and all in six files this work did not touch.
- **Targeted tests** (all of `src/main`, `src/shared` and `src/preload`, plus the invoice, settings and fixture-updated renderer folders): 95 files, **2,136 passed**, 0 failed.
- **Not run:** coverage, `build`, `build:unpack` and `build:win`.
