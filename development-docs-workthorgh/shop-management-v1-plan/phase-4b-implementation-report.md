# StockFlow — Phase 4B Implementation Report

> **Phase:** 4B — Settings + Backup/Restore UI. **Date:** 2026-09-15. **Status:** implemented and verified. **Awaiting approval.**
> Nothing was committed. Schema is still **1**. Phase 5 was not started.

---

## 1. What changed

- **The Settings page is real.** It replaces the placeholder with five sections:
  - A. Business
  - B. Currency
  - C. Invoice
  - D. Backup & Restore
  - E. Maintenance and About
- **New IPC.** Eight calls were added to the allow-list, each validated with Zod in the main process. There is no generic IPC.
- **Main-process services** (`src/main/services/`):
  - `backup.service.ts`: Backup Now, Open Backup Folder and the backup status.
  - `restore.service.ts`: the file dialog, validation, a one-time token, the restore and the restart.
  - `auto-backup.ts`: the scheduler.
  - `backup-status.ts`: `backups\backup-status.json`.
  - `maintenance.service.ts`: the integrity check in plain language.
  - `live-database.ts`: the connection is refused during a restore and while the app restarts.
  - `operation-lock.ts`: backups and restores never overlap.
  - Electron dialogs, `shell.openPath` and relaunch are isolated in `src/main/desktop.ts`.
- **App lifecycle** (`src/main/index.ts`):
  - Automatic backups start after startup.
  - A normal quit makes the shutdown backup first.
  - A restore restarts the app with `app.relaunch()` and `app.exit(0)`.
  - Starting StockFlow again while it is closing relaunches it once it has quit.
- **Phase 4A engine, small additions only:**
  - `createVerifiedBackup(…, { fileName })` writes a manual backup under the name chosen in the Save dialog. A name that is taken fails with the new `DESTINATION_EXISTS`: nothing is ever replaced.
  - The sidecar never replaces a file of the user's with the same name.
  - `integrity.ts` exports the "could not run" summary as a constant.
  - Verification rules, rotation, restore and retention are unchanged.
- **Settings rules moved to `src/shared/settings.ts`,** so the form and the main process use the same Zod rules.
  - The rules are identical to Phase 4A; the messages are now plain language.
  - `settings.service.ts` re-exports them.
- **Files:** 44 new (22 source, 16 tests, 6 shadcn UI components) and 22 changed, including `README.md`.
  - The new UI components are `input`, `label`, `alert`, `alert-dialog`, `badge` and `radio-group`, built on the existing `radix-ui` package.
  - No new dependency.

## 2. IPC / API added

```text
window.api.app.info()                          (unchanged)
window.api.settings.get()                      → 8 editable settings
window.api.settings.update(patch)              strict Zod: only those 8 keys; validated again by the service
window.api.backup.status()                     no input
window.api.backup.createManual()               no input; main opens the Save dialog and keeps the path
window.api.backup.openFolder()                 no input; always <data-root>\backups\auto
window.api.backup.selectRestoreCandidate()     no input; main opens the Open dialog, validates, returns summary + token
window.api.backup.restore({ token, confirmation: 'RESTORE' })   strict; 32-hex token; never a path
window.api.maintenance.integrityCheck()        no input; plain-language report + log reference
```

- **The restore token:**
  - 128-bit random, compared in constant time.
  - Used up by any restore request, including a forged one.
  - Valid for 10 minutes.
  - Bound to the file's size and modification time, both when checked and when restored.
- **New error codes:** `BACKUP_FAILED`, `RESTORE_REJECTED` and `RESTORE_FAILED`. "Busy" and "restarting" use `FORBIDDEN_STATE`.
- **Never exposed:** `ipcRenderer`, `fs`, `shell` or any path. `window.electron` stays undefined.

## 3. Settings / backup / restore UI

- **Settings form:**
  - React Hook Form with the shared Zod rules, so errors match what the main process refuses.
  - Only changed fields are saved.
  - A "First invoice number" preview.
  - Paper size A4 or A5.
  - No negative-stock setting.
- **Backup & Restore:**
  - Status: working, last failed, or none yet.
  - Last automatic backup, last manual backup (file and folder), last restore, and the backup folder.
  - Buttons: Open Backup Folder, Backup Now and Restore Backup.
  - The reminder: *"Keep an occasional backup on a USB drive or another physical drive."*
  - Backup Now moves through Idle, Creating…, then Success or Failed, with toasts.
