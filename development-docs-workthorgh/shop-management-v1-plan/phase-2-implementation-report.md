# StockFlow — Phase 2 Implementation Report

> **Phase:** 2 — Shared domain library: pure functions, no database.
> **Date:** 2026-09-10.
> **Status:** Implemented and verified. **Awaiting approval.**
> - Phase 3 has **not** been started.
> - No SQLite, driver, migrations, IPC or business screens were added.
> - Nothing was committed.

---

## 1. Summary

`src/shared/domain/` is now a pure TypeScript library that later frontend and main-process code will share.

| Area | Contents |
|---|---|
| Money | Integer minor units; strict parsing and formatting; exact arithmetic; half-up rounding; BigInt multiply/divide; basis points |
| Units / quantities | A generic base-unit model: conversion to base, totals, greedy split, display, and unit-set validation with the nesting rule |
| Invoice calculations | Quantity rows, lines, and invoice totals built from caller-named deductions and charges, so no unconfirmed business rule is hardcoded |
| Weighted-average valuation | Outflow value (COGS) with the "take the whole value when the last unit leaves" rule |
| Amount in words | Lakh/crore (and international) numbering, with configurable labels |

**Tests:** 261 domain tests, with **100% statement, branch, function and line coverage** of `src/shared/domain`.

**Checks:**

- Typecheck, lint, tests and build all pass.
- The Phase 1 UI still passes its automated sidebar/theme suite (**40/40**) and its security/route suite (**29/29**).

The code has no Electron APIs, filesystem access, IPC, database, React, DOM or browser/Node globals. A new ESLint
guard enforces this (§9).

---

## 2. Files

### Created

| File | Purpose |
|---|---|
| `src/shared/domain/money.ts` | Money representation, parsing, formatting, arithmetic, rounding, basis points |
| `src/shared/domain/quantity.ts` | Generic unit model, validation, conversion, split, display |
| `src/shared/domain/invoice-calc.ts` | Pure quantity-row, line and invoice calculators |
| `src/shared/domain/valuation.ts` | Weighted-average outflow value |
| `src/shared/domain/amount-in-words.ts` | Numbers and amounts in words |
| `src/shared/domain/errors.ts` | `DomainError` + `DomainErrorCode` |
| `src/shared/domain/guards.ts` | Internal integer and range guards (not exported from the entry point) |
| `src/shared/domain/index.ts` | Public entry point (`@shared/domain`) |
| `src/shared/domain/test-utils.ts` | Test-only helpers: error-code capture and a seeded PRNG. Excluded from coverage and never imported by app code. |
| `src/shared/domain/{money,quantity,invoice-calc,valuation,amount-in-words,index}.test.ts` | Tests |

The plan listed four files (`money`, `quantity`, `invoice-calc`, `amount-in-words`). `valuation.ts` was added because
this phase's instructions allow it. `errors.ts`, `guards.ts`, `index.ts` and `test-utils.ts` are small supporting
files.

### Changed

| File | Change |
|---|---|
| `package.json` / `package-lock.json` | Added devDependency **`@vitest/coverage-v8` 5.0.0** (exact) and script `test:coverage` (`vitest run --coverage`) |
| `vitest.config.ts` | Coverage: v8 provider, scope `src/shared/domain/**` (tests and test utils excluded), text + HTML reports, **95% thresholds** for statements, branches, functions and lines |
| `eslint.config.mjs` | Ignores `coverage/`. New `src/shared/**` guard with `no-restricted-imports` (Electron, React, `node:*`, `fs`, `path`, SQLite, renderer libraries…) and `no-restricted-globals` (`window`, `document`, `localStorage`, `process`, `Buffer`, `require`, `globalThis`…) |
| `.gitignore`, `.prettierignore` | Ignore `coverage` |
| `electron-builder.yml` | Excludes `coverage/**` from the package |
| `src/shared/README.md` | Describes `domain/` and the boundary rule |

