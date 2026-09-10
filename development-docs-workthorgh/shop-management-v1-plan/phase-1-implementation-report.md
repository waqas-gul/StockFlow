# StockFlow — Phase 1 Implementation Report

> Phase: **1 — UI foundation** (Tailwind CSS v4, shadcn/ui, React Router, application shell, TanStack
> Query, toasts, error handling, test runner). Date: 2026-09-10.
> Status: **Implemented and verified**, with the sidebar UI correction (§11) and the theme / colour refinement
> (§12) applied. Theme/UI approved by the owner. **Final packaged-build verification passed (§13).** Phase 2
> has **not** been started.

---

## 1. Phase 0 checkpoint

| Item | Result |
|---|---|
| Diff inspected before committing | Only the approved Phase 0 work: 13 tracked changes (107+/432−), plus `src/main/{app-identity,paths,security,window}.ts` and `phase-0-implementation-report.md` |
| Requested command | `git add .` then `git commit -m "feat: establish secure StockFlow desktop foundation"` |
| Outcome | **Nothing to commit.** Between the inspection and the commit, the owner had already committed the identical Phase 0 work. |
| Phase 0 commit | **`f57a0ce5068c704130b0edc8cbb4fcbf55df08c7`**. Author Waqas Gul, 2026-09-10 14:39 +0500. Message: *"feat: implement Phase 0 foundation for StockFlow application"*. |
| Content check | `git diff 511deec f57a0ce`: exactly the 18 Phase 0 files (13 changed + 4 new main files + report) |
| Baseline | `511deec` is untouched. It is the direct parent of `f57a0ce`, and nothing was amended. |
| Remote | `origin = https://github.com/waqas-gul/StockFlow.git`. `main` is up to date with `origin/main`. |
| Action taken | None. A duplicate or empty commit was not created, and the pushed history was not rewritten. |

The only difference from the request is the commit message: *"implement Phase 0 foundation…"* instead of
*"establish secure StockFlow desktop foundation"*.

Phase 1 changes were left uncommitted for review. The owner has since committed them: `5bdc0c6` and `46ec900`
(2026-09-10 15:41), pushed to `origin/main`. Claude made no commits.

---

## 2. Dependencies

### Removed

| Package | Reason |
|---|---|
| `@electron-toolkit/preload` | A repository search found no imports outside `package.json`, the lockfile, and docs. It became unused when Phase 0 stopped exposing `electronAPI`. |

### Moved `dependencies` → `devDependencies`

`tailwindcss`, `@tailwindcss/vite`, `@tanstack/react-query`, `zustand`, `react-hook-form`, `@hookform/resolvers`.

- All of these are **renderer/build-time** libraries. Vite bundles them into `out/renderer`, so they are not
  needed at runtime.
- electron-builder copies only `dependencies` into `app.asar`.
- The packaged `node_modules` shrank from ~30 packages (including native Tailwind/lightningcss binaries) to
  **2**.

### Kept in `dependencies` (main-process runtime)

- `@electron-toolkit/utils`: used by main
- `zod`: reserved for main-process validation from Phase 3

### Added (`devDependencies`, all bundled into the renderer or used for tests)

| Package | Version | Purpose |
|---|---|---|
| `react-router` | ^8.3.1 | Hash router. **Current major is 8**, whereas the plan said v7. It requires Node ≥ 22.22.0; this machine has 22.22.2. |
| `radix-ui` | ^1.6.7 | Unified Radix primitives used by the shadcn components (Slot, Separator, Tooltip) |
| `class-variance-authority` | ^0.7.1 | shadcn Button variants |
| `clsx` | ^2.1.1 | `cn()` utility |
| `tailwind-merge` | ^3.6.0 | `cn()` utility (Tailwind v4 aware) |
| `lucide-react` | ^1.44.0 | Icons |
| `tw-animate-css` | ^1.4.0 | Animation utilities used by shadcn (tooltip) |
| `sonner` | ^2.0.8 | Toasts |
| `vitest` | ^5.0.0 | Test runner (peer `vite ^6.4 \|\| ^7 \|\| ^8`; project has 7.3.6) |

**Deliberately not added:**

- `next-themes`: the shadcn Sonner wrapper needs it only for theme switching, and V1 is light-only.
- `cn`: added automatically by the shadcn CLI, then removed (see §10, item 3).
- `jsdom` / `@testing-library/react`: not needed for the Phase 1 tests.

Final `dependencies`: `@electron-toolkit/utils`, `zod`.

---

## 3. Files

### Created

| File | Purpose |
|---|---|
| `components.json` | shadcn/ui configuration |
| `vitest.config.ts` | Vitest config (node environment, React plugin, `@renderer`/`@shared` aliases) |
| `src/shared/README.md` | Keeps the `@shared` folder in git and documents its rules. It contains no code. |
| `src/renderer/src/lib/utils.ts` | `cn()` = `twMerge(clsx(...))` |
| `src/renderer/src/app/navigation.ts` | Single source of navigation: sections, paths, labels, icons, placeholder text |
| `src/renderer/src/app/routes.ts` | Route tree (no JSX, so it can be tested in Node) |
| `src/renderer/src/app/router.ts` | `createHashRouter(routes)` |
| `src/renderer/src/app/query-client.ts` | QueryClient with the approved defaults |
| `src/renderer/src/app/layout/AppShell.tsx` | Sidebar + top bar + scrolling content area |
| `src/renderer/src/app/layout/Sidebar.tsx` | Persistent sidebar with grouped navigation, active state, and icon rail + tooltips below 1024px |
| `src/renderer/src/app/layout/TopBar.tsx` | Section title + today's date |
| `src/renderer/src/app/NotFoundPage.tsx` | Unknown route screen, rendered inside the shell |
| `src/renderer/src/app/RouteErrorPage.tsx` | Router error boundary screen |
| `src/renderer/src/app/AppErrorBoundary.tsx` | Top-level React error boundary for failures outside the router |
| `src/renderer/src/components/common/ErrorFallback.tsx` | Shared error UI (Reload / Dashboard) |
| `src/renderer/src/components/common/PlaceholderPage.tsx` | Section placeholder card, driven by `navigation.ts` |
| `src/renderer/src/components/common/DevChecks.tsx` | **Development-only** card on Settings: "Show test notification" and "Simulate screen error". It is not rendered in production (`import.meta.env.DEV`). |
| `src/renderer/src/components/ui/button.tsx`, `card.tsx`, `separator.tsx`, `tooltip.tsx` | Generated by `npx shadcn@4.21.0 add` |
| `src/renderer/src/components/ui/sonner.tsx` | shadcn Sonner wrapper, written without `next-themes` |
| `src/renderer/src/lib/utils.test.ts`, `app/routes.test.ts`, `app/query-client.test.ts`, `app/layout/Sidebar.test.tsx` | Tests (`Sidebar.test.tsx` added by the sidebar correction, §11) |

