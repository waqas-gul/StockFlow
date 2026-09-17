import { describe, expect, it } from 'vitest'
import type {
  InvoicePdfResult,
  InvoicePrintInput,
  InvoicePrintResult,
  PrintableInvoiceLine
} from '@shared/invoice-print'
import type { Result } from '@shared/types/result'
import {
  freeQuantityText,
  invoicePageCss,
  lineDiscount,
  printBalance,
  printColumns,
  printMoney,
  printQuantityRows,
  submitInvoicePdf,
  submitInvoicePrint
} from './invoice-print'
import type { InvoiceNotifier } from './invoice-history'
import { printableInvoice } from './invoice-test-data'

const PKR = { code: 'PKR', symbol: 'Rs', minorDigits: 2 }
const [tea, sugar] = printableInvoice().lines

function recorder(): InvoiceNotifier & { messages: string[] } {
  const messages: string[] = []
  return {
    messages,
    success: (message) => messages.push(`success: ${message}`),
    error: (message) => messages.push(`error: ${message}`)
  }
}

describe('printed amounts', () => {
  it('writes amounts without the symbol, in the currency decimal places', () => {
    expect(printMoney(570_000, PKR)).toBe('5,700.00')
    expect(printMoney(0, PKR)).toBe('0.00')
    expect(printMoney(1_250, { ...PKR, minorDigits: 0 })).toBe('1,250')
  })

  it('writes a balance the customer does not owe as an advance', () => {
    expect(printBalance(100_000, PKR)).toBe('1,000.00')
    expect(printBalance(0, PKR)).toBe('0.00')
    expect(printBalance(-25_050, PKR)).toBe('250.50 Advance')
  })
})

describe('printed quantities', () => {
  it('prints each saved quantity row with its own price, by the saved short name when there is one', () => {
    expect(printQuantityRows(tea, PKR)).toEqual([
      { quantity: '2 Box', price: '2,400.00' },
      { quantity: '5 Pc', price: '110.00' }
    ])
    expect(printQuantityRows(sugar, PKR)).toEqual([{ quantity: '10 Kg', price: '160.00' }])
  })

  it('prints free scheme goods in the line’s saved units, or in base units when those cannot express them', () => {
    expect(freeQuantityText(tea)).toBe('3 Pc')
    expect(freeQuantityText({ ...tea, schemeQtyBase: 26 })).toBe('1 Box + 2 Pc')
    const boxesOnly: PrintableInvoiceLine = { ...tea, quantities: [tea.quantities[0]] }
    expect(freeQuantityText({ ...boxesOnly, schemeQtyBase: 24 })).toBe('1 Box')
    expect(freeQuantityText({ ...boxesOnly, schemeQtyBase: 3 })).toBe('3 base units')
    expect(freeQuantityText(sugar)).toBeNull()
  })

  it('prints a discount as its amount, with the percentage when one was entered', () => {
    expect(lineDiscount(tea, PKR)).toEqual({ amount: '267.50', percent: '5%' })
    expect(lineDiscount({ ...tea, discountBps: 250, discountMinor: 13_375 }, PKR)).toEqual({
      amount: '133.75',
      percent: '2.5%'
    })
    expect(lineDiscount(sugar, PKR)).toEqual({ amount: '50.00', percent: null })
    expect(lineDiscount({ ...sugar, discountMinor: 0 }, PKR)).toBeNull()
    expect(lineDiscount({ ...tea, discountBps: 0, discountMinor: 0 }, PKR)).toBeNull()
  })

  it('leaves out the Discount, Ctn and Sch columns only when no line has one', () => {
    expect(printColumns([tea, sugar])).toEqual({ discount: true, ctn: true, scheme: true })
    expect(printColumns([sugar])).toEqual({ discount: true, ctn: false, scheme: false })
    const plain = { ...sugar, discountMinor: 0 }
    expect(printColumns([plain])).toEqual({ discount: false, ctn: false, scheme: false })
    expect(printColumns([{ ...plain, ctnCount: 0 }])).toMatchObject({ ctn: true })
    expect(printColumns([{ ...plain, schemeQtyBase: 2 }])).toMatchObject({ scheme: true })
  })
})

