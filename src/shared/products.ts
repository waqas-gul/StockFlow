import { z } from 'zod'
import { MAX_MINOR_DIGITS } from './domain/guards'
import { validateUnits, type UnitIssue } from './domain/quantity'
import { IdSchema, MinorAmountSchema, optionalText, requiredText, wholeNumber } from './validation'

/*
 * Products and their units (plan §7.3, §9.2). Stock is counted in the base unit; every other unit holds a whole number
 * of base units, and the sizes must nest (validateUnits). The packing label ("1*12*18") is display text only: it is
 * never parsed and never used for units or stock. Prices and costs are integer minor units; null means that price is
 * not set for the unit.
 *
 * The same schemas validate the Products form (renderer) and every IPC request (main process).
 */

export const PRODUCT_CODE_MAX = 30
export const PRODUCT_NAME_MAX = 120
export const PACKING_LABEL_MAX = 40
export const UNIT_NAME_MAX = 30
export const UNIT_SHORT_NAME_MAX = 12
export const MAX_UNITS_PER_PRODUCT = 10
export const MAX_BASE_QTY = 1_000_000
export const MAX_LOW_STOCK_THRESHOLD = 1_000_000_000
export const MAX_PRODUCT_PAGE_SIZE = 100
export const MAX_SEARCH_LIMIT = 50

/** Shown when a product that still has stock is deactivated. */
export const DEACTIVATE_WITH_STOCK_WARNING =
  'This product still has stock. It will be hidden from normal sales selection but its stock and history will remain.'

export const ProductUnitInputSchema = z.strictObject({
  /** The saved unit's id; null for a new unit. */
  id: IdSchema.nullable(),
  name: requiredText('unit name', UNIT_NAME_MAX),
  shortName: optionalText(UNIT_SHORT_NAME_MAX),
  baseQty: wholeNumber(1, MAX_BASE_QTY),
  isBase: z.boolean(),
  canSell: z.boolean(),
  canPurchase: z.boolean(),
  wholesalePriceMinor: MinorAmountSchema,
  retailPriceMinor: MinorAmountSchema,
  defaultCostMinor: MinorAmountSchema,
  isActive: z.boolean()
})
export type ProductUnitInput = z.output<typeof ProductUnitInputSchema>

const productFields = {
  code: requiredText('product code', PRODUCT_CODE_MAX),
  name: requiredText('product name', PRODUCT_NAME_MAX),
  companyId: IdSchema.nullable(),
  packingLabel: optionalText(PACKING_LABEL_MAX),
  lowStockThresholdBase: wholeNumber(0, MAX_LOW_STOCK_THRESHOLD),
  /** The currency decimal places the amounts were entered with; must match the current setting. */
  currencyMinorDigits: z.number().int().min(0).max(MAX_MINOR_DIGITS),
  /** In display order. */
  units: z
    .array(ProductUnitInputSchema)
    .min(1, 'Add at least one unit.')
    .max(MAX_UNITS_PER_PRODUCT, `Use at most ${MAX_UNITS_PER_PRODUCT} units.`)
}

/** `window.api.products.create(...)`: every unit is new. */
export const ProductCreateSchema = z.strictObject(productFields).superRefine((product, ctx) => {
  product.units.forEach((unit, index) => {
    if (unit.id !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['units', index, 'id'],
        message: 'A new product has only new units.'
      })
    }
  })
  addUnitIssues(product.units, ctx)
})
export type ProductCreateInput = z.output<typeof ProductCreateSchema>

/** `window.api.products.update(...)`: saved units keep their id; units left out are removed. */
export const ProductUpdateSchema = z
  .strictObject({ id: IdSchema, ...productFields })
  .superRefine((product, ctx) => {
    const seen = new Set<number>()
    product.units.forEach((unit, index) => {
      if (unit.id === null) return
      if (seen.has(unit.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['units', index, 'id'],
          message: 'A unit appears twice.'
        })
      }
      seen.add(unit.id)
    })
    addUnitIssues(product.units, ctx)
  })
export type ProductUpdateInput = z.output<typeof ProductUpdateSchema>

export type ProductStatusFilter = 'active' | 'inactive' | 'all'

/** `window.api.products.list(...)`: one page of the Products table. */
export const ProductListInputSchema = z.strictObject({
  page: wholeNumber(1, 1_000_000),
  pageSize: wholeNumber(1, MAX_PRODUCT_PAGE_SIZE),
  /** Words matched against the code, name and company name (every word must match one of them). */
  search: z.string().trim().max(100, 'Use at most 100 characters.'),
  companyId: IdSchema.nullable(),
  status: z.enum(['active', 'inactive', 'all'])
})
export type ProductListInput = z.output<typeof ProductListInputSchema>

/** `window.api.products.search(...)`: quick lookup by code, name or company (for later keyboard selection). */
export const ProductSearchInputSchema = z.strictObject({
  query: z.string().trim().max(100, 'Use at most 100 characters.'),
  limit: wholeNumber(1, MAX_SEARCH_LIMIT),
  includeInactive: z.boolean()
})
export type ProductSearchInput = z.output<typeof ProductSearchInputSchema>

