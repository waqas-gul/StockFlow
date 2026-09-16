import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupFolder } from '../data-paths'
import { formatBackupFileName } from '../db/backup-files'
import { TEST_APP_VERSION, TEST_TIME, createTempDir, type TempDir } from '../db/test-utils'
import { verifyDatabaseFile } from '../db/verify'
import { AppFailure } from '../errors'
import { BackupStatusStore, backupFailureMessage } from './backup-status'
import { createServicesFixture, type ServicesFixture } from './test-utils'

const SUGGESTED = formatBackupFileName(TEST_TIME, TEST_APP_VERSION, 1)
const INSIDE_DATA_FOLDER =
  'Choose a folder outside the StockFlow data folder, such as a USB drive, a second drive or your Documents folder.'

let temp: TempDir
let fixture: ServicesFixture
let failBackups: boolean

beforeEach(async () => {
  temp = createTempDir()
  failBackups = false
  fixture = await createServicesFixture(temp, {
    faults: {
      afterBackupCopy: () => {
        if (failBackups) throw new Error('simulated disk failure')
      }
    }
  })
})

afterEach(() => {
  temp.remove()
})

/** `<temp>\usb`: stands for a USB drive, outside the StockFlow data root `<temp>\StockFlow`. */
function usb(name = ''): string {
  return name === '' ? temp.file('usb') : temp.file(`usb\\${name}`)
}

function listing(folder: string): string[] {
  return existsSync(folder) ? readdirSync(folder).sort() : []
}

async function failure(attempt: Promise<unknown>): Promise<AppFailure['error']> {
  const error = await attempt.then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(AppFailure)
  return (error as AppFailure).error
}

