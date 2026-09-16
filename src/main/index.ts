import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { is, optimizer } from '@electron-toolkit/utils'
import { APP_ID } from './app-identity'
import { initializeDatabase } from './db'
import type { Db } from './db/adapter'
import type { DataSafetyContext } from './db/context'
import { migrations } from './db/migrations'
import { createBackupDialogs, openFolderInExplorer, relaunchApp } from './desktop'
import { registerIpc } from './ipc'
import { createErrorRef, createFileLogger } from './logging'
import { configureUserDataPath, getDataPaths } from './paths'
import { denyAllPermissions, enforceSecurityDefaults, isTrustedIpcSender } from './security'
import { AutomaticBackups } from './services/auto-backup'
import { BackupStatusStore } from './services/backup-status'
import { BackupService } from './services/backup.service'
import { LiveDatabase } from './services/live-database'
import { OperationLock } from './services/operation-lock'
import { RestoreService } from './services/restore.service'
import { createMainWindow } from './window'

// Order matters: the single-instance lock below is keyed on the userData path.
configureUserDataPath()
enforceSecurityDefaults()

/** After a restore, StockFlow restarts once the renderer has had time to show the result. */
const RESTART_DELAY_MS = 2_500

let mainWindow: BrowserWindow | null = null
let database: LiveDatabase | null = null
let automaticBackups: AutomaticBackups | null = null
/** Quitting has started: the shutdown backup is made once. */
let quitting = false
/** Start StockFlow again once it has quit: after a restore, or when it was started again while closing. */
let relaunchOnQuit = false

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

  // After a restore: the renderer shows the result, then StockFlow relaunches and opens the database in place.
  const restartAfterRestore = (): void => {
    automaticBackups?.stop()
    relaunchOnQuit = true
    setTimeout(() => {
      log.info('StockFlow restarts after a restore')
      relaunchApp()
    }, RESTART_DELAY_MS)
  }

  app.on('second-instance', () => {
    // Started again while closing (during the shutdown backup): start again once this instance has quit.
    if (quitting) {
      relaunchOnQuit = true
      return
    }
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
    const ctx: DataSafetyContext = {
      paths,
      appVersion: app.getVersion(),
      log,
      migrations,
      now: () => new Date()
    }
    let db: Db
    try {
      db = await initializeDatabase(ctx)
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

    // Settings → Backup & Restore. Backups and restores never overlap (OperationLock), and the database is
    // refused to every request while a restore runs or StockFlow restarts (LiveDatabase).
    database = new LiveDatabase(db)
    const lock = new OperationLock()
    const status = new BackupStatusStore(paths, log)
    const dialogs = createBackupDialogs(() => mainWindow)
    automaticBackups = new AutomaticBackups({ ctx, database, lock, status })
    const backups = new BackupService({
      ctx,
      database,
      lock,
      status,
      dialogs,
      openFolder: openFolderInExplorer,
      documentsDir: app.getPath('documents'),
      appDataPath: app.getPath('appData'),
      homePath: app.getPath('home')
    })
    const restore = new RestoreService({
      ctx,
      database,
      lock,
      status,
      dialogs,
      restart: restartAfterRestore
    })

    registerIpc(
      ipcMain,
      {
        appInfo: {
          appVersion: app.getVersion(),
          isDev: is.dev,
          dataDir: paths.dataDir,
          appDataPath: app.getPath('appData')
        },
        database,
        backups,
        restore,
        ctx
      },
      { isTrustedSender: isTrustedIpcSender, log }
    )

    mainWindow = createMainWindow()
    mainWindow.on('closed', () => {
      mainWindow = null
    })

    // The first launch or use of a day makes an automatic backup; it never blocks the app.
    automaticBackups.start()
  })

  // Windows only: closing the last window quits the app.
  app.on('window-all-closed', () => {
    app.quit()
  })

  // A normal quit first makes the shutdown backup (at most one an hour; it never blocks quitting for long), then
  // closes the connection last, which checkpoints the WAL into shop.db. The restart after a restore uses app.exit,
  // which skips this.
  app.on('will-quit', (event) => {
    if (!quitting && automaticBackups !== null) {
      quitting = true
      event.preventDefault()
      void automaticBackups.runAtShutdown().finally(() => app.quit())
      return
    }
    quitting = true
    try {
      database?.close()
    } catch (error) {
      log.error('[main] the database could not be closed', error)
    }
    database = null
    log.info('StockFlow stopped: the database was closed')
    if (relaunchOnQuit) app.relaunch()
  })
}
