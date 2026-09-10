import { app, session, type WebContents } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'

const rendererIndexUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href.toLowerCase()

/** The app may only show its own document: the Vite dev server in development, the bundled index.html otherwise. */
function isAppUrl(url: string): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && devServerUrl) {
    return target.origin === new URL(devServerUrl).origin
  }

  target.hash = ''
  target.search = ''
  return target.href.toLowerCase() === rendererIndexUrl
}

function hardenWebContents(contents: WebContents): void {
  // V1 has no external links: never open new windows and never hand URLs to the OS.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))

  contents.on('will-navigate', (event) => {
    if (!isAppUrl(event.url)) event.preventDefault()
  })
  contents.on('will-redirect', (event) => {
    if (!isAppUrl(event.url)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

/** Must be called before the app is ready. Applies to every current and future window. */
export function enforceSecurityDefaults(): void {
  app.enableSandbox()
  app.on('web-contents-created', (_, contents) => hardenWebContents(contents))
}

/** Must be called after the app is ready. V1 needs no camera, microphone, notifications, etc. */
export function denyAllPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )
  session.defaultSession.setPermissionCheckHandler(() => false)
}
