import { describe, expect, it } from 'vitest'
import type {
  DuplicateSupplierPaymentCheck,
  Supplier,
  SupplierBalanceAdjustmentResult,
  SupplierCreateInput,
  SupplierLedgerRow,
  SupplierPaymentCreateInput,
  SupplierPaymentSaveResult,
  SupplierPaymentSummary,
  SupplierPaymentVoidResult
} from '@shared/suppliers'
import type { Result } from '@shared/types/result'
import {
  saveSupplier,
  submitSupplierAdjustment,
  submitSupplierPayment,
  submitSupplierPaymentVoid,
  toggleSupplierActive,
  type SupplierNotifier
} from './supplier-actions'
import {
  supplierBalanceDescription,
  supplierBalanceText,
  supplierDeactivateText,
  supplierLedgerAmount,
  supplierLedgerLabel,
  supplierLedgerReference
} from './supplier-display'
import {
  emptySupplierAdjustmentForm,
  emptySupplierForm,
  serverSupplierAdjustmentErrors,
  serverSupplierErrors,
  supplierAdjustmentFormSchema,
  supplierAdjustmentPreview,
  supplierFormSchema,
  supplierFormValues,
  supplierOpeningPreview,
  toSupplierAdjustmentInput,
  toSupplierCreateInput,
  toSupplierUpdateInput,
  type SupplierFormValues
} from './supplier-form'
import {
  emptySupplierPaymentForm,
  serverSupplierPaymentErrors,
  supplierPaymentFormSchema,
  supplierPaymentPreview,
  toSupplierPaymentInput,
  withSupplier
} from './supplier-payment-form'

const RS = { minorDigits: 2, symbol: 'Rs' }
const TODAY = '2026-09-16'

const supplier: Supplier = {
  id: 1,
  code: 'SUP-00001',
  name: 'ABC Distributors',
  contactPerson: 'Imran',
  phone: '0300-1112233',
  city: 'Lahore',
  isActive: true,
  balanceMinor: 4_000_000,
  address: 'Circular Road',
  notes: null,
  latestEntryDate: '2026-09-10',
  totalPurchasesMinor: 5_000_000,
  purchaseCount: 1,
  totalPaidMinor: 2_000_000,
  paymentCount: 1,
  lastPurchaseDate: '2026-09-10',
  lastPaymentDate: '2026-09-10',
  productsPurchased: [],
  createdAt: '2026-09-10T10:00:00.000Z',
  updatedAt: '2026-09-10T10:00:00.000Z'
}

function ledgerRow(overrides: Partial<SupplierLedgerRow>): SupplierLedgerRow {
  return {
    id: 1,
    entryDate: '2026-09-10',
    type: 'OPENING',
    amountMinor: 1_000_000,
    runningBalanceMinor: 1_000_000,
    receiptId: null,
    receiptNo: null,
    supplierBillNo: null,
    paymentId: null,
    paymentNo: null,
    paymentMethod: null,
    paymentStatus: null,
    note: null,
    createdAt: '2026-09-10T10:00:00.000Z',
    ...overrides
  }
}

function recorder(): SupplierNotifier & { messages: string[] } {
  const messages: string[] = []
  return {
    messages,
    success: (message) => messages.push(`success: ${message}`),
    error: (message) => messages.push(`error: ${message}`),
    warning: (message) => messages.push(`warning: ${message}`)
  }
}

function issuesOf(result: {
  success: boolean
  error?: { issues: Array<{ path: PropertyKey[]; message: string }> }
}): Record<string, string[]> {
  const issues: Record<string, string[]> = {}
  for (const issue of result.error?.issues ?? []) {
    const path = issue.path.join('.')
    issues[path] = [...(issues[path] ?? []), issue.message]
  }
  return issues
}