### Changed

| File | Change |
|---|---|
| `package.json` / `package-lock.json` | Dependency changes (§2); scripts `test` (`vitest run`) and `test:watch` (`vitest`) |
| `electron.vite.config.ts` | `@tailwindcss/vite` in the **renderer only**; `@shared` alias for main, preload, and renderer |
| `tsconfig.json` | Root `paths` (`@renderer/*`, `@shared/*`) so the shadcn CLI can resolve aliases. It still compiles nothing (`files: []` + references). |
| `tsconfig.node.json` | Include `vitest.config.*` and `src/shared/**`; `@shared/*` path |
| `tsconfig.web.json` | Include `src/shared/**`; `@shared/*` path. The template's deprecated `baseUrl` was removed (see §10, item 5). |
| `eslint.config.mjs` | Override for `src/renderer/src/components/ui/**`: generated shadcn files may omit explicit return types and export variants |
| `electron-builder.yml` | Exclude `vitest.config.*` and `components.json` from the package |
| `src/renderer/src/main.tsx` | Providers: `AppErrorBoundary` → `QueryClientProvider` → `TooltipProvider` → `RouterProvider` + `Toaster` |
| `src/renderer/src/assets/main.css` | Tailwind v4 + shadcn theme tokens (replaces the Phase 0 placeholder CSS). The sidebar correction (§11) added the thin `.scrollbar-subtle` scrollbar. The theme refinement (§12) replaced the palette (navy / off-white / amber). |

### Deleted

- `src/renderer/src/App.tsx`: the Phase 0 placeholder, replaced by the router and shell.

---

## 4. Tailwind CSS v4

- **Plugin:** `@tailwindcss/vite` in `renderer.plugins` only. Main and preload are unaffected.
- **CSS entry:** `src/renderer/src/assets/main.css`, containing `@import 'tailwindcss'` and `@import 'tw-animate-css'`.
- **Theme:** `@theme inline` maps shadcn CSS variables (background, foreground, card, primary, muted, border, ring,
  sidebar…) to Tailwind colours and radii. The `:root` token values are the shadcn **neutral** palette.
- **Light theme only.** The `dark` custom variant is declared but has no dark tokens.
- **Font:** `'Segoe UI', system-ui, sans-serif` (offline, no web fonts).
- There is no `tailwind.config.*` file; Tailwind v4 is configured in CSS.
- **CSP compatibility:** unchanged. The CSS is emitted as a file (`style-src 'self'`). Radix/Sonner inline styles
  are covered by the existing `'unsafe-inline'` for styles. No CSP violations were observed.

---

## 5. shadcn/ui

**`components.json`:**

```json
{
  "style": "new-york", "rsc": false, "tsx": true,
  "tailwind": { "config": "", "css": "src/renderer/src/assets/main.css", "baseColor": "neutral", "cssVariables": true, "prefix": "" },
  "iconLibrary": "lucide",
  "aliases": { "components": "@renderer/components", "utils": "@renderer/lib/utils", "ui": "@renderer/components/ui",
               "lib": "@renderer/lib", "hooks": "@renderer/hooks" }
}
```

**Why these values:**

- They were taken from the shadcn CLI 4.21.0 source, not guessed.
- With Tailwind v4, the CLI maps `new-york` to its `new-york-v4` registry, and legacy styles default to the
  **Radix** base.
- `slate` is no longer a valid base colour, so `neutral` is used.

**How the components were created:**

- `shadcn init` was not used, because it cannot detect an `electron.vite.config.ts` project.
- The config was written by hand, then `npx shadcn@4.21.0 add button card separator tooltip --yes` generated
  the components.
- The CLI did **not** modify `main.css`.

**Components:** Button, Card, Separator, Tooltip (generated), and Sonner Toaster (hand-written).

**Post-generation changes:**

1. The `import { cn } from "cn"` imports were replaced with `@renderer/lib/utils` (see §10, item 3).
2. The files were formatted with Prettier to match the project style (single quotes, no semicolons).

---

## 6. `@shared` alias

| Place | Configuration |
|---|---|
| `electron.vite.config.ts` | `@shared → src/shared` for main, preload, and renderer |
| `tsconfig.node.json` / `tsconfig.web.json` | `include: src/shared/**`, `paths: @shared/*` |
| `tsconfig.json` (root) | `paths: @shared/*` |
| `vitest.config.ts` | alias `@shared` |

`src/shared/` contains only a README. **No schemas and no domain logic were added.**

---

## 7. Router, shell, Query, toasts, errors

### Router (`createHashRouter`, `RouterProvider` from `react-router/dom`)

