// Test-only data for the Phase 11 report tests. Never imported by application code.
import type { ProfitLossReport } from '@shared/reports'

/** September 2026: one posted invoice (revenue Rs 10,000.00, COGS Rs 6,000.00) and a Rs 1,000.00 shop expense. */
export const basePl: ProfitLossReport = {
  dateFrom: '2026-09-01',
  dateTo: '2026-09-30',
  postedInvoiceCount: 1,
  goodsRevenueMinor: 1_000_000,
  cogsMinor: 600_000,
  grossProfitMinor: 400_000,
  freightIncomeMinor: 0,
  stockGainsMinor: 0,
  shopExpensesMinor: 100_000,
  generalExpensesMinor: 0,
  operatingExpensesMinor: 100_000,
  stockDamageMinor: 0,
  stockExpiryMinor: 0,
  stockShortageMinor: 0,
  stockLossesMinor: 0,
  netOperatingProfitMinor: 300_000,
  purchaseCostCorrectionsMinor: 0,
  inventoryCorrections: [
    {
      reason: 'RECEIPT_QTY_CORRECTION',
      count: 0,
      valueAddedMinor: 0,
      valueRemovedMinor: 0,
      netValueMinor: 0
    },
    {
      reason: 'RECEIPT_COST_CORRECTION',
      count: 0,
      valueAddedMinor: 0,
      valueRemovedMinor: 0,
      netValueMinor: 0
    },
    {
      reason: 'OTHER_CORRECTION',
      count: 0,
      valueAddedMinor: 0,
      valueRemovedMinor: 0,
      netValueMinor: 0
    }
  ],
  inventoryCorrectionsNetMinor: 0,
  inventoryCorrectionDetails: [],
  profitAfterDataCorrectionsMinor: 300_000,
  expenseCategories: [],
  openingStockValueMinor: 0,
  showFrozenCogsNote: false
}
