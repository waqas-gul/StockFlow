import { existsSync, rmSync } from 'node:fs'
import { win32 } from 'node:path'
import { resolveDataPaths } from '../data-paths'
import { AppFailure } from '../errors'
import { APP_DATA_FOLDER } from '../app-identity'
import type { Logger } from '../logging'
import { initializeDatabase } from './index'
import { migrations } from './migrations'
import { hasBusinessData, seedDemoData } from './seed'

/*
 * The command line behind `npm run seed` (see scripts/seed.mjs, which bundles this file and runs it in
 * Electron's Node so better-sqlite3's prebuilt binary loads).
 *
 * It opens the StockFlow database the same way the app does at startup — the same pragmas, the same
 * migrations, the same checks — then fills it through the services. By default it writes to the development
 * data folder, %APPDATA%\StockFlow-dev, so a real installation is never touched.
 *
 *   npm run seed                    fill %APPDATA%\StockFlow-dev (refuses a database that already has data)
 *   npm run seed -- --reset         delete that database first, then fill a fresh one
 *   npm run seed -- --root=<path>   use another data folder (the database lands in <path>\data)
 *   npm run seed -- --prod          use %APPDATA%\StockFlow instead (asks for --force as well)
 *
 * StockFlow's main process owns the database on its own, so close the app before seeding: Windows keeps the
 * file locked while it runs.
 */

interface Options {
  readonly root: string
  readonly reset: boolean
}

function parseArguments(argv: readonly string[]): Options {
  const flags = new Set(argv.filter((argument) => argument.startsWith('--')))
  const chosenRoot = argv
    .find((argument) => argument.startsWith('--root='))
    ?.slice('--root='.length)
  if (chosenRoot !== undefined && chosenRoot !== '') {
    return { root: win32.resolve(chosenRoot), reset: flags.has('--reset') }
  }
  const production = flags.has('--prod')
  if (production && !flags.has('--force')) {
    throw new Error(
      '--prod writes to the real StockFlow data folder. Add --force if that is what you want.'
    )
  }
  const appData = process.env.APPDATA
  if (appData === undefined || appData === '') {
    throw new Error('APPDATA is not set, so the StockFlow data folder cannot be located.')
  }
  return {
    root: win32.join(appData, production ? APP_DATA_FOLDER : `${APP_DATA_FOLDER}-dev`),
    reset: flags.has('--reset')
  }
}

const consoleLogger: Logger = {
  info: () => {},
  warn: (message) => console.warn(`  ! ${message}`),
  error: (message, error) => console.error(`  ! ${message}`, error)
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const paths = resolveDataPaths(options.root)
  console.log(`StockFlow seed -> ${paths.databaseFile}`)

  if (options.reset) {
    // The WAL and shared-memory files belong to the database and must go with it.
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${paths.databaseFile}${suffix}`
      if (existsSync(file)) rmSync(file)
    }
    console.log('  reset: the old database file was deleted')
  }

  const db = await initializeDatabase({
    paths,
    appVersion: '1.0.0-seed',
    log: consoleLogger,
    migrations,
    now: () => new Date()
  })
  try {
    if (hasBusinessData(db)) {
      throw new Error(
        'This database already holds data. Run `npm run seed -- --reset` to replace it with a fresh demo database.'
      )
    }
    const started = Date.now()
    const summary = seedDemoData(db, { onProgress: (message) => console.log(`  ${message}`) })
    console.log(
      `\nSeeded ${summary.firstDate} to ${summary.lastDate} in ${Date.now() - started} ms\n`
    )
    const width = Math.max(...summary.tables.map((table) => table.table.length))
    for (const { table, rows } of summary.tables) {
      const mark = rows === 0 ? ' <- empty' : ''
      console.log(`  ${table.padEnd(width)}  ${String(rows).padStart(6)}${mark}`)
    }
    const empty = summary.tables.filter((table) => table.rows === 0)
    console.log(
      `\n  ${summary.tables.length - empty.length} of ${summary.tables.length} tables hold rows`
    )
    for (const note of summary.notes) console.log(`  - ${note}`)
    console.log('\nStart the app with `npm run dev` to see it.')
  } finally {
    db.close()
  }
}

main().catch((error: unknown) => {
  console.error(`\nThe seed failed: ${error instanceof Error ? error.message : String(error)}`)
  // A service refusal names the fields it refused, which is what a seed bug almost always comes down to.
  if (error instanceof AppFailure) {
    console.error(`  code: ${error.error.code}`)
    for (const [field, messages] of Object.entries(error.error.fieldErrors ?? {})) {
      console.error(`  ${field}: ${messages.join(' ')}`)
    }
  }
  if (error instanceof Error && error.stack !== undefined) console.error(error.stack)
  process.exitCode = 1
})