```
/  (AppShell, ErrorBoundary = RouteErrorPage  ← last resort, full screen)
└─ (pathless, ErrorBoundary = RouteErrorPage  ← screen errors render INSIDE the shell)
   ├─ index                → PlaceholderPage   #/
   ├─ invoices/new         → PlaceholderPage   #/invoices/new
   ├─ invoices             → PlaceholderPage   #/invoices
   ├─ products             → PlaceholderPage   #/products
   ├─ stock/in             → PlaceholderPage   #/stock/in
   ├─ stock/adjustments    → PlaceholderPage   #/stock/adjustments
   ├─ customers            → PlaceholderPage   #/customers
   ├─ payments             → PlaceholderPage   #/payments
   ├─ expenses             → PlaceholderPage   #/expenses
   ├─ reports              → PlaceholderPage   #/reports
   ├─ settings             → PlaceholderPage   #/settings
   └─ *                    → NotFoundPage
```

Routes are generated from `navigation.ts`, so the sidebar and routes cannot drift apart. Each later phase
replaces a route's `Component` with its real page.

### Shell and navigation

- **Sidebar** (224px from 1024px wide, otherwise a 64px icon rail with tooltips; corrected in §11):
  - "StockFlow" brand with the Lucide `Boxes` icon at the top
  - Dashboard (`LayoutDashboard`)
  - **Sales:** New Invoice (`FilePlus`), Invoices (`ReceiptText`)
  - **Inventory:** Products (`Package`), Stock In (`PackagePlus`), Stock Adjustments (`ArrowUpDown`)
  - **Customers:** Customers (`Users`), Payments (`HandCoins`)
  - **Finance:** Expenses (`Wallet`), Reports (`ChartColumn`)
  - **Settings** (`Settings`) pinned at the bottom
  - The active item is highlighted: `NavLink end` sets `aria-current="page"`, and the styling keys off that
    attribute (grey background, full-strength text, a 3px indicator bar). See §11.
- **Top bar:** current section title and today's date.
- **Content area:** scrolls independently. Verified at 1366×768 and at the 1024×700 minimum with no horizontal
  overflow.
- **Placeholder pages:** a Card with the section icon, the title, "*X* will be implemented in a later phase.",
  and "This section is a placeholder. No data is stored or shown yet." **No sample or business data.**

### TanStack Query (`app/query-client.ts`)

```
queries:   { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false }
mutations: { retry: 0 }
```

`QueryClientProvider` wraps the app root. **No queries exist yet.**

### Toasts

Sonner `<Toaster position="bottom-right" />` at the root, light theme, shadcn token colours. It is triggered in
development via Settings → Developer checks.

### Error handling (the window is never blank)

1. **`AppErrorBoundary`** (class component) wraps all providers. It catches failures outside the router.
2. **Root route `ErrorBoundary`** catches failures of the shell itself.
3. **Pathless layout route `ErrorBoundary`** catches screen failures and shows the fallback inside the shell,
   so the sidebar keeps working. The fallback offers **Reload** and **Dashboard**.

No logging beyond `console.error`. Main-process logging belongs to a later phase.

---

## 8. Tests

- **Config:** `vitest.config.ts`, Node environment, pattern `src/**/*.test.{ts,tsx}`
- **Scripts:** `npm test` → `vitest run`; `npm run test:watch` → `vitest`

| File | Tests |
|---|---|
| `lib/utils.test.ts` | `cn` drops falsy values; the last conflicting Tailwind utility wins |
| `app/routes.test.ts` | Navigation has exactly the 11 V1 sections with unique paths; each of the 11 paths resolves (via `matchRoutes`) to its section page; unknown paths resolve to `NotFoundPage` |
| `app/query-client.test.ts` | QueryClient uses the approved defaults |
| `app/layout/Sidebar.test.tsx` | Renders the sidebar (`react-dom/server` + `MemoryRouter`): one link per navigation item; every link has real layout classes (regression test for the §11 bug); only the current route has `aria-current="page"` |

No money, quantity, or other Phase 2 tests were added.

---

## 9. Results

| Command | Result |
|---|---|
| `npm run typecheck` | ✅ Pass (node + web) |
| `npm run lint` | ✅ Pass, **0 problems**. The first run had 56 Prettier *warnings*, almost all in the generated shadcn files; they were fixed by running Prettier on `src` and the config files. |
| `npm test` | ✅ **4 files, 19 tests passed** (16 before the sidebar correction) |
| `npm run build` | ✅ Pass: main 3.45 kB, preload 0.24 kB, renderer JS 1,224.34 kB, CSS 33.12 kB (after the theme refinement) |
| `npm run build:unpack` | ✅ Pass: `dist/win-unpacked/StockFlow.exe` |
| Packaged `app.asar` | `out/**`, `package.json`, `resources/icon.png`, `node_modules/{@electron-toolkit/utils, zod}`. That is 7.2 MB, with no `src/`, docs, `components.json`, or `vitest.config.ts`. |

**Bundle size note:** the renderer bundle is 1.2 MB, up from 0.64 MB in Phase 0. Icons are tree-shaken (8 icon
definitions in the bundle); the size comes from react-dom, Radix, React Router, and TanStack Query. That is
acceptable for an offline app loaded from disk.

### Runtime verification

The checks were automated through the Chrome DevTools Protocol (renderer) and the main-process inspector. The
script is kept in the session scratchpad, not in the project.

- **Dev** (`electron-vite dev`): **29 / 29 passed**
- **Packaged** (`StockFlow.exe`, fresh launch): **26 / 26 passed**

