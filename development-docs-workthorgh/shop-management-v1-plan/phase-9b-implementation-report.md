# Phase 9B — Professional Invoice Printing / PDF: Implementation Report

Status: implemented and verified in the packaged app. **Nothing committed.**
- **Schema:** still **2**. No migration; `0001`/`0002` are unchanged.
- **Not started:** Phase 10, Expenses, Reports.
- **Read-only:** printing never writes to the database.

## 1. Print architecture

**Flow:** Invoice Detail → **Print Invoice** → Print Preview (`#/invoices/:id/print`) → **Print…** or **Save as PDF…**

**One printable DTO, read once**
- `invoices.printable(id)` returns `PrintableInvoice`, built by the main process in one synchronous read (`readPrintableInvoice`).
- Its sources:
  - the invoice's saved customer, product, unit, price and total snapshots;
  - the current dispatch details;
  - the current business name, currency and paper size (presentation only).
- It also carries the amount in words and the suggested PDF name.
- It has no costs, product/customer codes, notes, payment status or change log.

**Printing is a main-process operation on the app window**
- `invoices.print({ id, paperSize })` and `invoices.savePdf({ id, paperSize })` are strict Zod objects. Any other key is refused, e.g. a path, file name or printer.
- Before any dialog, the main process:
  - reads the invoice itself (`NOT_FOUND` if missing);
  - checks the window shows `#/invoices/<id>/print` with a document marked with that invoice number and paper (`FORBIDDEN_STATE` "Open the print preview of INV-X to print it or save it as a PDF.").
- **Print:** `webContents.print({ silent: false, pageSize })` opens the system print dialog, where the user picks printer, copies and printer properties. Result: `SENT` or `CANCELLED`.
- **Save as PDF:**
  - The main process opens a Save dialog proposing `INV-000123.pdf`: Documents first, then the last PDF folder in this session.
  - It then runs `printToPDF({ preferCSSPageSize: true })` and writes a temporary file that is renamed into place, so no partial file is left.
  - The Windows dialog confirms replacing an existing file. A typed name without `.pdf` whose `.pdf` already exists is refused rather than replaced.
- **One at a time:** a second request while a print or PDF is running is refused (`FORBIDDEN_STATE`). The toolbar also uses a single-flight guard.
- **Errors:** new code `PRINT_FAILED` with plain messages. The raw printer or file error only goes to the log.

**Security is unchanged:** contextIsolation, sandbox, no Node in the renderer, no raw ipcRenderer, no paths from the renderer.

**Deviation from plan §17:** the plan described a hidden print window. This uses the visible preview route instead, so what prints is exactly what the preview shows. The user brief allowed a route or a window.

## 2. Invoice layout

A plain paper document (`invoice-print.css`), not the app theme:
- black on white, thin borders, no fills or gradients;
- tabular numbers, right-aligned money;
- light branding (a small "Generated with StockFlow" line).

| Block | Content |
|---|---|
| Header | Business name (Settings); INVOICE; Invoice No, Date, Invoice Code (hidden when empty) |
| Bill To | Customer, Shop Name, Contact, Address, City, from the snapshot; empty details are hidden |
| Dispatch | Bilty Number, Transport Service, Adda Name, with current values or blank lines to write on |
| Items | #, Product, Packing (verbatim), Quantity, Price, Gross Amount, Discount, Ctn, Sch, Net Amount |
| Summary | Amount in Words, next to Gross Amount / Discount / Scheme / Extra Discount (only when there are deductions), Current Invoice, Freight, Invoice Total, Previous Balance, Received, Net Outstanding |
| Footer | Checked By (value or blank line), Signature line |

**Item cells**
- **Quantity and Price:** one row per saved quantity row, e.g. "2 Box" at 2,400.00 above "5 Pc" at 110.00. The unit's saved short name is used when it has one.
- **Discount:** the amount, with the percentage underneath when one was entered.
- **Ctn:** the saved `ctn_count` only.
- **Sch:** the scheme amount, plus "Free 3 Pc" underneath for free goods. Free goods use the line's saved units, or "N base units" when those units cannot express the quantity.
- The Discount, Ctn and Sch columns are left out only when no line uses them.

**Balances:** amounts carry no symbol; a note says "Amounts in Rs". A negative balance prints as "250.50 Advance". Received is always the amount saved on the invoice.

**Amount in words:** the Phase 2 helper applied to the invoice **total**, generated at print time.
- **PKR:** "Rupees Twelve Thousand Five Hundred Only" in lakh/crore; paisa as "… and Paisa Fifty Only".
- The helper gained a backward-compatible `labelPosition` option for "Rupees" first.

## 3. A4 / A5

- **Default:** the preview opens on the Settings paper size, and an A4/A5 toggle changes it for this print only.
- **Page rule:** each paper has its own `@page` size and margins (A4: 12/12/14 mm; A5: 8/8/10 mm) with smaller type on A5.
- **Footer on every page:** the invoice number and "Page n of N".
- **Multi-page:**
  - column headings repeat;
  - a row never splits;
  - totals, words and signatures stay together (they move to the next page as a block when needed).
- **Preview:** one continuous sheet of the exact paper width, so text wraps exactly as it prints. Page breaks are visible only on paper and in the PDF.
- **Edge inset:** the document is inset 0.5 mm at each side. A printer that scales the page to its own paper otherwise cut off the table's right border (found in the packaged run, now fixed).

## 4. VOID

- A large light diagonal **VOID** watermark repeats on every page.
- A bordered heading reads "**VOID** This invoice was voided on 17-Sep-2026. Reason: …".
- The number, lines and saved amounts (Received included) are unchanged. Void invoices can still be previewed, printed and saved.