describe('invoicePageCss', () => {
  it('sets the paper, its margins and a numbered footer with the invoice number', () => {
    const a4 = invoicePageCss('A4', 'INV-000001')
    expect(a4).toContain('size: A4 portrait;')
    expect(a4).toContain('margin: 12mm 12mm 14mm;')
    expect(a4).toContain('content: "INV-000001";')
    expect(a4).toContain('content: "Page " counter(page) " of " counter(pages);')
    const a5 = invoicePageCss('A5', 'INV-000001')
    expect(a5).toContain('size: A5 portrait;')
    expect(a5).toContain('margin: 8mm 8mm 10mm;')
  })

  it('keeps the invoice number inside its CSS string', () => {
    expect(invoicePageCss('A4', 'A"B\\C}')).toContain('content: "A\\22 B\\5c C}";')
  })
})

describe('submitInvoicePrint', () => {
  const input: InvoicePrintInput = { id: 1, paperSize: 'A4' }

  function api(result: Result<InvoicePrintResult> | Error): {
    print(input: InvoicePrintInput): Promise<Result<InvoicePrintResult>>
  } {
    return {
      print: async () => {
        if (result instanceof Error) throw result
        return result
      }
    }
  }

  it('says the invoice was sent to the printer, and nothing when printing was cancelled', async () => {
    const notify = recorder()
    const sent = api({ ok: true, data: { status: 'SENT' } })
    await expect(submitInvoicePrint(sent, input, 'INV-000001', notify)).resolves.toBe('SENT')
    const cancelled = api({ ok: true, data: { status: 'CANCELLED' } })
    await expect(submitInvoicePrint(cancelled, input, 'INV-000001', notify)).resolves.toBe(
      'CANCELLED'
    )
    expect(notify.messages).toEqual(['success: INV-000001 was sent to the printer.'])
  })

  it('shows a refusal, and never the raw error of a failed call', async () => {
    const notify = recorder()
    const refused = api({
      ok: false,
      error: { code: 'PRINT_FAILED', message: 'INV-000001 could not be printed.' }
    })
    await expect(submitInvoicePrint(refused, input, 'INV-000001', notify)).resolves.toBeNull()
    await expect(
      submitInvoicePrint(api(new Error('IPC channel closed')), input, 'INV-000001', notify)
    ).resolves.toBeNull()
    expect(notify.messages).toEqual([
      'error: INV-000001 could not be printed.',
      'error: The invoice could not be printed. Try again.'
    ])
  })
})

describe('submitInvoicePdf', () => {
  const input: InvoicePrintInput = { id: 1, paperSize: 'A5' }

  function api(result: Result<InvoicePdfResult> | Error): {
    savePdf(input: InvoicePrintInput): Promise<Result<InvoicePdfResult>>
  } {
    return {
      savePdf: async () => {
        if (result instanceof Error) throw result
        return result
      }
    }
  }

  it('says where the PDF was saved, and nothing when the Save dialog was cancelled', async () => {
    const notify = recorder()
    const saved = api({
      ok: true,
      data: {
        status: 'SAVED',
        fileName: 'INV-000001.pdf',
        location: '%USERPROFILE%\\Documents'
      }
    })
    await expect(submitInvoicePdf(saved, input, notify)).resolves.toBe('SAVED')
    const cancelled = api({ ok: true, data: { status: 'CANCELLED' } })
    await expect(submitInvoicePdf(cancelled, input, notify)).resolves.toBe('CANCELLED')
    expect(notify.messages).toEqual(['success: Saved INV-000001.pdf in %USERPROFILE%\\Documents.'])
  })

  it('shows a refusal, and never the raw error of a failed call', async () => {
    const notify = recorder()
    const refused = api({
      ok: false,
      error: { code: 'PRINT_FAILED', message: 'INV-000001.pdf could not be saved.' }
    })
    await expect(submitInvoicePdf(refused, input, notify)).resolves.toBeNull()
    await expect(submitInvoicePdf(api(new Error('EPERM')), input, notify)).resolves.toBeNull()
    expect(notify.messages).toEqual([
      'error: INV-000001.pdf could not be saved.',
      'error: The PDF could not be saved. Try again.'
    ])
  })
})
