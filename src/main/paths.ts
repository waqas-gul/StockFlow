import { app } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { APP_DATA_FOLDER } from './app-identity'
import { resolveDataPaths, type DataPaths } from './data-paths'

/**
 * Pins Electron's userData directory to %APPDATA%\StockFlow, independent of the package
 * name or productName, and sends development runs to %APPDATA%\StockFlow-dev so they can
 * never touch production data.
 *
 * Must run before the app is ready and before `app.requestSingleInstanceLock()`, because
 * the lock is keyed on the userData path. Creates no application files itself.
 */
export function configureUserDataPath(): string {
  const folder = is.dev ? `${APP_DATA_FOLDER}-dev` : APP_DATA_FOLDER
  const userDataPath = join(app.getPath('appData'), folder)
  app.setPath('userData', userDataPath)
  return userDataPath
}

/** The data folder and database file under the pinned userData folder (`<userData>\data\shop.db`). */
export function getDataPaths(): DataPaths {
  return resolveDataPaths(app.getPath('userData'))
}
