# StockFlow — Phase 3A Implementation Report

> **Phase:** 3A — SQLite / IPC foundation spike (the technical part of Phase 3 only).
> **Date:** 2026-09-11.
> **Status:** Implemented and verified. **Awaiting approval.**
> - The production business schema (`0001_initial`) was **not** created. No business tables exist anywhere.
> - Products, stock, customers, invoices, payments, expenses, reports, backups and printing were not started.
> - Nothing was committed.

---

## 1. Summary

| Area | Result |
|---|---|
| SQLite driver | **better-sqlite3 12.11.1** (exact pin). GO: installs, builds and packages with **no native compilation**. |
| Newest release (13.0.3) | **NO-GO on this machine.** A fresh `npm install`/`npm ci` runs `node-gyp`, which needs Visual Studio Build Tools (§2). |
| node:sqlite fallback | Not needed. better-sqlite3 has compatible prebuilt binaries for both Node 22 and Electron 39. |
| Db adapter | `src/main/db/adapter.ts`: `run`, `get`, `all`, `exec`, `transaction`, `backup`, `close` (+ `isOpen`, `inTransaction`, `driver`) |
| Connection | `foreign_keys = 1`, `journal_mode = wal`, `synchronous = 2` (FULL), `busy_timeout = 5000`, **read back and verified** on every open |
| application_id | **`0x5354464C`** (1,398,031,948 = ASCII "STFL"), permanent constant |
| Migrations | Generic runner with newer-schema refusal, per-migration transactions, recorder hook and a pre-migration backup boundary. **The production list is empty.** |
| IPC | Shared contract → typed preload bridge → main handlers with sender check, Zod validation and a safe `Result` envelope |
| Exposed API | **`window.api.app.info()` only** |
| Tests | **403 tests / 24 files** pass (123 new). Coverage of every measured file: **100%** statements, branches, functions and lines. |
| Builds | typecheck, lint (0 problems), test, coverage, build and build:unpack all pass |
| Runtime | Dev **31/31** and packaged **32/32** checks pass, including the Phase 0/1 security, route and theme regression checks |

---

## 2. SQLite driver spike (go/no-go)

### 2.1 Environment

| Item | Value |
|---|---|
| Node.js (tooling) | 22.22.2, `NODE_MODULE_VERSION` 127, N-API 10 |
| Electron | 39.8.10 (Node 22.22.1, `NODE_MODULE_VERSION` **140**, N-API 10) |
| electron-builder / @electron/rebuild | 26.15.3 / 4.2.0 |
| C++ toolchain | **None** (`vswhere.exe` absent). Python 3.14 is present but irrelevant without a compiler. |

### 2.2 Attempt 1: better-sqlite3 13.0.3 (newest, published 2026-08-05) — NO-GO

13.x is the first Node-API release. Its npm tarball bundles prebuilt binaries for 8 platforms
(`prebuilds/win32-x64.node`), and it declares `gypfile: false` with no install script.

| Step | Result |
|---|---|
| `npm install better-sqlite3@13.0.3 --save-exact` | ✅ exit 0, 3 s, 2 packages (with `node-addon-api` 8.9.2). Nothing ran or compiled. |
| Same binary in plain Node 22.22.2, Electron-as-Node 39.8.10 and a real Electron 39.8.10 main process | ✅ all three loaded `prebuilds\win32-x64.node` (SQLite 3.53.4, WAL, clean close) |
| Our `postinstall` (`electron-builder install-app-deps`) | ❌ **exit 1** |
| Clean-room `npm ci` of that lockfile (fresh-clone simulation) | ❌ **exit 1** |

**Why the postinstall failed.** `@electron/rebuild` treats every dependency with a `binding.gyp` as native
(`rebuild.js:98`). It recognises prebuilt Node-API binaries only at `prebuilds/<platform>-<arch>/node.napi.node`
(`prebuildify.js:41-44`), but 13.x ships `prebuilds/win32-x64.node`. So it fell through to
`node-gyp rebuild`, which stopped with **"Could not find any Visual Studio installation to use"**. That is
before any compiler runs.

**Why a fresh clone fails too.** The lockfile entry for 13.0.3 carries no `gypfile` information. A
lockfile-driven `npm ci` therefore ran npm's implicit install script `node-gyp rebuild` for it, and failed
with the same Visual Studio error. The first `npm install` had worked only because npm read the registry
manifest, which says `gypfile: false`.

The rule for this spike was not to force native compilation, so I stopped there.

### 2.3 Attempt 2: better-sqlite3 12.11.1 (latest 12.x, 2026-06-15) — **GO**

12.x uses `prebuild-install`: a separate prebuilt binary per ABI, downloaded from GitHub. The Electron-39
Windows asset `better-sqlite3-v12.11.1-electron-v140-win32-x64.tar.gz` was confirmed first (HTTP 200,
1,039,779 bytes). It was then tested in an isolated scratch project before it touched the project.

