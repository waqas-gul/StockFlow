import { describe, expect, it } from 'vitest'
import {
  InvoicePrintInputSchema,
  invoiceAmountInWords,
  invoicePdfFileName,
  invoicePrintPath
} from './invoice-print'

const PKR = { code: 'PKR', minorDigits: 2 }

describe('invoiceAmountInWords', () => {
  it('writes a PKR total as Rupees and Paisa in lakh and crore', () => {
    expect(invoiceAmountInWords(12_500_00, PKR)).toBe('Rupees Twelve Thousand Five Hundred Only')
    expect(invoiceAmountInWords(1_25_000_50, PKR)).toBe(
      'Rupees One Lakh Twenty Five Thousand and Paisa Fifty Only'
    )
    expect(invoiceAmountInWords(2_03_45_678_00, PKR)).toBe(
      'Rupees Two Crore Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only'
    )
    expect(invoiceAmountInWords(100, PKR)).toBe('Rupees One Only')
    expect(invoiceAmountInWords(0, PKR)).toBe('Rupees Zero Only')
    expect(invoiceAmountInWords(1250, { code: 'PKR', minorDigits: 0 })).toBe(
      'Rupees One Thousand Two Hundred Fifty Only'
    )
  })

  it('writes another currency with its code, international numbering and the minor part as a fraction', () => {
    const usd = { code: 'USD', minorDigits: 2 }
    expect(invoiceAmountInWords(1_250_000_00, usd)).toBe(
      'USD One Million Two Hundred Fifty Thousand Only'
    )
    expect(invoiceAmountInWords(1_250_75, usd)).toBe(
      'USD One Thousand Two Hundred Fifty and 75/100 Only'
    )
    expect(invoiceAmountInWords(5, usd)).toBe('USD Zero and 05/100 Only')
    expect(invoiceAmountInWords(1250, { code: 'KWD', minorDigits: 3 })).toBe(
      'KWD One and 250/1000 Only'
    )
  })
})

describe('invoicePdfFileName', () => {
  it('is the invoice number with .pdf', () => {
    expect(invoicePdfFileName('INV-000123')).toBe('INV-000123.pdf')
    expect(invoicePdfFileName('S.2026_0042')).toBe('S.2026_0042.pdf')
  })

  it('never contains a character Windows refuses in a file name', () => {
    expect(invoicePdfFileName('INV/01:02*"<>|?\\x')).toBe('INV-01-02-------x.pdf')
    expect(invoicePdfFileName('INV\u000001. ')).toBe('INV-01.pdf')
    expect(invoicePdfFileName('   ')).toBe('Invoice.pdf')
  })
})

describe('invoicePrintPath', () => {
  it('is the print preview route of the invoice', () => {
    expect(invoicePrintPath(12)).toBe('/invoices/12/print')
  })
})

describe('InvoicePrintInputSchema', () => {
  it('takes an invoice id and A4 or A5 only', () => {
    expect(InvoicePrintInputSchema.parse({ id: 3, paperSize: 'A5' })).toEqual({
      id: 3,
      paperSize: 'A5'
    })
    for (const input of [
      { id: 3, paperSize: 'Letter' },
      { id: 3 },
      { id: '3', paperSize: 'A4' },
      { id: 0, paperSize: 'A4' },
      { id: 3, paperSize: 'A4', path: 'C:\\Users\\x.pdf' },
      { id: 3, paperSize: 'A4', fileName: 'x.pdf' },
      'C:\\x.pdf',
      null
    ]) {
      expect(InvoicePrintInputSchema.safeParse(input).success).toBe(false)
    }
  })
})
