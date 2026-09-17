import { describe, expect, it } from 'vitest'
import { linkedId, pageLinks, wantsForm } from './page-links'

function params(link: string): URLSearchParams {
  return new URLSearchParams(link.split('?')[1] ?? '')
}

describe('page links', () => {
  it('open the form a page offers, and only when asked', () => {
    expect(wantsForm(params(pageLinks.receivePayment), 'receive')).toBe(true)
    expect(wantsForm(params(pageLinks.addExpense), 'add')).toBe(true)
    expect(wantsForm(params(pageLinks.addProduct), 'add')).toBe(true)
    expect(wantsForm(params('/payments'), 'receive')).toBe(false)
    expect(wantsForm(params('/expenses?add=yes'), 'add')).toBe(false)
  })

  it('carry a record id that the page shows', () => {
    expect(pageLinks.invoice(12)).toBe('/invoices/12')
    expect(linkedId(params(pageLinks.payment(34)), 'payment')).toBe(34)
    for (const link of [
      '/payments',
      '/payments?payment=',
      '/payments?payment=0',
      '/payments?payment=-3',
      '/payments?payment=1.5',
      '/payments?payment=abc',
      '/payments?payment=99999999999999999999'
    ]) {
      expect(linkedId(params(link), 'payment'), link).toBeNull()
    }
  })

  it('go to the pages the Dashboard offers', () => {
    expect(pageLinks).toMatchObject({
      newInvoice: '/invoices/new',
      stockIn: '/stock/in',
      products: '/products',
      productSalesReport: '/reports?tab=products'
    })
  })
})
