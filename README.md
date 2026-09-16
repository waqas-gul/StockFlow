# StockFlow

Offline shop and stock management desktop application for Windows (Electron, React and TypeScript).

Planning and phase reports live in `development-docs-workthorgh/shop-management-v1-plan/`.

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

No C++ build tools are needed. `better-sqlite3` (pinned to 12.11.1) installs a prebuilt binary, and
`postinstall` (`electron-builder install-app-deps`) replaces it with the prebuilt binary for Electron's ABI.
Both are downloaded from GitHub, so the developer or build machine needs internet access whenever it installs
or rebuilds the native dependencies. The packaged StockFlow installer and app already contain the native
binary: installing and running StockFlow needs no internet. If the driver is ever rebuilt for plain Node.js
(for example by `npm rebuild`), run `npm run postinstall` again.

### Development

```bash
$ npm run dev
```

Development runs store their data in `%APPDATA%\StockFlow-dev`; installed builds use `%APPDATA%\StockFlow`.
The database is `data\shop.db` inside that folder. On first start the app creates it and applies the schema
migrations in `src/main/db/migrations` (currently schema version 1, `0001_initial`).

The same folder holds the technical log, `logs\app.log` (rotated at about 5 MB, with three older copies), and
the verified backups in `backups\auto`, `backups\pre-migration` and `backups\pre-restore`. Before a migration
changes a database that holds data, a verified backup is written to `backups\pre-migration`; if it fails, the
migration does not run.

Settings → Backup & Restore makes backups at any time ("Backup Now", saved wherever the user chooses, for example a
USB drive) and restores a backup after a typed confirmation, then restarts StockFlow. Automatic backups are made on
the first use of each day and at a normal quit (at most one an hour) in `backups\auto`. `backups\backup-status.json`
records the last manual backup, the last failed automatic backup and the last restore; it holds no business data.

When a backup is restored over a damaged database (one that fails its checks, so it cannot have a verified backup),
the damaged database is moved unchanged to `recovery\damaged-live-db_<date>_<time>.db`, with its `-wal` and `-shm`
files. These files are not backups: they are kept only in case a specialist needs them. StockFlow also refuses to
start with a database whose recorded migration checksums differ from its own, and changes nothing in it.

When normal startup refuses the database because it is damaged or cannot be verified (corruption, a failed integrity
or foreign key check, a checksum mismatch, a file that is not StockFlow's), a native dialog offers **Restore Backup**
or **Exit** before any window opens. The chosen backup is validated and summarized, the restore needs a ticked
confirmation, and StockFlow relaunches afterwards; it uses the same restore engine as Settings. At startup, temporary
files that an interrupted backup left in `backups\auto`, `pre-migration` or `pre-restore` (StockFlow backup names
ending in `.db.tmp` or `.json.tmp`, older than an hour) are removed. The currency's decimal places (minor digits) can
no longer change once any amount has been entered: amounts are stored as whole minor units.

### Tests

```bash
$ npm test
$ npm run test:coverage
```

The tests run Vitest inside Electron's own Node.js (`scripts/vitest-electron.mjs`), because the database
driver is built for Electron. A plain `npx vitest` (or an editor's test runner) cannot load it.

### Build

```bash
# Windows installer (NSIS)
$ npm run build:win

# Unpacked build for local testing
$ npm run build:unpack
```