**Not touched:** `src/main`, `src/preload`, `index.html`/CSP, the renderer (routes, sidebar, theme), Electron,
React Router, and the implementation plan. The production renderer bundle is **byte-identical** to Phase 1 (same
asset hashes `index-C92gGL3-.js` / `index-B9InTQId.css`), because nothing imports the domain library yet.

---

## 3. Public API (`@shared/domain`)

### Money (`money.ts`)

| Export | Description |
|---|---|
| `type MinorUnits = number` | Integer minor units (paisa) |
| `type BasisPoints = number` | 100 bps = 1% |
| `BPS_PER_WHOLE = 10_000` | Basis points in 100% |
| `MAX_MINOR_DIGITS = 4` | Largest supported number of decimal places |
| `parseMoney(input, { minorDigits, allowNegative? })` | Returns `ParseResult<MinorUnits>` |
| `parsePercentToBps(input, { maxBps? })` | Returns `ParseResult<BasisPoints>`: `"12.5"` / `"12.5%"` → 1250, at most 2 decimals, default max 100% |
| `formatMoney(amount, { minorDigits, grouping?, prefix? })` | Display string |
| `addMinor(a, b)`, `subtractMinor(a, b)`, `sumMinor(list)`, `multiplyMinor(amount, factor)` | Exact arithmetic; throw `OUT_OF_RANGE` instead of losing precision |
| `divideRoundHalfUp(n: bigint, d: bigint): bigint` | Integer division, half away from zero |
| `mulDivRoundHalfUp(a, b, divisor)` | `round_half_up(a × b ÷ divisor)` with a BigInt intermediate |
| `basisPointsOf(amount, bps)` | `round_half_up(amount × bps ÷ 10 000)` |

Supporting types: `ParseResult<T>`, `DecimalParseError`, `DigitGrouping`, `ParseMoneyOptions`, `ParsePercentOptions`,
`FormatMoneyOptions`.

### Quantity (`quantity.ts`)

| Export | Description |
|---|---|
| `validateUnits(units): UnitIssue[]` | Checks a unit set; an empty array means valid |
| `createUnitSet(units)` | Returns `{ ok, unitSet }` or `{ ok: false, issues }` |
| `toBaseQuantity(quantity, unitBaseQty)` | Quantity in a unit → base units |
| `totalBaseQuantity(rows)` | Σ quantity × unitBaseQty |
| `splitBaseQuantity(qtyBase, unitSet)` | Greedy split into the set's units |
| `formatQuantity(qtyBase, unitSet, { label?, separator? })` | Display text |

Supporting types: `UnitDefinition`, `UnitId`, `UnitIssue`, `UnitIssueCode`, `UnitSet` (branded: only
`createUnitSet` can produce one), `UnitSetResult`, `QuantityInUnit`, `UnitCount`, `FormatQuantityOptions`.

### Invoice calculation (`invoice-calc.ts`)

| Export | Description |
|---|---|
| `calculateQuantityRow(row)` | Computes `qtyBase` and `amountMinor` for one row |
| `applyDeductions(baseMinor, deductions)` | Returns the deductions, total and remaining amount |
| `calculateLine(line)` | Line totals |
| `calculateInvoice(input)` | Whole-invoice totals |

Supporting types: `QuantityRowInput`/`Result`, `DeductionSpec`, `DeductionBasis`, `Deduction`, `DeductionResult`,
`DeductionsResult`, `LineInput`/`Result`, `KeyedAmount`, `InvoiceInput`/`Result`.

### Valuation (`valuation.ts`)

| Export | Description |
|---|---|
| `weightedAverageOutflowValue(position, outQtyBase)` | Value of units leaving stock |
| `applyOutflow(position, outQtyBase)` | Returns the value removed and the stock that remains |

Supporting types: `StockPosition`, `OutflowResult`.

### Amount in words (`amount-in-words.ts`)

| Export | Description |
|---|---|
| `integerToWords(value, numbering?)` | A whole number in words |
| `amountInWords(amountMinor, options?)` | An amount in words, with configurable labels |

