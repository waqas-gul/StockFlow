# StockFlow — Phase 0 Implementation Report

> Phase: **0 — Repository baseline & project hygiene**. Date: 2026-09-10.
> Status: **Implemented and verified. Awaiting approval.** Phase 1 has **not** been started.

---

## 1. Summary

Phase 0 turned the unmodified electron-vite template into a clean, secure, Windows-only StockFlow foundation:

- **Permanent identity applied:** `StockFlow` / `com.waqas.stockflow` / data folder `StockFlow`.
- **Electron hardened:**
  - sandbox, context isolation, and web security on; Node integration off
  - no `window.electron`
  - new windows denied, external navigation blocked, permissions denied
  - DevTools and the menu only in development
- **Single-instance lock:** a second launch restores and focuses the existing window.
- **Template UI removed:** a minimal "StockFlow / Desktop application foundation ready." placeholder remains.
- **Placeholder auto-update `publish` configuration removed;** mac/linux targets removed.
- **No database, no SQLite package, and no business functionality** were added.

---

## 2. Git

| Item | Result |
|---|---|
| Repository before Phase 0 | **Already existed.** It was initialised by the project owner at 14:23:22. No remotes. Branch `main`. |
| Baseline commit | `511deecaf23631a5491b34f216185ddff9d38afa` (**Waqas Gul**, 2026-09-10 14:23:34 +0500): *"feat: initialize Electron app with React and TypeScript"*. It contains the unmodified template (34 files) plus the implementation plan. |
| Actions taken by Claude | `git init` ran on the existing repository ("Reinitialized existing Git repository"), which is harmless and changed no history. Both baseline commit attempts found **nothing to commit**, because commit `511deec` already *is* the requested baseline. **No duplicate commit was created.** |
| Phase 0 changes | **Left uncommitted** in the working tree for review. They can be committed after approval. |
| `.gitignore` | Reviewed; unchanged. It already ignores `node_modules`, `dist`, `out`, `.eslintcache`, and logs, so the build outputs `out/` and `dist/` are not tracked. |

`git status --short` after Phase 0 (plus this report, untracked):

```
 M README.md
 M electron-builder.yml
 M package.json
 M src/main/index.ts
 M src/preload/index.d.ts
 M src/preload/index.ts
 M src/renderer/index.html
 M src/renderer/src/App.tsx
 D src/renderer/src/assets/base.css
 D src/renderer/src/assets/electron.svg
 M src/renderer/src/assets/main.css
 D src/renderer/src/assets/wavy-lines.svg
 D src/renderer/src/components/Versions.tsx
?? src/main/app-identity.ts
?? src/main/paths.ts
?? src/main/security.ts
?? src/main/window.ts
?? development-docs-workthorgh/shop-management-v1-plan/phase-0-implementation-report.md
```

Diff stat (tracked files): 13 files changed, 107 insertions, 432 deletions.

---

## 3. Files

### Added

| File | Purpose |
|---|---|
| `src/main/app-identity.ts` | Permanent constants: `APP_NAME = 'StockFlow'`, `APP_ID = 'com.waqas.stockflow'`, `APP_DATA_FOLDER = 'StockFlow'` |
| `src/main/paths.ts` | `configureUserDataPath()`: pins `userData` to `%APPDATA%\StockFlow` (production) or `%APPDATA%\StockFlow-dev` (development). It creates no files itself. |
| `src/main/security.ts` | `enforceSecurityDefaults()` (global sandbox + per-webContents guards) and `denyAllPermissions()` |
| `src/main/window.ts` | `createMainWindow()` with explicit secure `webPreferences` |
| `development-docs-workthorgh/shop-management-v1-plan/phase-0-implementation-report.md` | This report |

### Changed

| File | Change |
|---|---|
| `src/main/index.ts` | Rewritten: path pinning → security defaults → single-instance lock → AUMID → permissions → production menu removal → window. The `ping` IPC and `shell.openExternal` were removed, along with the macOS `activate` handler (Windows-only). |
| `src/preload/index.ts` | Exposes **only** `window.api` (an empty frozen object). Removed `@electron-toolkit/preload` `electronAPI` and the non-isolated fallback. It throws if context isolation is off. |
| `src/preload/index.d.ts` | `window.api: StockFlowApi` (`Readonly<Record<string, never>>`); `window.electron` removed |
| `src/renderer/index.html` | Title `StockFlow`, `lang="en"`, hardened CSP |
| `src/renderer/src/App.tsx` | Minimal placeholder |
| `src/renderer/src/assets/main.css` | Minimal placeholder styles (to be replaced by Tailwind in Phase 1) |
| `electron-builder.yml` | Identity, Windows-only NSIS, publish removed, app data kept on uninstall, docs excluded from package |
| `package.json` | `productName`, `description`, `author`; `homepage` removed; `build:mac` / `build:linux` scripts removed |
| `README.md` | StockFlow title; Windows-only build instructions; data folder note |

