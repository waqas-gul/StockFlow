# StockFlow — Phase 4C Implementation Report

> **Phase:** 4C — Final recovery hardening. **Date:** 2026-09-16. **Status:** implemented and verified. **Awaiting approval.**
> Nothing was committed. Schema is still **1** (no 0002; `0001_initial` and its checksum unchanged). Phase 5 was not started.

**Files:** 4 new (`src/main/services/startup-recovery.ts`, `src/main/db/backup-cleanup.ts`, and a test for each) and 16 changed, including `README.md`. No new dependency.

---

## 1. Recovery mode

**When it is offered.** Normal startup (`initializeDatabase`) is refused and `startupRecoveryReason(error)` finds a database condition. It follows the error's cause chain.

| Offered (reason) | Not offered (the old "StockFlow cannot start" box stays) |
|---|---|
| SQLite corruption or `SQLITE_NOTADB` anywhere in the chain (`DAMAGED`) | An application error, such as an invalid migration list |
| A failed `integrity_check` or `foreign_key_check` that blocks startup | A database from a **newer** StockFlow (installing that version is the answer) |
| A migration checksum mismatch (`SCHEMA_CHECKSUM_MISMATCH`) | A busy or locked file, a full disk, an I/O error, a folder that cannot be created |
| An invalid schema version | An interrupted restore that cannot be rolled back at startup |
| A SQLite file that is not StockFlow's | Any error that is not an `Error` |
| Connection settings that cannot be applied (`CANNOT_OPEN_SAFELY`) | |

**The flow.** Everything runs in the main process through native dialogs. No window opens, no IPC is registered, and the renderer never sees a path.

1. *"StockFlow could not safely open its database."* offers **[Restore Backup] [Exit]**, with the log reference.
2. The main process opens the file dialog in `backups\auto`; cancelling returns to step 1.
3. The existing `validateRestoreCandidate` checks a private copy. A rejected backup shows the engine's message and returns to step 1, and no live file is touched.
4. The summary shows the backup file, date, StockFlow version, schema version, and product, customer and invoice counts. It warns: *"Restoring will replace the current StockFlow data."*
   - Explicit confirmation is **Restore** with the box *"I understand that restoring replaces the current StockFlow data."* ticked.
   - **Cancel** is the default.
   - Restore without the tick asks again.
5. The backup file must be unchanged since it was checked (same size and modification time).
6. The existing `restoreDatabase(null, file, ctx)` restores it. `lastRestore` is recorded in `backup-status.json`, then `app.relaunch()` and `app.exit(0)`.

**Failures.**
- A restore that fails after touching the live files shows the engine's safe message: *"StockFlow restarts and checks its database again."* It then relaunches rather than continuing in an uncertain state. The engine has put the previous files back, or the next start does.
- An unexpected throw is handled the same way.
- Exit ends with code 1 and leaves everything unchanged.

**Safety.** Phase 4A's rules are unchanged, because the same engine does the work:
- The candidate is validated first, including its application_id, `integrity_check`, `foreign_key_check`, schema version (a newer schema is rejected) and its own recorded checksums.
- A damaged live database goes to `recovery\damaged-live-db_*.db` byte for byte and is never called a backup.
- A healthy but refused database, such as one with a checksum mismatch, first gets a verified `pre-restore` backup.

**Engine changes.** None. `restore.service.ts` only exports its file-fingerprint and restored-message helpers.

## 2. Currency decimal places (`currency.minorDigits`) locking

- **The rule.** `hasMonetaryData(db)` is true once any of these exists. The main process then refuses a *different* value with the new typed code `SETTING_LOCKED`: *"Currency decimal places cannot be changed after financial data has been entered."* That message is also attached as the field error.
  - a unit wholesale price, retail price or default cost that is not NULL;
  - any row in `stock_receipts`, `stock_receipt_items`, `stock_adjustments`, `stock_movements`, `invoices`, `invoice_items`, `invoice_item_quantities`, `payments`, `expenses` or `customer_ledger`.
- **Enforcement.**
  - The check is in `updateSettings`, inside the write transaction, so every path is guarded.
  - The whole save is refused and nothing is written.
  - Saving the same value is allowed.
- **Not financial data:** the seeded settings, counters, walk-in customer and expense categories, and companies, products, unpriced units and customers.
- **Still editable:** the currency code and symbol.
- **IPC.** `settings.get()` and `settings.update()` now return `{ values, minorDigitsLocked }`. There are still exactly 9 calls.
- **UI.** When locked, *Minor digits* is **read-only** (not disabled, because React Hook Form drops disabled values). It is greyed and hinted *"Locked: decimal places cannot change after financial data has been entered."* Nothing else in Settings changed.
- **Backup settings:** kept fixed as decided (on, 14 daily, 12 monthly). The backend keys remain, and the IPC still refuses them.

## 3. Stale temporary backup cleanup

`removeStaleBackupTempFiles` runs first in `initializeDatabase`, before the database opens and before any backup can run. The single-instance lock excludes another StockFlow. It never throws.

- **Removes only:**
  - `<StockFlow backup name>.db.tmp`, with its `-journal`, `-wal` or `-shm`, and the sidecar's `<name>.json.tmp`, where the name must parse as a generated StockFlow backup name;
  - regular files older than **1 hour** (a file dated in the future is kept);
  - files directly inside `backups\auto`, `pre-migration` and `pre-restore`.