Supporting types: `NumberingSystem`, `UnitLabel`, `AmountInWordsOptions`.

### Errors (`errors.ts`)

`DomainError` has `code`, one of:

- `INVALID_ARGUMENT`
- `OUT_OF_RANGE`
- `DEDUCTION_EXCEEDS_BASE`
- `INSUFFICIENT_STOCK`

**Error convention:**

- **Parsers of user-typed text return results.** Invalid text is expected, and the error code maps directly to a
  form message.
- **Calculators throw `DomainError`.** Their input breaks an invariant (non-integer, overflow, a discount above
  its base, insufficient stock). Phase 3+ maps it to the IPC `VALIDATION` error; the renderer can switch on
  `code`.
- The APIs are small pure functions. The only class is the `Error` subclass. There is no global mutable state and
  no `any`.

---

## 4. Money representation and rounding

**Representation:**

- Money is a `number` holding an **integer count of minor units**: PKR paisa, so Rs 1.00 = 100.
- Every function rejects non-integers and values outside `Number.MAX_SAFE_INTEGER`, which is about Rs 90
  trillion at 2 decimals.
- Floating-point rupee values never appear in arithmetic. They exist only as formatted text.
- This matches the planned SQLite `INTEGER *_minor` columns.

**Parsing (`parseMoney`):**

- Accepted: optional surrounding whitespace, an optional `-` (only with `allowNegative`), digits, and an optional
  fraction with at least one digit.
- Commas are accepted only as **correct grouping**, in either style: international `1,234,567.89` or
  South Asian `12,34,567.89`.
- The value is built from the digit string with `BigInt`, so it involves no float step.

| Input (2 decimals) | Result |
|---|---|
| `"0"` / `"1"` / `"1.5"` / `"1.50"` / `"1,250.50"` | 0 / 100 / 150 / 150 / 125050 |
| `"1,25,050.50"` | 12505050 |
| `"12.345"` | `TOO_MANY_DECIMALS`: **never silently rounded** |
| `"abc"`, `"1.2.3"`, `"1,2,3"`, `"12,34"`, `".5"`, `"5."`, `"+1"`, `"1e3"`, `"Rs 10"`, `"1 000"`, non-ASCII digits | `INVALID_FORMAT` |
| `""` / `"   "` | `EMPTY` (callers with optional fields check for blank input first) |
| `"-5"` without `allowNegative` | `NEGATIVE_NOT_ALLOWED` |
| Beyond the safe range | `OUT_OF_RANGE` |

The precision comes from `minorDigits` (0–4; PKR = 2). Strictness choices:

- `"12.340"` is also rejected with 2 minor digits: precision is enforced by digit count, not by value.
- `".5"` and `"5."` are rejected (a digit is required on both sides of the point).

**Formatting (`formatMoney`):**

- Deterministic string arithmetic, not `Intl`, so main and renderer always agree.
- Grouping is `international` (default), `south-asian` or `none`.
- Optional prefix: `-Rs 1,250.50`.
- Every formatted value round-trips exactly through `parseMoney` (tested on 1,500 values).

**Rounding rule:**

- **Half away from zero**, which is ordinary **half-up** for the non-negative amounts the app stores: 2.5 → 3,
  2.4999 → 2.
- Negative results are symmetric: −2.5 → −3.
- `divideRoundHalfUp` computes `(2|n| + |d|) ÷ 2|d|` in BigInt.
- `mulDivRoundHalfUp(a, b, c)` forms `a × b` in **BigInt**, so intermediates beyond 2^53 are exact. Only the final
  result must be a safe integer.
- Percentages are integer basis points: `basisPointsOf(amount, bps) = round_half_up(amount × bps ÷ 10 000)`.
- A test documents a case where float arithmetic would be wrong:
  - `MAX_SAFE ÷ 3` should be …330.33.
  - A float division gives …330.5 and rounds up to …331.
  - The BigInt path returns …330.

---

## 5. Quantity / base-unit model and nesting rule

**Model (plan §9.2):**

