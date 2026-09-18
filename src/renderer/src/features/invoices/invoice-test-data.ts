// Test-only data for the Phase 9A invoice history and Phase 9B printing tests. Never imported by application code.
import type { InvoiceDetail } from '@shared/invoices'
import type { PrintableInvoice } from '@shared/invoice-print'

/**
 * INV-000001 of C-00002 Ali Raza: 2 Box + 5 Piece of tea with 3 free pieces and a 5% discount, Rs 1,000.00 received
 * with RCP-000001 (posted), sold by Iftikhar and Arshad Traders with salesman Mansoor Iqbal.
 */
export function invoiceDetail(overrides: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    id: 1,
    invoiceNo: 'INV-000001',
    invoiceDate: '2026-09-12',
    invoiceCode: 'B-17',
    status: 'POSTED',
    customerId: 2,
    customerCode: 'C-00002',
    customerName: 'Ali Raza',
    customerShopName: 'Ali Traders',
    customerPhone: '0300-1234567',
    customerAddress: 'Main Bazar',
    customerCity: 'Lahore',
    business: {
      shopName: 'Iftikhar and Arshad Traders',
      shopAddress: 'Shop 12, Main Bazar, Mingora',
      salesmanName: 'Mansoor Iqbal',
      salesmanPhone1: '03179927633',
      salesmanPhone2: '03463820629'
    },
    priceTier: 'RETAIL',
    grossMinor: 535_000,
    lineDiscountMinor: 26_750,
    lineSchemeMinor: 1_000,
    extraDiscountMinor: 250,
    netMinor: 507_000,
    freightMinor: 15_000,
    totalMinor: 522_000,
    receivedMinor: 100_000,
    previousBalanceMinor: 50_000,
    netOutstandingMinor: 472_000,
    cogsMinor: 560_000,
    biltyNo: 'BL-221',
    transportName: 'Daewoo Cargo',
    addaName: null,
    checkedBy: 'Waqas',
    notes: 'Deliver before noon',
    dispatchUpdatedAt: null,
    payment: {
      id: 7,
      paymentNo: 'RCP-000001',
      paymentDate: '2026-09-12',
      amountMinor: 100_000,
      method: 'BANK',
      reference: null,
      status: 'POSTED'
    },
    lines: [
      {
        id: 11,
        lineNo: 1,
        productId: 3,
        productCode: 'P-001',
        productName: 'Tea 950g',
        companyName: 'Tapal',
        packingLabel: '1*12*18',
        qtyBase: 56,
        schemeQtyBase: 3,
        grossMinor: 535_000,
        discountBps: 500,
        discountMinor: 26_750,
        schemeMinor: 1_000,
        ctnCount: 2,
        netMinor: 507_250,
        costMinor: 560_000,
        quantities: [
          {
            id: 21,
            unitId: 31,
            unitName: 'Box',
            unitShortName: 'Bx',
            unitBaseQty: 24,
            quantity: 2,
            unitPriceMinor: 240_000,
            amountMinor: 480_000,
            qtyBase: 48
          },
          {
            id: 22,
            unitId: 30,
            unitName: 'Piece',
            unitShortName: 'Pcs',
            unitBaseQty: 1,
            quantity: 5,
            unitPriceMinor: 11_000,
            amountMinor: 55_000,
            qtyBase: 5
          }
        ]
      }
    ],
    changes: [],
    voidReason: null,
    voidDate: null,
    voidedAt: null,
    createdAt: '2026-09-12T05:30:00.000Z',
    ...overrides
  }
}

/**
 * The printed INV-000001 of Madina Traders (salesman Hamid Ali) for Ali Raza: 2 Box + 5 Pc of tea (5% discount, Rs 100
 * scheme, 3 Pc free, 2 Ctn) and 10 Kg of sugar (Rs 50 off), Rs 32.50 extra discount, Rs 200 freight, Rs 1,000 owed
 * before and Rs 2,000 received.
 */
export function printableInvoice(overrides: Partial<PrintableInvoice> = {}): PrintableInvoice {
  return {
    id: 1,
    invoiceNo: 'INV-000001',
    invoiceCode: 'IC-7',
    invoiceDate: '2026-09-12',
    status: 'POSTED',
    voidDate: null,
    voidReason: null,
    businessName: 'Madina Traders',
    businessAddress: 'Shop 4, Circular Road, Lahore',
    salesman: { name: 'Hamid Ali', phone1: '0300-7654321', phone2: '0345-1112223' },
    currency: { code: 'PKR', symbol: 'Rs', minorDigits: 2 },
    paperSize: 'A4',
    customer: {
      name: 'Ali Raza',
      shopName: 'Ali Traders',
      phone: '0300-1234567',
      address: 'Main Bazar',
      city: 'Lahore'
    },
    dispatch: { biltyNo: 'BL-1', transportName: 'Daewoo Cargo', addaName: 'Badami Bagh' },
    checkedBy: 'Hamid',
    lines: [
      {
        lineNo: 1,
        productName: 'Tea 950g',
        packingLabel: '1*12*18',
        quantities: [
          {
            unitName: 'Box',
            unitShortName: null,
            unitBaseQty: 24,
            quantity: 2,
            unitPriceMinor: 240_000,
            amountMinor: 480_000
          },
          {
            unitName: 'Piece',
            unitShortName: 'Pc',
            unitBaseQty: 1,
            quantity: 5,
            unitPriceMinor: 11_000,
            amountMinor: 55_000
          }
        ],
        schemeQtyBase: 3,
        grossMinor: 535_000,
        discountBps: 500,
        discountMinor: 26_750,
        schemeMinor: 10_000,
        ctnCount: 2,
        netMinor: 498_250
      },
      {
        lineNo: 2,
        productName: 'Sugar',
        packingLabel: null,
        quantities: [
          {
            unitName: 'Kg',
            unitShortName: null,
            unitBaseQty: 1,
            quantity: 10,
            unitPriceMinor: 16_000,
            amountMinor: 160_000
          }
        ],
        schemeQtyBase: 0,
        grossMinor: 160_000,
        discountBps: null,
        discountMinor: 5_000,
        schemeMinor: 0,
        ctnCount: null,
        netMinor: 155_000
      }
    ],
    totals: {
      grossMinor: 695_000,
      lineDiscountMinor: 31_750,
      lineSchemeMinor: 10_000,
      extraDiscountMinor: 3_250,
      netMinor: 650_000,
      freightMinor: 20_000,
      totalMinor: 670_000,
      previousBalanceMinor: 100_000,
      receivedMinor: 200_000,
      netOutstandingMinor: 570_000
    },
    amountInWords: 'Rupees Six Thousand Seven Hundred Only',
    pdfFileName: 'INV-000001.pdf',
    ...overrides
  }
}
