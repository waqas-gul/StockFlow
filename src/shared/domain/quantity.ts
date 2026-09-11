import { assertNonNegativeInteger, assertPositiveInteger, toSafeNumber } from './guards'

/**
 * Generic unit model (plan §9.2). Every product has exactly one base unit, the smallest unit it is counted
 * in, and stock is always an integer count of base units. Larger units contain a whole number of base units
 * (`baseQty`).
 *
 * Unit names are data. This module never interprets packing labels such as "1*12*18"; their meaning awaits
 * client confirmation (decisions A1/A2).
 */

export type UnitId = string | number

export interface UnitDefinition {
  /** Stable identifier, e.g. the future `product_units` row id. */
  readonly id: UnitId
  /** The client's own word for this level. */
  readonly name: string
  /** Optional printed abbreviation. */
  readonly shortName?: string
  /** How many base units one of this unit contains: a whole number of at least 1. */
  readonly baseQty: number
  /** Marks the base unit. Exactly one unit per product has it, and that unit has `baseQty` 1. */
  readonly isBase: boolean
}

export type UnitIssueCode =
  | 'NO_UNITS'
  | 'NO_BASE_UNIT'
  | 'MULTIPLE_BASE_UNITS'
  | 'BASE_UNIT_QTY_NOT_ONE'
  | 'INVALID_BASE_QTY'
  | 'EMPTY_NAME'
  | 'DUPLICATE_ID'
  | 'DUPLICATE_NAME'
  | 'DUPLICATE_BASE_QTY'
  | 'NOT_NESTED'

export interface UnitIssue {
  readonly code: UnitIssueCode
  /** Units involved in the issue (empty when the issue concerns the set as a whole). */
  readonly unitIds: readonly UnitId[]
  readonly message: string
}

declare const validatedUnitSet: unique symbol

/**
 * A unit set that passed `validateUnits`, sorted from the largest unit down to the base unit. Only
 * `createUnitSet` can produce one, so conversion functions never receive an unvalidated set.
 */
export interface UnitSet {
  readonly units: readonly UnitDefinition[]
  readonly baseUnit: UnitDefinition
  readonly [validatedUnitSet]: true
}

export type UnitSetResult =
  | { readonly ok: true; readonly unitSet: UnitSet }
  | { readonly ok: false; readonly issues: readonly UnitIssue[] }

/** A quantity entered in one unit, e.g. 2 of a unit that contains 24 base units. */
export interface QuantityInUnit {
  readonly quantity: number
  readonly unitBaseQty: number
}

export interface UnitCount {
  readonly unit: UnitDefinition
  readonly count: number
}

export interface FormatQuantityOptions {
  /** Label printed per unit. `'shortName'` falls back to the name when a unit has none. Default `'name'`. */
  readonly label?: 'name' | 'shortName'
  /** Text between the parts. Default `' + '`. */
  readonly separator?: string
}

function duplicateGroups<K>(
  units: readonly UnitDefinition[],
  keyOf: (unit: UnitDefinition) => K
): UnitDefinition[][] {
  const groups = new Map<K, UnitDefinition[]>()
  for (const unit of units) {
    const key = keyOf(unit)
    const group = groups.get(key)
    if (group) group.push(unit)
    else groups.set(key, [unit])
  }
  return [...groups.values()].filter((group) => group.length > 1)
}

/**
 * Checks a product's unit definitions. An empty array means the set is valid.
 *
 * **Nesting rule (plan §7.3):** sort the units by `baseQty`. Each unit's `baseQty` must be an exact
 * multiple of the next smaller unit's `baseQty`. So 1 / 6 / 60 and 1 / 6 / 24 are valid (24 = 4 × 6),
 * but 1 / 4 / 6 is not (6 is not a multiple of 4).
 *
 * The rule is what makes a greedy split canonical. In a nested set, each smaller-unit count is always below
 * one of the next larger unit, so "4 Carton + 7 Box + 1 Piece" is the only sensible reading. Without it the
 * display is ambiguous: with 1 / 4 / 6, 12 base units could be "2 × 6" or "3 × 4", and greedy splitting
 * would show a mix no one counted. Adjacent pairs are enough, because divisibility is transitive.
 */