| Step | Result |
|---|---|
| Install script `prebuild-install \|\| node-gyp rebuild --release` | ✅ `prebuild-install` downloaded the Node-ABI binary (1,918,976 bytes); `node-gyp` was never reached |
| `@electron/rebuild` with **exactly** the options `install-app-deps` passes (`app-builder-lib/out/util/yarn.js:148-157`) | ✅ "assuming is prebuild-install powered" → "installed prebuilt module". The Electron-ABI binary is 1,920,512 bytes, SHA-256 `C9C931F06EAAEF78…`. |
| Electron-as-Node / Electron main process | ✅ loads (ABI 140, WAL, clean close) |
| Plain Node 22 | ❌ `NODE_MODULE_VERSION 140 … requires 127`. This is expected: the installed binary is now the Electron build (§2.5). |
| Project: `npm install better-sqlite3@12.11.1 --save-exact` | ✅ exit 0 (+25 / −1 / ~1 packages) |
| Project: `npm run postinstall` | ✅ exit 0, prebuilt download in about 2 s. The binary is byte-identical (`C9C931F0…`). |
| **Clean-room `npm ci` of the final `package.json` + lockfile** | ✅ exit 0, 740 packages in 56 s. Both prebuilt binaries were downloaded, nothing was compiled, and the resulting binary is identical and loads in Electron. |
| Plain `npm install` in the project (root lifecycle) | ✅ exit 0 |

### 2.4 Native compilation

**None occurred at any point.** The only `node-gyp` runs were the two failed 13.0.3 attempts. Both stopped at
the Visual Studio lookup in `node-gyp configure`, before any compiler was invoked. No build tools were
installed.

### 2.5 Installed versions

| Package | Version | In | Notes |
|---|---|---|---|
| `better-sqlite3` | **12.11.1** (exact) | `dependencies` | Bundles **SQLite 3.53.2**. Pinned exactly because the driver decides the SQLite engine used on the owner's data. |
| `@types/better-sqlite3` | 9.6.0 (`^9.6.0`) | `devDependencies` | Newest available. Covers every API the adapter uses. |
| Transitive runtime | `bindings` 1.5.0, `file-uri-to-path` 1.0.0, `prebuild-install` 7.1.3 and 22 of its dependencies (e.g. `tar-fs` 2.1.5, `simple-get` 4.0.1, `node-abi` 3.96.0) | — | 27 lockfile entries added in total; 0 removed or changed |

Consequences of choosing 12.x:

- **`postinstall` stays exactly as approved in Phase 0** (`electron-builder install-app-deps`). It replaces the
  Node-ABI binary with the Electron-ABI binary.
- **Tests run inside Electron's Node.js**, as plan §24 anticipated. The new launcher `scripts/vitest-electron.mjs`
  starts Vitest with `ELECTRON_RUN_AS_NODE=1` and Electron's executable. `npm test`, `test:watch` and
  `test:coverage` use it. Tests therefore run on exactly the runtime and native binary of the main process.

---

## 3. Files

### Created (34)

| File | Purpose |
|---|---|
| `scripts/vitest-electron.mjs` | Runs Vitest in Electron-as-Node (excluded from the package) |
| `src/main/db/adapter.ts` | `Db` interface + the better-sqlite3 implementation; `openSqlite`, `sqliteErrorCode` |
| `src/main/db/connection.ts` | `openDatabase` (pragmas, read-back verification, application_id), `readUserVersion`, … |
| `src/main/db/migrate.ts` | Generic migration runner, backup-hook and recorder types, `MigrationError` |
| `src/main/db/migrations/index.ts` | Production migration list: **empty** |
| `src/main/db/index.ts` | `initializeDatabase` (startup) and the honest backup placeholder |
| `src/main/db/test-utils.ts` | Test-only temp folders under `%TEMP%` (excluded from coverage) |
| `src/main/data-paths.ts` | Pure `resolveDataPaths` / `toDisplayPath` |
| `src/main/app-info.ts` | `readAppInfo` (the `app.info` answer) |
| `src/main/errors.ts` | `AppFailure`: expected, user-safe failures thrown by future services |
| `src/main/ipc/handle.ts` | Handler wrapper: sender check → Zod → service → Result; error mapping |
| `src/main/ipc/index.ts` | The handler map for the contract + registration |
| `src/shared/ipc-contract.ts` | The single IPC contract (no runtime imports) |
| `src/shared/types/result.ts` | `Result<T>`, `AppError`, `AppErrorCode`, `ok`, `fail` |
| `src/shared/types/app-info.ts` | `AppInfo`, `DatabaseDriver` |
| `src/preload/api.ts` | Builds `window.api` from the contract |
| `src/renderer/src/lib/api.ts` | `ApiError`, `unwrap` |
| `src/renderer/src/lib/query-keys.ts` | Query-key factory (`app.info` only) |
| `src/renderer/src/lib/app-queries.ts` | `appInfoQuery` |
| `src/renderer/src/components/common/AboutCard.tsx` | Small technical About card on Settings |
| 14 test files | `result`, `ipc-contract`, `adapter`, `connection`, `migrate`, `db/index`, `data-paths`, `app-info`, `ipc/handle`, `ipc/index`, `preload/api`, `lib/api`, `app-queries`, `AboutCard` |
| `development-docs-workthorgh/shop-management-v1-plan/phase-3a-implementation-report.md` | This report |

