import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/*
 * The main-process technical log: <data-root>\logs\app.log, rotated to app.log.1 … app.log.3 at about 5 MB.
 *
 * It records technical events and unexpected errors, with the error reference the user was shown, and never
 * business data: callers pass a fixed message and a few primitive context values, and an error is written as its
 * name, message, code, stack trace and causes only, never its other properties (such as a request payload). The
 * renderer has no access to it.
 */

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

/** Context values are primitives only, so a record or a payload cannot be logged by mistake. */
export type LogValue = string | number | boolean | null
export type LogContext = Readonly<Record<string, LogValue>>

export interface Logger {
  info(message: string, context?: LogContext): void
  warn(message: string, context?: LogContext): void
  /** Writes `error` as its name, message, code, stack trace and causes. Its other properties are never written. */
  error(message: string, error?: unknown, context?: LogContext): void
}

/** app.log is rotated before an entry would take it past this size. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024
/** Rotated copies kept: app.log.1 (newest) to app.log.3 (oldest). */
export const LOG_KEEP_FILES = 3

export interface FileLoggerOptions {
  /** `<data-root>\logs\app.log`. Its folder is created by the first write. */
  readonly file: string
  readonly maxBytes?: number
  readonly keepFiles?: number
  readonly now?: () => Date
  /**
   * Folders replaced in every entry, such as the user's profile folder by %USERPROFILE%, so the Windows user name
   * stays out of the log.
   */
  readonly redact?: ReadonlyArray<readonly [folder: string, placeholder: string]>
  /** Also receives every entry (the development console). */
  readonly echo?: (entry: string, level: LogLevel) => void
  /** Receives a failure to write or rotate the log; logging itself never throws. Default: console.error. */
  readonly onWriteError?: (error: unknown) => void
}

const MAX_MESSAGE_CHARS = 500
const MAX_VALUE_CHARS = 300
const MAX_ENTRY_CHARS = 16_000
const MAX_CAUSES = 4
/** SQLite and Node.js error codes, e.g. SQLITE_BUSY or ENOENT. */
const ERROR_CODE = /^[A-Za-z0-9_]{1,64}$/

/** A short reference for an unexpected error: shown to the user and written to the log with the full error. */
export function createErrorRef(): string {
  return randomBytes(3).toString('hex').toUpperCase()
}

/** The string `code` of a Node.js or SQLite error (e.g. EBUSY, SQLITE_BUSY), or null: safe log context. */
export function errorCodeOf(error: unknown): string | null {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : null
  return typeof code === 'string' ? code : null
}

