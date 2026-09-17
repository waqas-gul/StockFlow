// Test-only data for the Phase 9A invoice history tests. Never imported by application code.
import type { InvoiceDetail } from '@shared/invoices'

/**
 * INV-000001 of C-00002 Ali Raza: 2 Box + 5 Piece of tea with 3 free pieces and a 5% discount, Rs 1,000.00 received
 * with RCP-000001 (posted).
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
