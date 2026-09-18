/*
 * Links that open a page ready for one task (the Dashboard's quick actions and activity rows). A page reads its own
 * parameter once, when it opens: `?add=1` / `?receive=1` / `?pay=1` open its form, `?payment=<id>` shows that payment,
 * `?supplier=<id>` starts Stock In for that supplier.
 */

export const pageLinks = Object.freeze({
  newInvoice: '/invoices/new',
  stockIn: '/stock/in',
  products: '/products',
  addProduct: '/products?add=1',
  receivePayment: '/payments?receive=1',
  addExpense: '/expenses?add=1',
  suppliers: '/suppliers',
  paySupplier: '/suppliers?pay=1',
  productSalesReport: '/reports?tab=products',
  supplierBalancesReport: '/reports?tab=suppliers',
  invoice: (id: number): string => `/invoices/${id}`,
  payment: (id: number): string => `/payments?payment=${id}`,
  supplier: (id: number): string => `/suppliers/${id}`,
  stockInFromSupplier: (id: number): string => `/stock/in?supplier=${id}`
})

/** True when the link asked the page to open its form. */
export function wantsForm(params: URLSearchParams, name: 'add' | 'receive' | 'pay'): boolean {
  return params.get(name) === '1'
}

/** The record id the link asked the page to show, or null. */
export function linkedId(params: URLSearchParams, name: string): number | null {
  const id = Number(params.get(name))
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
