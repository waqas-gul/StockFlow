// Runs Vitest inside Electron's own Node.js runtime (ELECTRON_RUN_AS_NODE=1).
//
// `postinstall` (electron-builder install-app-deps) installs better-sqlite3's prebuilt binary for Electron's
// ABI, which plain Node.js cannot load. Running the tests in Electron's Node also means they exercise exactly
// the runtime and native binary of the app's main process.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
// Required from Node.js, the electron package exports the path of the Electron executable.
const electron = require('electron')
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')

const child = spawn(electron, [vitest, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})

child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