### Deleted (template-only)

- `src/renderer/src/components/Versions.tsx` (and the now-empty `components/` folder)
- `src/renderer/src/assets/electron.svg`
- `src/renderer/src/assets/wavy-lines.svg`
- `src/renderer/src/assets/base.css`

**Not deleted:** `build/entitlements.mac.plist` and `build/icon.icns`. They are unused macOS files that are harmless to keep. `resources/icon.png` and `build/icon.*` are still the default Electron icon; a real icon is planned for Phase 12.

---

## 4. Exact configuration changes

### `package.json`

```diff
   "name": "shop-management",
+  "productName": "StockFlow",
   "version": "1.0.0",
-  "description": "An Electron application with React and TypeScript",
+  "description": "StockFlow - offline shop and stock management for Windows",
   "main": "./out/main/index.js",
-  "author": "example.com",
-  "homepage": "https://electron-vite.org",
+  "author": "StockFlow",
 ...
-    "build:win": "npm run build && electron-builder --win",
-    "build:mac": "electron-vite build && electron-builder --mac",
-    "build:linux": "electron-vite build && electron-builder --linux"
+    "build:win": "npm run build && electron-builder --win"
```

Dependencies are **unchanged**. Nothing was installed or removed.

### `electron-builder.yml`

| Key | Before | After |
|---|---|---|
| `appId` | `com.electron.app` | `com.waqas.stockflow` |
| `productName` | `shop-management` | `StockFlow` |
| `files` | template list | template list + `'!development-docs-workthorgh/**'` |
| `win.target` | (default) | `nsis` |
| `win.executableName` | `shop-management` | `StockFlow` |
| `nsis.artifactName` | `${name}-${version}-setup.${ext}` | `${productName}-${version}-setup.${ext}`, which gives `StockFlow-1.0.0-setup.exe` |
| `nsis.deleteAppDataOnUninstall` | (default false, implicit) | `false` (explicit) |
| `mac`, `dmg`, `linux`, `appImage` blocks | present | **removed** |
| `publish` (generic `https://example.com/auto-updates`) | present | **removed** |
| `npmRebuild: false`, `asarUnpack: resources/**` | present | kept. Native modules will be rebuilt by the existing `postinstall` (`electron-builder install-app-deps`). |

### CSP (`src/renderer/index.html`)

```
Before: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:
After:  default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
        object-src 'none'; base-uri 'none'; form-action 'none'
```

The development server (Vite HMR) works with this policy. No CSP violations were logged apart from the deliberate test requests described in §7.

---

## 5. Security changes