describe('supplier display', () => {
  it('reads a supplier balance as Due, Advance or Settled, never as a signed number', () => {
    expect(supplierBalanceText(4_000_000, RS)).toBe('Rs 40,000.00 Due')
    expect(supplierBalanceText(-500_000, RS)).toBe('Rs 5,000.00 Advance')
    expect(supplierBalanceText(0, RS)).toBe('Settled')
    expect(supplierBalanceDescription(1)).toBe('The shop owes the supplier.')
    expect(supplierBalanceDescription(-1)).toBe(
      'The supplier holds an advance of the shop’s money.'
    )
    expect(supplierBalanceDescription(0)).toBe('Nothing is owed either way.')
  })

  it('names ledger entries in shop terms, with their document and signed amount', () => {
    expect(supplierLedgerLabel(ledgerRow({}))).toBe('Opening balance (due)')
    expect(supplierLedgerLabel(ledgerRow({ amountMinor: -5 }))).toBe('Opening balance (advance)')
    expect(supplierLedgerLabel(ledgerRow({ type: 'PAYMENT', paymentMethod: 'BANK' }))).toBe(
      'Payment · Bank'
    )
    expect(supplierLedgerLabel(ledgerRow({ type: 'PURCHASE' }))).toBe('Stock purchase')
    expect(supplierLedgerLabel(ledgerRow({ type: 'PURCHASE_VOID' }))).toBe('Purchase voided')
    expect(supplierLedgerLabel(ledgerRow({ type: 'PAYMENT_VOID' }))).toBe('Payment voided')
    expect(supplierLedgerLabel(ledgerRow({ type: 'ADJUSTMENT' }))).toBe('Balance adjustment')
    expect(
      supplierLedgerReference(ledgerRow({ receiptNo: 'GRN-000001', supplierBillNo: 'ABC-101' }))
    ).toBe('GRN-000001 · Bill ABC-101')
    expect(supplierLedgerReference(ledgerRow({ receiptNo: 'GRN-000002' }))).toBe('GRN-000002')
    expect(supplierLedgerReference(ledgerRow({ paymentNo: 'SPAY-000001' }))).toBe('SPAY-000001')
    expect(supplierLedgerReference(ledgerRow({}))).toBe('')
    expect(supplierLedgerAmount(5_000_000, RS)).toBe('+Rs 50,000.00')
    expect(supplierLedgerAmount(-2_000_000, RS)).toBe('−Rs 20,000.00')
    expect(supplierDeactivateText('Rs 40,000.00 Due')).toContain(
      'the balance (Rs 40,000.00 Due) and history stay'
    )
  })
})