- Each product has exactly **one base unit** (`isBase`, `baseQty = 1`).
- Every other unit contains a **whole number of base units** (`baseQty`).
- Stock and quantities are integer base units.
- **Unit names are data.** The maths never refers to names, and no packing string (`1*12*18`, …) is read or
  interpreted.
- `id` is `string | number`, so the future `product_units` ids fit.
- Units carry an optional `shortName` for print.

**Conversions:**

| Function | Rule | Example |
|---|---|---|
| `toBaseQuantity(q, size)` | q × size, exact | — |
| `totalBaseQuantity(rows)` | Σ q × size | 2 Box (24) + 5 Piece = **53** |
| `splitBaseQuantity(qtyBase, set)` | Greedy, largest unit first. Uses remainder arithmetic, because `Math.floor(q ÷ size)` can round up near 2^53; a test covers that exact trap. | 283 with 60/6/1 → **4 Carton + 7 Box + 1 Piece** |
| `formatQuantity` | Omits zero parts; zero shows as `0 <base unit>`; optional short names and separator. No pluralisation, because names are data. | — |

**Validation (`validateUnits` → issue codes):**

| Code | Rule |
|---|---|
| `NO_UNITS` | At least one unit |
| `NO_BASE_UNIT` / `MULTIPLE_BASE_UNITS` | Exactly one base unit |
| `BASE_UNIT_QTY_NOT_ONE` | The base unit has `baseQty` 1 |
| `INVALID_BASE_QTY` | `baseQty` is a positive safe integer |
| `DUPLICATE_BASE_QTY` | No two units have the same size (so a non-base unit of size 1 is rejected) |
| `DUPLICATE_ID` | Unique ids |
| `DUPLICATE_NAME` | Unique names, ignoring case and surrounding spaces (like the planned `COLLATE NOCASE`) |
| `EMPTY_NAME` | Every unit has a name |
| `NOT_NESTED` | The nesting rule below |

**Nesting rule (exact; plan §7.3):**

- Sort the units by `baseQty`. **Each unit's `baseQty` must be an exact multiple of the next smaller unit's
  `baseQty`.** Checking adjacent pairs is enough, because divisibility is transitive.
- 1 / 6 / 60 ✅. 1 / 6 / 24 ✅ (24 = 4 × 6). 1 / 2 / 12 / 144 ✅.
- **1 / 4 / 6 ❌.** 6 is not a multiple of 4. 12 base units could be "2 × 6" or "3 × 4", so a greedy display
  would be ambiguous.
- 1 / 6 / 60 / 90 ❌ (90 is not a multiple of 60).
- **Why it matters:** with the rule, the greedy split is canonical. Every smaller count is below one of the next
  larger unit, which the invariant test confirms for all quantities 0–3000 and 300 large random ones.
- The plan's fallback, "if A1 confirms non-nested packing, relax the rule and display base + largest unit", is
  **not** implemented because it is unconfirmed. It would be a change confined to `quantity.ts`.

---

## 6. Invoice calculation design

The calculator receives already-resolved numbers only: quantities, unit sizes (snapshots), prices charged, and
balances. It performs no database, stock, product or customer lookup. The formulas follow plan §11.2:

```
row:      qtyBase = quantity × unitBaseQty ;  amount = quantity × unitPrice
line:     gross = Σ row amounts ; deductions applied in order ; net = gross − deductions   (net ≥ 0)
invoice:  linesNet = Σ line net ; net = linesNet − invoice-level deductions
          total = net + Σ charges
          outstanding = previousBalance + total − received
```

**Composable, not hardcoded:**

- **Deductions** are an ordered list of caller-named entries (`{ key, spec, basis? }`). Examples: `'discount'`,
  `'scheme'`, `'extraDiscount'`.
  - Each is a **percentage (bps)** or a **fixed amount**.
  - A percentage applies to the **original** amount (the default) or to the **remaining** amount after earlier
    deductions (compounding).
  - **Validation:**
    - bps must be 0–10 000
    - amounts must be non-negative integers
    - keys must be unique and non-empty
    - **each deduction may take at most what remains**, so a discount can never exceed its gross/net
      (`DEDUCTION_EXCEEDS_BASE`)