| Area | Implementation |
|---|---|
| `webPreferences` | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, `devTools: is.dev` (explicit) |
| Global sandbox | `app.enableSandbox()` before ready, so every renderer is sandboxed |
| Renderer globals | Only `window.api` (empty, frozen). **Not exposed:** `window.electron`, `ipcRenderer`, `process`, `require`, `Buffer`, fs, or any IPC channel |
| New windows | `setWindowOpenHandler(() => ({ action: 'deny' }))` on **every** webContents (via `web-contents-created`) |
| Navigation | `will-navigate` / `will-redirect` are allowed only to the app's own document: the dev-server origin in development, the bundled `index.html` in production |
| `<webview>` | `will-attach-webview` → prevented |
| `shell.openExternal` | Removed. It is not used anywhere. |
| Permissions | `setPermissionRequestHandler` → deny all; `setPermissionCheckHandler` → false |
| DevTools | Only in development (`devTools: is.dev`; F12 toggles in dev via `@electron-toolkit/utils` optimizer) |
| Menu | Removed in production (`Menu.setApplicationMenu(null)`), so there are no reload/DevTools accelerators |
| Single instance | `app.requestSingleInstanceLock()`. A second process quits; the first restores, shows, and focuses its window. The lock is keyed on the pinned `userData` path, so dev and prod have separate locks. |
| AUMID | `app.setAppUserModelId('com.waqas.stockflow')` (called directly rather than via the toolkit helper, which substitutes `electron.exe`'s path in dev) |

---

## 6. Commands executed

```
git --version / git rev-parse / git config (inspection)
git init                                  # re-initialised existing repo; no history change
git add ... && git commit ...             # nothing to commit (baseline 511deec already present)
npm run typecheck
npm run lint
npm run build
electron-vite dev --inspect 9229 --remoteDebuggingPort 9222      # dev runtime checks (3 runs, see §8)
npm run build:unpack                      # packaged production build → dist/win-unpacked/StockFlow.exe
dist\win-unpacked\StockFlow.exe --inspect=9230 --remote-debugging-port=9223   # packaged runtime checks
node <scratchpad>/verify-phase0.mjs ...   # CDP/inspector verification script (kept outside the project)
node -e "@electron/asar listPackage"      # packaged file list
Get-AuthenticodeSignature                 # signature status
```

The verification script lives only in the session scratchpad. It is not part of the project.

---

## 7. Results

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ Pass (node + web, exit 0) |
| `npm run lint` | ✅ Pass (exit 0, no warnings) |
| `npm run build` | ✅ Pass: `out/main/index.js` 3.45 kB, `out/preload/index.js` 0.24 kB, renderer JS 641.7 kB, CSS 0.58 kB |
| `npm run build:unpack` | ✅ Pass: `dist/win-unpacked/StockFlow.exe` (Electron 39.8.10, x64) |
| Packaged `app.asar` contents | `out/**`, `package.json`, `resources/icon.png`, `node_modules/**`. **No `src/`, no `development-docs-workthorgh/`.** |

### Runtime verification (automated via Chrome DevTools Protocol + main-process inspector)

| # | Check | Dev (`electron-vite dev`) | Packaged (`StockFlow.exe`) |
|---|---|---|---|
| 1 | Launches | ✅ | ✅ |
| 2 | Window title | `StockFlow` ✅ | `StockFlow` ✅ |
| 3 | Starter content gone | Body = "StockFlow / Desktop application foundation ready.", 0 images ✅ | same ✅ |
| 4 | `window.electron` | `undefined` ✅ | `undefined` ✅ |
| 5 | `window.api` | `object`, keys `[]` ✅ | same ✅ |
| 6 | Node/Electron in renderer (`require`, `process`, `module`, `Buffer`, `global`, `ipcRenderer`) | all `undefined` ✅ | all `undefined` ✅ |
| 7 | `sandbox` | `true` ✅ | `true` ✅ |
| 8 | `contextIsolation` | `true` ✅ | `true` ✅ |
| 9 | `nodeIntegration` | `false` ✅ | `false` ✅ |
| 9b | `webSecurity` | `true` ✅ | `true` ✅ |
| 10a | `window.open('https://example.com/')` | returns `null`, no new window ✅ | same ✅ |
| 10b | `location.href = 'https://example.com/'` | URL unchanged (blocked) ✅ | URL unchanged (blocked) ✅ |
| 10c | `fetch('https://example.com/')` | blocked by CSP ✅ | blocked by CSP ✅ |
| 11 | Second instance (first window minimised, then a second process launched) | second process exited (code 0, ~1.7 s); window count 1; first window restored and visible ✅ | same ✅ |
| — | DevTools on request (`openDevTools()` + 2 s) | opens (positive control) | **does not open** ✅ |
| — | Application menu | present (dev) | **none** ✅ |
| — | `userData` | `%APPDATA%\StockFlow-dev` ✅ | `%APPDATA%\StockFlow` ✅ |
| — | Console problems | only the two CSP messages caused by the deliberate `fetch` test | same |
| 12 | electron-builder Windows-only | ✅ (no mac/linux blocks; NSIS target) | — |
| 13 | Placeholder `publish` removed | ✅ | — |
| 14 | No database created | ✅ See §8 | ✅ See §8 |
| 15 | No Phase 1 functionality | ✅ No Tailwind wiring, shadcn, router, Query/Zustand setup, forms, SQLite, schemas, or pages | — |

Packaged executable: Authenticode status **NotSigned** (no certificate configured, as intended). Version resource: ProductName `StockFlow`, FileDescription `StockFlow`, CompanyName `StockFlow` (from
`author`), ProductVersion `1.0.0.0`.

---

## 8. Data folders and "no database" confirmation

- `%APPDATA%\StockFlow-dev` (created by dev runs) and `%APPDATA%\StockFlow` (created by the packaged test run) contain **only Chromium's standard profile files**: `Cache`, `Code Cache`, `GPUCache`, `Local Storage`, `Session Storage`, `Network`, `Preferences`, `Local State`, `DIPS`, and so on.
- There are **no `data/` or `backups/` folders** and **no `.db`/`.sqlite` files.** No application database exists.
- `DIPS` / `DIPS-wal` are Chromium's own internal bookkeeping files, created automatically by every Electron app. They are not StockFlow data.
- `%APPDATA%\shop-management` (created by earlier runs of the original template) still exists. It was **not** touched or deleted.

---

## 9. Differences from the plan / decisions made during implementation

1. **The baseline commit was already present** (created by the owner). No duplicate was made (§2).
2. **Phase 0 changes are uncommitted.** They are left for your review rather than committed automatically.
3. **`userData` pinning (`paths.ts`) implemented now** rather than in Phase 3. Two reasons:
   - The single-instance lock is keyed on `userData`, so the path must be final before the lock is taken.
   - Chromium already writes its profile there.

   Only the path is set. No data or backup folders and no database are created.
4. **`src/main/app-identity.ts` added.** It is a small constants module that is not in the plan's folder list. It keeps the permanent identity values in one place.
5. **`app.enableSandbox()`, `will-redirect` / `will-attach-webview` guards, and production menu removal** were added as small hardening beyond the plan's list.
6. **npm package `name` kept as `shop-management`.** It is internal only. The user-visible identity comes from `productName` (`StockFlow`), and the installer name uses `${productName}`. Renaming it would require regenerating `package-lock.json`, which was out of scope.
7. **`author` set to `"StockFlow"`** as a neutral value, since no publisher identity was provided. Windows installers show this as the **Publisher**. Replace it if you have a real publisher name.
8. **Dependencies not reorganised.** The plan's optional step "move renderer-only deps to devDependencies" was **not** done, because no package changes were allowed in Phase 0 (see risk 1).

---

## 10. Risks / issues discovered

1. **Package size / unused dependencies.**
   - Because `tailwindcss`, `@tailwindcss/vite`, `@tanstack/react-query`, `zustand`, `react-hook-form`, and `@hookform/resolvers` are in `dependencies`, electron-builder copies them into `app.asar`. That includes native Tailwind/lightningcss binaries (`@tailwindcss/oxide-win32-x64-msvc`, `lightningcss-win32-x64-msvc`). The renderer never needs them at runtime, because Vite bundles it.
   - `@electron-toolkit/preload` is **no longer used** but is still a dependency, so it is also packaged.
   - Recommendation for Phase 1 (needs your approval to change packages): move the renderer-only packages to `devDependencies` and uninstall `@electron-toolkit/preload`. **Keep `zod` in `dependencies`,** because the main process will need it.
2. **The first dev launch attempt exited immediately** (exit code 0, Vite reported port 5173 busy). Nothing was running when checked afterwards. The behaviour matches the new single-instance lock: another StockFlow dev instance was most likely open at that moment. Every later launch worked normally.
3. **`%APPDATA%\StockFlow` now exists on this development PC** (Chromium profile only) because of the packaged test. It is the permanent production folder. It is harmless and can be deleted before a real install on this machine.
4. **Permission check handler denies everything.** If a later phase needs a specific permission (e.g. clipboard write for "copy invoice number"), that one permission must be allowed explicitly. Printing is not a permission and is unaffected.
5. **Unsigned executable.** Windows SmartScreen will warn on install. This is expected for V1 (plan §22).
6. **Line endings.** Git (`core.autocrlf`) warns that LF files will be converted to CRLF on checkout. The files follow `.editorconfig` (LF). This is cosmetic.
7. **Version is `1.0.0`.** Consider using `0.x` until the first real release, so that the first production install is unambiguous. This is your decision; it was not changed.
8. **Default Electron icon** is still used (planned for Phase 12).

---

## 11. Confirmation

- **Phase 1 was NOT started.**
  - No Tailwind wiring, shadcn/ui, React Router, sidebar/dashboard/pages, TanStack Query or Zustand setup, or forms.
  - No SQLite, `better-sqlite3`, `node:sqlite`, migrations, database files/folders, backup system, reports, printing, or business schemas.
- **No packages were installed or removed.**
- The approved implementation plan (`implementation-plan.md`) was **not modified**.