describe('supplier form', () => {
  function values(overrides: Partial<SupplierFormValues> = {}): SupplierFormValues {
    return { ...emptySupplierForm(TODAY), name: ' ABC Distributors ', ...overrides }
  }

  it('turns the typed supplier into the create input: no opening balance when the amount is empty or 0', () => {
    for (const openingAmount of ['', '0']) {
      const parsed = supplierFormSchema(2).safeParse(values({ openingAmount, phone: ' 0300 ' }))
      expect(parsed.success).toBe(true)
      if (!parsed.success) return
      expect(toSupplierCreateInput(parsed.data, 2)).toEqual({
        name: 'ABC Distributors',
        contactPerson: null,
        phone: '0300',
        address: null,
        city: null,
        notes: null,
        opening: null,
        currencyMinorDigits: 2
      } satisfies SupplierCreateInput)
    }
  })

  it('records an opening balance the shop owes, or a supplier advance, without a typed sign', () => {
    const due = supplierFormSchema(2).safeParse(
      values({ openingAmount: '10,000', openingDate: '2026-09-01' })
    )
    expect(due.success && due.data.opening).toEqual({
      side: 'DUE',
      amountMinor: 1_000_000,
      date: '2026-09-01'
    })
    const advance = supplierFormSchema(2).safeParse(
      values({ openingAmount: '500', openingSide: 'ADVANCE' })
    )
    expect(advance.success && advance.data.opening).toEqual({
      side: 'ADVANCE',
      amountMinor: 50_000,
      date: TODAY
    })
    expect(supplierOpeningPreview({ openingAmount: '10,000', openingSide: 'DUE' }, 2)).toBe(
      1_000_000
    )
    expect(supplierOpeningPreview({ openingAmount: '500', openingSide: 'ADVANCE' }, 2)).toBe(
      -50_000
    )
    expect(supplierOpeningPreview({ openingAmount: '', openingSide: 'DUE' }, 2)).toBe(0)
    expect(supplierOpeningPreview({ openingAmount: 'x', openingSide: 'DUE' }, 2)).toBeNull()
  })

  it('requires a name, and a date for an opening balance', () => {
    expect(issuesOf(supplierFormSchema(2).safeParse(values({ name: ' ' })))).toEqual({
      name: ['Enter the supplier name.']
    })
    expect(
      issuesOf(supplierFormSchema(2).safeParse(values({ openingAmount: '5', openingDate: '' })))
    ).toEqual({ openingDate: ['Enter the opening balance date.'] })
    expect(issuesOf(supplierFormSchema(2).safeParse(values({ openingAmount: '-5' })))).toEqual({
      openingAmount: ['The amount cannot be negative.']
    })
  })

  it('edits the profile only', () => {
    const form = supplierFormValues(supplier, TODAY)
    expect(form).toMatchObject({
      name: 'ABC Distributors',
      contactPerson: 'Imran',
      notes: '',
      openingAmount: ''
    })
    const parsed = supplierFormSchema(2).safeParse({ ...form, city: '' })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(toSupplierUpdateInput(1, parsed.data)).toEqual({
      id: 1,
      name: 'ABC Distributors',
      contactPerson: 'Imran',
      phone: '0300-1112233',
      address: 'Circular Road',
      city: null,
      notes: null
    })
  })

  it('puts main-process field errors on the form fields', () => {
    expect(
      serverSupplierErrors({
        name: ['Too long.'],
        'opening.date': ['Not after today.'],
        other: ['x']
      })
    ).toEqual([
      ['name', 'Too long.'],
      ['openingDate', 'Not after today.'],
      ['root', 'x']
    ])
  })
})

