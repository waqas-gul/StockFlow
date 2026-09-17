import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { allNavItems } from '@renderer/app/navigation'
import { queryKeys } from '@renderer/lib/query-keys'
import { DashboardPage } from './DashboardPage'

function render(businessName: string | null): string {
  const queryClient = new QueryClient()
  if (businessName !== null) {
    queryClient.setQueryData(queryKeys.settings, {
      values: { 'business.name': businessName },
      minorDigitsLocked: false
    })
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('Dashboard', () => {
  it('links to every other section with what it is for, and shows no figures', () => {
    const html = render('Ali Traders')
    const shown = html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
    expect(shown).toContain('Ali Traders')
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1])
    expect(hrefs).toEqual(allNavItems.filter((item) => item.path !== '/').map((item) => item.path))
    for (const item of allNavItems.filter((navItem) => navItem.path !== '/')) {
      expect(shown).toContain(`${item.label} ${item.description}`)
    }
    expect(shown).not.toMatch(/\bRs\s|\d/)
    expect(shown).not.toMatch(/later phase|placeholder/i)
  })

  it('uses the product name until settings are loaded', () => {
    expect(render(null)).toContain('StockFlow')
  })
})