| # | Requested check | Dev | Packaged |
|---|---|---|---|
| 1 | StockFlow launches; title `StockFlow` | ✅ | ✅ |
| 2 | Sidebar renders (11 links, brand visible, Tailwind computed styles: flex, 240px, border, sidebar colour, Segoe UI). Re-run in dev after §11 with 224px. | ✅ | ✅ |
| 3 | Every nav item opens its route (hash, top-bar heading, card title, active link all match) | ✅ 11/11 | ✅ 11/11 |
| 4 | Reload on `#/stock/in` stays on Stock In; unknown `#/does-not-exist` shows "Page not found" inside the shell | ✅ | ✅ |
| 5 | Tailwind styling works | ✅ | ✅ |
| 6 | shadcn components render (Card: 14px radius, border, shadow; Buttons; Tooltip "Products" visible on the icon rail at 1024×700) | ✅ | ✅ |
| 7 | QueryClientProvider initialises without errors (no console errors or CSP violations during the whole run) | ✅ | ✅ |
| 8 | Toast works: "Show test notification" → Sonner toast "Notifications are working." | ✅ | n/a (dev-only trigger; checks card confirmed hidden) |
| 8b | Error handling: "Simulate screen error" → fallback inside the shell (not blank) → "Dashboard" recovers | ✅ | n/a (dev-only trigger) |
| 9 | Test runner passes | ✅ 16/16 | — |
| 10 | Packaged application launches | — | ✅ |
| 11 | Phase 0 security still passes (see §9.1) | ✅ | ✅ |
| 12 | No database or data folder from business logic | ✅ | ✅ |
| 13 | No Phase 2 or business functionality | ✅ | ✅ |
| — | Minimum size 1024×700: sidebar collapses to a 64px icon rail, labels hidden, no horizontal overflow | ✅ | ✅ |

### 9.1 Phase 0 security regression

| Check | Dev | Packaged |
|---|---|---|
| `window.electron` undefined | ✅ | ✅ |
| Only `window.api` exposed (empty object) | ✅ | ✅ |
| No `require`, `process`, `Buffer`, or `ipcRenderer` in the renderer | ✅ | ✅ |
| `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true` | ✅ | ✅ |
| `window.open` → `null`; `location.href = 'https://example.com/'` blocked | ✅ | ✅ |
| DevTools: open in dev (control) / **blocked** in production; menu: dev only | ✅ | ✅ |
| `userData`: `StockFlow-dev` / `StockFlow` | ✅ | ✅ |
| Second instance exits (code 0, ~1.7 s); the minimised first window is restored; one window remains | ✅ | ✅ |

No IPC was added; `preload` and `src/main` are unchanged in Phase 1.

### 9.2 Data folders

`%APPDATA%\StockFlow-dev` and `%APPDATA%\StockFlow` contain only Chromium's profile files. There are **no
`.db`/`.sqlite` files and no `data/` or `backups/` folders.**

---

## 10. Issues and deviations

1. **Phase 0 commit message differs.** The owner's own commit `f57a0ce` holds the Phase 0 checkpoint (§1). It
   was not rewritten, because it is already pushed.
2. **React Router 8** instead of the plan's v7, because 8.3.1 is current. The APIs used (`createHashRouter`,
   `RouterProvider` from `react-router/dom`, `NavLink`, `useRouteError`) are unchanged. **Every machine that
   builds the project needs Node ≥ 22.22.0.**
3. **shadcn CLI 4.21 imports `cn` from a new `cn` npm package.** The package is shadcn's own (maintainer
   `shadcn`, repo `shadcn-ui/cn`, v0.2.6, no install scripts), and the CLI added it to runtime `dependencies`.
   - It was removed. The generated imports now use the requested `@renderer/lib/utils` (`clsx` +
     `tailwind-merge`), so there is a single, mature implementation.
   - **Every future `shadcn add` needs the same one-line import fix**, unless you prefer to adopt the `cn`
     package later, once it reaches 1.0.
4. **No `next-themes`.** The Sonner wrapper is hand-written with a fixed light theme.
5. **`baseUrl` removed from the tsconfigs.** The editor flagged it as deprecated for TypeScript 6/7. `paths` are
   now relative (`./src/...`), which TypeScript has supported since 4.1. It works with TS 5.9.3 and with the
   shadcn CLI.
6. **Packaging leak found and fixed.** `components.json` and `vitest.config.ts` were being copied into
   `app.asar`. They are now excluded in `electron-builder.yml`.
7. **The development-only "Developer checks" card** (Settings) exists to exercise toasts and error handling. It
   is compiled out of production rendering. It can be removed in a later phase if you prefer.
8. **The first dev launch quit immediately.** Your own `npm run dev` session (started 14:49) held the
   `StockFlow-dev` single-instance lock; this is correct behaviour and a live confirmation of the lock. Dev
   verification ran after your session had closed. Your session was never touched.
