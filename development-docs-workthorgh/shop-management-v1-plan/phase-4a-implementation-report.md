# StockFlow — Phase 4A Implementation Report

> **Phase:** 4A — Data safety engine (backend and infrastructure only).
> **Date:** 2026-09-14.
> **Status:** Implemented and verified. **Awaiting approval.**
> - Verified backups, rotation, restore with rollback, the real pre-migration backup, the integrity-check engine, the settings backend and the persistent technical log.
> - No IPC, preload or renderer changes: `window.api` still exposes only `app.info()`.
> - Schema version is still **1**; `0001_initial.ts` is unchanged; there is no migration 0002.
> - Phase 4B (screens, dialogs, scheduler, relaunch) and business features were not started. Nothing was committed.

---

## 1. Summary

| Area | Result |
|---|---|
| Logging | `<data-root>\logs\app.log`, rotated to `app.log.1…3` at 5 MB; the IPC error reference is written with the real error and stack; payloads never serialized |
| Backups | SQLite online backup → `.tmp` → verified (self-contained, marker, schema, `integrity_check`, `foreign_key_check`) → renamed, never overwriting → optional JSON sidecar |
| Rotation | Auto: newest of each of the last 14 backup days + first of each of the last 12 backup months. Pre-migration / pre-restore: last 5. Only after a verified backup; never the new one |
| Pre-migration | The Phase 3A placeholder is replaced: a verified backup in `backups\pre-migration` before any migration of a database that holds anything; if it fails, nothing is migrated |
| Restore | Validates a private copy, verified pre-restore backup, safe swap with WAL/SHM handling, reopen + migrate + final checks; any failure puts the previous database back; an interrupted restore is rolled back at the next start |
| Integrity | 8 checks, each OK / WARNING / ERROR with human-readable findings; read-only |
| Settings | Typed Zod backend for the 11 seeded keys; strict updates in one transaction |
| Schema | Still **1**; `0001` checksum `sha256:0cc4eb98…0bee576cc4` unchanged; checked against `schema_migrations` at every start |
| Tests | **923 / 923** in 37 files (**235 new**). Coverage 99.74 % statements, 99.25 % branches, 100 % functions |
| Builds | typecheck, lint (0 problems), test, test:coverage, build, build:unpack all pass |
| Packaged | **48 / 48** runtime checks against a temporary appData (fresh start, restart, damaged database) |

---

## 2. Files

### Created (19)

| File | Lines | Purpose |
|---|---|---|
| `src/main/logging.ts` | 201 | File logger: format, rotation, redaction, safe error serialization, error references |
| `src/main/db/context.ts` | 30 | `DataSafetyContext` (paths, app version, logger, migrations, clock) and the test-only fault hooks |
| `src/main/db/verify.ts` | 185 | Verification of a closed database file; `integrityProblems`, `foreignKeyViolations`, `recordCounts` |
| `src/main/db/backup-files.ts` | 67 | Backup file names (format/parse) and sidecar names |
| `src/main/db/rotation.ts` | 130 | Retention policies, pure selection, rotation of a folder |
| `src/main/db/backup.ts` | 273 | Verified backup, category backup + rotation, sidecar write/read, backup folders |
| `src/main/db/schema-upgrade.ts` | 60 | Verified pre-migration backup hook, migration recorder, `upgradeSchema` |
| `src/main/db/restore.ts` | 470 | Candidate validation, restore with rollback, startup recovery of an interrupted restore |
| `src/main/db/integrity.ts` | 346 | Integrity-check engine and schema-history (checksum) check |
| `src/main/services/settings.service.ts` | 103 | Typed settings backend |
| 9 test files | 2,600 | `logging`, `verify`, `backup-files`, `rotation`, `backup`, `schema-upgrade`, `restore`, `integrity`, `settings.service` |

### Changed (16 tracked files; 536 insertions, 179 deletions)