## 5. Tests

`npm test`: **1821/1821 in 88 files** (Phase 9A: 1760 in 83). Typecheck, lint and prettier (src) are clean.

**Build** (`build:unpack` succeeded):
- main 314.73 kB
- preload 6.34 kB
- renderer JS 2,201.24 kB, CSS 66.79 kB

**New or extended tests**
- **Main service (`invoice-print.service.test.ts`):**
  - the DTO exactly from snapshots;
  - unchanged after customer, company, product, unit and price renames;
  - dispatch updates appear and nothing else changes;
  - settings only change presentation;
  - VOID status, date and reason, with Received kept after the payment is voided;
  - empty optional fields and zero totals;
  - `NOT_FOUND` and `VALIDATION`, with no writes (`total_changes`);
  - print/PDF only from the matching preview route, invoice and paper;
  - cancel, printer failure, Save dialog default and last folder, `.pdf` added, no silent replace, relative path refused;
  - no partial file after a create or write failure;
  - one operation at a time.
- **`print-window.test.ts`:** "cancelled" and Windows 11's "Print job canceled" both mean CANCELLED; other failures throw.
- **Shared:** amount in words (PKR lakh/crore, paisa, zero, other currencies); PDF file name (Windows-safe); print route; input schema (A4/A5 only, no extra keys).
- **Renderer helpers:** money and Advance; Box + Piece rows with short names; free goods including the base-unit fallback; discount %; optional columns; `@page` CSS for A4/A5 with escaping; print/PDF messages (raw errors never shown).
- **UI (SSR):**
  - header, Bill To, Dispatch, line cells, totals, words, signatures;
  - nothing extra printed;
  - A4/A5 page rule, VOID watermark and heading, empty fields;
  - preview toolbar with no editing, disabled while busy;
  - preview page on the configured paper without app navigation;
  - Detail offers Print Invoice for POSTED and VOID invoices.
- **IPC:** printable/print/savePdf end to end with no writes and no invoice number used; boundary refusals (text id, missing or Letter paper, printer name, file name, paths); untrusted sender.

**Deliberate-break check:** 20 key rules switched off one at a time, all caught. One initially survived (the route check); a test was added and it is now caught. Every file was restored exactly.

## 6. Packaged / manual result

The **packaged** `dist\win-unpacked\StockFlow.exe` ran on a temporary appData. The Save dialog was stubbed; the **real Windows 11 print dialog** was used, answered by UI Automation. **35/35 checks passed.** The real StockFlow folders were unchanged and the temporary data was removed.

**Seven representative invoices**
1. Simple cash invoice
2. Account invoice with a previous balance (plus an advance on another)
3. Box + Piece
4. Discounts + scheme money + free goods + Ctn + extra discount + freight + received
5. Bilty/Transport/Adda changed after posting
6. A 45-line invoice
7. A VOID invoice

After posting, the customer and product (with units and prices) were renamed.

**Verified**
- The preview has no sidebar or navigation and has the paper toggle, Save as PDF and Print. The table and totals fit on A4 and A5.
- PDFs are A4 (210 × 297) or A5 (148 × 210). The text includes the business name, saved names and units after the renames, correct amounts and words, and latest dispatch values without the log. No text lies outside the margins, and table borders are whole.
- The long invoice spans 3 pages on both A4 and A5: headings repeat, "Page n of 3", every row once, totals and signatures together on the last page.
- VOID shows the watermark, date and reason.
- Settings on A5 opens the preview on A5.
- **Real Print:**
  - Cancel sends nothing and shows no message.
  - Print to Microsoft Print to PDF sends the job ("INV-000004 was sent to the printer.").
  - Output fits the printer's paper with borders whole, for both A5 and multi-page A4 layouts.
- No database row changed during printing. Schema 2, integrity ok.

**Defects the packaged run found and fixed**
1. Windows 11 reports a cancelled print as "Print job canceled", which would have shown "could not be printed".
2. Table right border cut off when the printer scales the page.
3. The "Quantity" heading broke mid-word.

## 7. Needs attention

1. **Paper on real printers:** Windows 11's print dialog uses the printer's own paper setting and ignores the size the app requests.
   - An A5 invoice on A4/Letter paper prints at true size, centred.
   - An A4 invoice on Letter is scaled down slightly.
   - Nothing is clipped. To print on A5 paper, choose A5 in the dialog's More settings (printer preferences) or set it as the printer's default.
   - Save as PDF always uses the exact A4/A5 size.
2. **New error code** `PRINT_FAILED`.
3. **Non-PKR currencies:** amount in words uses the currency code, international numbering and the minor part as a fraction, e.g. "USD One Thousand and 50/100 Only". Only PKR uses Rupees/Paisa in lakh/crore.
4. **Presentation choices to confirm with the client:**
   - Not printed: notes, price tier, product/customer codes, payment status.
   - Empty dispatch fields and Checked By print as blank lines; empty customer details are hidden.
   - Unused Discount/Ctn/Sch columns are dropped.
   - Gross and deduction rows appear only when there are deductions.
   - The "Bill To" heading and "Amounts in Rs" note were added.
5. **Free goods** the line's saved units cannot express print as "N base units" (the base unit's name is not saved on the invoice).
6. **No paged preview:** the preview shows one continuous sheet, and the Windows dialog shows "This app doesn't support print preview". Page breaks show on paper or in the PDF.
7. **Still open from 8B:** closing the window with an unsaved invoice does not ask.