### Changed (13 tracked files; 509 insertions, 31 deletions)

| File | Change |
|---|---|
| `package.json` / `package-lock.json` | `better-sqlite3` 12.11.1, `@types/better-sqlite3`; `test*` scripts use the Electron launcher. **`postinstall` is unchanged.** |
| `src/main/index.ts` | Opens and migrates the DB before any window, registers IPC, shows a native error dialog and exits if the DB cannot open, closes the DB on `will-quit` |
| `src/main/paths.ts` | `getDataPaths()` (`configureUserDataPath` unchanged) |
| `src/main/security.ts` | `isTrustedIpcSender`, reusing the Phase 0 `isAppUrl`. Existing guards unchanged. |
| `src/preload/index.ts`, `index.d.ts` | `window.api` from `createApi` over `ipcRenderer.invoke`, typed as `StockFlowApi` |
| `src/renderer/src/components/common/PlaceholderPage.tsx` | +2 lines: `<AboutCard />` on Settings |
| `electron-builder.yml` | Exclude `scripts/**` and better-sqlite3's C sources (`deps/`, `src/`); comment updated |
| `eslint.config.mjs` | Only `db/adapter.ts` may import `better-sqlite3` in `src/main`. The renderer may not import `electron`, `@electron-toolkit/*`, `node:*`, `fs`, `path`, `os`, `child_process` or `better-sqlite3`. |
| `vitest.config.ts` | Coverage now also measures the new foundation; the domain ≥ 95% threshold is still enforced on its own |
| `README.md`, `src/shared/README.md` | Install notes (no C++ tools), how tests run, DB location, contract and types |

**Not touched:** the domain library, the shell, sidebar, theme, routes, `window.ts`, `index.html`/CSP, the
Phase 0 security guards, and the implementation plan.

---

## 4. Db adapter

Services will depend on this interface and never on the driver. An ESLint rule enforces it; §10.3 shows the
rule firing.

```ts
type SqlValue = number | bigint | string | null            // booleans are not SQLite values (store 0/1)
type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>   // ? or @name
interface RunResult { readonly changes: number; readonly lastInsertRowid: number | bigint }

interface Db {
  readonly driver: 'better-sqlite3' | 'node:sqlite'
  readonly isOpen: boolean
  readonly inTransaction: boolean
  run(sql: string, params?: SqlParams): RunResult            // one statement, no rows
  get<Row = unknown>(sql: string, params?: SqlParams): Row | undefined
  all<Row = unknown>(sql: string, params?: SqlParams): Row[]
  exec(sql: string): void                                    // multi-statement scripts (migrations, pragmas)
  transaction<T>(fn: () => T): T                             // BEGIN IMMEDIATE … COMMIT / ROLLBACK
  backup(destinationFile: string): Promise<void>            // SQLite online backup (includes WAL content)
  close(): void                                              // checkpoints the WAL; idempotent
}

openSqlite(file, { readonly? }): Db        // raw open, no StockFlow configuration
sqliteErrorCode(error): string | undefined // e.g. 'SQLITE_CONSTRAINT_UNIQUE', driver-neutral
```

Design notes:

- The adapter is small on purpose: no ORM or repository layer, and no statement cache. A cache can be added
  inside the adapter later without changing the API.
- `run` refuses multi-statement SQL; only `exec` runs scripts.
- Swapping to `node:sqlite` means reimplementing this one file. `sqliteErrorCode` is the single place that
  reads driver-specific error objects.
- `backup` is the raw SQLite online-backup primitive only. Verification, naming, rotation and restore are
  Phase 4.

---

## 5. Connection: paths, pragmas, application_id

### 5.1 Paths

| Mode | Data root (pinned in Phase 0) | Database |
|---|---|---|
| Development (`electron-vite dev`) | `%APPDATA%\StockFlow-dev` | `%APPDATA%\StockFlow-dev\data\shop.db` |
| Production (packaged) | `%APPDATA%\StockFlow` | `%APPDATA%\StockFlow\data\shop.db` |
| Tests | `%TEMP%\stockflow-test-*` (one per test, deleted afterwards) | — |

`resolveDataPaths(root)` is pure and uses Windows path rules on every platform. Its tests check that the dev
and prod paths differ.

### 5.2 Pragmas: set, then read back

`openDatabase(file)` creates the folder and opens the file, then does the following:

1. It sets the pragmas in this order: `foreign_keys = ON`, `busy_timeout = 5000`, `journal_mode = WAL`,
   `synchronous = FULL`.
2. It **reads every value back**. Any mismatch closes the connection and throws
   `DatabaseOpenError('CONFIGURATION_FAILED')`.

| Pragma | Required / verified value | Evidence |
|---|---|---|
| `foreign_keys` | `1` | Read back; a real FK violation fails with `SQLITE_CONSTRAINT_FOREIGNKEY` |
| `journal_mode` | `wal` | Read back; a `-wal` file appears on write; the header of both technical DBs says `wal`; an in-memory DB (which cannot use WAL) is **refused** |
| `synchronous` | `2` (FULL) | Read back |
| `busy_timeout` | `5000` | Read back |

Because `openDatabase` throws on any mismatch, the dev and packaged apps could only start after all four
values verified.

### 5.3 application_id

- **Value:** `STOCKFLOW_APPLICATION_ID = 0x5354464C` = **1,398,031,948**, the ASCII bytes **"STFL"**.
- **Why this value:**
  - It is a positive signed 32-bit integer, so there is no sign ambiguity.
  - It is a fixed constant, never derived from runtime values.
  - It is not in SQLite's registry of assigned application IDs (`magic.txt`, 10 entries), checked on
    2026-09-11.
- **On open:**
  - The StockFlow ID → the file is accepted.
  - `0` on an empty file (no schema objects, `user_version` 0) → the file is stamped with the ID.
  - Anything else → `NOT_STOCKFLOW_DATABASE`: another application's SQLite file, an unmarked file with
    tables, or a non-SQLite file (`SQLITE_NOTADB`). **Refused files are never modified.**
- **`user_version`:** read by `readUserVersion`; written only by the migration runner.

---

## 6. Transactions

`db.transaction(fn)` runs `BEGIN IMMEDIATE`, then `fn`, then `COMMIT`. Any throw, including a failing
`COMMIT`, triggers `ROLLBACK` and rethrows the original error. `ROLLBACK` is skipped if SQLite already ended the
transaction.

Tests use technical tables in temp files only:

| Test | Result |
|---|---|
| Commit: the value is returned, `inTransaction` is true inside and false after, and **a second connection sees the rows** | ✅ |
| **BEGIN IMMEDIATE:** before any write, a second connection's `BEGIN IMMEDIATE` fails at once with `SQLITE_BUSY` | ✅ |
| Rollback on throw after three writes (two inserts + an update): the original error is rethrown and **no partial writes remain**, confirmed from a second connection | ✅ |
| Rollback when a statement inside fails (`SQLITE_CONSTRAINT_UNIQUE`) | ✅ |
| A nested `transaction` is refused and the outer one rolled back | ✅ |
| An async callback is refused and its synchronous writes rolled back; its later rejection causes no unhandled rejection | ✅ |
| The transaction already ended inside `fn`: the original error is rethrown, not a ROLLBACK error | ✅ |
| Works again after a rollback | ✅ |

---

## 7. Migration framework and backup boundary

```ts
interface Migration { version: number; name: string; up(db: Db): void }   // forward-only, synchronous
type PreMigrationBackup = (db: Db, plan: MigrationPlan) => Promise<void>  // Phase 4 plugs in here
type MigrationRecorder = (db: Db, migration: Migration) => void           // schema_migrations, later

validateMigrations(list)          // versions 1, 2, 3… in order; names present and unique
planMigrations(db, list)          // reads user_version → { currentVersion, latestVersion, pending }
migrate(db, list, { backupBeforeMigrating, recordMigration? }) → { fromVersion, toVersion, applied }
```

`migrate` works in this order:

1. It validates the list (`INVALID_MIGRATIONS`) and reads `user_version`.
   - A negative version gives `UNKNOWN_SCHEMA_VERSION`.
   - A version **newer than the app understands** is refused with `DATABASE_TOO_NEW`, before any backup is
     requested. The message tells the user to install the newer version or restore a compatible backup.
2. If nothing is pending, it does nothing: no backup request and no write.
3. It calls the **pre-migration backup hook once**, before the first migration. A rejection gives
   `BACKUP_FAILED`, and nothing is applied.
4. Each pending migration runs in **its own `BEGIN IMMEDIATE` transaction**: `PRAGMA user_version = N`, then
   `up(db)`, then `recordMigration`, then `COMMIT`.
   - Any failure rolls that migration back completely, **including `user_version`**, and gives
     `MIGRATION_FAILED` with the version.
   - Earlier migrations stay applied.

**Backup boundary (no fake backup).**

- In production, `initializeDatabase` passes `preMigrationBackupNotAvailable`.
- It lets migrations run only on an **empty** database (no schema objects, schema 0), which has nothing to
  lose.
- For any other database it throws "A verified pre-migration backup is required … not available yet (Phase 4)".
- It never writes a file; a test checks the folder afterwards.
- Phase 4 replaces it with the verified backup.

