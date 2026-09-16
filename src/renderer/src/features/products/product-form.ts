import { z } from 'zod'
import { formatMoney } from '@shared/domain'
import {
  MAX_BASE_QTY,
  MAX_LOW_STOCK_THRESHOLD,
  MAX_UNITS_PER_PRODUCT,
  PACKING_LABEL_MAX,
  PRODUCT_CODE_MAX,
  PRODUCT_NAME_MAX,
  UNIT_NAME_MAX,
  UNIT_SHORT_NAME_MAX,
  unitStructureIssues,
  type Product,
  type ProductCreateInput,
  type ProductUnitInput,
  type ProductUpdateInput
} from '@shared/products'
import { requiredText } from '@shared/validation'
import { moneyText, optionalText, wholeNumberText } from '@renderer/lib/form-text'

/*
 * The Add/Edit Product form. The user types amounts and quantities as text ("1,250.50"); the form parses them with the
 * Phase 2 money parser into integer minor units, checks the unit structure with the shared rules, and sends the same
 * shape the main process validates again. Field names match the main process fields, so its errors land on the form.
 */

/** The company select's value for "no company". */
export const NO_COMPANY = 'none'

export interface UnitFormRow {
  /** Identifies the row in the form (the base unit choice refers to it). */
  rowKey: string
  /** The saved unit's id; null for a new unit. */
  unitId: number | null
  name: string
  shortName: string
  baseQty: string
  canSell: boolean
  canPurchase: boolean
  wholesalePriceMinor: string
  retailPriceMinor: string
  defaultCostMinor: string
  isActive: boolean
}

export interface ProductFormValues {
  code: string
  name: string
  /** NO_COMPANY or a company id. */
  companyId: string
  packingLabel: string
  lowStockThresholdBase: string
  /** The rowKey of the base unit. */
  baseRowKey: string
  units: UnitFormRow[]
}

/** What the form produces: the product input without the currency check. */
export type ProductDraft = Omit<ProductCreateInput, 'currencyMinorDigits'>

let rowCounter = 0

export function newUnitRow(): UnitFormRow {
  rowCounter += 1
  return {
    rowKey: `unit-${rowCounter}`,
    unitId: null,
    name: '',
    shortName: '',
    baseQty: '',
    canSell: true,
    canPurchase: true,
    wholesalePriceMinor: '',
    retailPriceMinor: '',
    defaultCostMinor: '',
    isActive: true
  }
}

/** A new product: one row, which is the base unit. */
export function emptyProductForm(): ProductFormValues {
  const base = { ...newUnitRow(), baseQty: '1' }
  return {
    code: '',
    name: '',
    companyId: NO_COMPANY,
    packingLabel: '',
    lowStockThresholdBase: '0',
    baseRowKey: base.rowKey,
    units: [base]
  }
}

export function productToFormValues(product: Product, minorDigits: number): ProductFormValues {
  const units = product.units.map((unit) => ({
    ...newUnitRow(),
    unitId: unit.id,
    name: unit.name,
    shortName: unit.shortName ?? '',
    baseQty: String(unit.baseQty),
    canSell: unit.canSell,
    canPurchase: unit.canPurchase,
    wholesalePriceMinor: amountText(unit.wholesalePriceMinor, minorDigits),
    retailPriceMinor: amountText(unit.retailPriceMinor, minorDigits),
    defaultCostMinor: amountText(unit.defaultCostMinor, minorDigits),
    isActive: unit.isActive
  }))
  const baseIndex = product.units.findIndex((unit) => unit.isBase)
  return {
    code: product.code,
    name: product.name,
    companyId: product.companyId === null ? NO_COMPANY : String(product.companyId),
    packingLabel: product.packingLabel ?? '',
    lowStockThresholdBase: String(product.lowStockThresholdBase),
    baseRowKey: units[Math.max(baseIndex, 0)]?.rowKey ?? '',
    units
  }
}

