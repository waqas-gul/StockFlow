import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { BackupStatus, RestoreCandidateSummary } from '@shared/types/backup'
import { formatDateTime } from '@renderer/lib/format'
import type { ManualBackupState } from './backup-actions'
import { BackupFailedLink } from './BackupStatusIndicator'
import { BackupRestorePanel } from './BackupRestoreCard'
import { RestartingNotice, RestoreConfirmation } from './RestoreDialog'

const STATUS: BackupStatus = {
  health: 'OK',
  lastAutomatic: {
    at: '2026-09-14T04:00:00.000Z',
    fileName: 'stockflow-backup_2026-09-14_090000_v1.0.0_s1.db'
  },
  lastFailure: null,
  lastManual: { at: '2026-09-13T12:00:00.000Z', fileName: 'shop copy.db', location: 'E:\\Backups' },
  lastRestore: null,
  folder: '%APPDATA%\\StockFlow\\backups\\auto',
  busy: false
}

const SUMMARY: RestoreCandidateSummary = {
  fileName: 'stockflow-backup_2026-09-01_180000_v0.9.0_s1.db',
  backupCreatedAt: '2026-09-01T13:00:00.000Z',
  schemaVersion: 1,
  appVersion: '0.9.0',
  products: 12,
  customers: 4,
  invoices: 30,
  sizeBytes: 250_000,
  needsMigration: false
}

const noop = (): void => undefined

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function panel(
  overrides: Partial<{
    status: BackupStatus | undefined
    backup: ManualBackupState
    restoreBusy: boolean
  }> = {}
): string {
  return renderToStaticMarkup(
    <BackupRestorePanel
      status={'status' in overrides ? overrides.status : STATUS}
      statusError={null}
      backup={overrides.backup ?? { state: 'idle' }}
      restoreBusy={overrides.restoreBusy ?? false}
      onBackupNow={noop}
      onOpenFolder={noop}
      onRestore={noop}
    />
  )
}

/** The `disabled` state of the button whose text is `label`. */
function buttonDisabled(html: string, label: string): boolean {
  const button = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/g)].find(([, , inner]) =>
    text(inner).includes(label)
  )
  if (!button) throw new Error(`No button "${label}"`)
  return /\sdisabled=""/.test(button[1])
}

describe('BackupRestorePanel', () => {
  it('shows the backup status, the backup folder and the reminder', () => {
    const shown = text(panel())
    for (const expected of [
      'Backup & Restore',
      'Backup status Working',
      `Last automatic backup ${formatDateTime(STATUS.lastAutomatic!.at)}`,
      `Last manual backup ${formatDateTime(STATUS.lastManual!.at)}, shop copy.db in E:\\Backups`,
      'Backup folder %APPDATA%\\StockFlow\\backups\\auto',
      'Keep an occasional backup on a USB drive or another physical drive.'
    ]) {
      expect(shown).toContain(expected)
    }
  })

  it('offers Backup Now, Restore Backup and Open Backup Folder, and never a path field', () => {
    const html = panel()
    expect(buttonDisabled(html, 'Backup Now')).toBe(false)
    expect(buttonDisabled(html, 'Restore Backup')).toBe(false)
    expect(buttonDisabled(html, 'Open Backup Folder')).toBe(false)
    expect(html).not.toMatch(/<input/)
  })

  it('shows Creating… and disables both operations while a backup is made', () => {
    const html = panel({ backup: { state: 'creating' } })
    expect(buttonDisabled(html, 'Creating backup…')).toBe(true)
    expect(buttonDisabled(html, 'Restore Backup')).toBe(true)
  })

  it('disables both operations while a restore is chosen or running, or the main process is busy', () => {
    for (const html of [
      panel({ restoreBusy: true }),
      panel({ status: { ...STATUS, busy: true } })
    ]) {
      expect(buttonDisabled(html, 'Backup Now')).toBe(true)
      expect(buttonDisabled(html, 'Restore Backup')).toBe(true)
    }
    expect(text(panel({ status: { ...STATUS, busy: true } }))).toContain(
      'Backup or restore in progress'
    )
  })

  it('shows the outcome of Backup Now', () => {
    const backup = { at: '2026-09-14T10:00:00.000Z', fileName: 'shop.db', location: 'E:\\' }
    expect(text(panel({ backup: { state: 'success', backup } }))).toContain(
      'Saved shop.db in E:\\.'
    )
    expect(text(panel({ backup: { state: 'failed', message: 'The drive is full.' } }))).toContain(
      'The backup was not made: The drive is full.'
    )
  })

  it('warns when the last automatic backup failed', () => {
    const status: BackupStatus = {
      ...STATUS,
      health: 'FAILED',
      lastFailure: { at: '2026-09-14T17:00:00.000Z', message: 'The backup could not be written.' }
    }
    const shown = text(panel({ status }))
    expect(shown).toContain('The last automatic backup failed')
    expect(shown).toContain('The backup could not be written.')
    expect(shown).toContain('Backup status Last automatic backup failed')
  })

  it('shows when there is no automatic backup yet, and the last restore', () => {
    const shown = text(
      panel({
        status: {
          ...STATUS,
          health: 'NONE',
          lastAutomatic: null,
          lastManual: null,
          lastRestore: {
            at: '2026-09-14T11:00:00.000Z',
            fileName: 'old.db',
            restored: true,
            message: 'The backup was restored.'
          }
        }
      })
    )
    expect(shown).toContain('No automatic backup yet')
    expect(shown).toContain('Last automatic backup None yet')
    expect(shown).toContain('Last manual backup None recorded')
    expect(shown).toContain('restored from old.db')
  })

  it('shows Loading… until the status arrives, while Backup Now stays available', () => {
    const html = panel({ status: undefined })
    expect(text(html)).toContain('Backup status Loading…')
    expect(buttonDisabled(html, 'Backup Now')).toBe(false)
  })
})