| File | Change |
|---|---|
| `src/main/index.ts` | Creates the file logger (after the single-instance lock), observes uncaught exceptions, starts the database through the data-safety context, logs startup failures with a reference shown in the dialog, passes the logger to IPC |
| `src/main/db/index.ts` | `initializeDatabase(ctx)`: interrupted-restore recovery → open → verified pre-migration backup + migrations → schema-history check → backup folders. The placeholder `preMigrationBackupNotAvailable` is removed |
| `src/main/ipc/handle.ts` | `HandlerOptions.logError` → `log` (`warn` for refused senders, `error` with `{ ref }` for unexpected failures) |
| `src/main/data-paths.ts` | `logsDir`, `logFile`, `backupsDir`, `BACKUP_CATEGORIES`, `backupFolder`, `isSameOrInside` |
| `src/main/db/adapter.ts` | `OpenOptions.mustExist` (open read-write without creating a missing file) |
| `src/main/errors.ts` | `fieldErrorsOf` (Zod issues → field errors), shared by IPC and settings |
| `vitest.config.ts` | Coverage also measures `logging.ts` and `services/` |
| `README.md` | Logs and backup folders; the pre-migration backup rule |
| `src/main/db/test-utils.ts` | Test-only fixtures: memory logger, test context, fixture migrations, fault helpers (hold a file open, violate a CHECK, corrupt an index, failing backup), `isBetween` |
| Tests: `index`, `handle`, `ipc/index`, `data-paths`, `adapter`, `0001_initial` (one line), `0001_constraints` (one assertion) | Updated for the new APIs; see §13 for the two 0001 test lines |

**Not changed:** `0001_initial.ts`, `migrate.ts` (the runner), `connection.ts`, `migrations/index.ts`, the preload, the renderer, the IPC contract, `package.json` (no new dependency), `electron-builder.yml`, ESLint config. `better-sqlite3` is still imported only by `src/main/db/adapter.ts`.

---

## 3. Logging architecture

- **Where:** `<data-root>\logs\app.log` (`%APPDATA%\StockFlow\logs\app.log`; `StockFlow-dev` in development). Created by the main process only, after the single-instance lock, so only one process ever writes it. The renderer has no file-system access and no log API.
- **Format:** one line per entry — `2026-09-14T09:05:13.232Z ERROR [startup] the database could not be opened ref=2BAE30` — then the error indented by two spaces: stack trace, `code:` (SQLite or Node code), and up to 4 `Caused by:` levels. Indentation means no line of an error can look like a new entry; control characters in messages and context become spaces, so an entry cannot be forged.
- **What is logged:** a fixed message plus primitive context values (`string | number | boolean | null` — the type makes it impossible to pass a record). An `Error` is written as name, message, code, stack and causes only; its other properties (e.g. a `payload`) are never serialized. A thrown non-Error object is logged only as its kind (`Thrown Object value; its contents are not logged.`). Request inputs are never passed to the logger. Values are shortened (message 500 chars, value 300, entry 16 KB).
- **Privacy:** the appData and user-profile folders are replaced by `%APPDATA%` / `%USERPROFILE%` in every entry (both slash styles, any letter case, whole folder names only). Backup logs name files, never folders.
- **Rotation:** before an entry would take `app.log` past 5 MB it becomes `app.log.1` (→ `.2` → `.3`; the oldest is dropped). An existing file's size is counted after a restart. An entry larger than the limit is written alone.
- **Never throws:** a write or rotation failure is reported once to the console (then again only after the log has recovered); entries keep going to `app.log` if rotation fails. Writes are synchronous, so an entry is on disk before a crash.
- **IPC error references:** an unexpected IPC failure returns `Something went wrong. (ref: ABC123)` to the renderer and logs `ERROR [ipc] <channel> failed ref=ABC123` with the full error and stack. A refused untrusted sender is logged as `WARN` with the sender URL.
- **Startup failures:** logged with a reference, and the dialog shows `Reference: XXXXXX (the details are in the StockFlow log file)`. This closes the Phase 3A limitation (references could not be looked up in a packaged app).
- **Uncaught exceptions:** observed with `process.on('uncaughtExceptionMonitor')`, which logs without changing Electron's own handling.

---

## 4. Backup algorithm (`createVerifiedBackup`)

