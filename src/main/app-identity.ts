// Permanent application identity. Never change these after the first production install:
// the data folder name locates the user's data (and, from Phase 3, the database), and the
// app ID identifies the installed app to Windows and the NSIS installer.
// APP_ID must stay in sync with `appId` in electron-builder.yml.

export const APP_NAME = 'StockFlow'
export const APP_ID = 'com.waqas.stockflow'
export const APP_DATA_FOLDER = 'StockFlow'
