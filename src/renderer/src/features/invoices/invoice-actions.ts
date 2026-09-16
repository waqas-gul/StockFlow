import type { InvoiceCreateInput, InvoiceSaveResult } from '@shared/invoices'
import type { Result } from '@shared/types/result'

export interface InvoiceNotifier {
  success(message: string): void
  error(message: string): void
}

export interface InvoiceSubmitHandlers {
  onSaved(invoice: InvoiceSaveResult): void
  /** The main process's field errors, by draft path (e.g. `lines.0.quantities.1.price`). */
  onFieldErrors(errors: Record<string, string>): void
  /** Products whose price or stock changed since they were added: read them again and refresh their lines. */
  onProductsChanged(productIds: number[]): Promise<void>
  readonly notify: InvoiceNotifier
}

const PRICE_CHANGED_MESSAGE =
  'A price changed since it was entered, so nothing was posted. The line now shows the current price: check it and post again.'

/**
 * Posts an invoice. The request id comes from the draft and only changes once the invoice is saved, so retrying after a
 * lost answer returns the invoice already saved instead of posting it again. Returns true when the invoice is saved.
 */
export async function submitInvoice(
  api: { post(input: InvoiceCreateInput): Promise<Result<InvoiceSaveResult>> },
  input: InvoiceCreateInput,
  handlers: InvoiceSubmitHandlers
): Promise<boolean> {
  let result: Result<InvoiceSaveResult>
  try {
    result = await api.post(input)
  } catch {
    handlers.notify.error('The invoice could not be posted. Try again.')
    return false
  }
  if (result.ok) {
    handlers.onSaved(result.data)
    handlers.notify.success(
      result.data.replayed
        ? `Invoice ${result.data.invoiceNo} was already saved.`
        : `Invoice ${result.data.invoiceNo} saved successfully.`
    )
    return true
  }

  const { error } = result
  handlers.onFieldErrors(invoiceFieldErrors(error.fieldErrors))
  if (error.code === 'PRICE_CHANGED' || error.code === 'INSUFFICIENT_STOCK') {
    // The configured prices or the stock on the screen are out of date: read the products again.
    const key = error.code === 'PRICE_CHANGED' ? 'prices' : 'shortages'
    const entries = (error.details as Record<string, Array<{ productId: number }>> | undefined)?.[
      key
    ]
    await handlers.onProductsChanged([...new Set((entries ?? []).map((entry) => entry.productId))])
  }
  handlers.notify.error(error.code === 'PRICE_CHANGED' ? PRICE_CHANGED_MESSAGE : error.message)
  return false
}

const RENAMED: Readonly<Record<string, string>> = {
  customerId: 'customer',
  extraDiscountMinor: 'extraDiscount',
  freightMinor: 'freight',
  receivedMinor: 'received'
}

const SAME = new Set([
  'invoiceDate',
  'lines',
  'invoiceCode',
  'biltyNo',
  'transportName',
  'addaName',
  'checkedBy',
  'notes',
  'paymentMethod',
  'paymentReference'
])

/** The main process's field errors keyed by the screen's draft paths; anything else goes under `root`. */
export function invoiceFieldErrors(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined
): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const [path, messages] of Object.entries(fieldErrors ?? {})) {
    const target = draftPath(path)
    errors[target] = [errors[target], ...messages].filter(Boolean).join(' ')
  }
  return errors
}

function draftPath(path: string): string {
  if (RENAMED[path] !== undefined) return RENAMED[path]
  if (SAME.has(path)) return path
  const row =
    /^lines\.(\d+)\.(quantities|freeQuantities)\.(\d+)\.(unitId|quantity|unitPriceMinor)$/.exec(
      path
    )
  if (row !== null) {
    return `lines.${row[1]}.${row[2]}.${row[3]}.${row[4] === 'unitPriceMinor' ? 'price' : row[4]}`
  }
  const line = /^lines\.(\d+)(?:\.(\w+))?/.exec(path)
  if (line !== null) {
    const [, index, field] = line
    if (field === undefined) return `lines.${index}.amounts`
    const target: Record<string, string> = {
      productId: 'product',
      quantities: 'quantities',
      discount: 'discount',
      schemeMinor: 'scheme',
      ctnCount: 'ctn'
    }
    if (
      target[field] !== undefined &&
      (field === 'discount' || path === `lines.${index}.${field}`)
    ) {
      return `lines.${index}.${target[field]}`
    }
  }
  return 'root'
}
