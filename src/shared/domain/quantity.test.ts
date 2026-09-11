import { describe, expect, it } from 'vitest'
import {
  createUnitSet,
  formatQuantity,
  splitBaseQuantity,
  toBaseQuantity,
  totalBaseQuantity,
  validateUnits,
  type UnitDefinition,
  type UnitSet
} from './quantity'
import { createRandom, thrownCode } from './test-utils'

const MAX = Number.MAX_SAFE_INTEGER

function unit(name: string, baseQty: number, extra: Partial<UnitDefinition> = {}): UnitDefinition {
  return { id: name, name, baseQty, isBase: baseQty === 1, ...extra }
}

function unitSetOf(...units: UnitDefinition[]): UnitSet {
  const result = createUnitSet(units)
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('; '))
  return result.unitSet
}

const codesOf = (units: UnitDefinition[]): string[] =>
  validateUnits(units).map((issue) => issue.code)

const countsOf = (qtyBase: number, unitSet: UnitSet): number[] =>
  splitBaseQuantity(qtyBase, unitSet).map((part) => part.count)

// Example units. Names and sizes are arbitrary test data, NOT interpretations of the client's packing labels.
const piece = unit('Piece', 1, { shortName: 'Pcs' })
const pack4 = unit('Pack', 4)
const box6 = unit('Box', 6)
const box24 = unit('Box', 24)
const case24 = unit('Case', 24)
const carton60 = unit('Carton', 60, { shortName: 'Ctn' })

const SINGLE = unitSetOf(unit('Unit', 1))
const TWO_LEVEL = unitSetOf(piece, box24)
const THREE_LEVEL = unitSetOf(piece, box6, carton60)
const SHORT = { label: 'shortName' } as const

describe('toBaseQuantity and totalBaseQuantity', () => {
  it('converts a quantity in a unit to base units', () => {
    expect(toBaseQuantity(2, 24)).toBe(48)
    expect(toBaseQuantity(0, 24)).toBe(0)
    expect(toBaseQuantity(5, 1)).toBe(5)
    expect(toBaseQuantity(MAX, 1)).toBe(MAX)
  })

  it('totals several unit quantities: 2 Box (24) + 5 Piece = 53', () => {
    expect(
      totalBaseQuantity([
        { quantity: 2, unitBaseQty: 24 },
        { quantity: 5, unitBaseQty: 1 }
      ])
    ).toBe(53)
    expect(totalBaseQuantity([])).toBe(0)
  })

  it('rejects negative, fractional, zero-sized or overflowing input', () => {
    expect(thrownCode(() => toBaseQuantity(-1, 24))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => toBaseQuantity(1.5, 24))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => toBaseQuantity(1, 0))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => toBaseQuantity(1, -6))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => toBaseQuantity(1, 2.5))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => toBaseQuantity(MAX, 2))).toBe('OUT_OF_RANGE')
    expect(
      thrownCode(() =>
        totalBaseQuantity([
          { quantity: MAX, unitBaseQty: 1 },
          { quantity: 1, unitBaseQty: 1 }
        ])
      )
    ).toBe('OUT_OF_RANGE')
  })
})