- **Restore:**
  - The steps are: choose (main's dialog) → validate → summary → type RESTORE → Restoring → Restarting.
  - The summary shows the file, date, app version, schema, product, customer and invoice counts, and size.
  - It warns: *"Restoring will replace the current StockFlow data."*
  - The confirm button stays disabled until RESTORE is typed exactly.
  - The dialog cannot be closed while restoring.
- **Maintenance:**
  - Run Integrity Check shows "Overall: OK / Warning / Error" and each check's message.
  - No SQL, pragma, table or checksum text is shown, and there is no fix button.
- **Top bar:** a "Backup failed" link to Settings appears only when the last automatic backup failed. The status refreshes every minute.
- **Double submissions:** every action is single-flight in the renderer, the buttons are disabled while running, and main's `OperationLock` refuses at once.

## 4. Automatic backup behaviour

- **Engine:** the Phase 4A `createCategoryBackup(db, 'auto')`. It writes to `<data-root>\backups\auto` and rotates (14 daily and 12 monthly) only after verification.
- **Launch:** a check runs 5 s after start. It makes a backup if today has no automatic backup yet.
- **While running:** the same check repeats every 15 min, so a day change is caught.
- **Normal quit:** a backup unless the last one is under an hour old. The quit waits at most 60 s for it.
- **Throttle:** never more than one automatic backup an hour. A backup dated in the future (a changed clock) never blocks new ones.
- **A failure never blocks the app.** It is:
  - logged;
  - recorded in `backup-status.json`, so the next launch still shows it;
  - shown in Settings and the top bar;
  - retried: at the next launch or quit, or after an hour by the periodic check.
- A later success clears the failure, and existing backups are never touched by a failure.

## 5. Tests run / results

| Command | Result |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run lint` | ✅ 0 problems |
| `npm test` | ✅ **1160 / 1160** in 52 files (Phase 4A: 977 in 38) |
| `npm run test:coverage` | ✅ 99.35 % statements, 98.41 % branches, 98.93 % functions. Run because the backup engine gained the `fileName` option |
| `npm run build` | ✅ main 138.69 kB, preload 1.96 kB, renderer 1,668 kB |
| `npm run build:unpack` | ✅ `dist\win-unpacked\StockFlow.exe` |

New targeted tests cover:
- settings IPC validation;
- manual backup (dialog, chosen name, `.db` added, data folder refused, no replacing, failure, double click);
- path refusal on every backup call;
- token forgery, reuse, expiry and a changed file;
- the confirmation;
- restore: healthy, damaged, stopped before any change, failed after the swap, unexpected throw;
- the integrity report wording and its logging (no business data);
- scheduler decisions, throttle, rotation-after-verification, failure persistence, timers and the shutdown timeout;
- the restore and backup UI flow logic;
- static renders of each UI state.

Existing tests: the IPC/contract/preload expectations grew with the contract; routes now send `/settings` to the Settings page; one Phase 3A test needed a type cast for its partial handler map.

## 6. Packaged verification

**39 / 39** checks passed. The unpacked app ran three times against a temporary appData. Before any app code ran:
- appData was redirected;
- the Save and Open dialogs, `shell.openPath` and `app.relaunch` were stubbed, so no instance could run on the real data.

| # | Check | Result |
|---|---|---|
| 1 | The packaged app launches | ✅ |
| 2 | Settings load and save (IPC and the form); a backup key is refused by main | ✅ |
| 3 | Backup Now (UI click) writes a verified backup where chosen, with a StockFlow name suggested; path input refused | ✅ |
| 4 | The launch backup is verified; none twice a day; shutdown backup throttled, then made once the last is 2 h old | ✅ |
| 5 | Restore summary: file, date, app 1.0.0, schema 1, counts, warning; status shows manual, restore and folder | ✅ |
| 6 | Forged token and path refused; UI restore with typed RESTORE; pre-restore backup; exit 0 with relaunch; next launch opens the restored data | ✅ |
| 7 | Integrity check OK, 8 checks | ✅ |
| 8 | `window.electron` undefined | ✅ |
| 9 | `window.api` is exactly the 9 approved functions, frozen; the same 9 IPC channels | ✅ |
| 10 | No `require`, `process`, `module`, `Buffer` or `global` in the renderer | ✅ |
| 11 | Schema 1 with only 0001 and its pinned checksum | ✅ |
| 12 | Products still a placeholder; 0 products | ✅ |

The log holds no profile path and no business data. The real `%APPDATA%\StockFlow` and `StockFlow-dev` were unchanged, and the temporary root was removed.

## 7. Needs attention

1. **`backup.autoEnabled`, `keepDaily` and `keepMonthly` exist in the settings backend but are not editable or used.** Automatic backups follow the approved fixed policy: always on, 14 daily, 12 monthly. The IPC refuses those keys.
2. **`currency.minorDigits` and `invoice.startNumber` are only stored.** Changing minor digits after amounts exist would reinterpret them. It should be locked once prices or invoices exist (Phase 5/8). The UI hint says to set it before entering prices.
3. **When a restore runs:**
   - A restore that stops **before** touching the current database (for example, the pre-restore backup fails) keeps the app running: `RESTORE_FAILED`.
   - Any restore that went further restarts the app, restored or with the previous data put back, rather than continuing on an uncertain state. This covers the damaged path and `ROLLBACK_FAILED`.
4. **Restore is not offered when startup is refused.** For example, with a checksum mismatch the startup dialog still just exits. A recovery screen could come later.
5. **Backup verification runs synchronously in the main process.** For a large database the UI pauses briefly during a backup.
   - If Windows kills StockFlow in the middle of a backup (for example, during a shutdown backup when Windows itself shuts down), a `.tmp` file is left behind. It is never listed as a backup, but it is also never cleaned up.
6. **Relaunch in development mode (`npm run dev`) was not tested.** In the packaged app, the relaunch request and exit 0 were verified by intercepting `app.relaunch`, and the next launch was started with the redirect.
7. **UI tests have no DOM library,** so no new dependency was added. Flows are tested as pure logic plus static renders, and real clicks were verified in the packaged run.
8. **The renderer bundle grew from 1,247 to 1,668 kB,** because Zod and the Radix dialog and radio components are now in it.
9. **On Windows, the Save dialog itself asks "Replace?"** for an existing file. StockFlow then still refuses to replace it and says so.

## 8. Schema confirmation

- The schema is still **1**.
- `src/main/db/migrations` holds only `0001_initial` (with its tests) and `index.ts`, and **there is no 0002**.
- `git diff` of the migrations folder is empty. The checksum `sha256:0cc4eb98…0bee576cc4` is unchanged and recorded by the packaged app.

## 9. Phase 5 not started

- No products, companies, stock, customers, payments, invoices, expenses, reports, dashboard data or printing were added.
- All other sections are still placeholders.
- Nothing was committed.