- **Charges** (`{ key, amountMinor }`, e.g. freight) are added after the deductions. They must be non-negative,
  with unique keys.
- **Balances:** the previous balance may be negative (customer credit). `received` must be ≥ 0. A negative
  outstanding (overpayment) is returned as-is, and the caller decides the policy.
- **Free goods (if B3 confirms them)** need no special API: a quantity row priced at 0 counts in `qtyBase` (and
  later in stock and COGS) and adds nothing to the gross.
- **Returned for later header columns and print:**
  - `lineDeductionTotals` gives per-key sums across lines (e.g. Σ discount and Σ scheme separately).
  - `netMinor` and `totalMinor` are both returned. Which one is "Current Invoice", and which is written in words,
    stays the caller's choice (B6).
- **Exact identities** (tested on 300 random invoices):
  - `gross − lineDeductions − invoiceDeductions + charges = total`
  - `previousBalance + total − received = outstanding`
  - each line: `gross − deductions = net ≥ 0`
  - Σ per-key totals equals Σ line deductions

When B3/B5/B6 are answered, a later phase fixes the keys, order and bases, e.g.
`[discount (bps or amount), scheme (…)]`. None of the arithmetic changes.

---

## 7. Weighted-average valuation helper

```
outValue = round_half_up( V × n ÷ Q )      (BigInt intermediate)
n = Q  ⇒  outValue = V exactly             (so Q = 0 ⇒ V = 0 always holds)
```

**Examples:**

- **Basic:** Q = 10, V = 150 000, sell 2 → **30 000**.
- **Rounding:** Q = 3, V = 100 → selling 1 + 1 + 1 gives **33, 34, 33** (Σ = 100, final V = 0).
- **Other boundaries tested:** 0.5 → 1, 2.5 → 3, 0.375 → 0, 0.625 → 1.

**BigInt cases tested:**

| Case | Result |
|---|---|
| V = 9e15, Q = 9e8, n = 450 000 001 | 4 500 000 010 000 000, from an intermediate of about 4e24 |
| V = 9 000 000 000 000 001, Q = 2, n = 1 | …001 (a float division would give …000) |
| Q = V = MAX_SAFE, n = MAX_SAFE − 1 | Exact |

**Guards:**

- n > Q → `INSUFFICIENT_STOCK`.
- Q = 0 with V ≠ 0 → `INVALID_ARGUMENT` (a broken position).
- Negative or fractional input → `INVALID_ARGUMENT`.
- n = 0 → 0.

**Invariants:**

- Over 200 random receive/sell sequences of 60 steps, at every step:
  - 0 ≤ out ≤ V, and out = V when n = Q
  - V ≥ 0, and Q = 0 ⇒ V = 0
  - Σ in − Σ out = V
- In 5,000 random cases, every partial outflow is within ½ minor unit of the exact value, with halves rounded up.

No stock movements or database logic were created.

---

## 8. Amount-in-words approach

- `integerToWords(value, numbering)` and `amountInWords(amountMinor, options)` take only a number. They are **not
  coupled to invoices**, and they do not decide which total is written in words (B6).
- **South Asian numbering** (default): thousand / **lakh** (1,00,000) / **crore** (1,00,00,000). Above a crore,
  the crore count is itself spelled out: 100 crore → "One Hundred Crore", 10^12 → "One Lakh Crore". This covers
  the whole safe-integer range.
- **International numbering** is available (thousand … quadrillion).
- **Style:** title case, no hyphens ("Twenty Five"), and no internal "and". Major and minor parts are joined
  with "and", and the configurable suffix defaults to "Only".
- **Examples:**
  - 125 050 → "One Thousand Two Hundred Fifty Rupees and Fifty Paisa Only"
  - 50 → "Fifty Paisa Only"
  - 0 → "Zero Rupees Only"
  - 99,99,999.99 → "Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine Rupees and Ninety Nine Paisa Only"
