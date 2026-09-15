import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { is, optimizer } from '@electron-toolkit/utils'
import { APP_ID } from './app-identity'
import { initializeDatabase } from './db'
import type { Db } from './db/adapter'
import { migrations } from './db/migrations'
import { registerIpc } from './ipc'
import { createErrorRef, createFileLogger } from './logging'
import { configureUserDataPath, getDataPaths } from './paths'
import { denyAllPermissions, enforceSecurityDefaults, isTrustedIpcSender } from './security'
import { createMainWindow } from './window'

// Order matters: the single-instance lock below is keyed on the userData path.
configureUserDataPath()
enforceSecurityDefaults()

let mainWindow: BrowserWindow | null = null
let database: Db | null = null

// Only one main process may run. It is the sole owner of the SQLite database and of the log file.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  const paths = getDataPaths()
  // The technical log (<data-root>\logs\app.log): main process only. User folders are replaced by placeholders.
  const log = createFileLogger({
    file: paths.logFile,
    redact: [
      [app.getPath('appData'), '%APPDATA%'],
      [app.getPath('home'), '%USERPROFILE%']
    ],
    echo: (entry, level) => {
      if (level === 'INFO') console.log(entry.trimEnd())
      else console.error(entry.trimEnd())
    }
  })
  // Observes uncaught exceptions without changing how Electron handles them.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    log.error('[main] uncaught exception', error, { origin })
  })

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID)
    denyAllPermissions()
    log.info('StockFlow starting', {
      version: app.getVersion(),
      mode: is.dev ? 'development' : 'production',
      electron: process.versions.electron
    })

    // Production has no menu, so no reload or developer-tools accelerators.
    if (!is.dev) Menu.setApplicationMenu(null)

    // F12 toggles DevTools in development; reload shortcuts are ignored in production.
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // The database is opened and migrated before any window exists; IPC is served only after that.
    try {
      database = await initializeDatabase({
        paths,
        appVersion: app.getVersion(),
        log,
        migrations,
        now: () => new Date()
      })
    } catch (error) {
      const ref = createErrorRef()
      log.error('[startup] the database could not be opened', error, { ref })
      const reason = error instanceof Error ? error.message : String(error)
      dialog.showErrorBox(
        'StockFlow cannot start',
        `The database could not be opened.\n\n${reason}\n\nReference: ${ref} (the details are in the StockFlow log file).`
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
      { isTrustedSender: isTrustedIpcSender, log }
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
    log.info('StockFlow stopped: the database was closed')
  })
}
