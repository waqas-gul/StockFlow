import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createTempDir, type TempDir } from './db/test-utils'
import { createIpcHandler } from './ipc/handle'
import {
  LOG_KEEP_FILES,
  LOG_MAX_BYTES,
  createErrorRef,
  createFileLogger,
  errorCodeOf,
  type FileLoggerOptions,
  type Logger
} from './logging'

const TIME = new Date('2026-09-14T10:30:45.123Z')
const STAMP = '2026-09-14T10:30:45.123Z'

let temp: TempDir

beforeEach(() => {
  temp = createTempDir()
})

afterEach(() => {
  vi.restoreAllMocks()
  temp.remove()
})

function logPath(suffix = ''): string {
  return temp.file(`logs\\app.log${suffix}`)
}

function readLog(suffix = ''): string {
  return readFileSync(logPath(suffix), 'utf8')
}

function fileLogger(options: Partial<FileLoggerOptions> = {}): Logger {
  return createFileLogger({ file: logPath(), now: () => TIME, ...options })
}

/** One 85-byte entry: 39 bytes of time, level and message, 45 of context, and the line break. */
function padded(log: Logger, message: string): void {
  log.info(message, { pad: 'x'.repeat(40) })
}

describe('createFileLogger: entries', () => {
  it('creates the logs folder and writes one line per entry: UTC time, level, message, context', () => {
    const log = fileLogger()
    log.info('StockFlow starting', { version: '1.0.0', dev: false, schema: 1, ref: null })
    log.warn('[backup] the sidecar could not be written', { file: 'stockflow-backup_x.db' })
    log.error('[startup] no details')
    expect(readLog()).toBe(
      `${STAMP} INFO  StockFlow starting version=1.0.0 dev=false schema=1 ref=null\n` +
        `${STAMP} WARN  [backup] the sidecar could not be written file=stockflow-backup_x.db\n` +
        `${STAMP} ERROR [startup] no details\n`
    )
  })

  it('quotes context values that contain spaces, quotes or equals signs', () => {
    fileLogger().info('probe', { reason: 'disk full', text: 'a="b"', empty: '' })
    expect(readLog()).toBe(`${STAMP} INFO  probe reason="disk full" text="a=\\"b\\"" empty=""\n`)
  })

  it('writes an unexpected error with its reference, its message and its stack trace', () => {
    fileLogger().error('[ipc] app:info failed', new Error('boom'), { ref: 'ABC123' })
    const [header, first, second] = readLog().split('\n')
    expect(header).toBe(`${STAMP} ERROR [ipc] app:info failed ref=ABC123`)
    expect(first).toBe('  Error: boom')
    expect(second).toMatch(/^ {6}at .*logging\.test\.ts/)
  })

  it('writes the error code and the chain of causes', () => {
    const cause = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR_WRITE' })
    fileLogger().error('[backup] failed', new Error('The backup copy failed', { cause }))
    const text = readLog()
    expect(text).toContain('\n  Error: The backup copy failed\n')
    expect(text).toContain('\n  Caused by: Error: disk I/O error\n')
    expect(text).toContain('\n  code: SQLITE_IOERR_WRITE\n')
  })

  it('writes an error without a stack as its name and message', () => {
    const error = new Error('no stack here')
    error.stack = undefined
    fileLogger().error('failed', error)
    expect(readLog()).toBe(`${STAMP} ERROR failed\n  Error: no stack here\n`)
  })

  it('stops following causes after a few levels, even for a cycle', () => {
    const first = new Error('first')
    const second = new Error('second', { cause: first })
    Object.assign(first, { cause: second })
    fileLogger().error('cycle', first)
    const text = readLog()
    expect(text.match(/Caused by: Error/g)).toHaveLength(4)
    expect(text).toContain('  Caused by: … (further causes are not logged)\n')
  })

  it('logs a thrown string or primitive, but never the contents of a thrown object', () => {
    const log = fileLogger()
    log.error('text', 'plain text failure')
    log.error('number', 42)
    log.error('nothing', null)
    log.error('object', { customer: 'Ali Traders' })
    log.error('array', ['Ali Traders'])
    const text = readLog()
    expect(text).toContain('\n  Thrown string: plain text failure\n')
    expect(text).toContain('\n  Thrown value: 42\n')
    expect(text).toContain('\n  Thrown value: null\n')
    expect(text).toContain('\n  Thrown Object value; its contents are not logged.\n')
    expect(text).toContain('\n  Thrown Array value; its contents are not logged.\n')
    expect(text).not.toContain('Ali')
  })

  it('never serializes the other properties of an error, such as a request payload', () => {
    const payload = {
      customer: { name: 'Ali Traders', phone: '0300-1234567' },
      amountMinor: 987654
    }
    const error = Object.assign(new Error('Invoice could not be saved'), {
      payload,
      details: payload,
      input: payload
    })
    fileLogger().error('[ipc] invoices:create failed', error, { ref: 'F00D42' })
    const text = readLog()
    expect(text).toContain('Invoice could not be saved')
    expect(text).not.toMatch(/Ali|0300|987654|customer|amountMinor|payload/)
  })

  it('keeps each entry on one line, so control characters cannot forge an entry', () => {
    fileLogger().warn(`refused\n${STAMP} ERROR forged`, {
      sender: 'https://evil.example/\r\nERROR forged'
    })
    const lines = readLog().split('\n').filter(Boolean)
    expect(lines).toEqual([
      `${STAMP} WARN  refused ${STAMP} ERROR forged sender="https://evil.example/  ERROR forged"`
    ])
  })

  it('indents every line of an error, so a message with line breaks cannot forge an entry', () => {
    fileLogger().error('failed', new Error(`first\n${STAMP} ERROR forged`))
    const lines = readLog().split('\n').filter(Boolean)
    expect(lines.filter((line) => line.startsWith(STAMP))).toHaveLength(1)
    expect(lines.slice(1).every((line) => line.startsWith('  '))).toBe(true)
  })

  it('shortens very long messages and context values', () => {
    fileLogger().info('m'.repeat(2000), { value: 'v'.repeat(2000) })
    const [line] = readLog().split('\n')
    expect(line.length).toBeLessThan(1000)
    expect(line).toContain('m…')
    expect(line).toContain('v…')
  })

  it('shortens a huge error to a bounded entry', () => {
    fileLogger().error('huge', new Error('e'.repeat(100_000)))
    const text = readLog()
    expect(text.length).toBeLessThan(20_000)
    expect(text.endsWith('  … (entry truncated)\n')).toBe(true)
  })

  it('replaces the user folders with placeholders, in either slash style and any letter case', () => {
    const log = fileLogger({
      redact: [
        ['C:\\Users\\owner', '%USERPROFILE%'],
        ['C:\\Users\\owner\\AppData\\Roaming\\', '%APPDATA%']
      ]
    })
    log.error(
      '[startup] failed',
      new Error(
        "ENOENT: no such file, open 'c:\\users\\OWNER\\AppData\\Roaming\\StockFlow\\data\\shop.db'"
      ),
      { url: 'file:///C:/Users/owner/Desktop/StockFlow.html' }
    )
    const text = readLog()
    expect(text).not.toMatch(/owner/i)
    expect(text).toContain("open '%APPDATA%\\StockFlow\\data\\shop.db'")
    expect(text).toContain('url=file:///%USERPROFILE%/Desktop/StockFlow.html')
  })

  it('redacts only whole folder names, and ignores a folder too short to redact safely', () => {
    const log = fileLogger({
      redact: [
        ['C:\\Users\\owner', '%USERPROFILE%'],
        ['C:\\', '%DRIVE%']
      ]
    })
    log.info('paths', {
      other: 'C:\\Users\\owner2\\notes.txt',
      mine: 'C:\\Users\\owner\\notes.txt'
    })
    expect(readLog()).toContain('other=C:\\Users\\owner2\\notes.txt mine=%USERPROFILE%\\notes.txt')
  })
})

