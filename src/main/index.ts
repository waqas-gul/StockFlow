import { app, BrowserWindow, Menu } from 'electron'
import { is, optimizer } from '@electron-toolkit/utils'
import { APP_ID } from './app-identity'
import { configureUserDataPath } from './paths'
import { denyAllPermissions, enforceSecurityDefaults } from './security'
import { createMainWindow } from './window'

// Order matters: the single-instance lock below is keyed on the userData path.
configureUserDataPath()
enforceSecurityDefaults()

let mainWindow: BrowserWindow | null = null

// Only one main process may run. From Phase 3 it is the sole owner of the SQLite database.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID)
    denyAllPermissions()

    // Production has no menu, so no reload or developer-tools accelerators.
    if (!is.dev) Menu.setApplicationMenu(null)

    // F12 toggles DevTools in development; reload shortcuts are ignored in production.
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    mainWindow = createMainWindow()
    mainWindow.on('closed', () => {
      mainWindow = null
    })
  })

  // Windows only: closing the last window quits the app.
  app.on('window-all-closed', () => {
    app.quit()
  })
}