**Metadata recording.** `schema_migrations` belongs to the business schema (plan §7.3), so it does not exist
yet. The runner's `recordMigration` hook already runs inside each migration's transaction. Tests prove it: a
failing recorder rolls the migration back.

**Production state.** `src/main/db/migrations/index.ts` exports an **empty, frozen list**, so the latest
schema version is 0. The technical test migrations (`fixture_items`, `fixture_note`, …) exist **only inside
`migrate.test.ts`**.

| Migration test | Result |
|---|---|
| New/empty DB at version 0; nothing to run leaves version 0, requests no backup, creates no tables | ✅ |
| Test migrations apply in order; `user_version` advances 0 → 2 | ✅ |
| Only the pending migrations are applied to an older DB | ✅ |
| The backup hook is requested once, before the first `up` | ✅ |
| A failed backup applies nothing | ✅ |
| **A failed migration rolls back completely (its table and `user_version`); earlier ones stay** | ✅ |
| A failing recorder rolls the migration back | ✅ |
| An async migration is refused and rolled back | ✅ |
| **A DB newer than supported is rejected** (runner and startup), and the file is released | ✅ |
| A negative schema version is rejected; invalid lists (gap, duplicate, order, first ≠ 1, non-integer, duplicate/blank name) are rejected | ✅ |
| Production list is valid and empty; `initializeDatabase` yields the technical DB with **no tables** | ✅ |

---

## 8. IPC foundation

```
renderer ── window.api.app.info() ──► preload (createApi, sandboxed) ── ipcRenderer.invoke('app:info', input)
         ◄──── Result<AppInfo> ──────                                   │
main: ipcMain.handle('app:info') → sender check → Zod parse → service → { ok: true, data } | { ok: false, error }
```

| Piece | Implementation |
|---|---|
| Contract (`src/shared/ipc-contract.ts`) | A frozen `{ app: { info: call<void, AppInfo>() } }`. Channel = `<domain>:<action>`. The types `IpcChannel`, `IpcInput`, `IpcOutput` and `StockFlowApi` are derived from it, and `ipcCalls` is the flattened list. **No runtime imports**, so the sandboxed preload can bundle it; the built preload requires only `electron`. |
| Result envelope (`src/shared/types/result.ts`) | `Result<T> = { ok: true; data } \| { ok: false; error: AppError }`. `AppError = { code, message, fieldErrors?, details?, ref? }`. The codes are the plan's §14.3 list plus **`FORBIDDEN`** (untrusted sender). The envelope survives structured cloning (tested). |
| Handler wrapper (`src/main/ipc/handle.ts`) | 1. Untrusted sender → `FORBIDDEN` (logged in main). 2. Zod `safeParse` → `VALIDATION` with `fieldErrors` (input-level issues under `root`, the React Hook Form convention). 3. Service. 4. `AppFailure` passes through. SQLite environment failures (FULL, IOERR, CORRUPT/NOTADB, BUSY/LOCKED, READONLY, CANTOPEN) → `DB_ERROR` with guidance + reference. Anything else → `INTERNAL: "Something went wrong. (ref: 7F3A2C)"`. **The full error is logged only in main.** Listeners never throw. |
| Sender check | `isTrustedIpcSender`: the sender frame must still exist, and its URL must be the app's own document (the Phase 0 `isAppUrl` rule: the bundled `index.html`, or the dev-server origin in development) |
| Registration (`src/main/ipc/index.ts`) | `createIpcHandlers` returns the `IpcHandlers` mapped type, so the typecheck fails if a contract call has no handler. `registerIpc(ipcMain, …)` registers exactly those. |
| Preload (`src/preload/api.ts`, `index.ts`) | `createApi(invoke)` builds a frozen `{ app: { info } }` from `ipcCalls`. Each function sends **exactly one** argument on its own channel. Only `window.api` is exposed: no `ipcRenderer`, no channel names, no generic invoke/send/on. |
| Renderer (`lib/api.ts`) | `unwrap(call)` returns `data` or throws an `ApiError` (code, fieldErrors, details, ref). A failed IPC call becomes `INTERNAL` without its raw text. |

IPC tests (unit, with a real temp DB where relevant):

- The approved channel works end to end through the registered listener.
- **Malformed input** is rejected with `VALIDATION`: objects, strings, `0`, `null` and arrays. The service is not
  called.
- An untrusted or destroyed sender gets `FORBIDDEN`.
- `AppFailure` passes through unchanged.
- Thrown errors, rejected promises and non-Error values become `INTERNAL`. The JSON sent contains no message,
  path or stack text, and each failure has its own reference.
- **Real** SQLite failures map to `DB_ERROR`: a full DB (via `max_page_count`), a busy DB (lock contention), a
  read-only connection, and a non-database file. A constraint violation maps to `INTERNAL`.
- The preload exposes exactly the contract calls. It is frozen, has no generic IPC, and forwards one argument
  per call.