describe('validateUnits and createUnitSet', () => {
  it.each<[string, UnitDefinition[]]>([
    ['one level', [unit('Unit', 1)]],
    ['two levels', [piece, box24]],
    ['three levels 1 / 6 / 60', [piece, box6, carton60]],
    ['three levels 1 / 6 / 24 (24 = 4 × 6)', [piece, box6, case24]],
    [
      'four levels 1 / 2 / 12 / 144',
      [piece, unit('Pair', 2), unit('Dozen', 12), unit('Gross', 144)]
    ]
  ])('accepts %s', (_, units) => {
    expect(validateUnits(units)).toEqual([])
  })

  it('rejects 1 / 4 / 6: 6 is not a whole multiple of 4', () => {
    // 12 base units could be read as 2 × 6 or 3 × 4, so a greedy display would be ambiguous.
    const issues = validateUnits([piece, pack4, box6])
    expect(issues.map((issue) => issue.code)).toEqual(['NOT_NESTED'])
    expect(issues[0].unitIds).toEqual(['Pack', 'Box'])
  })

  it('checks every adjacent pair of sizes', () => {
    expect(codesOf([piece, box6, carton60, unit('Bale', 90)])).toEqual(['NOT_NESTED'])
    expect(validateUnits([piece, box6, carton60, unit('Bale', 90)])[0].unitIds).toEqual([
      'Carton',
      'Bale'
    ])
    expect(codesOf([piece, pack4, box6, unit('Crate', 12)])).toEqual(['NOT_NESTED'])
  })

  it('requires at least one unit and exactly one base unit of size 1', () => {
    expect(codesOf([])).toEqual(['NO_UNITS'])
    expect(codesOf([box6])).toEqual(['NO_BASE_UNIT'])
    expect(codesOf([piece, unit('Each', 1)])).toEqual(['MULTIPLE_BASE_UNITS', 'DUPLICATE_BASE_QTY'])
    expect(codesOf([{ id: 'Box', name: 'Box', baseQty: 6, isBase: true }])).toEqual([
      'BASE_UNIT_QTY_NOT_ONE'
    ])
    expect(codesOf([piece, unit('Each', 1, { isBase: false })])).toEqual(['DUPLICATE_BASE_QTY'])
  })

  it.each([0, -6, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX + 1])(
    'rejects the unit size %s',
    (baseQty) => {
      expect(codesOf([piece, unit('Box', baseQty)])).toEqual(['INVALID_BASE_QTY'])
    }
  )

  it('rejects duplicate sizes, ids and names, and empty names', () => {
    const duplicateSize = validateUnits([piece, box6, unit('Pack', 6)])
    expect(duplicateSize.map((issue) => issue.code)).toEqual(['DUPLICATE_BASE_QTY'])
    expect(duplicateSize[0].unitIds).toEqual(['Box', 'Pack'])

    expect(codesOf([piece, { id: 'Piece', name: 'Box', baseQty: 6, isBase: false }])).toEqual([
      'DUPLICATE_ID'
    ])
    expect(
      codesOf([
        piece,
        { id: 'b1', name: 'Box', baseQty: 6, isBase: false },
        { id: 'b2', name: ' box ', baseQty: 12, isBase: false }
      ])
    ).toEqual(['DUPLICATE_NAME'])
    expect(codesOf([piece, { id: 'x', name: '  ', baseQty: 6, isBase: false }])).toEqual([
      'EMPTY_NAME'
    ])
  })

  it('accepts numeric ids and treats 1 and "1" as different ids', () => {
    expect(
      validateUnits([
        { id: 1, name: 'Piece', baseQty: 1, isBase: true },
        { id: '1', name: 'Box', baseQty: 12, isBase: false }
      ])
    ).toEqual([])
  })

  it('gives every issue a readable message', () => {
    const issues = [
      ...validateUnits([]),
      ...validateUnits([box6]),
      ...validateUnits([piece, unit('Each', 1)]),
      ...validateUnits([{ id: 'Box', name: 'Box', baseQty: 6, isBase: true }]),
      ...validateUnits([
        piece,
        unit('Box', 0),
        { id: 'Piece', name: ' ', baseQty: 2, isBase: false }
      ]),
      ...validateUnits([piece, box6, unit('box', 12)]),
      ...validateUnits([piece, pack4, box6])
    ]
    expect(issues.length).toBeGreaterThanOrEqual(8)
    for (const issue of issues) expect(issue.message.length).toBeGreaterThan(10)
  })

  it('returns the issues instead of a unit set when the definitions are invalid', () => {
    const result = createUnitSet([piece, pack4, box6])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0].code).toBe('NOT_NESTED')
  })

  it('sorts a valid set from the largest unit down to the base unit, whatever the input order', () => {
    const unitSet = unitSetOf(carton60, piece, box6)
    expect(unitSet.units.map((u) => u.name)).toEqual(['Carton', 'Box', 'Piece'])
    expect(unitSet.baseUnit).toBe(piece)
    expect(Object.isFrozen(unitSet.units)).toBe(true)
  })
})

describe('splitBaseQuantity', () => {
  it.each<[number, number[]]>([
    [53, [2, 5]],
    [187, [7, 19]],
    [240, [10, 0]],
    [23, [0, 23]],
    [0, [0, 0]]
  ])('two levels (Box = 24): %i → %j', (qtyBase, expected) => {
    expect(countsOf(qtyBase, TWO_LEVEL)).toEqual(expected)
  })

  it.each<[number, number[]]>([
    [283, [4, 7, 1]],
    [223, [3, 7, 1]],
    [300, [5, 0, 0]],
    [59, [0, 9, 5]],
    [0, [0, 0, 0]]
  ])('three levels (60 / 6 / 1): %i → %j', (qtyBase, expected) => {
    expect(countsOf(qtyBase, THREE_LEVEL)).toEqual(expected)
  })

  it('uses a single unit as is', () => {
    expect(countsOf(17, SINGLE)).toEqual([17])
  })

  it('stays exact for the largest safe quantities', () => {
    expect(countsOf(MAX, THREE_LEVEL)).toEqual([150119987579016, 5, 1])
    // One below a multiple of 60, where Math.floor(q / 60) would round up to the next carton.
    expect(countsOf(9007199254740959, THREE_LEVEL)).toEqual([150119987579015, 9, 5])
  })

  it('rejects negative or fractional quantities', () => {
    expect(thrownCode(() => splitBaseQuantity(-1, THREE_LEVEL))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => splitBaseQuantity(1.5, THREE_LEVEL))).toBe('INVALID_ARGUMENT')
  })
})

