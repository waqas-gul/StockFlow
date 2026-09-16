import { describe, expect, it } from 'vitest'
import type { Product, ProductCreateInput, ProductUpdateInput } from '@shared/products'
import type { Result } from '@shared/types/result'
import {
  saveProduct,
  toggleProductActive,
  type ProductSaveApi,
  type SaveHandlers
} from './product-actions'

const draft: ProductCreateInput = {
  code: 'P-001',
  name: 'Tea',
  companyId: null,
  packingLabel: null,
  lowStockThresholdBase: 0,
  currencyMinorDigits: 2,
  units: []
}

const saved = { id: 9, code: 'P-001', name: 'Tea' } as Product

function handlers(): SaveHandlers & { calls: string[]; fieldErrors: Array<[string, string]> } {
  const calls: string[] = []
  const fieldErrors: Array<[string, string]> = []
  return {
    calls,
    fieldErrors,
    onSaved: (product) => calls.push(`saved ${product.id}`),
    onFieldError: (path, message) => fieldErrors.push([path, message]),
    notify: {
      success: (message) => calls.push(`success: ${message}`),
      error: (message) => calls.push(`error: ${message}`),
      warning: (message) => calls.push(`warning: ${message}`)
    }
  }
}

function api(result: Result<Product>): ProductSaveApi & { sent: Array<[string, unknown]> } {
  const sent: Array<[string, unknown]> = []
  return {
    sent,
    create: async (input: ProductCreateInput) => {
      sent.push(['create', input])
      return result
    },
    update: async (input: ProductUpdateInput) => {
      sent.push(['update', input])
      return result
    }
  }
}

describe('saving a product', () => {
  it('creates a product, then reports it saved', async () => {
    const fake = api({ ok: true, data: saved })
    const h = handlers()
    await expect(saveProduct(fake, { mode: 'create', input: draft }, h)).resolves.toBe(true)
    expect(fake.sent).toEqual([['create', draft]])
    expect(h.calls).toEqual(['saved 9', 'success: Product P-001 added.'])
  })

  it('updates a product', async () => {
    const fake = api({ ok: true, data: saved })
    const h = handlers()
    await saveProduct(fake, { mode: 'update', input: { ...draft, id: 9 } }, h)
    expect(fake.sent[0][0]).toBe('update')
    expect(h.calls).toEqual(['saved 9', 'success: Product P-001 saved.'])
  })

  it('shows a duplicate code on the code field, with the plain message', async () => {
    const message = 'Another product already uses the code "P-001".'
    const fake = api({
      ok: false,
      error: { code: 'DUPLICATE', message, fieldErrors: { code: [message] } }
    })
    const h = handlers()
    await expect(saveProduct(fake, { mode: 'create', input: draft }, h)).resolves.toBe(false)
    expect(h.fieldErrors).toEqual([['code', message]])
    expect(h.calls).toEqual([`error: ${message}`])
  })

  it('reports a failed IPC call without raw details', async () => {
    const h = handlers()
    const broken = {
      create: async () =>
        Promise.reject(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: products.code')),
      update: async () => Promise.reject(new Error('x'))
    }
    await expect(saveProduct(broken, { mode: 'create', input: draft }, h)).resolves.toBe(false)
    expect(h.calls).toEqual(['error: The product could not be saved. Try again.'])
  })
})

describe('activating and deactivating a product', () => {
  it('reports the result, with the stock warning when there is one', async () => {
    const h = handlers()
    const warning =
      'This product still has stock. It will be hidden from normal sales selection but its stock and history will remain.'
    const setActive = async (input: { id: number; active: boolean }) =>
      ({
        ok: true,
        data: { id: input.id, isActive: input.active, stockQtyBase: 5, warning }
      }) as const
    await expect(
      toggleProductActive({ setActive }, { id: 9, code: 'P-001', active: false }, h.notify)
    ).resolves.toBe(true)
    await toggleProductActive(
      {
        setActive: async (input) => ({
          ok: true,
          data: { ...input, isActive: input.active, stockQtyBase: 0, warning: null }
        })
      },
      { id: 9, code: 'P-001', active: true },
      h.notify
    )
    expect(h.calls).toEqual([
      `warning: Product P-001 deactivated. ${warning}`,
      'success: Product P-001 activated.'
    ])
  })

  it('shows a failure message', async () => {
    const h = handlers()
    await expect(
      toggleProductActive(
        {
          setActive: async () => ({
            ok: false,
            error: { code: 'NOT_FOUND', message: 'This product no longer exists.' }
          })
        },
        { id: 9, code: 'P-001', active: false },
        h.notify
      )
    ).resolves.toBe(false)
    expect(h.calls).toEqual(['error: This product no longer exists.'])
  })
})