- **Configurable:**
  - `minorDigits` (0–4)
  - `numbering`
  - `majorUnit` and `minorUnit` (singular/plural; defaults Rupee/Rupees, Paisa/Paisa)
  - `suffix`
- Negative amounts are rejected.
- Quotient and remainder avoid float division (`n % d` is exact), so large values are correct.
- The defaults are **provisional until E2 is confirmed**.

---

## 9. Shared-code boundary

- `src/shared/**` imports nothing outside itself. The domain modules import only each other.
- **ESLint guard** (new, `src/shared/**/*.ts`):
  - **Restricted imports:** `electron`, `@electron-toolkit/*`, `react`, `react-dom`, `node:*`, `fs`, `path`, `os`,
    `child_process`, `better-sqlite3`, `@renderer/*`, `@tanstack/*`, `zustand`, `sonner`, `lucide-react`,
    `radix-ui`.
  - **Restricted globals:** `window`, `document`, `navigator`, `location`, `localStorage`, `sessionStorage`,
    `indexedDB`, `fetch`, `process`, `Buffer`, `require`, `__dirname`, `__filename`, `global`, `globalThis`.
- **The guard was proven to fire.** Linting a probe snippet from stdin, with no file written, gave 5 errors: the
  `node:fs` and `electron` imports, and `window`, `localStorage` and `process`.

---

## 10. Tests and coverage

| Test file | Tests | Covers |
|---|---|---|
| `money.test.ts` | 113 | Parsing (valid, invalid, precision, negative, range), percent parsing, formatting (grouping, prefix, precision, limits, round-trip), add/subtract/sum/multiply overflow, half-up division table incl. negatives and 10^40, BigInt `mulDiv`, basis points + 5,000-case rounding property |
| `quantity.test.ts` | 41 | toBase/total, validation of 1/2/3/4-level sets, 1/4/6 and other non-nested sets, all issue codes, split for 1/2/3 levels, zero, MAX_SAFE and the float-floor trap, formatting, **both §9.3 stress tables**, split/toBase reconciliation invariants |
| `invoice-calc.test.ts` | 21 | Rows, no discount, % discount (incl. 49.975 → 50), fixed discount, 100%, original vs remaining basis, exceeding/invalid deductions, mixed rows (2 Box + 5 Pcs = 53, Rs 5,350), free goods as a zero-price row, invoice with extra discount (amount and %), freight, other charges, previous balance, received, credit, overpayment, empty invoice, invalid invoice input, 300-invoice reconciliation property |
| `valuation.test.ts` | 27 | Partial, full, zero outflow; 13 rounding boundaries; BigInt intermediates; errors; 33/34/33 depletion; random-sequence invariants; ½-unit rounding property |
| `amount-in-words.test.ts` | 57 | 0, 1, 19, 20, 99, 100, 1,000, 1 lakh, 10 lakh, 1 crore, 99,99,999, 100 crore, lakh crore, MAX_SAFE (both systems), minor units, labels/suffix/precision options, errors; distinct well-formed words for 0–20,000 |
| `index.test.ts` | 2 | The public API is exported; internals are not |
| **Domain total** | **261** | |

The whole suite (`npm test`) is **280 tests in 10 files**, all passing. Beyond the domain tests above, that
includes the 19 Phase 1 tests.

**Coverage** (`npm run test:coverage`, scope `src/shared/domain`, thresholds 95%):

| Statements | Branches | Functions | Lines |
|---|---|---|---|
| **100%** (313/313) | **100%** (185/185) | **100%** (70/70) | **100%** (271/271) |

- Coverage tooling: **`@vitest/coverage-v8` 5.0.0**, pinned exactly because it must match `vitest` 5.0.0. Its
  only peer, `@vitest/browser`, is optional and was not installed.
- The HTML report is written to `coverage/`, which git, ESLint, Prettier and packaging all ignore.

---