1. Refuse a destination that is the data folder or inside it (`UNSAFE_DESTINATION`). A backup can never land beside `shop.db`, and its generated name can never be `shop.db`.
2. Create the folder (`DESTINATION_UNAVAILABLE` on failure).
3. Choose the first free name `stockflow-backup_<YYYY-MM-DD>_<HHMMSS>_v<app>_s<schema>[_<n>].db`, where neither the name nor its `.tmp` exists (up to 99 per second).
4. `db.backup('<name>.db.tmp')` — SQLite's online backup through the Db adapter, including committed WAL content. The live file is never copied with the file system (`COPY_FAILED`).
5. Verify the temporary copy (§5) (`VERIFICATION_FAILED`, with the file problem as the cause).
6. Rename `.tmp` → `.db`. If a file took the name meanwhile it is **not** replaced: the backup fails instead (`FINALIZE_FAILED`).
7. Write the optional sidecar (`.json`) through its own `.tmp` + rename. A sidecar failure is logged and leaves the backup valid (`sidecarWritten: false`).

On any failure: the verification connection is already closed, the `.tmp` (and any `-journal`/`-wal`/`-shm`) is removed (a removal failure is logged, never masking the real error), existing backups are untouched, the failure is logged, and a typed `BackupError` is thrown.

- **Names** use local time (what the shop owner reads), the sanitized app version (only `0-9A-Za-z.-`) and the schema version; no business or customer names. Example: `stockflow-backup_2026-09-14_153045_v1.0.0_s1.db`.
- **Sidecar** (safe summary only): `format`, `formatVersion`, `backupFile`, `backupCreatedAt` (UTC ISO), `appVersion`, `schemaVersion`, `sqliteVersion`, `applicationId`, `sizeBytes`, `counts { products, customers, invoices }` (null when a table does not exist). No names, money or personal data. The `.db` is authoritative; validity never depends on the sidecar.
- **Folders:** `<data-root>\backups\auto`, `pre-migration`, `pre-restore`, created at startup (a failure is logged; backups report their own failures). No scheduler: automatic backups are Phase 4B.

---

## 5. Verification algorithm (`verifyDatabaseFile`)

Used for new backups and for the private copy of a restore candidate — never for a file StockFlow does not own:

1. The file must exist and be a file (`MISSING`).
2. Open it with a raw connection (`mustExist`) and set `PRAGMA journal_mode = DELETE`. **Why:** the probe showed that an online backup of a WAL database is WAL-flagged (header bytes 2/2), and that even opening such a file read-only creates `-wal`/`-shm` files beside it. After this step the file is one self-contained file (bytes 1/1).
3. `application_id` must be StockFlow's `0x5354464C` (`NOT_STOCKFLOW`; a text file is `NOT_SQLITE`).
4. `user_version` must be ≥ 0 (`INVALID_SCHEMA_VERSION`) and, for a restore candidate, ≤ the app's latest schema (`SCHEMA_TOO_NEW`).
5. `PRAGMA integrity_check` must return exactly `ok` (`INTEGRITY_CHECK_FAILED`). Damage can make the check itself throw `SQLITE_CORRUPT` (observed in the probe); that also counts as a failure.
6. `PRAGMA foreign_key_check` must return no rows (`FOREIGN_KEY_CHECK_FAILED`).
7. Report `applicationId`, `schemaVersion`, `sqliteVersion` and record counts. The connection is always closed.

---

## 6. Rotation policy implementation

- **Pure selection** (`selectBackupsToDelete`) works on file names only. Only names that parse *and* format back identically are backups; `.tmp` files, sidecars, other letter cases, impossible dates and unrelated files are never selected. The just-created backup (`protect`) is never selected, even if the clock went backwards.
- **Keep last N** (pre-migration, pre-restore: 5): newest first by the name's time, then the same-second sequence.
- **Automatic backups** (14 daily / 12 monthly): the newest backup of each of the 14 most recent **days that have backups**, plus the first (oldest) backup of each of the 12 most recent **months that have backups**. Counting days and months that have backups, rather than calendar time, means a long break (the PC unused for months) never deletes every backup.
- **Applying it** (`rotateBackups`) runs only after a new backup is verified (`createCategoryBackup`). It deletes each selected `.db` with its sidecar, keeps and logs any file it cannot delete, and never throws (an unreadable folder or invalid policy is logged; nothing is deleted).

---

## 7. Pre-migration integration

