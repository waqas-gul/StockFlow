import type {
  DuplicateSupplierPaymentCheck,
  Supplier,
  SupplierBalanceAdjustmentInput,
  SupplierBalanceAdjustmentResult,
  SupplierCreateInput,
  SupplierPaymentCreateInput,
  SupplierPaymentDuplicateCheckInput,
  SupplierPaymentSaveResult,
  SupplierPaymentSummary,
  SupplierPaymentVoidInput,
  SupplierPaymentVoidResult,
  SupplierUpdateInput
} from '@shared/suppliers'
import type { Result } from '@shared/types/result'
import type { SetActiveInput } from '@shared/validation'
import type { CurrencyFormat } from '../products/product-display'
import { supplierBalanceText } from './supplier-display'
import { serverSupplierAdjustmentErrors, serverSupplierErrors } from './supplier-form'
import { serverSupplierPaymentErrors } from './supplier-payment-form'

export interface SupplierNotifier {
  success(message: string): void
  error(message: string): void
  warning(message: string): void
}

export interface SupplierSubmitHandlers<T> {
  onSaved(saved: T): void
  /** A main-process error for a form field (a form path such as `name` or `openingDate`). */
  onFieldError(path: string, message: string): void
  readonly notify: SupplierNotifier
}

export type SupplierSaveRequest =
  | { readonly mode: 'create'; readonly input: SupplierCreateInput }
  | { readonly mode: 'update'; readonly input: SupplierUpdateInput }

/** Saves the Add/Edit Supplier form through `window.api.suppliers`. Returns true when it was saved. */
export async function saveSupplier(
  api: {
    create(input: SupplierCreateInput): Promise<Result<Supplier>>
    update(input: SupplierUpdateInput): Promise<Result<Supplier>>
  },
  request: SupplierSaveRequest,
  handlers: SupplierSubmitHandlers<Supplier>
): Promise<boolean> {
  let result: Result<Supplier>
  try {
    result =
      request.mode === 'create' ? await api.create(request.input) : await api.update(request.input)
  } catch {
    handlers.notify.error('The supplier could not be saved. Try again.')
    return false
  }
  if (result.ok) {
    handlers.onSaved(result.data)
    handlers.notify.success(
      `Supplier ${result.data.code} ${result.data.name} ${request.mode === 'create' ? 'added' : 'saved'}.`
    )
    return true
  }
  for (const [path, message] of serverSupplierErrors(result.error.fieldErrors)) {
    handlers.onFieldError(path, message)
  }
  handlers.notify.error(result.error.message)
  return false
}

/** Deactivates or reactivates a supplier. Nothing is removed either way. */
export async function toggleSupplierActive(
  api: { setActive(input: SetActiveInput): Promise<Result<Supplier>> },
  target: { readonly id: number; readonly code: string; readonly active: boolean },
  notify: SupplierNotifier
): Promise<boolean> {
  let result: Result<Supplier>
  try {
    result = await api.setActive({ id: target.id, active: target.active })
  } catch {
    notify.error('The supplier could not be changed. Try again.')
    return false
  }
  if (!result.ok) {
    notify.error(result.error.message)
    return false
  }
  notify.success(`Supplier ${target.code} ${target.active ? 'reactivated' : 'deactivated'}.`)
  return true
}

/** Posts a supplier balance adjustment and reports the new balance. */
export async function submitSupplierAdjustment(
  api: {
    adjustBalance(
      input: SupplierBalanceAdjustmentInput
    ): Promise<Result<SupplierBalanceAdjustmentResult>>
  },
  input: SupplierBalanceAdjustmentInput,
  handlers: SupplierSubmitHandlers<SupplierBalanceAdjustmentResult> & {
    readonly currency: CurrencyFormat
  }
): Promise<boolean> {
  let result: Result<SupplierBalanceAdjustmentResult>
  try {
    result = await api.adjustBalance(input)
  } catch {
    handlers.notify.error('The adjustment could not be saved. Try again.')
    return false
  }
  if (result.ok) {
    handlers.onSaved(result.data)
    handlers.notify.success(
      `Supplier balance adjusted. New balance: ${supplierBalanceText(result.data.supplier.balanceMinor, handlers.currency)}.`
    )
    return true
  }
  for (const [path, message] of serverSupplierAdjustmentErrors(result.error.fieldErrors)) {
    handlers.onFieldError(path, message)
  }
  handlers.notify.error(result.error.message)
  return false
}

export interface SupplierPaymentSubmitHandlers extends SupplierSubmitHandlers<SupplierPaymentSaveResult> {
  /**
   * Asked when posted payments with the same supplier, date and amount exist: resolves true to save anyway (Continue),
   * false to save nothing (Cancel).
   */
  confirmDuplicate(duplicates: readonly SupplierPaymentSummary[]): Promise<boolean>
  readonly currency: CurrencyFormat
}

export type SupplierPaymentOutcome = 'saved' | 'cancelled' | 'failed'

/**
 * Pay Supplier: first the soft duplicate check (the owner may continue), then the payment itself. The request id stays
 * the same for a retry, so a lost answer or a double click never posts the payment twice.
 */
export async function submitSupplierPayment(
  api: {
    checkDuplicate(
      input: SupplierPaymentDuplicateCheckInput
    ): Promise<Result<DuplicateSupplierPaymentCheck>>
    create(input: SupplierPaymentCreateInput): Promise<Result<SupplierPaymentSaveResult>>
  },
  input: SupplierPaymentCreateInput,
  handlers: SupplierPaymentSubmitHandlers
): Promise<SupplierPaymentOutcome> {
  let result: Result<SupplierPaymentSaveResult>
  try {
    const check = await api.checkDuplicate({
      supplierId: input.supplierId,
      paymentDate: input.paymentDate,
      amountMinor: input.amountMinor
    })
    // A refused check is reported by the save itself.
    if (check.ok && check.data.duplicates.length > 0) {
      if (!(await handlers.confirmDuplicate(check.data.duplicates))) return 'cancelled'
    }
    result = await api.create(input)
  } catch {
    handlers.notify.error('The payment could not be saved. Try again.')
    return 'failed'
  }
  if (result.ok) {
    handlers.onSaved(result.data)
    const balance = supplierBalanceText(result.data.balanceAfterMinor, handlers.currency)
    handlers.notify.success(
      result.data.replayed
        ? `Payment ${result.data.paymentNo} was already saved. Supplier balance now: ${balance}.`
        : `Payment ${result.data.paymentNo} saved. Supplier balance now: ${balance}.`
    )
    return 'saved'
  }
  for (const [path, message] of serverSupplierPaymentErrors(result.error.fieldErrors)) {
    handlers.onFieldError(path, message)
  }
  handlers.notify.error(result.error.message)
  return 'failed'
}

/** Voids a supplier payment. Returns the void payment, or null when it was refused. */
export async function submitSupplierPaymentVoid(
  api: { void(input: SupplierPaymentVoidInput): Promise<Result<SupplierPaymentVoidResult>> },
  input: SupplierPaymentVoidInput,
  notify: SupplierNotifier,
  currency: CurrencyFormat
): Promise<SupplierPaymentVoidResult | null> {
  let result: Result<SupplierPaymentVoidResult>
  try {
    result = await api.void(input)
  } catch {
    notify.error('The payment could not be voided. Try again.')
    return null
  }
  if (!result.ok) {
    notify.error(result.error.message)
    return null
  }
  notify.success(
    `Payment ${result.data.paymentNo} voided. Supplier balance now: ${supplierBalanceText(result.data.balanceAfterMinor, currency)}.`
  )
  return result.data
}