9. **npm audit: 2 high findings**, `electron` → `extract-zip` (symlink path traversal in the zip extractor used
   by Electron's install/download script).
   - They are **pre-existing** (Electron 39.8.10 is unchanged since the baseline) and not introduced by Phase 1.
   - Fixing them requires an Electron major upgrade (≥ 40.10.3 / 41.7.2 / 42.3.4). That is a separate decision.
10. **Placeholder routing design.** A single `PlaceholderPage`, driven by `navigation.ts`, serves all sections
    instead of 11 near-identical page files. Feature folders (`features/<domain>/pages`) will be created by
    the phases that implement them.
11. **Zustand, React Hook Form, and `@hookform/resolvers`** are installed (now as devDependencies) but not used
    yet. No stores or forms were created, as instructed.
12. **Tailwind v4 scans the whole repository for class names** (including the docs). This is harmless; it can be
    narrowed with `@import 'tailwindcss' source(...)` if build time ever matters.
13. **Test-harness notes** (not app issues):
    - At this PC's display scaling, Chromium reports 1px borders as `0.8px`, so the check was relaxed to
      "> 0".
    - One packaged run reused an instance that the previous run had minimised and restored, and `setSize` did
      not apply to it. A fresh launch passed 26/26, and the script now restores the window before resizing.
14. **Line endings:** Git warns about LF→CRLF conversion (`core.autocrlf`). This is cosmetic.
15. **The original verification missed the sidebar styling bug** fixed in §11. Its "active link" check read
    `aria-current`, which NavLink sets correctly, and never checked the link's computed layout. The new
    `Sidebar.test.tsx` and the §11 layout checks now cover this.

---

## 11. Sidebar UI correction

Requested after review. The screenshot was taken at about 1580×890 on a 125%-scaled display. It showed:

- a sidebar that was too wide and too tall
- a native scrollbar
- Customers, Payments, Expenses, and Reports pushed below the fold
- no clear active item

**Scope:** only `Sidebar.tsx` and `main.css` changed, plus a new test. Routes, `navigation.ts`, the top bar,
the placeholder pages, `src/main`, and the preload are untouched.

### What caused the excessive scrolling

The root cause was a **bug**, not only spacing:

- Each link was `<TooltipTrigger asChild><NavLink className={({ isActive }) => …}>`.
- Radix `Slot` (behind `asChild`) merges class names as strings:
  `[slotClassName, childClassName].filter(Boolean).join(' ')`
  (`@radix-ui/react-slot/dist/index.mjs:99-100`).
- That turned NavLink's `className` **function into its own source text**. The rendered `class` attribute was
  literally `({ isActive }) => cn('flex items-center …', …)`.

**Effects:**

- Tokens such as `'flex` carried stray quotes and never matched, so the links were not flex rows.
- Each icon (a block-level `svg`) stacked **above** its label, which made each item about 66px tall (about 82
  physical px on the screenshot).
- Both the active and inactive class lists were in the text, so every link received the same styles and
  **no item looked active**.
- 11 stacked items plus group headings needed roughly 900px, far more than the space available, so the nav
  scrolled with the native Windows scrollbar.

**Fix:**

- NavLink now receives a **plain string** `className`, which `Slot` merges correctly.
- Active styling uses Tailwind `aria-[current=page]:` variants, keyed off the `aria-current="page"` attribute
  that NavLink sets on the current route.
- A code comment in `Sidebar.tsx` explains why a function `className` must not be used there.

### Sidebar width

| | Before | After |
|---|---|---|
| Expanded width (CSS/DIP px) | 240 (`w-60`) | **224** (`w-56`) |
| On a 125%-scaled display (physical px) | 300, which is what the screenshot showed | **280** |
| Collapsed icon rail | 64 | 64 (unchanged) |

- Your "~300px" was 240 CSS px shown at 125% scaling.
- 224 CSS px is between your 240–250 target read as CSS px and read as physical px.
- It fits "Stock Adjustments" with room to spare.
- The wide look came mostly from the stacked rows. If you want another width, it is a one-class change
  (`lg:w-56` → `lg:w-60` for 240, or `lg:w-52` for 208).
- The main content fills the rest automatically (`flex-1`). At 1366×768 it gained 16px (1128px wide).

### Row sizing and spacing

| Element | Before (as rendered) | After |
|---|---|---|
| Nav row | ≈66px, icon stacked above label | **36px** (`h-9`) single row, icon + label vertically centred |
| Row pitch | — | 38px (`space-y-0.5`) |
| Icon | 16px | 16px (`size-4`), in one consistent column |
| Icon/text gap | — | 12px (`gap-3`) |
| Horizontal padding | — | 8px nav + 12px row |
| Radius / type | — | `rounded-md`, 14px medium (`text-sm font-medium`) |
| Group label | 36px incl. padding, 12px text | **20px**, 11px semibold uppercase, muted, wider tracking, 12px gap above each group |
| Header | 56px, 24px logo, 18px text | 56px (kept, so the border lines up with the top bar), 20px logo, 15px semibold text |
| Logo alignment | not aligned with the nav icons | logo left edge = nav icon column (verified) |
| Settings | pinned | pinned (`shrink-0` footer), same 36px row |

**Total height needed:** the full sidebar (header + all 10 nav items with 4 group labels + Settings) needs
**≈631px of window content height**, which is a window about 670px tall.

**Collapsed rail:** group labels are hidden and replaced by a thin 32px divider, so the groups stay visually
separated.

### Scrollbar behaviour

- Structure: header `shrink-0`, then nav `min-h-0 flex-1 overflow-y-auto`, then Settings footer `shrink-0`.
  **Only the middle list scrolls.** Header and Settings never move.
- At normal desktop sizes the list fits, so **no scrollbar exists at all**. Verified: `scrollHeight ==
  clientHeight` at 1580×890, 1366×768, 1264×712, and 1024×700.
- When the window is genuinely too short, a `.scrollbar-subtle` style (`main.css`) replaces the wide native
  Windows scrollbar:
  - **6px** wide
  - rounded, faint grey thumb (`oklch(0.88)`), darker on hover
  - transparent track and no arrow buttons
- Scrolling was **not** disabled; the last item is reachable by scrolling.
- A thumb that appears only on hover was tried first. Chromium does not repaint scrollbar pseudo-elements when
  the parent's `:hover` changes, so the thumb never appeared. A faint, always-present thumb (shown only when
  there is overflow) is reliable and also signals that there are more items.

### Active and hover states

| State | Styling |
|---|---|
| Inactive | Text at 70% foreground, no background |
| Hover (inactive) | `sidebar-accent` at 60% background, full-strength text, `transition-colors` |
| **Active** | `sidebar-accent` background (`--sidebar-accent` darkened from `oklch(0.97)`, which was nearly invisible on the `oklch(0.985)` sidebar, to **`oklch(0.94)`**), full-strength text and icon, plus a **3px dark indicator bar** on the left edge (`before:` pseudo-element) |
| Keyboard focus | `focus-visible` 2px ring (`sidebar-ring`) |