describe('formatQuantity', () => {
  it('prints the non-zero parts, largest first', () => {
    expect(formatQuantity(283, THREE_LEVEL)).toBe('4 Carton + 7 Box + 1 Piece')
    expect(formatQuantity(300, THREE_LEVEL)).toBe('5 Carton')
    expect(formatQuantity(61, THREE_LEVEL)).toBe('1 Carton + 1 Piece')
    expect(formatQuantity(0, THREE_LEVEL)).toBe('0 Piece')
  })

  it('can use short names (falling back to the name) and another separator', () => {
    expect(formatQuantity(283, THREE_LEVEL, SHORT)).toBe('4 Ctn + 7 Box + 1 Pcs')
    expect(formatQuantity(0, THREE_LEVEL, SHORT)).toBe('0 Pcs')
    expect(formatQuantity(283, THREE_LEVEL, { separator: ', ' })).toBe('4 Carton, 7 Box, 1 Piece')
  })
})

describe('plan §9.3 stress tables', () => {
  it('(a) two levels, Box = 24 base units', () => {
    let q = toBaseQuantity(10, 24)
    expect([q, formatQuantity(q, TWO_LEVEL, SHORT)]).toEqual([240, '10 Box'])

    const sale = totalBaseQuantity([
      { quantity: 2, unitBaseQty: 24 },
      { quantity: 5, unitBaseQty: 1 }
    ])
    expect(sale).toBe(53)
    q -= sale
    expect([q, formatQuantity(q, TWO_LEVEL, SHORT)]).toEqual([187, '7 Box + 19 Pcs'])

    q -= totalBaseQuantity([
      { quantity: 7, unitBaseQty: 24 },
      { quantity: 19, unitBaseQty: 1 }
    ])
    expect([q, formatQuantity(q, TWO_LEVEL, SHORT)]).toEqual([0, '0 Pcs'])
    expect(toBaseQuantity(1, 1) > q).toBe(true) // selling 1 Pcs is blocked

    q += toBaseQuantity(3, 1)
    expect([q, formatQuantity(q, TWO_LEVEL, SHORT)]).toEqual([3, '3 Pcs'])
    expect(toBaseQuantity(1, 24) > q).toBe(true) // selling 1 Box is blocked
  })

  it('(b) three levels, Carton = 10 Box and Box = 6 Pcs', () => {
    let q = toBaseQuantity(5, 60)
    expect([q, formatQuantity(q, THREE_LEVEL, SHORT)]).toEqual([300, '5 Ctn'])

    q -= totalBaseQuantity([
      { quantity: 2, unitBaseQty: 6 },
      { quantity: 5, unitBaseQty: 1 }
    ])
    expect([q, formatQuantity(q, THREE_LEVEL, SHORT)]).toEqual([283, '4 Ctn + 7 Box + 1 Pcs'])

    q -= toBaseQuantity(1, 60)
    expect([q, formatQuantity(q, THREE_LEVEL, SHORT)]).toEqual([223, '3 Ctn + 7 Box + 1 Pcs'])
    expect(toBaseQuantity(4, 60) > q).toBe(true) // selling 4 Ctn (240) is blocked

    q -= totalBaseQuantity([
      { quantity: 3, unitBaseQty: 60 },
      { quantity: 7, unitBaseQty: 6 },
      { quantity: 1, unitBaseQty: 1 }
    ])
    expect(q).toBe(0)
  })
})

describe('invariants', () => {
  const sets = [
    SINGLE,
    TWO_LEVEL,
    THREE_LEVEL,
    unitSetOf(piece, box6, case24),
    unitSetOf(piece, unit('Pair', 2), unit('Dozen', 12), unit('Gross', 144))
  ]

  it('split always reconciles to the same base quantity, in canonical form', () => {
    const random = createRandom(5)
    const quantities = Array.from({ length: 3001 }, (_, i) => i)
    for (let i = 0; i < 300; i++) quantities.push(random(MAX))

    for (const unitSet of sets) {
      for (const qtyBase of quantities) {
        const parts = splitBaseQuantity(qtyBase, unitSet)
        const rows = parts.map((part) => ({ quantity: part.count, unitBaseQty: part.unit.baseQty }))
        expect(totalBaseQuantity(rows)).toBe(qtyBase)
        // Every part except the largest is smaller than one of the next larger unit.
        for (let i = 1; i < parts.length; i++) {
          expect(parts[i].count).toBeLessThan(parts[i - 1].unit.baseQty / parts[i].unit.baseQty)
        }
      }
    }
  })

  it('toBase → split → toBase returns the original total for random mixed entries', () => {
    const random = createRandom(6)
    for (const unitSet of sets) {
      for (let i = 0; i < 500; i++) {
        const entered = unitSet.units.map((u) => ({
          quantity: random(1000),
          unitBaseQty: u.baseQty
        }))
        const qtyBase = totalBaseQuantity(entered)
        const again = splitBaseQuantity(qtyBase, unitSet).map((part) => ({
          quantity: part.count,
          unitBaseQty: part.unit.baseQty
        }))
        expect(totalBaseQuantity(again)).toBe(qtyBase)
      }
    }
  })
})