## 11. Verification results

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ (node + web) |
| `npm run lint` | ✅ 0 problems |
| `npm test` | ✅ 280 / 280 |
| `npm run test:coverage` | ✅ 100% on every metric (threshold 95%) |
| `npm run build` | ✅ Renderer output **byte-identical to Phase 1** (same asset hashes) |
| Phase 1 UI launches (dev); sidebar and theme unchanged | ✅ **40 / 40** (layout, 224px sidebar, navy/amber active state, hover, collapsed rail + tooltips, no scrolling at 1580×890 / 1366×768 / 1264×712, no console errors) |
| Routes unchanged; Phase 0 security unchanged | ✅ **29 / 29** (sandbox, contextIsolation, nodeIntegration off, webSecurity, `window.api` only, no Node APIs, `window.open`/external navigation blocked, second instance, all 11 routes, 404, error boundary, toasts) |
| No database | ✅ No `.db`/`.sqlite` files and no `data/`/`backups/` in `%APPDATA%\StockFlow` or `StockFlow-dev`; no SQLite package in `node_modules` |
| No Phase 3 files | ✅ `src/main` unchanged (`app-identity`, `index`, `paths`, `security`, `window`); no `db/`, migrations, `.sql`, IPC contract, schemas or services |

---

## 12. Business assumptions intentionally NOT implemented

| ID | Question | How Phase 2 stays neutral |
|---|---|---|
| A1 | Meaning of packing strings (`1*12*18`, …) | Never parsed or interpreted. Units come from explicit `baseQty` data. |
| A2 | Real units per product | Unit names and sizes are data. Any 1..n nested set works. |
| A3 | Mixed-unit presentation (one line per unit vs one line with several units) | The calculator accepts any number of quantity rows per line, so both options compute identically. No print format is chosen. |
| B1 | Invoice Code | Not in the maths at all |
| B2 | Ctn | Not in the maths. Never used for stock quantities. |
| B3 | Sch (free goods vs amount/%) | Both are expressible: a zero-price quantity row, or a named deduction (% or amount) on the original or remaining basis |
| B4 | Dispatch fields | Not in the maths |
| B5 | Discount policy | % or fixed amount, per line and/or invoice level, in any order. Nothing is fixed. |
| B6 | Current Invoice formula, received presentation, amount-in-words target | Both `netMinor` and `totalMinor` are returned; `amountInWords` takes any amount |
| B7 | Invoice numbering | Not in Phase 2 |
| E2 | Currency / words style | PKR / Rupees / Paisa / lakh-crore are **defaults only**, and every label is configurable |

**Also deliberately not decided:**

- The relaxed display for non-nested units (plan §7.3 fallback).
- Pluralised unit names.
- Negative-quantity display (e.g. adjustment deltas).
- Stock-availability blocking. It is Phase 6 service logic. The §9.3 "blocked" steps are asserted in tests as
  plain comparisons.

---

## 13. Notes for the reviewer

1. **New devDependency:** `@vitest/coverage-v8` **5.0.0**, pinned exactly because the coverage provider must
   match the installed `vitest` version. If `vitest` is upgraded later, upgrade this package to the same version.
2. **Parsing strictness is a UX choice.** It rejects `".5"`, `"5."` and `"12.340"` (with 2 decimals). It
   accepts both international and lakh-style commas. Relaxing any of these is a one-line change to the pattern.
3. **Deduction basis default is `'original'`.** Two percentages on a line are both computed on the gross unless
   `'remaining'` is chosen. This is an open business question (B3/B5), not a technical one.
4. **npm audit** still reports the same 2 high findings in `electron` (via `extract-zip`), as in earlier phases.
   The coverage package added no new findings.

---

## 14. Confirmation

- **Phase 3 was NOT started.**
  - No SQLite, driver, migrations, database files/folders, IPC channels, Zod schemas, services or business
    screens.
  - No fake or sample business data.
- Electron, security, preload, routing (React Router v8), sidebar and theme are unchanged.
- The implementation plan was not modified.
- **Nothing was committed.**