describe('createFileLogger: rotation', () => {
  it('keeps app.log under the size limit and rotates it to app.log.1, .2 and .3, dropping the oldest', () => {
    const log = fileLogger({ maxBytes: 200 })
    for (let index = 1; index <= 20; index++) padded(log, `entry ${String(index).padStart(2, '0')}`)
    expect(readdirSync(temp.file('logs')).sort()).toEqual([
      'app.log',
      'app.log.1',
      'app.log.2',
      'app.log.3'
    ])
    const files = ['', '.1', '.2', '.3'].map((suffix) => readLog(suffix))
    for (const text of files) expect(Buffer.byteLength(text)).toBeLessThanOrEqual(200)
    const entries = files.map((text) => text.match(/entry \d+/g))
    expect(entries).toEqual([
      ['entry 19', 'entry 20'],
      ['entry 17', 'entry 18'],
      ['entry 15', 'entry 16'],
      ['entry 13', 'entry 14']
    ])
  })

  it('counts an existing app.log, so a restarted app still rotates at the limit', () => {
    mkdirSync(temp.file('logs'))
    writeFileSync(logPath(), 'previous run\n'.repeat(12))
    padded(fileLogger({ maxBytes: 200 }), 'entry after restart')
    expect(readLog('.1')).toBe('previous run\n'.repeat(12))
    expect(readLog()).toContain('entry after restart')
  })

  it('writes an entry larger than the limit on its own instead of rotating in a loop', () => {
    const log = fileLogger({ maxBytes: 50 })
    log.info('first', { pad: 'x'.repeat(60) })
    log.info('second', { pad: 'y'.repeat(60) })
    expect(readLog('.1')).toContain('first')
    expect(readLog()).toContain('second')
    expect(readLog()).not.toContain('first')
  })

  it('uses 5 MB files and three rotated copies by default', () => {
    expect(LOG_MAX_BYTES).toBe(5 * 1024 * 1024)
    expect(LOG_KEEP_FILES).toBe(3)
  })
})