function confirmation(typed: string, restoring = false, summary = SUMMARY): string {
  return renderToStaticMarkup(
    <RestoreConfirmation
      summary={summary}
      typed={typed}
      restoring={restoring}
      onType={noop}
      onCancel={noop}
      onConfirm={noop}
    />
  )
}

describe('RestoreConfirmation', () => {
  it('shows what is in the backup and the warning', () => {
    const shown = text(confirmation(''))
    for (const expected of [
      `File ${SUMMARY.fileName}`,
      `Backup date ${formatDateTime(SUMMARY.backupCreatedAt)}`,
      'Made with StockFlow 0.9.0',
      'Schema version 1',
      'Products 12',
      'Customers 4',
      'Invoices 30',
      'Restoring will replace the current StockFlow data.',
      'Type RESTORE to confirm'
    ]) {
      expect(shown).toContain(expected)
    }
  })

  it('shows an unknown version and missing counts plainly, and says an older backup is upgraded', () => {
    const shown = text(
      confirmation('', false, {
        ...SUMMARY,
        appVersion: null,
        invoices: null,
        needsMigration: true
      })
    )
    expect(shown).toContain('Made with Unknown version')
    expect(shown).toContain('Invoices —')
    expect(shown).toContain('It is upgraded after it is restored.')
  })

  it('enables Restore backup only once RESTORE is typed', () => {
    expect(buttonDisabled(confirmation(''), 'Restore backup')).toBe(true)
    expect(buttonDisabled(confirmation('restore'), 'Restore backup')).toBe(true)
    expect(buttonDisabled(confirmation('RESTORE'), 'Restore backup')).toBe(false)
    expect(buttonDisabled(confirmation('RESTORE'), 'Cancel')).toBe(false)
  })

  it('cannot be cancelled or confirmed again while restoring', () => {
    const html = confirmation('RESTORE', true)
    expect(buttonDisabled(html, 'Restoring…')).toBe(true)
    expect(buttonDisabled(html, 'Cancel')).toBe(true)
    expect(html).toMatch(/<input[^>]*disabled=""/)
  })
})

describe('RestartingNotice', () => {
  it('shows the result until StockFlow restarts', () => {
    const shown = text(
      renderToStaticMarkup(
        <RestartingNotice result={{ restored: true, message: 'The backup was restored.' }} />
      )
    )
    expect(shown).toBe('The backup was restored. StockFlow is restarting…')
  })
})

describe('BackupFailedLink (top bar)', () => {
  function render(status: BackupStatus | undefined): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <BackupFailedLink status={status} />
      </MemoryRouter>
    )
  }

  it('appears only when the last automatic backup failed, and leads to Settings', () => {
    expect(render(undefined)).toBe('')
    expect(render(STATUS)).toBe('')
    expect(render({ ...STATUS, health: 'NONE' })).toBe('')
    const html = render({ ...STATUS, health: 'FAILED' })
    expect(html).toMatch(/href="\/settings"/)
    expect(text(html)).toBe('Backup failed')
  })
})