- Main registers exactly `ipcCalls`.

---

## 9. `app.info()` and Settings → About

- `window.api.app.info()` takes no input and returns only display-safe values.
- The packaged app returned:

  ```json
  { "ok": true, "data": { "appVersion": "1.0.0", "mode": "production", "databaseDriver": "better-sqlite3",
    "sqliteVersion": "3.53.2", "schemaVersion": 0, "dataDirectory": "%APPDATA%\\StockFlow\\data" } }
  ```

- `schemaVersion` is read live from `PRAGMA user_version`.
- The data folder is in **display form**, so the Windows user name never reaches the renderer. That is tested,
  and checked at runtime.
- There is no path, file handle or filesystem capability.

Settings remains the Phase 1 placeholder. A small **About** card was added below it (version, mode, database
driver, SQLite version, schema version, data folder), using the existing Card component and theme. The dev-only
Developer checks card is unchanged. Screenshots from both runs were reviewed. There is no "Open folder" button,
because that would need a main-process handler with shell access (a later phase).

---

## 10. Tests and coverage

### 10.1 Counts

**403 tests in 24 files, all passing** (`npm test`, through Electron-as-Node). The 280 existing tests are
unchanged: 261 domain + 19 Phase 1.

| New test file | Tests |
|---|---|
| `src/main/db/adapter.test.ts` | 25 |
| `src/main/db/migrate.test.ts` | 25 |
| `src/main/ipc/handle.test.ts` | 15 |
| `src/main/db/connection.test.ts` | 12 |
| `src/main/db/index.test.ts` | 10 |
| `src/shared/types/result.test.ts` | 5 |
| `src/main/data-paths.test.ts` | 5 |
| `src/preload/api.test.ts` | 5 |
| `src/shared/ipc-contract.test.ts` (includes type-level checks) | 4 |
| `src/main/ipc/index.test.ts` | 4 |
| `src/renderer/src/components/common/AboutCard.test.tsx` | 4 |
| `src/main/app-info.test.ts` | 3 |
| `src/renderer/src/lib/api.test.ts` | 3 |
| `src/renderer/src/lib/app-queries.test.ts` | 3 |
| **Total new** | **123** |

**Test-first:** each new module's tests were written and seen failing ("Cannot find module …") before the
module existed. Four regression tests were added afterwards for behaviour that already existed, to close
coverage gaps:

- async-rejection swallowing
- the already-ended-transaction path
- a non-Error migration failure
- the "Development" label

### 10.2 Coverage (`npm run test:coverage`, 24 measured files)

| Scope | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| **All measured files** | **100%** (523/523) | **100%** (262/262) | **100%** (129/129) | **100%** (466/466) |
| Phase 2 domain library (threshold ≥ 95%, still enforced on its own) | 100% (313/313) | 100% (185/185) | 100% (70/70) | 100% (271/271) |
| `main/db` | 100% (120/120) | 100% (47/47) | 100% (33/33) | 100% (114/114) |
| `main/ipc` | 100% (37/37) | 100% (14/14) | 100% (9/9) | 100% (34/34) |

Electron entry points need the Electron app itself, so they are verified by launching it (§12): `main/index`,
`window`, `security`, `paths` and `preload/index`.

### 10.3 Static guards

The new ESLint rules were run against probe snippets through stdin; no file was written.

- A service importing `better-sqlite3` → **error**.
- `db/adapter.ts` importing it → allowed.
- A renderer file importing `electron` and `node:fs` → **2 errors**.

---

## 11. Build and packaging

| Command | Result |
|---|---|
| `npm run typecheck` | ✅ node + web |
| `npm run lint` | ✅ 0 problems |
| `npm test` | ✅ 403 / 403 |
| `npm run test:coverage` | ✅ 100% (thresholds: 95% overall and 95% for the domain library) |
| `npm run build` | ✅ main 17.12 kB (Phase 2: 3.45 kB), preload 1.04 kB (0.24 kB), renderer JS 1,247.13 kB (1,224.34 kB), CSS 33.41 kB (33.12 kB) |
| `npm run build:unpack` | ✅ `dist\win-unpacked\StockFlow.exe` (electron-builder 26.15.3, "skipped dependencies rebuild — npmRebuild is set to false") |

**Packaged SQLite:**

- The Electron-ABI binary is packaged as a real file:
  `resources\app.asar.unpacked\node_modules\better-sqlite3\build\Release\better_sqlite3.node` (1,920,512
  bytes, SHA-256 `C9C931F0…`, the same as the postinstall build).
- electron-builder unpacks it automatically.
- The first build also unpacked better-sqlite3's C sources (`deps\sqlite3\sqlite3.c` is 9.5 MB). The new
  exclusion reduced `app.asar.unpacked` from 48 files / ≈12.3 MB to **17 files / 1.89 MB**: `lib/`,
  `package.json`, `LICENSE`, the binary, and the existing icon.