/** Appends to `options.file`, rotating it by size. Synchronous, so an entry is on disk before a crash. */
export function createFileLogger(options: FileLoggerOptions): Logger {
  const { file, echo, maxBytes = LOG_MAX_BYTES, keepFiles = LOG_KEEP_FILES } = options
  const now = options.now ?? (() => new Date())
  const onWriteError =
    options.onWriteError ??
    ((error: unknown) => console.error('[logging] The log file could not be written.', error))
  const redact = redactor(options.redact ?? [])
  let size: number | undefined
  let writeFailing = false
  let rotationFailed = false

  function rotate(): void {
    try {
      rmSync(`${file}.${keepFiles}`, { force: true })
      for (let index = keepFiles - 1; index >= 1; index--) {
        const from = `${file}.${index}`
        if (existsSync(from)) renameSync(from, `${file}.${index + 1}`)
      }
      renameSync(file, `${file}.1`)
    } catch (error) {
      // Entries keep going to app.log; rotation is tried again before the next one.
      if (!rotationFailed) onWriteError(error)
      rotationFailed = true
    }
  }

  function write(level: LogLevel, entry: string): void {
    echo?.(entry, level)
    try {
      if (size === undefined) {
        mkdirSync(dirname(file), { recursive: true })
        size = sizeOf(file)
      }
      const bytes = Buffer.byteLength(entry, 'utf8')
      if (size > 0 && size + bytes > maxBytes) {
        rotate()
        size = sizeOf(file)
      }
      appendFileSync(file, entry, 'utf8')
      size += bytes
      writeFailing = false
    } catch (error) {
      if (!writeFailing) onWriteError(error)
      writeFailing = true
    }
  }

  const log = (level: LogLevel, message: string, error: unknown, context?: LogContext): void =>
    write(level, redact(formatEntry(now(), level, message, error, context)))

  return {
    info: (message, context) => log('INFO', message, undefined, context),
    warn: (message, context) => log('WARN', message, undefined, context),
    error: (message, error, context) => log('ERROR', message, error, context)
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function formatEntry(
  time: Date,
  level: LogLevel,
  message: string,
  error: unknown,
  context: LogContext | undefined
): string {
  let entry = `${time.toISOString()} ${level.padEnd(5)} ${oneLine(message, MAX_MESSAGE_CHARS)}`
  for (const [key, value] of Object.entries(context ?? {})) {
    entry += ` ${key.replace(/[^A-Za-z0-9_.-]/g, '_')}=${formatValue(value)}`
  }
  entry += '\n'
  if (error !== undefined) {
    // Indented, so no line of an error can look like the start of an entry.
    for (const line of describeError(error, 0)) entry += `  ${oneLine(line, MAX_ENTRY_CHARS)}\n`
  }
  if (entry.length > MAX_ENTRY_CHARS) {
    entry = `${entry.slice(0, MAX_ENTRY_CHARS)}\n  … (entry truncated)\n`
  }
  return entry
}

function formatValue(value: LogValue): string {
  if (typeof value !== 'string') return String(value)
  const text = oneLine(value, MAX_VALUE_CHARS)
  return /^[^\s"=]+$/.test(text) ? text : JSON.stringify(text)
}

function describeError(error: unknown, depth: number): string[] {
  if (error instanceof Error) {
    const stack = typeof error.stack === 'string' && error.stack !== '' ? error.stack : undefined
    const lines = splitLines(stack ?? `${error.name}: ${error.message}`)
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && ERROR_CODE.test(code)) lines.push(`code: ${code}`)
    if (error.cause !== undefined) {
      if (depth >= MAX_CAUSES) {
        lines.push('Caused by: … (further causes are not logged)')
      } else {
        const [first, ...rest] = describeError(error.cause, depth + 1)
        lines.push(`Caused by: ${first}`, ...rest)
      }
    }
    return lines
  }
  if (typeof error === 'string') return splitLines(`Thrown string: ${error}`)
  if (error === null || typeof error !== 'object') return [`Thrown value: ${String(error)}`]
  // An object's fields could be anything (a customer record, an invoice), so only its kind is written.
  return [
    `Thrown ${Object.prototype.toString.call(error).slice(8, -1)} value; its contents are not logged.`
  ]
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

/** Replaces control characters (line breaks included) with spaces and shortens the text to `max` characters. */
function oneLine(text: string, max: number): string {
  let result = ''
  for (const char of text) {
    const code = char.charCodeAt(0)
    result += code < 0x20 || code === 0x7f ? ' ' : char
  }
  return result.length > max ? `${result.slice(0, max)}…` : result
}

function redactor(
  folders: ReadonlyArray<readonly [folder: string, placeholder: string]>
): (text: string) => string {
  const rules = folders
    .flatMap(([folder, placeholder]) => {
      const trimmed = folder.replace(/[\\/]+$/, '')
      // A drive root (C:) is never redacted: it would mangle every path.
      if (trimmed.length < 4) return []
      const variants = new Set([trimmed, trimmed.replaceAll('\\', '/')])
      return [...variants].map((variant) => ({
        length: variant.length,
        placeholder,
        // Whole folder names only: C:\Users\owner must not match C:\Users\owner2.
        pattern: new RegExp(`${escapeRegExp(variant)}(?![A-Za-z0-9_-])`, 'gi')
      }))
    })
    .sort((a, b) => b.length - a.length)
  return (text) =>
    rules.reduce((result, rule) => result.replace(rule.pattern, rule.placeholder), text)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
