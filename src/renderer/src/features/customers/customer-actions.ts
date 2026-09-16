import type {
  BalanceAdjustmentInput,
  BalanceAdjustmentResult,
  Customer,
  CustomerCreateInput,
  CustomerUpdateInput
} from '@shared/customers'
import type { Result } from '@shared/types/result'
import type { SetActiveInput } from '@shared/validation'
import type { CurrencyFormat } from '../products/product-display'
import { serverBalanceAdjustmentErrors } from './balance-adjustment-form'
import { balanceText } from './customer-display'
import { serverCustomerErrors } from './customer-form'

export interface CustomerNotifier {
  success(message: string): void
  error(message: string): void
  warning(message: string): void
}

export interface CustomerSubmitHandlers<T> {
  onSaved(saved: T): void
  /** A main-process error for a form field (a form path such as `name` or `openingDate`). */
  onFieldError(path: string, message: string): void
  readonly notify: CustomerNotifier
}

export type CustomerSaveRequest =
  | { readonly mode: 'create'; readonly input: CustomerCreateInput }
  | { readonly mode: 'update'; readonly input: CustomerUpdateInput }

/** Saves the Add/Edit Customer form through `window.api.customers`. Returns true when it was saved. */
export async function saveCustomer(
  api: {
    create(input: CustomerCreateInput): Promise<Result<Customer>>
    update(input: CustomerUpdateInput): Promise<Result<Customer>>
  },
  request: CustomerSaveRequest,
  handlers: CustomerSubmitHandlers<Customer>
): Promise<boolean> {
  let result: Result<Customer>
  try {
    result =
      request.mode === 'create' ? await api.create(request.input) : await api.update(request.input)
  } catch {
    handlers.notify.error('The customer could not be saved. Try again.')
    return false
  }
  if (result.ok) {
    handlers.onSaved(result.data)
    handlers.notify.success(
      `Customer ${result.data.code} ${result.data.name} ${request.mode === 'create' ? 'added' : 'saved'}.`
    )
    return true
  }
  for (const [path, message] of serverCustomerErrors(result.error.fieldErrors)) {
    handlers.onFieldError(path, message)
  }
  handlers.notify.error(result.error.message)
  return false
}

/** Deactivates or reactivates a customer. Nothing is removed either way. */
export async function toggleCustomerActive(
  api: { setActive(input: SetActiveInput): Promise<Result<Customer>> },
  target: { readonly id: number; readonly code: string; readonly active: boolean },
  notify: CustomerNotifier
): Promise<boolean> {
  let result: Result<Customer>
  try {
    result = await api.setActive({ id: target.id, active: target.active })
  } catch {
    notify.error('The customer could not be changed. Try again.')
    return false
  }
  if (!result.ok) {
    notify.error(result.error.message)
    return false
  }
  notify.success(`Customer ${target.code} ${target.active ? 'reactivated' : 'deactivated'}.`)
  return true
}

/** Posts a balance adjustment and reports the new balance. */
export async function submitBalanceAdjustment(
  api: { adjustBalance(input: BalanceAdjustmentInput): Promise<Result<BalanceAdjustmentResult>> },
  input: BalanceAdjustmentInput,
  handlers: CustomerSubmitHandlers<BalanceAdjustmentResult> & { readonly currency: CurrencyFormat }
): Promise<boolean> {
  let result: Result<BalanceAdjustmentResult>
  try {
    result = await api.adjustBalance(input)
  } catch {
    handlers.notify.error('The adjustment could not be saved. Try again.')
    return false
  }
  if (result.ok) {
    handlers.onSaved(result.data)
    handlers.notify.success(
      `Balance adjusted. New balance: ${balanceText(result.data.customer.balanceMinor, handlers.currency)}.`
    )
    return true
  }
  for (const [path, message] of serverBalanceAdjustmentErrors(result.error.fieldErrors)) {
    handlers.onFieldError(path, message)
  }
  handlers.notify.error(result.error.message)
  return false
}