- `app.asar` is 7.45 MB; `dist\win-unpacked` is 335.1 MB.
- **The unpacked app launched, created and opened its technical DB, answered `app.info` from it, and closed it
  cleanly** (§12).

---

## 12. Runtime verification (dev + packaged)

The checks were automated with the Chrome DevTools Protocol (renderer) and the Node inspector (main process).
Screenshots were taken. The script lives in the session scratchpad, not in the project. The app was closed
the way a user closes it: closing the window quits the app, which closes the database last.

| Check | Dev (`electron-vite dev`) | Packaged (`StockFlow.exe`) |
|---|---|---|
| One window titled StockFlow; runtime Electron 39.8.10 / ABI 140 | ✅ | ✅ |
| `userData` | `%APPDATA%\StockFlow-dev` ✅ | `%APPDATA%\StockFlow` ✅ |
| sandbox, contextIsolation, webSecurity on; nodeIntegration off | ✅ | ✅ |
| Application menu | present ✅ | **none** ✅ |
| DevTools on request | open ✅ | **cannot be opened** ✅ |
| **`window.electron` undefined** | ✅ | ✅ |
| **`window.api` = only `api.app.info` (function), frozen, not replaceable** | ✅ | ✅ |
| No generic `invoke/send/on`; `require`, `process`, `Buffer`, `module`, `global`, `ipcRenderer` undefined | ✅ | ✅ |
| Main process handles exactly one channel: `app:info` | ✅ | ✅ |
| **`app.info()`** → ok; mode, driver, schema 0 and display path correct; no user path | ✅ | ✅ |
| Object / string input → `VALIDATION` | ✅ | ✅ |
| `window.open` denied; external fetch blocked by the CSP; external navigation blocked; CSP string unchanged | ✅ | ✅ |
| Sidebar: the same 11 links in order; every route opens with one active link; unknown route → "Page not found" inside the shell | ✅ | ✅ |
| Theme tokens (sidebar `oklch(0.275 0.05 257)`, top bar white, page `oklch(0.972 0.005 250)`, amber logo, active link `oklch(0.36 0.06 257)`); sidebar 224px | ✅ | ✅ |
| Settings → About shows the values; Developer checks dev-only | ✅ shown | ✅ hidden |
| While running: `data\shop.db` + `-wal` + `-shm` | ✅ | ✅ |
| Second instance exits (code 0); the first keeps working | — | ✅ |
| No unexpected console errors or warnings (only the 2 deliberate example.com requests) | ✅ | ✅ |
| **Clean shutdown:** WAL checkpointed and removed, only `shop.db` remains; no process left | ✅ | ✅ |
| **Total** | **31 / 31** | **32 / 32** |

Also verified:

- **WAL crash recovery.** One dev run was force-killed by the harness, leaving `-wal`/`-shm` behind. The next
  launch opened the database normally, and its clean shutdown removed them.
- **Bundles.** The preload requires only `electron` and contains no Zod. The renderer bundle contains neither
  `ipcRenderer` nor `better-sqlite3`. Main keeps `better-sqlite3` and `zod` external.
- **Logs.** The main-process log of both runs shows no IPC refusals or failures.

Four runs failed because of **verification-script** bugs, never because of the app. All four were fixed and
re-run:

- `process.mainModule` is undefined in Electron 39's inspector.
- `getLastWebPreferences()` does not report `devTools`.
- A colour was sampled mid-transition after the DevTools probe had occluded the window.
- An early aborted run.

---

## 13. Technical databases and files created during testing

| Item | Created by | State now |
|---|---|---|
| `%APPDATA%\StockFlow-dev\data\shop.db` | First dev verification run | **4,096 bytes, 1 page**; application_id `0x5354464C` ("STFL"); `user_version` 0; `journal_mode` wal; `integrity_check` ok; **0 schema objects**; SQLite 3.53.2. Only `shop.db` in the folder. |
| `%APPDATA%\StockFlow\data\shop.db` (**production path**) | Packaged verification | Identical properties. The `StockFlow` folder already existed from Phase 0/1 (Chromium profile). |
| Per-test DBs in `%TEMP%\stockflow-test-*` | Every DB test | Deleted by each test; none remain |
| Spike/inspection DBs in `%TEMP%\stockflow-spike-*`, `%TEMP%\stockflow-inspect-*` | Probes / DB inspection (always on a **copy**) | Deleted; one empty leftover spike folder was found and removed |
| `C:\Users\hp\.electron-gyp\39.8.10` (Electron headers, 126 files, ≈3 MB) | The failed 13.0.3 `postinstall` | **Removed** |
| `node_modules\better-sqlite3\build` (empty) and `node_modules\.better-sqlite3-uJMNxzfp` (stale `sqlite3.c`, locked during the 13 → 12 switch) | The failed 13.0.3 rebuild / npm cleanup | Removed |
| npm cache | Tarballs of 13.0.3 and 12.11.1; `prebuild-install` downloads | Kept (normal npm cache) |
| Session scratchpad (outside the project) | Probe and verification scripts, logs, screenshots, an isolated 12.11.1 test project, the extracted 13.0.3 tarball | Kept for reference; the two clean-room installs (≈1.3 GB) were deleted after their logs were saved |

