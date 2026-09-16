import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { allNavItems } from '../navigation'
import { Sidebar } from './Sidebar'

interface RenderedLink {
  href: string
  className: string
  current: string | null
}

function renderSidebarLinks(pathname: string): RenderedLink[] {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[pathname]}>
      <TooltipProvider>
        <Sidebar />
      </TooltipProvider>
    </MemoryRouter>
  )
  return [...html.matchAll(/<a\b([^>]*)>/g)].map(([, attrs]) => ({
    href: /href="([^"]*)"/.exec(attrs)?.[1] ?? '',
    className: /class="([^"]*)"/.exec(attrs)?.[1] ?? '',
    current: /aria-current="([^"]*)"/.exec(attrs)?.[1] ?? null
  }))
}

describe('Sidebar', () => {
  it('renders one link per navigation item', () => {
    expect(renderSidebarLinks('/').map((link) => link.href)).toEqual(
      allNavItems.map((item) => item.path)
    )
  })

  // Regression: a className *function* passed through Radix Slot (TooltipTrigger asChild) was
  // stringified into the function's source, so layout classes like `flex` never applied.
  it('gives every link real layout classes', () => {
    for (const link of renderSidebarLinks('/')) {
      expect(link.className.split(' ')).toContain('flex')
      expect(link.className).not.toMatch(/=>|isActive/)
    }
  })

  it('marks only the current route as active', () => {
    const links = renderSidebarLinks('/invoices')
    expect(links.filter((link) => link.current === 'page').map((link) => link.href)).toEqual([
      '/invoices'
    ])
  })

  it('keeps Customers active on a customer page', () => {
    const links = renderSidebarLinks('/customers/12')
    expect(links.filter((link) => link.current === 'page').map((link) => link.href)).toEqual([
      '/customers'
    ])
  })
})