- `verifiedPreMigrationBackup(ctx)` is the runner's `backupBeforeMigrating` hook in production (`upgradeSchema`, used at startup and after a restore). The Phase 3A migration runner is unchanged: it calls the hook once, before the first pending migration, and applies nothing if the hook throws (`BACKUP_FAILED`).
- A **new, empty** database (no schema objects, `user_version` 0) has nothing to lose: no backup, logged.
- Any other database gets a **verified** backup in `backups\pre-migration` (the last 5 kept) before any migration begins; if the backup fails, the migration does not start and the schema is unchanged.
- **Behaviour change from the placeholder:** a schema-0 database that already holds data used to be refused; it is now backed up and then migrated. The Phase 3A test was rewritten accordingly (the backup is verified to contain that data at schema 0).
- **Proof with a TEST-ONLY migration 2** (`schema-upgrade.test.ts`): on a schema-1 database, the fixture migration's own `up()` inspects the pre-migration folder and finds the backup already there, passing `verifyDatabaseFile` at schema 1 with the pre-migration data — before migration 2 runs. Afterwards the database is at 2 with both rows in `schema_migrations`.

---

## 8. Restore algorithm (`validateRestoreCandidate`, `restoreDatabase`)

**Validation (for a confirmation screen, restores nothing).** The candidate must not be in the data folder (so never the live `shop.db` or its WAL) and must be a file. It is **copied** to `shop.db.restore-check` and only the copy is verified (max schema = the app's latest); the candidate is never opened, so it is never modified. The copy is removed afterwards. It returns a safe summary: `fileName`, `schemaVersion`, `appVersion` (sidecar → file name → null), `backupCreatedAt` (sidecar → file name → file time), `sizeBytes`, counts, `needsMigration`. Errors carry user-safe messages without paths, e.g. *"This backup was created by a newer version of StockFlow. Install the newer application version before restoring it."*

**Restore:**

1. Validate a private copy (`shop.db.restore-staging`) — the exact file that will be installed.
2. Verified backup of the current database in `backups\pre-restore` (last 5 kept).
3. `PRAGMA wal_checkpoint(TRUNCATE)`; a reader still holding a snapshot makes it report busy → `DATABASE_IN_USE`, nothing closed.
4. Write the marker `shop.db.restore-pending`.
5. Close the live connection. If `shop.db-wal` still holds data (another connection) → stop. Rename `shop.db` → `shop.db.restore-rollback` (Windows refuses while another program holds it). Remove any stale `-wal`/`-shm`.
6. Rename the staged copy → `shop.db`.
7. Reopen it with `openDatabase` (every connection pragma, `recursive_triggers` included, is set and read back).
8. Migrate if it is older (`upgradeSchema`, which makes its own verified pre-migration backup of the restored data).
9. Final `integrity_check` and `foreign_key_check`.
10. Remove the marker, then the set-aside copy; return the open, verified database. Relaunching (`app.relaunch(); app.exit(0)`) is left to Phase 4B.

---

## 9. Rollback and recovery strategy

The user is never left without a database:

- **Before the swap** (validation, pre-restore backup, readers, marker): nothing is closed; the result returns the untouched live connection.
- **After the database was set aside:** any failure (replace, reopen, migrate, final check, marker removal) closes the restored connection, removes it, renames the set-aside original back, reopens it and checks `integrity_check` + `foreign_key_check`, then removes the marker. If that fails, the **verified pre-restore backup** is copied into place and checked instead.
- **If both fail** (e.g. another program holds the file), the result is `ROLLBACK_FAILED` with `db: null`, naming the pre-restore backup file. The set-aside original and the marker are kept, and **the next start puts it back** (`recoverInterruptedRestore`, run by `initializeDatabase` before opening anything).
- **Crash during a restore:** at startup a marker plus a set-aside copy means the restore did not finish: whatever was installed is removed and the previous database is put back (logged as a warning). A set-aside copy without a marker (a finished restore whose cleanup failed) is removed. Leftover working copies are removed. If the previous database cannot be put back, startup fails with a dialog and a logged reference, rather than opening an incomplete restore.
- All working files sit next to `shop.db` in the data folder, so every rename stays on one disk.

---

## 10. Integrity-check implementation (`runIntegrityCheck`)

Read-only; never fixes anything. Each check is `OK`, `WARNING` or `ERROR` with a summary and up to 20 findings (then "… and N more"); the report status is the worst one. A check that cannot run (e.g. a dropped view) is reported as `ERROR`, never thrown.

| Check | What it verifies |
|---|---|
| `sqlite.integrity` | `PRAGMA integrity_check` = ok |
| `sqlite.foreign-keys` | `PRAGMA foreign_key_check` empty (grouped by table) |
| `database.application-id` | StockFlow marker |
| `database.schema-version` | 0 ≤ `user_version` ≤ latest; older = `WARNING` (migrations pending) |
| `schema.history` | `schema_migrations` versions = 1…`user_version`; each recorded name and **checksum** equals the compiled migration; unknown (newer) migrations reported |
| `inventory.stock` | Per product: Q = Σ `qty_base` ≥ 0, V = Σ `value_minor` ≥ 0, Q = 0 ⇒ V = 0, and `v_product_stock` agrees |
| `ledger.entries` | Every `customer_ledger` row has the sign and references its type requires, and an INVOICE/PAYMENT entry is on its document's customer |
| `ledger.balances` | Every customer's `v_customer_balance` equals the sum of their ledger rows |

The business checks are "not applicable" before schema 1. Document-level checks (invoice totals, one SALE per line, void reversals) belong to the phases that write those documents.

**Schema checksum validation (§15):** at every start the recorded history is compared with the compiled migrations. **Chosen behaviour:** a mismatch is logged as a `WARNING` naming both checksums and is **never corrected**; the app still starts, because the database passed the open checks and its data is not in doubt. The integrity report shows it as an `ERROR`, so Phase 4B's maintenance screen surfaces it. Startup is blocked only where safety is uncertain (unreadable or foreign file, newer schema, failed pre-migration backup, interrupted restore that cannot be rolled back).

---

## 11. Settings backend (`services/settings.service.ts`)

- Zod schemas for exactly the 11 seeded keys (no other key, no negative-stock setting):

| Key | Rule |
|---|---|
| `business.name` | trimmed, 1–100 characters |
| `currency.code` | three capital letters (e.g. PKR) |
| `currency.symbol` | trimmed, 1–8 characters |
| `currency.minorDigits` | integer 0–4 (the domain library's maximum) |
| `invoice.prefix` | 0–12 of letters, digits, `.`, `-`, `_` (no spaces or slashes) |
| `invoice.padding` | integer 1–10 |
| `invoice.startNumber` | integer 1–999,999,999 |
| `invoice.paperSize` | `A4` or `A5` |
| `backup.autoEnabled` | boolean |
| `backup.keepDaily` | integer 1–365 |
| `backup.keepMonthly` | integer 0–120 |

- `readSettings(db, log?)` returns every setting typed; a missing or invalid stored value falls back to its seeded default and only its **key** is logged. Rows of unknown keys are ignored.
- `updateSettings(db, patch)` validates with a strict schema (unknown keys refused → `VALIDATION` with field errors, via `AppFailure`) and writes every value in **one transaction** (all or nothing); `updated_at` changes only on changed rows. `SettingsPatchSchema` is exported for Phase 4B's IPC input. No IPC or UI yet.

---

## 12. Failure-injection tests

Failures are injected with real conditions where possible (Windows `EBUSY` from a file SQLite holds open, a file where a folder should be, a CHECK violation inserted with `ignore_check_constraints`, corrupted index bytes, an orphan row with foreign keys off) and otherwise with test-only hooks (`ctx.faults`, never set by the app).

| Area | Injected failures | Proven |
|---|---|---|
| Backup | destination unwritable; online backup throws; copy not StockFlow; `integrity_check` fails; `foreign_key_check` fails; name taken meanwhile; rename `EBUSY`; unexpected error; all 99 names taken | typed error, no `.db`, no `.tmp` (or a logged one when Windows holds it), earlier backup byte-identical, error logged |
| Pre-migration (schema 1 → test 2) | the six cases above (`it.each`) and through `initializeDatabase` | migration 2 never runs, `user_version` stays 1, no fixture table, `schema_migrations` = [1], no backup left |
| Rotation | undeletable backup; undeletable sidecar; unreadable folder; invalid policy | never throws, logs, keeps files; the new backup stays valid |
| Restore | invalid candidate; pre-restore backup fails; a reader holds a snapshot; another program holds the file; marker cannot be written; replacement fails; reopened DB fails; final integrity fails; final FK check fails; migration of an older backup fails; set-aside copy unhealthy (falls back to the pre-restore backup); rollback impossible | after each: the previous database is open, has its data, accepts a write, is on disk, passes both checks, has all pragmas, no working files remain; for the impossible rollback, both copies survive and the next start puts the data back |
| Recovery | crash before / after install; marker only; leftover set-aside copy; leftover working copies; locked database | correct reinstatement or cleanup; refuses (throws) rather than open an incomplete restore |
| Settings | 20 invalid values; unknown keys; non-objects; a write failing halfway | nothing changes; the transaction rolls back |
| Logging | unwritable log; failing rotation; recovery; forged newlines; payload-carrying errors | never throws; entries intact; no payload in the file |

---

## 13. Tests and coverage

- **923 / 923** tests in 37 files (Phase 3B: 688). **235 new**: logging 27, verify 19, backup-files 18, rotation 21, backup 30, integrity 27, schema-upgrade 13, restore 41, settings 34, plus 5 in updated files (handle +1, data-paths +3, adapter +1; `index.test.ts` rewritten at 14).
- **Coverage** (`npm run test:coverage`): all files **99.74 % statements, 99.25 % branches, 100 % functions, 99.72 % lines**. Every file is at 100 % except `integrity.ts` (100 / 98.55 / 100 / 100), `restore.ts` (99.35 / 96.87 / 100 / 99.33) and `verify.ts` (96.55 / 94.28 / 100 / 96.29). The four uncovered branches are defensive guards: a check throwing a non-Error, the WAL still holding data after the checkpoint and close (only a race), `journal_mode` refusing to become `delete`, and `SQLITE_CORRUPT` outside `integrity_check`.
- **Phase 2 domain library:** 100 % (threshold ≥ 95 %). The existing 688 tests all still pass.
- **Two Phase 3B test assertions were made tolerant**, test code only (`0001_initial.ts` untouched): the "created_at is the current time" assertions compared SQLite's clock with V8's to the millisecond, and failed once in this session because the two read the Windows clock separately. They now allow 50 ms (`isBetween`). One `0001_initial.test.ts` line now opens the database at the test context's location.

---

## 14. Builds

| Command | Result |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run lint` | ✅ 0 problems |
| `npm test` | ✅ 923 / 923 |
| `npm run test:coverage` | ✅ thresholds met |
| `npm run build` | ✅ main 71.62 kB (was 44.73), preload 1.04 kB, renderer JS 1,247.13 kB, CSS 33.41 kB |
| `npm run build:unpack` | ✅ `dist\win-unpacked\StockFlow.exe` (electron-builder 26.15.3, Electron 39.8.10) |

---

## 15. Packaged runtime result (48 / 48)

The unpacked packaged app ran three times against one **temporary appData** (redirected through the inspector before any app code ran; Electron ignores the `APPDATA` variable):

- **A. Fresh start:**
  - The database was created at schema 1: 19 STRICT tables, 2 views, 40 indexes, 23 triggers, and the pinned checksum recorded. Only the seeds exist; there are 0 business rows.
  - `app.info()` reports production, better-sqlite3, SQLite 3.53.2, schema 1 and `%APPDATA%\StockFlow\data`. Settings → About shows schema 1 and no new UI.
  - `app.log` was written under the temporary data root. It records the start, "new database: no pre-migration backup is needed", the 0→1 migration, "database ready", "schema history verified", the refused untrusted IPC sender (FORBIDDEN) and the shutdown. There are no user paths and no business data in it.
  - The backup folders were created and are empty.
  - A second instance exits with code 0 and logs nothing.
  - Shutdown is clean, with exit 0 and only `shop.db` left.
  - Security and UI are unchanged:
    - `window.electron` is undefined, `window.api` is only `app.info` and frozen, and there are no Node globals.
    - The only IPC channel is `app:info`.
    - The sandbox, context isolation and web security are on. There is no menu and no DevTools.
    - The CSP, window.open, fetch and navigation guards all hold.
    - The 11 routes, the sidebar and the theme are unchanged, with no console errors.
- **B. Restart:** the existing schema-1 database opens without migrating. The log records "schema=1 migrated=0" and a verified history, `schema_migrations` is unchanged, there are still no backups, and the exit is clean.
- **C. Damaged `shop.db`:**
  - Startup stops with exit code 1. The modal error box was stubbed by the verification harness.
  - `app.log` holds `ERROR [startup] the database could not be opened ref=2BAE30`, then `DatabaseOpenError: %APPDATA%\StockFlow\data\shop.db is not a StockFlow database.` with its stack, `code: NOT_STOCKFLOW_DATABASE` and `Caused by: SqliteError … code: SQLITE_NOTADB`.
  - The path is redacted.
  - The damaged file was not modified.

The real `%APPDATA%\StockFlow` and `StockFlow-dev` folders (data, logs, backups) were fingerprinted before and after: **unchanged**. The temporary root was removed, and no app process remained.

---

## 16. Documentation correction (internet)

`README.md` (and the Phase 3A report, corrected in 3B) already say it correctly: internet access may be needed on the **developer/build machine** when it installs or rebuilds the `better-sqlite3` dependencies; the **packaged installer contains its native SQLite binary** and needs no internet to install or run. No other document says the client installation needs internet (`implementation-plan.md` mentions downloads only for the developer setup), so nothing else needed changing.

---

## 17. Confirmation

- **Schema version remains 1.** No migration 0002 exists (`src/main/db/migrations` holds only `0001_initial`); future migrations are tested with TEST-ONLY fixtures.
- **The 0001 checksum is unchanged:** `sha256:0cc4eb9837b99f71442ed9e8bbd48723f869bcbc8fb2f4d8b0dcd90bee576cc4`; `0001_initial.ts` has no diff.
- The approved Phase 3B decisions are preserved: customer sequence 2, zero-cost inflows, cost-correction magnitude, no zero ledger rows, `recursive_triggers = ON` set and verified on every StockFlow connection (the restored connection included).
- **Phase 4B and business features were not started:** no IPC, preload or UI changes; no scheduler; no products, stock, customers, invoices or reports.
- Nothing was committed (HEAD is still `8a3d4f5`).

---

## 18. Needs attention

1. **The real `%APPDATA%\StockFlow-dev` folder was changed by development launches outside the automated runs** (none of my commands started the dev app).
   - Its database was last written at 10:43, with Phase 3B code: it was migrated 0 → 1 then.
   - A 9-second Phase 4A dev launch at 14:01 created `logs\app.log` and the empty backup folders. That launch did not modify the database.
   - The production `%APPDATA%\StockFlow\data\shop.db` is still the untouched schema-0 file from 11 Sep.
   - Every automated run used temporary roots and left both real folders byte-for-byte unchanged.
2. **A damaged database cannot be backed up.** A backup must pass `integrity_check` and `foreign_key_check`, so a live database with such damage blocks migrations and restores (and, in 4B, automatic backups) until it is repaired or restored. This is by design, and the integrity report shows the cause.
3. **Schema checksum mismatch at startup:** logged as a warning and the app still starts; the integrity report shows it as an error (§10). Confirm this is the behaviour you want.
4. **Rotation interpretation:** "last 14 daily / 12 monthly" counts days and months *that have backups* (newest of each day; first of each month), not calendar time, so a long break never deletes every backup. Backup names use local time; `createdAt` and the sidecar use UTC.
5. **Restore detail:**
   - Only the main file of a candidate is copied. StockFlow's own backups are always self-contained; a foreign raw copy with a separate `-wal` would lose its uncheckpointed WAL data.
   - Detecting a reader waits up to the 5-second busy timeout.
6. **`invoice.startNumber` is only stored.** Applying it to the invoice sequence (e.g. only before the first invoice) is Phase 4B/8 business logic. `invoice.paperSize` allows A4/A5 until decision E1; thermal would be a new value, with no migration.
7. **Test-only fault hooks** (`DataSafetyContext.faults`) exist on the backup and restore paths; the app never sets them.
8. **Not added:** a `foreign_key_check` inside each migration's transaction (plan §21). The runner is unchanged, as instructed; worth adding when 0002 is written. Unhandled promise rejections are not logged separately; uncaught exceptions are.
9. **Log redaction** covers the appData and profile folders. Other absolute paths (e.g. a USB backup folder chosen in 4B) would appear as they are.
10. **Internal API change:** `HandlerOptions.logError` became `log` (`warn`/`error`); `initializeDatabase` now takes the data-safety context instead of a file path.
