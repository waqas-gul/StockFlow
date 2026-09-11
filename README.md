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

No C++ build tools are needed. `better-sqlite3` installs a prebuilt binary, and `postinstall`
(`electron-builder install-app-deps`) replaces it with the prebuilt binary for Electron's ABI. Both are
downloaded from GitHub, so the first install needs internet access. If the driver is ever rebuilt for plain
Node.js (for example by `npm rebuild`), run `npm run postinstall` again.

### Development

```bash
$ npm run dev
```

Development runs store their data in `%APPDATA%\StockFlow-dev`; installed builds use `%APPDATA%\StockFlow`.
The database is `data\shop.db` inside that folder.

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