- **Never touches:**
  - finished backups, sidecars, or look-alike and unknown names;
  - subfolders, `recovery\`, `data\`, the backups root, or any folder the user chose for a manual backup.
- **Logging:** the files removed (`<category>\<name>`) and each file that could not be removed, with its error code.

## 4. Tests and results

| Command | Result |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run lint` | ✅ 0 problems |
| `npm test` | ✅ **1228 / 1228** in 54 files (Phase 4B: 1160 in 52) |
| `npm run test:coverage` | ✅ 99.24 % statements, 97.51 % branches, 98.98 % functions, 99.28 % lines. Not required; run to confirm thresholds |
| `npm run build` | ✅ main 150.82 kB, preload 2.03 kB, renderer 1,668 kB |
| `npm run build:unpack` | ✅ `dist\win-unpacked\StockFlow.exe` |

Targeted tests, numbered as requested:
1. A corrupt live database (not a database) gets `DAMAGED`. Real integrity failures, foreign-key failures, invalid schema versions and non-StockFlow files are also covered.
2. A checksum mismatch gets `SCHEMA_CHECKSUM_MISMATCH` and restores over it with a `pre-restore` backup.
3. A valid backup goes through summary, ticked confirmation and restore to `RELAUNCH`. The next `initializeDatabase` opens the restored data, and the damaged file is in `recovery\` byte for byte.
4. An invalid backup is rejected and the live file's hash is unchanged. Also covered:
   - a cancelled dialog, a cancelled confirmation, and Restore without the tick;
   - a file changed after it was checked;
   - a failure after the move (files put back, relaunch);
   - an unexpected throw.
5. A newer-schema backup is rejected, and so is a backup with its own checksum mismatch.
6. With no monetary data, the decimal places may change.
7. Each of the 13 kinds of monetary data locks it, with `SETTING_LOCKED` and nothing saved (service and IPC).
8. The currency code and symbol stay editable while locked.
9. Stale owned `.tmp` files are cleaned from all three folders and logged.
10. Recent, future-dated, unknown and unrelated files, folders, and files outside the three folders are untouched. A busy file is logged and skipped.

Also: application and environment errors do not get recovery mode, the log holds file names only, and there are static renders of the locked and unlocked field.

Existing tests changed only where the settings IPC now returns `{ values, minorDigitsLocked }` (IPC and contract type tests).

## 5. Packaged checks

**38 / 38** passed. The unpacked app ran **6 times** against a temporary appData redirected before any app code ran. Message boxes, file dialogs, `shell.openPath` and `app.relaunch` were stubbed and recorded.

| Check | Result |
|---|---|
| Normal startup still works (fresh start, window, 9 IPC channels, integrity OK) | ✅ |
| Startup failure offers recovery: damaged `shop.db` shows *[Restore Backup] [Exit]*; Exit gives code 1, no window, file unchanged, logged `reason=DAMAGED` | ✅ |
| Valid restore recovers the app: file dialog in `backups\auto` → summary (`Schema version: 1`, `Products: 0`, `Customers: 1`, `Invoices: 0`, no path) → ticked confirmation → restore → relaunch requested, exit 0; damaged file kept byte for byte in `recovery\`; the relaunched app starts normally on the restored data | ✅ |
| Checksum mismatch offers recovery; restoring gives a verified `pre-restore` backup, exit 0, and the pinned checksum back | ✅ |
| Minor digits locks after test monetary data: `minorDigitsLocked: true`; IPC refuses with `SETTING_LOCKED`; the field is read-only and real typing does not change it; the symbol and code still save | ✅ |
| Stale owned `.tmp` files removed at startup; a recent `.tmp`, `notes.tmp` and a `.tmp` in `recovery\` kept | ✅ |
| `window.electron` undefined (3 launches) | ✅ |
| No renderer Node access (`require`, `process`, `module`, `Buffer`, `global`) | ✅ |
| Schema still 1 with only 0001 and its pinned checksum | ✅ |
| Log holds no profile path or business data; the real `%APPDATA%\StockFlow` and `StockFlow-dev` unchanged; temporary root removed | ✅ |

## 6. Needs attention

1. **Recovery mode is not offered for:**
   - a database from a newer StockFlow (restoring an older backup over newer data would lose it);
   - computer-side problems: a locked file, a full disk, an I/O error or permissions;
   - a failed rollback of an interrupted restore at startup.

   These keep the Phase 4A "cannot start" box. Say if any should also get recovery.
2. **Startup still does not run a full `integrity_check`** (unchanged, to keep startup fast). Damage that does not stop the database from opening and migrating is found by Settings → Run Integrity Check, and can be restored from Settings.
3. **The recovery confirmation is a ticked checkbox,** not typed RESTORE, because a native message box cannot take text. Cancel is the default button.
4. **After a failed recovery restore StockFlow relaunches:** if the database is still refused, the user sees recovery mode again. It never loops without user input.
5. **What counts as "financial data" is conservative:** a price or cost of 0 also locks. A refused save rejects the whole patch (other changed fields are not saved). The read-only field means the form never sends a locked change.
6. **Temporary files are cleaned only at startup, with a 1-hour age threshold.** A `.tmp` from a crash less than an hour before the next start is removed at a later start. `backup-status.json.tmp` is not included, because the next status write replaces it.
7. **The packaged checks stubbed the native dialogs,** so the Windows message box itself (checkbox, button layout) was not checked visually. The dialogs have no parent window. Recovery mode in `npm run dev` was not run.
8. **Not verified by tests:** one defensive branch in `startup-recovery.ts`, a backup that passes the first check but fails the second one inside the restore. Line coverage of that file is 97.7 %.
