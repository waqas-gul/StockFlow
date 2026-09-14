import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { is, optimizer } from '@electron-toolkit/utils'
import { APP_ID } from './app-identity'
import { initializeDatabase } from './db'
import type { Db } from './db/adapter'
import { registerIpc } from './ipc'
import { configureUserDataPath, getDataPaths } from './paths'
import { denyAllPermissions, enforceSecurityDefaults, isTrustedIpcSender } from './security'
import { createMainWindow } from './window'

// Order matters: the single-instance lock below is keyed on the userData path.
configureUserDataPath()
enforceSecurityDefaults()

let mainWindow: BrowserWindow | null = null
let database: Db | null = null

// Only one main process may run. It is the sole owner of the SQLite database.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID)
    denyAllPermissions()

    // Production has no menu, so no reload or developer-tools accelerators.
    if (!is.dev) Menu.setApplicationMenu(null)

    // F12 toggles DevTools in development; reload shortcuts are ignored in production.
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // The database is opened and migrated before any window exists; IPC is served only after that.
    const paths = getDataPaths()
    try {
      database = await initializeDatabase(paths.databaseFile, { appVersion: app.getVersion() })
    } catch (error) {
      console.error('[startup] The database could not be opened.', error)
      const reason = error instanceof Error ? error.message : String(error)
      dialog.showErrorBox(
        'StockFlow cannot start',
        `The database could not be opened.\n\n${reason}`
      )
      app.exit(1)
      return
    }

    registerIpc(
      ipcMain,
      {
        appInfo: {
          db: database,
          appVersion: app.getVersion(),
          isDev: is.dev,
          dataDir: paths.dataDir,
          appDataPath: app.getPath('appData')
        }
      },
      {
        isTrustedSender: isTrustedIpcSender,
        logError: (message, error) => console.error(message, error)
      }
    )

    mainWindow = createMainWindow()
    mainWindow.on('closed', () => {
      mainWindow = null
    })
  })

  // Windows only: closing the last window quits the app.
  app.on('window-all-closed', () => {
    app.quit()
  })

  // The connection closes last, after every window is gone, which checkpoints the WAL into shop.db.
  app.on('will-quit', () => {
    database?.close()
    database = null
  })
}
