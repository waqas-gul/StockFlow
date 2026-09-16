import type {
  ReceiptVoidInput,
  StockAdjustmentInput,
  StockAdjustmentResult,
  StockReceiptDetail,
  StockReceiptInput
} from '@shared/stock'
import type { Result } from '@shared/types/result'
import { ADJUSTMENT_REASON_INFO } from '@shared/stock'
import { serverAdjustmentErrors } from './adjustment-form'
import { serverReceiptErrors } from './receipt-form'

export interface StockNotifier {
  success(message: string): void
  error(message: string): void
  warning(message: string): void
}

export interface SubmitHandlers<T> {
  onSaved(saved: T): void
  /** A main-process error for a form field (a form path such as `receiptDate` or `lines.1.unitCost`). */
  onFieldError(path: string, message: string): void
  readonly notify: StockNotifier
}

/** A new request id for one submission of a stock form; retries of that submission reuse it. */
export function newRequestId(): string {
  return crypto.randomUUID()
}

/**
 * Posts a receipt through `window.api.stock`. A retry with the same request id returns the saved receipt instead of
 * saving it twice. Returns true when the receipt was saved.
 */
export async function submitReceipt(
  api: { receive(input: StockReceiptInput): Promise<Result<StockReceiptDetail>> },
  input: StockReceiptInput,
  handlers: SubmitHandlers<StockReceiptDetail>
): Promise<boolean> {
  let result: Result<StockReceiptDetail>
  try {
    result = await api.receive(input)
  } catch {
    handlers.notify.error('The receipt could not be saved. Try again.')
    return false
  }
  if (result.ok) {
    handlers.onSaved(result.data)
    handlers.notify.success(`Receipt ${result.data.receiptNo} saved.`)
    return true
  }
  for (const [path, message] of serverReceiptErrors(result.error.fieldErrors)) {
    handlers.onFieldError(path, message)
  }
  handlers.notify.error(result.error.message)
  return false
}

/** Posts an adjustment; the late cost correction warning (L1) is shown when the main process returns it. */
export async function submitAdjustment(
  api: { adjust(input: StockAdjustmentInput): Promise<Result<StockAdjustmentResult>> },
  input: StockAdjustmentInput,
  handlers: SubmitHandlers<StockAdjustmentResult>
): Promise<boolean> {
  let result: Result<StockAdjustmentResult>
  try {
    result = await api.adjust(input)
  } catch {
    handlers.notify.error('The adjustment could not be saved. Try again.')
    return false
  }
  if (result.ok) {
    handlers.onSaved(result.data)
    const done = `${ADJUSTMENT_REASON_INFO[result.data.reason].label} ${result.data.adjustmentNo} saved.`
    if (result.data.warning !== null) handlers.notify.warning(`${done} ${result.data.warning}`)
    else handlers.notify.success(done)
    return true
  }
  for (const [path, message] of serverAdjustmentErrors(result.error.fieldErrors)) {
    handlers.onFieldError(path, message)
  }
  handlers.notify.error(result.error.message)
  return false
}

/** Voids a receipt. Returns the voided receipt, or null when it was refused (e.g. locked by later activity). */
export async function submitVoid(
  api: { voidReceipt(input: ReceiptVoidInput): Promise<Result<StockReceiptDetail>> },
  input: ReceiptVoidInput,
  notify: StockNotifier
): Promise<StockReceiptDetail | null> {
  let result: Result<StockReceiptDetail>
  try {
    result = await api.voidReceipt(input)
  } catch {
    notify.error('The receipt could not be voided. Try again.')
    return null
  }
  if (!result.ok) {
    notify.error(result.error.message)
    return null
  }
  notify.success(`Receipt ${result.data.receiptNo} voided.`)
  return result.data
}
