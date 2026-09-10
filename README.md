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

### Development

```bash
$ npm run dev
```

Development runs store their data in `%APPDATA%\StockFlow-dev`; installed builds use `%APPDATA%\StockFlow`.

### Build

```bash
# Windows installer (NSIS)
$ npm run build:win

# Unpacked build for local testing
$ npm run build:unpack
```
