import type {
  Product,
  ProductActiveResult,
  ProductCreateInput,
  ProductUpdateInput
} from '@shared/products'
import type { Result } from '@shared/types/result'
import type { SetActiveInput } from '@shared/validation'
import { serverFieldErrors } from './product-form'

export interface ProductNotifier {
  success(message: string): void
  error(message: string): void
  warning(message: string): void
}

export interface SaveHandlers {
  onSaved(product: Product): void
  /** A main-process error for a form field (a form path such as `code` or `units.1.baseQty`). */
  onFieldError(path: string, message: string): void
  readonly notify: ProductNotifier
}

export interface ProductSaveApi {
  create(input: ProductCreateInput): Promise<Result<Product>>
  update(input: ProductUpdateInput): Promise<Result<Product>>
}

export type SaveRequest =
  | { readonly mode: 'create'; readonly input: ProductCreateInput }
  | { readonly mode: 'update'; readonly input: ProductUpdateInput }

/** Saves the form through `window.api.products`. Returns true when the product was saved. */
export async function saveProduct(
  api: ProductSaveApi,
  request: SaveRequest,
  handlers: SaveHandlers
): Promise<boolean> {
  let result: Result<Product>
  try {
    result =
      request.mode === 'create' ? await api.create(request.input) : await api.update(request.input)
  } catch {
    handlers.notify.error('The product could not be saved. Try again.')
    return false
  }
  if (result.ok) {
    handlers.onSaved(result.data)
    handlers.notify.success(
      `Product ${result.data.code} ${request.mode === 'create' ? 'added' : 'saved'}.`
    )
    return true
  }
  for (const [path, message] of serverFieldErrors(result.error.fieldErrors)) {
    handlers.onFieldError(path, message)
  }
  handlers.notify.error(result.error.message)
  return false
}

export interface ProductActiveApi {
  setActive(input: SetActiveInput): Promise<Result<ProductActiveResult>>
}

/** Activates or deactivates a product; the stock warning is shown when the main process returns one. */
export async function toggleProductActive(
  api: ProductActiveApi,
  target: { readonly id: number; readonly code: string; readonly active: boolean },
  notify: ProductNotifier
): Promise<boolean> {
  let result: Result<ProductActiveResult>
  try {
    result = await api.setActive({ id: target.id, active: target.active })
  } catch {
    notify.error('The product could not be changed. Try again.')
    return false
  }
  if (!result.ok) {
    notify.error(result.error.message)
    return false
  }
  const done = `Product ${target.code} ${target.active ? 'activated' : 'deactivated'}.`
  if (result.data.warning !== null) notify.warning(`${done} ${result.data.warning}`)
  else notify.success(done)
  return true
}
