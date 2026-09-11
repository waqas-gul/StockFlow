import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AppInfo } from '@shared/types/app-info'
import { ApiError } from '@renderer/lib/api'
import { queryKeys } from '@renderer/lib/query-keys'
import { AboutCard } from './AboutCard'

const info: AppInfo = {
  appVersion: '1.0.0',
  mode: 'production',
  databaseDriver: 'better-sqlite3',
  sqliteVersion: '3.50.4',
  schemaVersion: 0,
  dataDirectory: '%APPDATA%\\StockFlow\\data'
}

/** Server-renders the card (no effects run, so window.api is never called) and returns its text. */
function renderText(client: QueryClient): string {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AboutCard />
    </QueryClientProvider>
  )
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('AboutCard', () => {
  it('shows the app and database information', () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.app.info, info)
    const text = renderText(client)
    for (const expected of [
      'About',
      'Version 1.0.0',
      'Mode Production',
      'Database driver better-sqlite3',
      'SQLite version 3.50.4',
      'Schema version 0',
      'Data folder %APPDATA%\\StockFlow\\data'
    ]) {
      expect(text).toContain(expected)
    }
  })

  it('labels a development run', () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.app.info, { ...info, mode: 'development' })
    expect(renderText(client)).toContain('Mode Development')
  })

  it('shows a loading state until the answer arrives', () => {
    expect(renderText(new QueryClient())).toContain('Loading')
  })

  it('shows the error message when the call fails', async () => {
    // Without retryOnMount, a first render shows the failed query as it is instead of optimistically loading.
    const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } })
    await client.prefetchQuery({
      queryKey: queryKeys.app.info,
      queryFn: () =>
        Promise.reject(
          new ApiError({ code: 'DB_ERROR', message: 'The database is busy. Try again.' })
        ),
      retry: false
    })
    expect(renderText(client)).toContain('The database is busy. Try again.')
  })
})