- The hover background is deliberately lighter than the active one, so the two are distinguishable.
- The active state still shows on the collapsed rail, as a highlighted square with the indicator bar.
- The scheme is restrained and neutral: no brand colours and no bold weight shift, so labels don't jump.

### Responsive verification

The checks were automated (CDP + main-process inspector, `electron-vite dev`) with a screenshot at each size.
Sizes are Windows logical px (DIP). This PC is 1536×864 DIP at 125% scaling, so **1264×712 DIP reproduces
your 1580×890 physical-pixel screenshot**. Final run: **40 / 40 passed**.

| Window | Viewport | Sidebar | Nav content / available | Scroll? | Result |
|---|---|---|---|---|---|
| 1580×890 | 1566×854 | 224px | 522 / 745 | No | ✅ all items visible, Settings pinned, active highlighted, no clipping |
| 1366×768 | 1352×731 | 224px | 522 / 622 | No | ✅ same |
| 1264×712 (= your screenshot) | 1250×675 | 224px | 522 / 566 | No | ✅ same |
| Short (asked 1280×560; the 640px minimum window height gave 1280×640) | 1266×603 | 224px | 522 / 494 | **Yes, 28px** | ✅ only the list scrolls; thin 5–6px scrollbar; header and Settings fixed; last item reachable |
| 1024×700 | 1011×663 | **64px rail** | fits | No | ✅ labels and group titles hidden, icons centred (nav, logo, Settings), active highlighted, tooltips "Stock Adjustments" and "Settings" shown |

Additional checks:

- **Hover:** hovering an inactive item changes its background to `sidebar-accent` at 60% and its text to full
  strength, and stays lighter than the active item.
- **Routes unchanged:** the same 11 `href`s in the same order. Each click opens its route and becomes the
  **single** highlighted item.
- **No console errors or warnings.**
- **Phase 0/1 regression** (`verify-phase1`, dev) re-run after the fix: **29 / 29 passed**. That covers
  sandbox, contextIsolation, nodeIntegration, webSecurity, `window.api` only, no Node APIs, `window.open` and
  external navigation blocked, DevTools and menu dev-only, `StockFlow-dev` userData, second instance, all 11
  routes, reload, 404, toast, error boundary, and the icon rail and tooltip.
- **Data folders:** `%APPDATA%\StockFlow-dev` and `%APPDATA%\StockFlow` still contain no `.db`/`.sqlite` files
  and no `data/` or `backups/` folders.

Commands after the correction:

- `npm run typecheck` ✅
- `npm run lint` ✅ 0 problems
- `npm test` ✅ 4 files / 19 tests
- `npm run build` ✅
- Prettier check ✅ for the changed files

The packaged build was not rebuilt for this correction: the change is renderer-only CSS/JSX, and
`npm run build` succeeds.

### Files changed by this correction

| File | Change |
|---|---|
| `src/renderer/src/app/layout/Sidebar.tsx` | String `className` + `aria-[current=page]` styling; compact rows, labels, and header; `lg:w-56`; nav `min-h-0 flex-1 overflow-y-auto scrollbar-subtle`; pinned `shrink-0` footer; collapsed-mode group dividers |
| `src/renderer/src/assets/main.css` | `--sidebar-accent` `0.97 → 0.94`; `.scrollbar-subtle` thin scrollbar |
| `src/renderer/src/app/layout/Sidebar.test.tsx` | **New.** Regression tests (§8) |

No Phase 2 work, business logic, database code, IPC, APIs, or sample data were added. **Nothing was
committed.**

> The **colours** described in this section (neutral grey sidebar, grey active background) were replaced by §12.
> The structure, sizing, scrolling, and active-state *mechanics* described here are unchanged.

---

## 12. Theme / colour refinement

Requested after review, using the supplied dashboard image **as colour inspiration only**. Nothing was copied:
no charts, stat tiles, gradients, or sample data. **Only colours and a few class names changed.** Layout,
spacing, routes, logic, placeholders, `src/main`, the preload, `index.html`/CSP, and security are untouched.

### Palette direction

A restrained three-role palette, defined once as shadcn/Tailwind tokens in `main.css` `:root`:

| Role | Tokens | Value (sRGB) | Used for |
|---|---|---|---|
| **Navy** (identity) | `--sidebar` | `oklch(0.275 0.05 257)` ≈ `#172840` | Sidebar background |
| | `--sidebar-accent` | `oklch(0.36 0.06 257)` ≈ `#283e5c` | Active item; hover at 60% |
| | `--primary` | `oklch(0.34 0.07 257)` ≈ `#1f385c` | Default buttons; placeholder icon |
| **Surfaces** | `--background` | `oklch(0.972 0.005 250)` ≈ `#f3f6f9` | Cool off-white page |
| | `--card` / `--popover` | white | Panels, top bar, toasts |
| | `--secondary` / `--muted` / `--accent` | ≈ `#ebf1f7` | Soft blue-grey tints (icon tile, hovers) |
| | `--border` | ≈ `#dbe0e6` | Borders |
| **Text** | `--foreground` | ≈ `#142030` | Dark slate text |
| | `--muted-foreground` | ≈ `#5a6472` | Secondary text |
| | `--sidebar-foreground` | ≈ `#eff2f6` | Sidebar text |
| | `--sidebar-muted-foreground` | ≈ `#98a6b8` | Sidebar group labels |
| **Amber** (the only warm colour) | `--highlight` = `--sidebar-primary` = `--sidebar-ring` | `oklch(0.78 0.14 70)` ≈ `#f0a646` | See below |