describe('createFileLogger: failures', () => {
  it('never throws when the log file cannot be written, and reports the failure once', () => {
    mkdirSync(logPath(), { recursive: true })
    const failures: unknown[] = []
    const log = fileLogger({ onWriteError: (error) => failures.push(error) })
    expect(() => {
      log.info('a')
      log.warn('b')
      log.error('c', new Error('d'))
    }).not.toThrow()
    expect(failures).toHaveLength(1)
  })

  it('keeps writing to app.log when rotation fails, and reports that once', () => {
    // Rotation cannot remove the oldest copy when it is a folder that holds a file.
    mkdirSync(logPath('.3'), { recursive: true })
    writeFileSync(`${logPath('.3')}\\keep.txt`, 'x')
    const failures: unknown[] = []
    const log = fileLogger({ maxBytes: 100, onWriteError: (error) => failures.push(error) })
    for (let index = 0; index < 4; index++) padded(log, `entry ${index}`)
    expect(readLog().match(/entry \d/g)).toHaveLength(4)
    expect(failures).toHaveLength(1)
  })

  it('reports a new write failure after the log has recovered', () => {
    const failures: unknown[] = []
    const log = fileLogger({ onWriteError: (error) => failures.push(error) })
    mkdirSync(logPath(), { recursive: true })
    log.info('fails: app.log is a folder')
    rmSync(logPath(), { recursive: true })
    log.info('written')
    rmSync(logPath())
    mkdirSync(logPath())
    log.info('fails again')
    expect(failures).toHaveLength(2)
  })

  it('reports to the console by default', () => {
    const console = vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined)
    mkdirSync(logPath(), { recursive: true })
    fileLogger().info('cannot be written')
    expect(console).toHaveBeenCalledWith(
      '[logging] The log file could not be written.',
      expect.any(Error)
    )
  })

  it('echoes each entry, for example to the development console', () => {
    const echoed: string[] = []
    fileLogger({ echo: (entry, level) => echoed.push(`${level}|${entry}`) }).warn('probe')
    expect(echoed).toEqual([`WARN|${STAMP} WARN  probe\n`])
  })

  it('stamps entries with the current time when no clock is given', () => {
    const before = new Date().toISOString()
    createFileLogger({ file: logPath() }).info('now')
    const stamp = readLog().slice(0, 24)
    expect(stamp >= before && stamp <= new Date().toISOString()).toBe(true)
  })
})

describe('errorCodeOf', () => {
  it('is the string code of a Node.js or SQLite error, otherwise null', () => {
    expect(errorCodeOf(Object.assign(new Error('busy'), { code: 'EBUSY' }))).toBe('EBUSY')
    expect(errorCodeOf(Object.assign(new Error('odd'), { code: 42 }))).toBeNull()
    expect(errorCodeOf(new Error('plain'))).toBeNull()
    expect(errorCodeOf('text')).toBeNull()
    expect(errorCodeOf(null)).toBeNull()
  })
})

describe('createErrorRef', () => {
  it('is six upper-case hexadecimal digits and differs between calls', () => {
    const refs = new Set(Array.from({ length: 20 }, () => createErrorRef()))
    for (const ref of refs) expect(ref).toMatch(/^[0-9A-F]{6}$/)
    expect(refs.size).toBeGreaterThan(15)
  })
})

describe('IPC error references in the log file', () => {
  it('logs the reference the renderer shows with the real error and stack, never the request input', async () => {
    const handler = createIpcHandler(
      'test:fail',
      {
        input: z.strictObject({ name: z.string() }),
        run: () => {
          throw new Error('SQLITE_BUSY: database is locked')
        }
      },
      { isTrustedSender: () => true, log: fileLogger() }
    )
    const result = await handler({} as IpcMainInvokeEvent, { name: 'Ali Traders' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe(`Something went wrong. (ref: ${result.error.ref})`)
    const text = readLog()
    expect(text).toContain(
      `ERROR [ipc] test:fail failed ref=${result.error.ref}\n  Error: SQLITE_BUSY: database is locked\n      at `
    )
    expect(text).not.toContain('Ali Traders')
  })
})
