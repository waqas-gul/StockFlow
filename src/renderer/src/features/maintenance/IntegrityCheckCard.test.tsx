import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { IntegrityCheckReport } from '@shared/types/maintenance'
import { fail, ok, type Result } from '@shared/types/result'
import { createIntegrityCheckAction, type IntegrityCheckRun } from './integrity-check'
import { IntegrityCheckPanel } from './IntegrityCheckCard'

const REPORT: IntegrityCheckReport = {
  status: 'ERROR',
  message:
    'Problems were found. Restore a recent verified backup, or contact support and give them the reference below.',
  checkedAt: '2026-09-14T10:00:00.000Z',
  checks: [
    {
      id: 'sqlite.integrity',
      title: 'Database file',
      status: 'ERROR',
      message: 'The database file is damaged.'
    },
    {
      id: 'database.schema-version',
      title: 'Database version',
      status: 'WARNING',
      message: 'The database is older.'
    },
    {
      id: 'ledger.balances',
      title: 'Customer balances',
      status: 'OK',
      message: 'Every customer balance matches the ledger.'
    }
  ],
  ref: 'ABC123'
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function render(run: IntegrityCheckRun): string {
  return renderToStaticMarkup(<IntegrityCheckPanel run={run} onRun={() => undefined} />)
}

describe('IntegrityCheckPanel', () => {
  it('offers Run Integrity Check, and no way to fix anything', () => {
    const html = render({ state: 'idle' })
    expect(text(html)).toContain('Run Integrity Check')
    expect(text(html)).toContain('It never changes your data.')
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(text(render({ state: 'done', report: REPORT }))).not.toMatch(/\b(fix|repair)\b/i)
  })

  it('disables the button while the check runs', () => {
    expect(render({ state: 'running' })).toMatch(/<button[^>]*disabled=""[^>]*>.*Checking…/)
  })

  it('shows the overall result, each check and the reference', () => {
    const shown = text(render({ state: 'done', report: REPORT }))
    for (const expected of [
      'Overall: Error Problems were found.',
      'Reference: ABC123',
      'Database file (Error) The database file is damaged.',
      'Database version (Warning) The database is older.',
      'Customer balances (OK) Every customer balance matches the ledger.'
    ]) {
      expect(shown).toContain(expected)
    }
  })

  it('shows an OK result without a reference', () => {
    const shown = text(
      render({
        state: 'done',
        report: {
          ...REPORT,
          status: 'OK',
          message: 'No problems were found.',
          checks: [],
          ref: null
        }
      })
    )
    expect(shown).toContain('Overall: OK No problems were found.')
    expect(shown).not.toContain('Reference')
  })

  it('shows a check that could not be run', () => {
    expect(text(render({ state: 'failed', message: 'A restore is in progress.' }))).toContain(
      'A restore is in progress.'
    )
  })
})

describe('createIntegrityCheckAction', () => {
  it('goes running → done, once even when clicked twice', async () => {
    const runs: IntegrityCheckRun[] = []
    let calls = 0
    let answer!: (result: Result<IntegrityCheckReport>) => void
    const check = createIntegrityCheckAction(
      {
        integrityCheck: () => {
          calls++
          return new Promise((resolve) => (answer = resolve))
        }
      },
      (run) => runs.push(run)
    )
    const first = check()
    const second = check()
    answer(ok(REPORT))
    await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(runs).toEqual([{ state: 'running' }, { state: 'done', report: REPORT }])
  })

  it('goes running → failed with the safe message', async () => {
    const runs: IntegrityCheckRun[] = []
    await createIntegrityCheckAction(
      {
        integrityCheck: async () =>
          fail({ code: 'FORBIDDEN_STATE', message: 'StockFlow is restarting.' })
      },
      (run) => runs.push(run)
    )()
    expect(runs).toEqual([
      { state: 'running' },
      { state: 'failed', message: 'StockFlow is restarting.' }
    ])
  })
})