export const ProductIdSchema = IdSchema

export interface ProductUnit {
  readonly id: number
  readonly name: string
  readonly shortName: string | null
  readonly baseQty: number
  readonly isBase: boolean
  readonly canSell: boolean
  readonly canPurchase: boolean
  readonly wholesalePriceMinor: number | null
  readonly retailPriceMinor: number | null
  readonly defaultCostMinor: number | null
  readonly sortOrder: number
  readonly isActive: boolean
}

/** A row of the Products table. */
export interface ProductListItem {
  readonly id: number
  readonly code: string
  readonly name: string
  readonly companyId: number | null
  readonly companyName: string | null
  readonly companyActive: boolean | null
  readonly packingLabel: string | null
  readonly lowStockThresholdBase: number
  readonly isActive: boolean
  /** From v_product_stock, in base units. */
  readonly stockQtyBase: number
  /** In display order. */
  readonly units: readonly ProductUnit[]
}

export interface ProductListPage {
  readonly items: readonly ProductListItem[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

/** One product for the edit form. */
export interface Product extends ProductListItem {
  /** True once any stock movement exists: base quantities and the base unit are then locked. */
  readonly hasStockMovements: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ProductSearchItem {
  readonly id: number
  readonly code: string
  readonly name: string
  readonly companyName: string | null
  readonly packingLabel: string | null
  readonly isActive: boolean
}

export interface ProductActiveResult {
  readonly id: number
  readonly isActive: boolean
  readonly stockQtyBase: number
  /** DEACTIVATE_WITH_STOCK_WARNING when a product with stock was deactivated. */
  readonly warning: string | null
}

/** The fields of a unit that decide its structure. */
export interface UnitShape {
  readonly name: string
  readonly baseQty: number
  readonly isBase: boolean
  readonly isActive: boolean
}

export interface UnitStructureIssue {
  /** `['units']` for the set as a whole, or `['units', index, field]`. */
  readonly path: readonly (string | number)[]
  readonly message: string
}

/**
 * The structure problems of a product's units, with plain messages and the field each one belongs to: exactly one
 * base unit, with base quantity 1 and always active; different names and base quantities; sizes that nest (the
 * Phase 2 rule of validateUnits). Field-level problems (a blank name, a base quantity that is not a whole number) are
 * the unit schema's.
 */
export function unitStructureIssues(units: readonly UnitShape[]): UnitStructureIssue[] {
  const valid = units.every(
    (unit) => unit.name.trim() !== '' && Number.isSafeInteger(unit.baseQty) && unit.baseQty >= 1
  )
  if (!valid) return []
  const issues: UnitStructureIssue[] = []
  const seen = new Set<string>()
  const add = (path: readonly (string | number)[], message: string): void => {
    const key = `${path.join('.')}|${message}`
    if (!seen.has(key)) issues.push({ path, message })
    seen.add(key)
  }
  const definitions = units.map((unit, index) => ({
    id: index,
    name: unit.name,
    baseQty: unit.baseQty,
    isBase: unit.isBase
  }))
  for (const issue of validateUnits(definitions)) {
    for (const [path, message] of describeIssue(issue, units)) add(path, message)
  }
  units.forEach((unit, index) => {
    if (unit.isBase && !unit.isActive) {
      add(['units', index, 'isActive'], 'The base unit is always active.')
    }
  })
  return issues
}

function describeIssue(
  issue: UnitIssue,
  units: readonly UnitShape[]
): Array<[readonly (string | number)[], string]> {
  const indexes = issue.unitIds.map(Number)
  switch (issue.code) {
    case 'NO_UNITS':
      return [[['units'], 'Add at least one unit.']]
    case 'NO_BASE_UNIT':
      return [[['units'], 'Choose the base unit: the smallest unit stock is counted in.']]
    case 'MULTIPLE_BASE_UNITS':
      return [[['units'], 'Only one unit can be the base unit.']]
    case 'BASE_UNIT_QTY_NOT_ONE':
      return indexes.map((index) => [
        ['units', index, 'baseQty'],
        'The base unit always has base quantity 1.'
      ])
    case 'DUPLICATE_NAME':
      return indexes.map((index) => [['units', index, 'name'], 'Each unit needs a different name.'])
    case 'DUPLICATE_BASE_QTY':
      return indexes.map((index) => [
        ['units', index, 'baseQty'],
        'Each unit needs a different base quantity.'
      ])
    case 'NOT_NESTED': {
      const [smaller, larger] = indexes
      return [
        [
          ['units', larger, 'baseQty'],
          `Must be a whole multiple of ${units[smaller].baseQty.toLocaleString('en-US')} (${units[smaller].name.trim()}).`
        ]
      ]
    }
    default:
      // EMPTY_NAME, INVALID_BASE_QTY and DUPLICATE_ID cannot occur here (checked before, ids are indexes).
      return []
  }
}

function addUnitIssues(units: readonly ProductUnitInput[], ctx: z.RefinementCtx): void {
  for (const issue of unitStructureIssues(units)) {
    ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message })
  }
}