export function validateUnits(units: readonly UnitDefinition[]): readonly UnitIssue[] {
  if (units.length === 0) {
    return [{ code: 'NO_UNITS', unitIds: [], message: 'A product needs at least one unit.' }]
  }

  const issues: UnitIssue[] = []
  const add = (code: UnitIssueCode, group: readonly UnitDefinition[], message: string): void => {
    issues.push({ code, unitIds: group.map((unit) => unit.id), message })
  }

  for (const unit of units) {
    if (unit.name.trim() === '') add('EMPTY_NAME', [unit], `Unit ${String(unit.id)} needs a name.`)
    if (!Number.isSafeInteger(unit.baseQty) || unit.baseQty < 1) {
      add(
        'INVALID_BASE_QTY',
        [unit],
        `"${unit.name}" must contain a whole number (≥ 1) of base units.`
      )
    }
  }

  for (const group of duplicateGroups(units, (unit) => unit.id)) {
    add('DUPLICATE_ID', group, `The unit id ${String(group[0].id)} is used more than once.`)
  }
  const named = units.filter((unit) => unit.name.trim() !== '')
  for (const group of duplicateGroups(named, (unit) => unit.name.trim().toLowerCase())) {
    add('DUPLICATE_NAME', group, `The unit name "${group[0].name.trim()}" is used more than once.`)
  }

  const baseUnits = units.filter((unit) => unit.isBase)
  if (baseUnits.length === 0) {
    add('NO_BASE_UNIT', [], 'Exactly one unit must be marked as the base unit.')
  } else if (baseUnits.length > 1) {
    add('MULTIPLE_BASE_UNITS', baseUnits, 'Only one unit can be the base unit.')
  } else if (baseUnits[0].baseQty !== 1) {
    add(
      'BASE_UNIT_QTY_NOT_ONE',
      baseUnits,
      `The base unit "${baseUnits[0].name}" must have size 1.`
    )
  }

  // Size comparisons only make sense once every size is a valid whole number.
  if (units.every((unit) => Number.isSafeInteger(unit.baseQty) && unit.baseQty >= 1)) {
    const sameSize = duplicateGroups(units, (unit) => unit.baseQty)
    for (const group of sameSize) {
      add(
        'DUPLICATE_BASE_QTY',
        group,
        `More than one unit contains ${group[0].baseQty} base units.`
      )
    }
    if (sameSize.length === 0) {
      const ascending = [...units].sort((a, b) => a.baseQty - b.baseQty)
      for (let i = 1; i < ascending.length; i++) {
        const smaller = ascending[i - 1]
        const larger = ascending[i]
        if (larger.baseQty % smaller.baseQty !== 0) {
          add(
            'NOT_NESTED',
            [smaller, larger],
            `"${larger.name}" (${larger.baseQty}) is not a whole multiple of "${smaller.name}" (${smaller.baseQty}).`
          )
        }
      }
    }
  }

  return issues
}

/** Validates the units and, if valid, returns them as a `UnitSet` sorted largest first. */
export function createUnitSet(units: readonly UnitDefinition[]): UnitSetResult {
  const issues = validateUnits(units)
  if (issues.length > 0) return { ok: false, issues }
  const largestFirst = Object.freeze([...units].sort((a, b) => b.baseQty - a.baseQty))
  const unitSet = Object.freeze({
    units: largestFirst,
    baseUnit: largestFirst[largestFirst.length - 1]
  }) as unknown as UnitSet
  return { ok: true, unitSet }
}

/** quantity × unitBaseQty: the base units in a quantity entered in some unit (2 × 24 = 48). */
export function toBaseQuantity(quantity: number, unitBaseQty: number): number {
  assertNonNegativeInteger(quantity, 'Quantity')
  assertPositiveInteger(unitBaseQty, 'Unit size')
  return toSafeNumber(BigInt(quantity) * BigInt(unitBaseQty), 'Base quantity')
}

/** Σ quantity × unitBaseQty over several rows: 2 Box (24) + 5 Piece (1) = 53. */
export function totalBaseQuantity(rows: readonly QuantityInUnit[]): number {
  let total = 0n
  for (const row of rows) total += BigInt(toBaseQuantity(row.quantity, row.unitBaseQty))
  return toSafeNumber(total, 'Base quantity')
}

/**
 * Splits a base quantity greedily into the set's units, largest first, e.g. 283 with 60 / 6 / 1 →
 * [4, 7, 1]. Every unit is returned, including zero counts. It uses remainder arithmetic rather than
 * `Math.floor(a / b)`, which can round up for very large quantities.
 */
export function splitBaseQuantity(qtyBase: number, unitSet: UnitSet): readonly UnitCount[] {
  assertNonNegativeInteger(qtyBase, 'Base quantity')
  let rest = qtyBase
  return unitSet.units.map((unit) => {
    const remainder = rest % unit.baseQty
    const count = (rest - remainder) / unit.baseQty
    rest = remainder
    return { unit, count }
  })
}

function unitLabel(unit: UnitDefinition, label: 'name' | 'shortName'): string {
  const short = unit.shortName?.trim()
  return label === 'shortName' && short ? short : unit.name
}

/**
 * Display text for a base quantity: "4 Carton + 7 Box + 1 Piece". Zero parts are omitted; zero stock
 * shows as "0 <base unit>". Names are printed as given, with no pluralisation.
 */
export function formatQuantity(
  qtyBase: number,
  unitSet: UnitSet,
  options: FormatQuantityOptions = {}
): string {
  const { label = 'name', separator = ' + ' } = options
  const parts = splitBaseQuantity(qtyBase, unitSet)
    .filter((part) => part.count > 0)
    .map((part) => `${part.count} ${unitLabel(part.unit, label)}`)
  return parts.length > 0 ? parts.join(separator) : `0 ${unitLabel(unitSet.baseUnit, label)}`
}