The **amber** is used in exactly three places: the StockFlow logo, the 3px active-item indicator bar, and the
keyboard focus ring in the sidebar. `--highlight` / `--highlight-foreground` are exposed as Tailwind colours
(`bg-highlight`, `text-highlight-foreground`) for later **small** emphasis, such as one key action per screen.

- **One hue family.** All blues share hue ~257, so there are no competing blues. Surfaces carry only a trace of
  blue (chroma ≤ 0.012).
- `--destructive` is unchanged (red, errors only).
- **No gradients.**
- **Shadows:** `--shadow-xs` / `--shadow-sm` were redefined as soft **navy-tinted** shadows (5–7% opacity), so
  cards read as "lifted paper" rather than grey smudges.

**New tokens:** `--highlight`, `--highlight-foreground`, `--sidebar-muted-foreground`, plus the shadow
overrides. Everything else reuses the existing shadcn token names, so future shadcn components pick up the
palette automatically.

### Where colours changed

| Area | Before | After |
|---|---|---|
| Sidebar | Near-white `#fafafa`, grey text | **Navy**; light text, inactive items at 70%, group labels in muted blue-grey |
| Sidebar active item | Light grey background, dark bar | Lighter-navy background, white text, **amber** bar |
| Sidebar hover | Faint grey | Lighter navy at 60%, text to full strength |
| Sidebar focus | Grey ring | **Amber** 2px ring (clearly visible on navy) |
| Sidebar logo | Near-black | **Amber** icon, white wordmark |
| Sidebar scrollbar (short windows) | Light grey thumb | Navy-tone thumb (`--sidebar-accent`), blue-grey on hover |
| Top bar | Page colour (`bg-background`) | **White** (`bg-card`) with a soft border. It links the white cards and the navy sidebar and stays light for readability. |
| Page background | White | **Cool off-white** `#f3f6f9`, so white cards stand out without heavy shadows |
| Cards / placeholder panels | White on white, grey shadow | White on off-white, soft border, navy-tinted soft shadow; icon tile is soft blue-grey with a **navy** icon |
| Titles / secondary text | Neutral black / grey | Dark slate / slate grey (slightly cool, consistent with the navy) |
| Buttons | Near-black primary; outline on page colour | **Navy** primary; outline buttons on **white** (so they don't look grey on white cards); hover soft blue-grey; focus ring navy |
| Tooltip / toast | Dark / white | Unchanged components; now dark slate / white via the tokens |

### Component style adjustments (minimal)

| File | Change |
|---|---|
| `components/ui/button.tsx` | `outline` variant: `bg-background` → `bg-card` (one class) |
| `app/layout/TopBar.tsx` | `bg-background` → `bg-card` |
| `app/layout/Sidebar.tsx` | Group labels use `text-sidebar-muted-foreground` (the old `text-muted-foreground` was designed for light backgrounds); the nav sets `--scrollbar-thumb` / `--scrollbar-thumb-hover` to sidebar tokens |
| `components/common/PlaceholderPage.tsx` | Icon tile: `bg-muted` → `bg-secondary text-primary` |
| `assets/main.css` | Palette, new tokens, shadow tokens; `.scrollbar-subtle` now reads `--scrollbar-thumb` / `--scrollbar-thumb-hover` (fallbacks: `--input` / `--ring`) |

Card, tooltip, separator, and Sonner source files were **not** edited; they restyle through the tokens.

### Accessibility and readability

WCAG 2.x contrast was computed from the actual `:root` values in `main.css` (script in the session scratchpad;
alpha layers composited as the browser does):

| Pair | Ratio | Requirement |
|---|---|---|
| Body text on page / on card | 15.2 / 16.5 | 4.5 ✅ |
| Secondary (muted) text on card / on page | 6.0 / 5.5 | 4.5 ✅ |
| Primary button text on navy | 11.3 | 4.5 ✅ |
| Hover text on accent (outline / ghost) | 11.8 | 4.5 ✅ |
| Tooltip text | 15.2 | 4.5 ✅ |
| Sidebar brand / active text | 13.2 / 10.6 | 4.5 ✅ |
| Sidebar **inactive** item (70%) | 7.2 | 4.5 ✅ |
| Sidebar hovered item | 11.0 | 4.5 ✅ |
| Sidebar group labels | 6.0 | 4.5 ✅ |
| Amber indicator vs sidebar / vs active background (non-text) | 7.2 / 5.3 | 3 ✅ |
| Focus ring: amber on navy / navy-blue on white (non-text) | 7.2 / 4.9 | 3 ✅ |
| Dark text on amber fill (for future `bg-highlight`) | 7.8 | 4.5 ✅ |
| Amber **as text on white** | 2.05 | ❌, so amber is **never used as text on light surfaces**. This is documented in a comment next to the token. |

Other readability points:

- Every state is distinguishable **without relying on colour alone**. The active item has a background, a
  bar, and brighter text, and it also has `aria-current="page"`. Keyboard focus is a 2px ring.
- Inactive icons use the same 70% tone as their labels, so the icons are not overly bright.

### Verification

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run lint` (+ Prettier check of `main.css`) | ✅ 0 problems |
| `npm test` | ✅ 4 files / 19 tests |
| `npm run build` | ✅ (CSS 33.12 kB) |
| Live computed colours (dev, CDP) | Match the tokens. Examples: sidebar `oklch(0.275 0.05 257)`, logo and indicator `oklch(0.78 0.14 70)`, top bar white, page `oklch(0.972 …)`, card shadow navy-tinted, outline button white, keyboard focus = amber 2px ring. |
| Screenshots reviewed | Dashboard, hover, keyboard focus, Settings with dev-only buttons, toast, 404, collapsed rail + tooltip (1024×700), short window scrolling (1280×640) |
| Sidebar layout suite (§11) | ✅ **40 / 40**: widths, 36px rows, no scrolling at 1580×890 / 1366×768 / 1264×712, active + hover, collapsed rail, tooltips, routes unchanged, no console errors |
| Phase 0/1 regression (`verify-phase1`, dev) | ✅ **29 / 29**: sandbox, contextIsolation, nodeIntegration off, webSecurity, `window.api` only, no Node APIs, `window.open` / external navigation blocked, dev-only DevTools and menu, second instance, all routes, 404, toast, error boundary |
| `src/main`, `src/preload`, `index.html` | Unchanged (`git status` shows no changes) |
| Data folders | No `.db`/`.sqlite` files, no `data/` or `backups/` folders |
| Phase 2 | Not started. No features, data, charts, or logic. |

The packaged app was not rebuilt at this point; §13 covers the packaged verification. **Nothing was
committed.**

---

## 13. Final packaged-build verification

Performed after the owner approved the theme/UI, because the renderer theme changed. **No code was changed**:
the verification found no problems.

**Build:**

- `npm run build:unpack`: ✅ Pass.
  - Typecheck + electron-vite build: renderer JS 1,224.34 kB, CSS 33.12 kB.
  - electron-builder 26.15.3 packaged Electron 39.8.10 (win32 x64) to `dist\win-unpacked\StockFlow.exe`.

**How it was verified:**

- `dist\win-unpacked\StockFlow.exe` was launched fresh (no other instance running), with the main-process
  inspector and the renderer DevTools protocol enabled for the automated checks.
- The same three check scripts as in dev were run against the **packaged** app, and the screenshots were
  reviewed.

| # | Requested check | Result | Evidence |
|---|---|---|---|
| 1 | Navy sidebar renders correctly | ✅ | Computed sidebar background `oklch(0.275 0.05 257)`, brand text `oklch(0.96 …)`, amber logo `oklch(0.78 0.14 70)`, group labels `oklch(0.72 0.03 255)`; screenshot reviewed |
| 2 | White top bar and off-white content background | ✅ | Top bar `oklch(1 0 0)`; page `oklch(0.972 0.005 250)`; cards white with soft border and navy-tinted shadow; titles `oklch(0.24 …)`, secondary text `oklch(0.5 …)` |
| 3 | Active sidebar state and amber indicator visible | ✅ | Active background `oklch(0.36 0.06 257)`, white text, `::before` indicator `oklch(0.78 0.14 70)` at opacity 1 (0 on inactive items); hover lighter than active; keyboard focus = 2px amber ring |
| 4 | Collapsed sidebar still works | ✅ | 1024×700: 64px icon rail; labels and group titles hidden; icons, logo, and Settings centred; active item highlighted; tooltips "Stock Adjustments" and "Settings" shown; no horizontal overflow |
| 5 | All routes still work | ✅ | All 11 links: hash, top-bar heading, card title, and single highlighted item all match; reload keeps `#/stock/in`; unknown route → "Page not found" inside the shell; same 11 `href`s in the same order |
| 6 | No console/runtime errors | ✅ | No exceptions, console errors/warnings, or CSP violations in any of the three runs |
| 7 | Dev-only Developer Checks do NOT appear | ✅ | Settings shows only the placeholder card: no "Developer checks" text and **0** buttons in the content area |
| 8 | `window.electron` undefined | ✅ | `typeof window.electron === 'undefined'`; `window.api` is the only exposed object (empty) |
| 9 | No Node APIs exposed | ✅ | `require`, `process`, `Buffer`, `ipcRenderer` all `undefined` in the renderer |
| 10 | No database / data / backups folder | ✅ | See the data folders below |

**Check suites run against the packaged app:**

| Suite | Result |
|---|---|
| Theme colours + screenshots (dashboard, hover, keyboard focus, Settings, 404, collapsed rail + tooltip, short-window scrolling) | ✅ values as above; no console problems |
| Sidebar layout suite (§11) | ✅ **40 / 40** (widths, 36px rows, no scrolling at 1580×890 / 1366×768 / 1264×712, hover/active, thin scrollbar on short windows, collapsed rail, tooltips, routes, no console errors) |
| Phase 0/1 regression, production mode | ✅ **26 / 26** (see below) |

**Phase 0/1 regression in detail:**

- title `StockFlow`
- `sandbox`, `contextIsolation`, `webSecurity` on; `nodeIntegration` off
- `userData` = `%APPDATA%\StockFlow`
- **DevTools blocked** and **no application menu** in production
- `window.open` and external navigation blocked
- a second instance exits and restores the first window

**Data folders:**

- **`%APPDATA%\StockFlow`** contains only Chromium profile files (`Cache`, `GPUCache`, `Local Storage`,
  `Preferences`, …), identical to its contents before launch.
- **`%APPDATA%\StockFlow-dev`** is the same.
- In both, there are **no `.db`/`.sqlite` files and no `data/` or `backups/` folders**.

The packaged instance was closed after the checks; no StockFlow processes remain.

---

## 14. Confirmation

- **Phase 2 was NOT started.**
  - No `src/shared` code: no money/quantity/invoice maths, schemas, or IPC contract.
  - No SQLite, `better-sqlite3`, `node:sqlite`, migrations, or database files/folders.
  - No products, stock, invoices, customers, payments, expenses, reports, or settings logic.
  - No sample data.
- No IPC channels were added, and Phase 0 security is intact.
- The approved implementation plan was **not** modified.
- Claude made **no commits**. The owner committed Phase 1 (`5bdc0c6`, `46ec900`). The only uncommitted change
  afterwards is this report's §13 packaged-verification update.
