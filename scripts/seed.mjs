// Runs a database command-line tool in Electron's own Node.js runtime.
//
//   node scripts/seed.mjs [args]             fills a development database with demo data (`npm run seed`)
//   node scripts/seed.mjs --verify <root>    runs the integrity report over a seeded database
//
// The tools are TypeScript that imports the main-process services, so each is bundled with esbuild (already
// here as a Vite dependency) and then run with ELECTRON_RUN_AS_NODE=1, exactly as the tests are: `postinstall`
// installs better-sqlite3's prebuilt binary for Electron's ABI, which plain Node.js cannot load.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
// Required from Node.js, the electron package exports the path of the Electron executable.
const electron = require('electron')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const verify = args[0] === '--verify'
const entry = verify ? 'src/main/db/seed-verify.ts' : 'src/main/db/seed-cli.ts'

// The bundle stays inside the project (out/ is gitignored) so that `require('better-sqlite3')` at run time
// resolves against the project's node_modules and finds the binary built for Electron's ABI.
const outDir = join(root, 'out', 'seed')
const bundle = join(outDir, 'tool.cjs')
mkdirSync(outDir, { recursive: true })

try {
  await build({
    entryPoints: [join(root, entry)],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: 'inline',
    // The same alias electron.vite.config.ts gives the main process.
    alias: { '@shared': join(root, 'src/shared') },
    // Loaded from node_modules at run time: its native binding cannot be bundled.
    external: ['better-sqlite3', 'electron']
  })

  const child = spawn(electron, [bundle, ...(verify ? args.slice(1) : args)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  await new Promise((done) => {
    child.on('exit', (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0)
      done()
    })
  })
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