describe('supplier balance adjustment form', () => {
  it('signs nothing itself: a direction and a positive amount, with a reason', () => {
    const parsed = supplierAdjustmentFormSchema(2).safeParse({
      ...emptySupplierAdjustmentForm(TODAY),
      direction: 'DECREASE',
      amount: '1,000',
      reason: ' Discount agreed '
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(toSupplierAdjustmentInput(parsed.data, 1, 2)).toEqual({
      supplierId: 1,
      entryDate: TODAY,
      direction: 'DECREASE',
      amountMinor: 100_000,
      reason: 'Discount agreed',
      currencyMinorDigits: 2
    })
  })

  it('refuses a missing direction, a zero amount and a missing reason', () => {
    expect(
      issuesOf(
        supplierAdjustmentFormSchema(2).safeParse({
          ...emptySupplierAdjustmentForm(TODAY),
          amount: '0'
        })
      )
    ).toEqual({
      direction: ['Choose whether the shop owes the supplier more or less.'],
      amount: ['Enter an amount greater than zero.'],
      reason: ['Enter the reason.']
    })
  })

  it('previews the balance after the adjustment', () => {
    expect(supplierAdjustmentPreview(1_000, { direction: 'INCREASE', amount: '5' }, 2)).toBe(1_500)
    expect(supplierAdjustmentPreview(1_000, { direction: 'DECREASE', amount: '15' }, 2)).toBe(-500)
    expect(supplierAdjustmentPreview(1_000, { direction: '', amount: '5' }, 2)).toBeNull()
    expect(supplierAdjustmentPreview(1_000, { direction: 'INCREASE', amount: 'x' }, 2)).toBeNull()
    expect(serverSupplierAdjustmentErrors({ amountMinor: ['Too large.'] })).toEqual([
      ['amount', 'Too large.']
    ])
  })
})

describe('Pay Supplier form', () => {
  it('starts dated today, in cash, with the chosen supplier when there is one', () => {
    expect(emptySupplierPaymentForm(TODAY)).toMatchObject({
      supplierId: null,
      paymentDate: TODAY,
      method: 'CASH'
    })
    expect(withSupplier(emptySupplierPaymentForm(TODAY), supplier)).toMatchObject({
      supplierId: 1,
      supplierLabel: 'SUP-00001 ABC Distributors'
    })
  })

  it('turns the typed payment into the IPC input, and requires a supplier and an amount above zero', () => {
    const parsed = supplierPaymentFormSchema(2).safeParse({
      ...withSupplier(emptySupplierPaymentForm(TODAY), supplier),
      amount: '15,000',
      method: 'CHEQUE',
      reference: ' CHQ-9 '
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(toSupplierPaymentInput(parsed.data, 'request-0001', 2)).toEqual({
      requestId: 'request-0001',
      supplierId: 1,
      paymentDate: TODAY,
      amountMinor: 1_500_000,
      method: 'CHEQUE',
      reference: 'CHQ-9',
      note: null,
      currencyMinorDigits: 2
    } satisfies SupplierPaymentCreateInput)
    expect(
      issuesOf(
        supplierPaymentFormSchema(2).safeParse({ ...emptySupplierPaymentForm(TODAY), amount: '' })
      )
    ).toEqual({
      supplierId: ['Choose the supplier.'],
      amount: ['Enter the amount paid.']
    })
  })

  it('previews the balance after the payment, and the supplier advance an overpayment creates', () => {
    expect(supplierPaymentPreview(1_000_000, '15,000', 2)).toEqual({
      amountMinor: 1_500_000,
      balanceAfterMinor: -500_000,
      advanceMinor: 500_000
    })
    expect(supplierPaymentPreview(1_000_000, '5,000', 2)).toEqual({
      amountMinor: 500_000,
      balanceAfterMinor: 500_000,
      advanceMinor: null
    })
    expect(supplierPaymentPreview(-100, '1', 2).advanceMinor).toBe(100)
    expect(supplierPaymentPreview(0, '0', 2).amountMinor).toBeNull()
    expect(serverSupplierPaymentErrors({ paymentDate: ['Too early.'] })).toEqual([
      ['paymentDate', 'Too early.']
    ])
  })
})

describe('supplier actions', () => {
  const summary: SupplierPaymentSummary = {
    id: 3,
    paymentNo: 'SPAY-000003',
    paymentDate: TODAY,
    supplierId: 1,
    supplierCode: 'SUP-00001',
    supplierName: 'ABC Distributors',
    amountMinor: 1_500_000,
    method: 'CASH',
    reference: null,
    status: 'POSTED',
    receiptId: null,
    receiptNo: null,
    createdAt: '2026-09-16T10:00:00.000Z'
  }
  const saved: SupplierPaymentSaveResult = {
    ...summary,
    id: 4,
    paymentNo: 'SPAY-000004',
    supplierActive: true,
    note: null,
    receiptStatus: null,
    voidReason: null,
    voidDate: null,
    voidedAt: null,
    balanceAfterMinor: 2_500_000,
    replayed: false
  }
  const input: SupplierPaymentCreateInput = {
    requestId: 'request-0001',
    supplierId: 1,
    paymentDate: TODAY,
    amountMinor: 1_500_000,
    method: 'CASH',
    reference: null,
    note: null,
    currencyMinorDigits: 2
  }

  function paymentsApi(
    duplicates: SupplierPaymentSummary[],
    created: Result<SupplierPaymentSaveResult> = { ok: true, data: saved }
  ): {
    calls: string[]
    checkDuplicate: () => Promise<Result<DuplicateSupplierPaymentCheck>>
    create: (sent: SupplierPaymentCreateInput) => Promise<Result<SupplierPaymentSaveResult>>
  } {
    const calls: string[] = []
    return {
      calls,
      checkDuplicate: async () => {
        calls.push('checkDuplicate')
        return { ok: true, data: { duplicates } }
      },
      create: async (sent) => {
        calls.push(`create ${sent.requestId}`)
        return created
      }
    }
  }

  type PaymentHandlers = Parameters<typeof submitSupplierPayment>[2]
  const handlers = (overrides: Partial<PaymentHandlers> = {}): PaymentHandlers => ({
    confirmDuplicate: async () => true,
    onSaved: () => undefined,
    onFieldError: () => undefined,
    notify: recorder(),
    currency: RS,
    ...overrides
  })

  it('pays at once when no similar payment exists, and reports the supplier balance', async () => {
    const notify = recorder()
    const target = paymentsApi([])
    expect(await submitSupplierPayment(target, input, handlers({ notify }))).toBe('saved')
    expect(target.calls).toEqual(['checkDuplicate', 'create request-0001'])
    expect(notify.messages).toEqual([
      'success: Payment SPAY-000004 saved. Supplier balance now: Rs 25,000.00 Due.'
    ])
  })

  it('warns about a possible duplicate: Cancel saves nothing, Continue saves with the same request id', async () => {
    const cancelled = paymentsApi([summary])
    expect(
      await submitSupplierPayment(
        cancelled,
        input,
        handlers({ confirmDuplicate: async () => false })
      )
    ).toBe('cancelled')
    expect(cancelled.calls).toEqual(['checkDuplicate'])
    const continued = paymentsApi([summary])
    const shown: SupplierPaymentSummary[][] = []
    const outcome = await submitSupplierPayment(
      continued,
      input,
      handlers({
        confirmDuplicate: async (found) => {
          shown.push([...found])
          return true
        }
      })
    )
    expect(outcome).toBe('saved')
    expect(shown).toEqual([[summary]])
    expect(continued.calls).toEqual(['checkDuplicate', 'create request-0001'])
  })

  it('says so when a retry returned the payment already saved', async () => {
    const notify = recorder()
    await submitSupplierPayment(
      paymentsApi([], { ok: true, data: { ...saved, replayed: true } }),
      input,
      handlers({ notify })
    )
    expect(notify.messages).toEqual([
      'success: Payment SPAY-000004 was already saved. Supplier balance now: Rs 25,000.00 Due.'
    ])
  })

  it('puts a refused payment on its fields, and hides raw IPC failures', async () => {
    const notify = recorder()
    const fields: Array<[string, string]> = []
    const refused = paymentsApi([], {
      ok: false,
      error: {
        code: 'DATE_NOT_ALLOWED',
        message:
          'SUP-00001 ABC Distributors has account activity on 12-Sep-2026. Use that date or later.',
        fieldErrors: { paymentDate: ['Use 12-Sep-2026 or later.'] }
      }
    })
    expect(
      await submitSupplierPayment(
        refused,
        input,
        handlers({ notify, onFieldError: (path, message) => fields.push([path, message]) })
      )
    ).toBe('failed')
    expect(fields).toEqual([['paymentDate', 'Use 12-Sep-2026 or later.']])
    const broken = {
      checkDuplicate: async () => {
        throw new Error('IPC down')
      },
      create: async () => ({ ok: true, data: saved }) as Result<SupplierPaymentSaveResult>
    }
    const hidden = recorder()
    expect(await submitSupplierPayment(broken, input, handlers({ notify: hidden }))).toBe('failed')
    expect(hidden.messages).toEqual(['error: The payment could not be saved. Try again.'])
  })

  it('voids a payment and reports the balance, or returns null with the refusal', async () => {
    const notify = recorder()
    const voided: SupplierPaymentVoidResult = {
      ...saved,
      status: 'VOID',
      balanceAfterMinor: 4_000_000
    }
    expect(
      await submitSupplierPaymentVoid(
        { void: async () => ({ ok: true, data: voided }) },
        { id: 4, reason: 'Returned' },
        notify,
        RS
      )
    ).toEqual(voided)
    expect(
      await submitSupplierPaymentVoid(
        {
          void: async () => ({
            ok: false,
            error: {
              code: 'FORBIDDEN_STATE',
              message: 'Supplier payment SPAY-000004 is already void.'
            }
          })
        },
        { id: 4, reason: 'Again' },
        notify,
        RS
      )
    ).toBeNull()
    expect(
      await submitSupplierPaymentVoid(
        {
          void: async () => {
            throw new Error('down')
          }
        },
        { id: 4, reason: 'x' },
        notify,
        RS
      )
    ).toBeNull()
    expect(notify.messages).toEqual([
      'success: Payment SPAY-000004 voided. Supplier balance now: Rs 40,000.00 Due.',
      'error: Supplier payment SPAY-000004 is already void.',
      'error: The payment could not be voided. Try again.'
    ])
  })

  it('saves a supplier, deactivates it, and adjusts its balance through window.api', async () => {
    const notify = recorder()
    const savedSuppliers: Supplier[] = []
    const fields: Array<[string, string]> = []
    const api = {
      create: async () => ({ ok: true, data: supplier }) as Result<Supplier>,
      update: async () =>
        ({
          ok: false,
          error: {
            code: 'VALIDATION',
            message: 'Check the name.',
            fieldErrors: { name: ['Too long.'] }
          }
        }) as Result<Supplier>
    }
    const handlersOf = {
      onSaved: (item: Supplier) => savedSuppliers.push(item),
      onFieldError: (path: string, message: string) => fields.push([path, message]),
      notify
    }
    const profile = {
      name: 'ABC Distributors',
      contactPerson: null,
      phone: null,
      address: null,
      city: null,
      notes: null
    }
    const create = toSupplierCreateInput({ ...profile, opening: null }, 2)
    expect(await saveSupplier(api, { mode: 'create', input: create }, handlersOf)).toBe(true)
    const update = toSupplierUpdateInput(1, { ...profile, opening: null })
    expect(await saveSupplier(api, { mode: 'update', input: update }, handlersOf)).toBe(false)
    expect(savedSuppliers).toEqual([supplier])
    expect(fields).toEqual([['name', 'Too long.']])
    expect(
      await toggleSupplierActive(
        { setActive: async () => ({ ok: true, data: { ...supplier, isActive: false } }) },
        { id: 1, code: 'SUP-00001', active: false },
        notify
      )
    ).toBe(true)
    const adjusted: SupplierBalanceAdjustmentResult = {
      entry: ledgerRow({
        type: 'ADJUSTMENT',
        amountMinor: -100_000,
        runningBalanceMinor: 3_900_000,
        note: 'Discount'
      }),
      supplier: { ...supplier, balanceMinor: 3_900_000 }
    }
    expect(
      await submitSupplierAdjustment(
        { adjustBalance: async () => ({ ok: true, data: adjusted }) },
        {
          supplierId: 1,
          entryDate: TODAY,
          direction: 'DECREASE',
          amountMinor: 100_000,
          reason: 'Discount',
          currencyMinorDigits: 2
        },
        { onSaved: () => undefined, onFieldError: () => undefined, notify, currency: RS }
      )
    ).toBe(true)
    expect(notify.messages).toEqual([
      'success: Supplier SUP-00001 ABC Distributors added.',
      'error: Check the name.',
      'success: Supplier SUP-00001 deactivated.',
      'success: Supplier balance adjusted. New balance: Rs 39,000.00 Due.'
    ])
  })
})