Both technical DBs are **empty schema-0 StockFlow files**. The future `0001_initial` will apply to them like a
new database. They can also simply be deleted; the app recreates them.

---

## 14. Business schema: explicit confirmation

- **`0001_initial` was NOT created.** The production migration list is empty (`migrations/index.ts`), the latest
  schema version is 0, and a test checks this.
- **No business tables exist anywhere:** neither technical DB contains any table, index, view or trigger
  (`sqlite_schema` is empty). Not even `schema_migrations` was created.
- **None of these were created:** products, product_units, companies, customers, customer_ledger, invoices,
  invoice_items, invoice_item_quantities, stock_movements, stock_receipts, stock_adjustments, payments,
  expenses, settings, sequences.
- The tables that tests create (`probe`, `parent`/`child`, `fixture_items`, `fixture_log`, …) exist only in
  temporary test databases, defined inside the test files.
- No business Zod schemas, services, screens or sample data were added.

---

## 15. Differences from the plan / decisions made

1. **The driver version is 12.11.1, not the newest (13.0.3)** (§2). Same library, same API; it is the only
   version that passes the no-compile gate on this machine.
2. **Tests run through Electron-as-Node.** Plan §24 anticipated this. There is one launcher script and no new
   package (no `cross-env`).
3. **Error code `FORBIDDEN` was added** to the plan's §14.3 list, for requests from an untrusted sender.
4. **`src/main/logging.ts` was not created.** As instructed, file logging stays for later. Unexpected IPC
   errors go to `console.error` in main, with a reference sent to the renderer.
5. **Small supporting files** not in the plan's folder list:
   - `data-paths.ts` and `app-info.ts`: pure, testable parts of paths and `app.info`.
   - `errors.ts`, `db/index.ts`, `preload/api.ts`, `lib/app-queries.ts`, `lib/query-keys.ts`.
   - `scripts/vitest-electron.mjs`.
6. **Hardening beyond the brief:**
   - two ESLint import guards (§10.3)
   - read-back verification of every pragma
   - refusal of foreign or unmarked SQLite files
   - refusal of negative schema versions
   - refusal of async transaction callbacks and async migrations
7. **Deferred to the schema phase:** the plan's Phase 3 tests for triggers and CHECK constraints need the
   business schema.

---

## 16. Needs attention

1. **Revisit better-sqlite3 13.x later.**
   - Its Node-API binaries would remove the Electron-ABI coupling and the separate test runtime.
   - It becomes usable here once `@electron/rebuild` recognises its prebuild layout **and** lockfile installs
     respect `gypfile: false`, or once C++ build tools are available.
2. **Every Electron upgrade must be paired with a driver check.**
   - 12.x needs a prebuilt binary for each Electron ABI.
   - The 2 pre-existing `npm audit` high findings (Electron → `extract-zip`) are fixed only by a major
     Electron upgrade (npm suggests 44.3.0).
   - The driver added **no** new audit findings.
3. **The first install needs internet access.**
   - `prebuild-install` downloads both binaries from GitHub, and caches them in the npm cache.
   - An offline first install would fall back to `node-gyp` and fail without build tools.
4. **`prebuild-install` 7.1.3 is deprecated upstream.** It and 22 transitive packages are copied into
   `app.asar` although they never run at runtime. This is harmless; they could be excluded later.
5. **Use `npm test`, not plain `npx vitest`.** The database tests need Electron's Node, so an editor's Vitest
   runner cannot load the driver.
   - `npm install <package>` does **not** run our root `postinstall` (observed). After adding or rebuilding
     native packages, run `npm run postinstall`.
6. **Technical DBs exist on this PC**, including the **production path** `%APPDATA%\StockFlow\data\shop.db`
   (§13). They are empty and harmless. Delete them before a real install on this machine if you want a
   pristine state.
7. **The backup placeholder must be replaced in Phase 4** before any real data exists. Until then, the app
   refuses to migrate any database that already has a schema, which is the intended safe behaviour.
8. **Unexpected-error references are logged only to the console.** A packaged app has no console, so a reference
   cannot be looked up until file logging is added.

---

## 17. Confirmation

- Phase 3A is limited to the technical foundation. **The production business schema was not started**, and it
  waits for your explicit approval and the Group A and B answers.
- No products, stock, customers, invoices, payments, expenses, reports, dashboard data, backup/restore UI or
  printing was implemented.
- Phase 0 security, the Phase 1 shell/theme/routes and the Phase 2 domain library are preserved and verified.
- The implementation plan was not modified.
- **Nothing was committed.**