/** The form's rules, with amounts parsed for a currency of `minorDigits` decimal places. */
export function productFormSchema(minorDigits: number): z.ZodType<ProductDraft, ProductFormValues> {
  const money = moneyText(minorDigits)
  const unitRow = z.object({
    rowKey: z.string(),
    unitId: z.number().nullable(),
    name: requiredText('unit name', UNIT_NAME_MAX),
    shortName: optionalText(UNIT_SHORT_NAME_MAX),
    baseQty: wholeNumberText(1, MAX_BASE_QTY),
    canSell: z.boolean(),
    canPurchase: z.boolean(),
    wholesalePriceMinor: money,
    retailPriceMinor: money,
    defaultCostMinor: money,
    isActive: z.boolean()
  })
  return z
    .object({
      code: requiredText('product code', PRODUCT_CODE_MAX),
      name: requiredText('product name', PRODUCT_NAME_MAX),
      companyId: z.string(),
      packingLabel: optionalText(PACKING_LABEL_MAX),
      lowStockThresholdBase: wholeNumberText(0, MAX_LOW_STOCK_THRESHOLD),
      baseRowKey: z.string(),
      units: z
        .array(unitRow)
        .min(1, 'Add at least one unit.')
        .max(MAX_UNITS_PER_PRODUCT, `Use at most ${MAX_UNITS_PER_PRODUCT} units.`)
    })
    .transform((values, ctx): ProductDraft => {
      const units: ProductUnitInput[] = values.units.map((unit) => ({
        id: unit.unitId,
        name: unit.name,
        shortName: unit.shortName,
        baseQty: unit.baseQty,
        isBase: unit.rowKey === values.baseRowKey,
        canSell: unit.canSell,
        canPurchase: unit.canPurchase,
        wholesalePriceMinor: unit.wholesalePriceMinor,
        retailPriceMinor: unit.retailPriceMinor,
        defaultCostMinor: unit.defaultCostMinor,
        isActive: unit.isActive
      }))
      for (const issue of unitStructureIssues(units)) {
        ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message })
      }
      return {
        code: values.code,
        name: values.name,
        companyId: values.companyId === NO_COMPANY ? null : Number(values.companyId),
        packingLabel: values.packingLabel,
        lowStockThresholdBase: values.lowStockThresholdBase,
        units
      }
    })
}

export function toCreateInput(draft: ProductDraft, minorDigits: number): ProductCreateInput {
  return { ...draft, currencyMinorDigits: minorDigits }
}

export function toUpdateInput(
  id: number,
  draft: ProductDraft,
  minorDigits: number
): ProductUpdateInput {
  return { id, ...draft, currencyMinorDigits: minorDigits }
}

/** The rows after `rowKey` becomes the base unit: its base quantity is always 1. */
export function chooseBaseRow(units: readonly UnitFormRow[], rowKey: string): UnitFormRow[] {
  return units.map((unit) => (unit.rowKey === rowKey ? { ...unit, baseQty: '1' } : unit))
}

/**
 * A row can be removed unless it is the base unit, or a saved unit of a product with stock history (such a unit is
 * made inactive instead).
 */
export function canRemoveUnitRow(
  row: UnitFormRow,
  baseRowKey: string,
  hasStockMovements: boolean
): boolean {
  if (row.rowKey === baseRowKey) return false
  return row.unitId === null || !hasStockMovements
}

/**
 * The main process's field errors as [form path, message] pairs. Errors about the unit list as a whole (a removed or
 * base unit) go to the unit list; anything the form has no field for goes to the form.
 */
export function serverFieldErrors(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined
): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const [path, messages] of Object.entries(fieldErrors ?? {})) {
    const target = formPathOf(path)
    for (const message of messages) pairs.push([target, message])
  }
  return pairs
}

const FORM_FIELDS = new Set(['code', 'name', 'companyId', 'packingLabel', 'lowStockThresholdBase'])
const UNIT_FIELDS = new Set([
  'name',
  'shortName',
  'baseQty',
  'wholesalePriceMinor',
  'retailPriceMinor',
  'defaultCostMinor',
  'isActive'
])

function formPathOf(path: string): string {
  if (FORM_FIELDS.has(path)) return path
  if (path === 'units') return 'units.root'
  const unit = /^units\.(\d+)\.(\w+)$/.exec(path)
  if (unit !== null) return UNIT_FIELDS.has(unit[2]) ? path : 'units.root'
  return 'root'
}

function amountText(minor: number | null, minorDigits: number): string {
  return minor === null ? '' : formatMoney(minor, { minorDigits, grouping: 'none' })
}