describe('BackupService.createManual (Backup Now)', () => {
  it('opens the Save dialog in Documents with a StockFlow backup name, and changes nothing when cancelled', async () => {
    await expect(fixture.backups.createManual()).resolves.toEqual({ status: 'CANCELLED' })
    expect(fixture.dialogs.saveRequests).toEqual([win32.join(fixture.documentsDir, SUGGESTED)])
    expect(listing(fixture.documentsDir)).toEqual([])
    expect(fixture.status.record.lastManual).toBeNull()
    expect(fixture.lock.current).toBeNull()
  })

  it('writes a verified backup exactly where the user chose, with its sidecar', async () => {
    fixture.dialogs.saveAnswers.push(usb('my shop backup.db'))
    await expect(fixture.backups.createManual()).resolves.toEqual({
      status: 'CREATED',
      backup: { at: TEST_TIME.toISOString(), fileName: 'my shop backup.db', location: usb() }
    })
    expect(listing(usb())).toEqual(['my shop backup.db', 'my shop backup.json'])
    expect(verifyDatabaseFile(usb('my shop backup.db')).schemaVersion).toBe(1)
    expect(fixture.ctx.log.entries).toContainEqual({
      level: 'INFO',
      message: '[backup] manual backup saved',
      context: { file: 'my shop backup.db' }
    })
    // The log names files, never the folder the user chose.
    expect(JSON.stringify(fixture.ctx.log.entries)).not.toContain(usb().replaceAll('\\', '\\\\'))
  })

  it('adds .db when the chosen name has no extension', async () => {
    fixture.dialogs.saveAnswers.push(usb('shop-copy'))
    await expect(fixture.backups.createManual()).resolves.toMatchObject({
      backup: { fileName: 'shop-copy.db' }
    })
    expect(verifyDatabaseFile(usb('shop-copy.db')).schemaVersion).toBe(1)
  })

  it('remembers the last manual backup across restarts and opens the next dialog in its folder', async () => {
    fixture.dialogs.saveAnswers.push(usb('first.db'))
    await fixture.backups.createManual()
    expect(new BackupStatusStore(fixture.ctx.paths, fixture.ctx.log).record.lastManual).toEqual({
      at: TEST_TIME.toISOString(),
      fileName: 'first.db',
      folder: usb()
    })
    await fixture.backups.createManual()
    expect(fixture.dialogs.saveRequests[1]).toBe(win32.join(usb(), SUGGESTED))
    rmSync(usb(), { recursive: true })
    await fixture.backups.createManual()
    expect(fixture.dialogs.saveRequests[2]).toBe(win32.join(fixture.documentsDir, SUGGESTED))
  })

  it('refuses a location inside the StockFlow data folder, where it could be mistaken for live data', async () => {
    const { paths } = fixture.ctx
    for (const file of [
      win32.join(paths.dataDir, 'copy.db'),
      win32.join(backupFolder(paths, 'auto'), 'copy.db'),
      win32.join(paths.root, 'copy.db')
    ]) {
      fixture.dialogs.saveAnswers.push(file)
      expect(await failure(fixture.backups.createManual())).toEqual({
        code: 'BACKUP_FAILED',
        message: INSIDE_DATA_FOLDER
      })
      expect(existsSync(file)).toBe(false)
    }
    expect(fixture.status.record.lastManual).toBeNull()
  })

  it('refuses a location that is not an absolute path', async () => {
    fixture.dialogs.saveAnswers.push('relative\\copy.db')
    expect(await failure(fixture.backups.createManual())).toMatchObject({ code: 'BACKUP_FAILED' })
  })

  it('never replaces an existing file', async () => {
    mkdirSync(usb(), { recursive: true })
    writeFileSync(usb('taken.db'), 'a file of the user')
    fixture.dialogs.saveAnswers.push(usb('taken.db'))
    expect(await failure(fixture.backups.createManual())).toEqual({
      code: 'BACKUP_FAILED',
      message: backupFailureMessage('DESTINATION_EXISTS')
    })
    expect(readFileSync(usb('taken.db'), 'utf8')).toBe('a file of the user')
  })

  it('reports a failed backup in plain words, leaves nothing behind, and can be tried again', async () => {
    failBackups = true
    fixture.dialogs.saveAnswers.push(usb('copy.db'))
    expect(await failure(fixture.backups.createManual())).toEqual({
      code: 'BACKUP_FAILED',
      message: backupFailureMessage('COPY_FAILED')
    })
    expect(listing(usb())).toEqual([])
    expect(fixture.lock.current).toBeNull()
    failBackups = false
    fixture.dialogs.saveAnswers.push(usb('copy.db'))
    await expect(fixture.backups.createManual()).resolves.toMatchObject({ status: 'CREATED' })
  })

  it('refuses a second Backup Now while the first is running (a double click)', async () => {
    fixture.dialogs.saveAnswers.push(usb('first.db'))
    const first = fixture.backups.createManual()
    const second = fixture.backups.createManual()
    expect(await failure(second)).toEqual({
      code: 'FORBIDDEN_STATE',
      message: 'A backup is already being made. Wait until it is finished.'
    })
    await expect(first).resolves.toMatchObject({ status: 'CREATED' })
    expect(fixture.dialogs.saveRequests).toHaveLength(1)
  })

  it('is refused while a restore runs', async () => {
    fixture.database.beginRestore()
    expect(await failure(fixture.backups.createManual())).toEqual({
      code: 'FORBIDDEN_STATE',
      message: 'A restore is in progress. Wait until it is finished.'
    })
    expect(fixture.dialogs.saveRequests).toEqual([])
  })
})

describe('BackupService.openFolder', () => {
  it('opens the automatic backup folder, creating it when needed', async () => {
    const folder = backupFolder(fixture.ctx.paths, 'auto')
    rmSync(folder, { recursive: true })
    await fixture.backups.openFolder()
    expect(fixture.opened).toEqual([folder])
    expect(existsSync(folder)).toBe(true)
  })
})

describe('BackupService.status', () => {
  it('reports the automatic and manual backups and whether an operation is running', async () => {
    expect(fixture.backups.status()).toMatchObject({
      health: 'NONE',
      lastManual: null,
      busy: false
    })
    fixture.dialogs.saveAnswers.push(usb('copy.db'))
    await fixture.backups.createManual()
    await fixture.automatic.runIfDue('LAUNCH')
    expect(fixture.backups.status()).toMatchObject({
      health: 'OK',
      lastAutomatic: { fileName: SUGGESTED },
      lastManual: { fileName: 'copy.db', location: usb() },
      busy: false
    })
    let release!: () => void
    const running = fixture.lock.run(
      'AUTOMATIC_BACKUP',
      () => new Promise<void>((resolve) => (release = resolve))
    )
    expect(fixture.backups.status().busy).toBe(true)
    release()
    await running
  })
})
