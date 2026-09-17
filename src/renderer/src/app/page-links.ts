/*
 * Links that open a page ready for one task (the Dashboard's quick actions and activity rows). A page reads its own
 * parameter once, when it opens: `?add=1` / `?receive=1` open its form, `?payment=<id>` shows that payment.
 */

export const pageLinks = Object.freeze({
  newInvoice: '/invoices/new',
  stockIn: '/stock/in',
  products: '/products',
  addProduct: '/products?add=1',
  receivePayment: '/payments?receive=1',
  addExpense: '/expenses?add=1',
  productSalesReport: '/reports?tab=products',
  invoice: (id: number): string => `/invoices/${id}`,
  payment: (id: number): string => `/payments?payment=${id}`
})

/** True when the link asked the page to open its form. */
export function wantsForm(params: URLSearchParams, name: 'add' | 'receive'): boolean {
  return params.get(name) === '1'
}

/** The record id the link asked the page to show, or null. */
export function linkedId(params: URLSearchParams, name: string): number | null {
  const id = Number(params.get(name))
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
