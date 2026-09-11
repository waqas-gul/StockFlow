import { describe, expect, it } from 'vitest'
import { createRandom, thrownCode } from './test-utils'
import { applyOutflow, weightedAverageOutflowValue, type StockPosition } from './valuation'

const MAX = Number.MAX_SAFE_INTEGER
const out = (qtyBase: number, valueMinor: number, n: number): number =>
  weightedAverageOutflowValue({ qtyBase, valueMinor }, n)

describe('weightedAverageOutflowValue', () => {
  it('values a partial outflow at the average cost: Q = 10, V = 150 000, sell 2 → 30 000', () => {
    expect(out(10, 150_000, 2)).toBe(30_000)
  })

  it.each<[number, number, number, number]>([
    [3, 100, 1, 33], // 33.33
    [3, 100, 2, 67], // 66.67
    [2, 1, 1, 1], // 0.5 rounds up
    [4, 10, 1, 3], // 2.5 rounds up
    [4, 10, 3, 8], // 7.5 rounds up
    [6, 5, 3, 3], // 2.5 rounds up
    [8, 1, 1, 0], // 0.125
    [8, 3, 1, 0], // 0.375
    [8, 4, 1, 1], // 0.5 rounds up
    [8, 5, 1, 1], // 0.625
    [3, 1, 1, 0], // 0.333
    [3, 2, 1, 1], // 0.667
    [7, 100, 3, 43] // 42.857
  ])('Q = %i, V = %i, sell %i → %i (half-up)', (qtyBase, valueMinor, n, expected) => {
    expect(out(qtyBase, valueMinor, n)).toBe(expected)
  })

  it.each<[number, number]>([
    [3, 100],
    [7, 1],
    [1, 999],
    [5, 0],
    [MAX, MAX]
  ])('a full outflow (n = Q = %i) takes exactly the whole value %i', (qtyBase, valueMinor) => {
    expect(out(qtyBase, valueMinor, qtyBase)).toBe(valueMinor)
  })

  it('returns 0 for a zero outflow, including from empty stock', () => {
    expect(out(10, 150_000, 0)).toBe(0)
    expect(out(0, 0, 0)).toBe(0)
  })

  it('uses exact BigInt intermediates', () => {
    // V × n = 9e15 × 450 000 001 ≈ 4e24, far beyond the exact float range.
    expect(out(900_000_000, 9_000_000_000_000_000, 450_000_001)).toBe(4_500_000_010_000_000)
    // 9 000 000 000 000 001 ÷ 2 = …000.5 → …001. A float division would round it to …000.
    expect(out(2, 9_000_000_000_000_001, 1)).toBe(4_500_000_000_000_001)
    // MAX ÷ 3 = 3002399751580330.33…
    expect(out(3, MAX, 1)).toBe(3_002_399_751_580_330)
    expect(out(MAX, MAX, MAX - 1)).toBe(MAX - 1)
  })

  it('refuses to take out more than is in stock', () => {
    expect(thrownCode(() => out(3, 100, 4))).toBe('INSUFFICIENT_STOCK')
    expect(thrownCode(() => out(0, 0, 1))).toBe('INSUFFICIENT_STOCK')
  })

  it('rejects a broken position and invalid numbers', () => {
    expect(thrownCode(() => out(0, 5, 0))).toBe('INVALID_ARGUMENT') // Q = 0 but V ≠ 0
    expect(thrownCode(() => out(-1, 0, 0))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => out(3, -100, 1))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => out(3, 100, -1))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => out(3, 100, 1.5))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => out(3.5, 100, 1))).toBe('INVALID_ARGUMENT')
    expect(thrownCode(() => out(3, 100.5, 1))).toBe('INVALID_ARGUMENT')
  })
})

describe('applyOutflow', () => {
  it('returns the value removed and the stock that remains', () => {
    expect(applyOutflow({ qtyBase: 10, valueMinor: 150_000 }, 2)).toEqual({
      outValueMinor: 30_000,
      remaining: { qtyBase: 8, valueMinor: 120_000 }
    })
  })

  it('empties stock to exactly zero value, whatever the earlier rounding', () => {
    // Q = 3, V = 100: sell 1, 1, 1 → 33, then round(67 / 2) = 34, then the last 33. Σ = 100.
    let position: StockPosition = { qtyBase: 3, valueMinor: 100 }
    const values: number[] = []
    for (let i = 0; i < 3; i++) {
      const result = applyOutflow(position, 1)
      values.push(result.outValueMinor)
      position = result.remaining
    }
    expect(values).toEqual([33, 34, 33])
    expect(position).toEqual({ qtyBase: 0, valueMinor: 0 })
  })
})

describe('invariants over random receive / sell sequences', () => {
  it('keeps 0 ≤ out ≤ V, V ≥ 0, Q = 0 ⇒ V = 0, and in − out = V', () => {
    const random = createRandom(2024)
    for (let run = 0; run < 200; run++) {
      let position: StockPosition = { qtyBase: 0, valueMinor: 0 }
      let valueIn = 0
      let valueOut = 0
      for (let step = 0; step < 60; step++) {
        if (position.qtyBase === 0 || random(2) === 0) {
          const qty = 1 + random(499)
          const value = random(qty * 5000)
          position = { qtyBase: position.qtyBase + qty, valueMinor: position.valueMinor + value }
          valueIn += value
        } else {
          const n = random(9) === 0 ? position.qtyBase : 1 + random(position.qtyBase - 1)
          const { outValueMinor, remaining } = applyOutflow(position, n)
          expect(outValueMinor).toBeGreaterThanOrEqual(0)
          expect(outValueMinor).toBeLessThanOrEqual(position.valueMinor)
          if (n === position.qtyBase) expect(outValueMinor).toBe(position.valueMinor)
          valueOut += outValueMinor
          position = remaining
        }
        expect(position.qtyBase).toBeGreaterThanOrEqual(0)
        expect(position.valueMinor).toBeGreaterThanOrEqual(0)
        if (position.qtyBase === 0) expect(position.valueMinor).toBe(0)
        expect(valueIn - valueOut).toBe(position.valueMinor)
      }
    }
  })

  it('rounds every partial outflow to within half a minor unit, halves up', () => {
    const random = createRandom(99)
    for (let i = 0; i < 5000; i++) {
      const qtyBase = 1 + random(10_000)
      const valueMinor = random(50_000_000)
      const n = 1 + random(qtyBase - 1)
      const result = out(qtyBase, valueMinor, n)
      // −Q ≤ 2 × (V × n − result × Q) < Q
      const twiceError = 2n * (BigInt(valueMinor) * BigInt(n) - BigInt(result) * BigInt(qtyBase))
      expect(twiceError >= -BigInt(qtyBase) && twiceError < BigInt(qtyBase)).toBe(true)
    }
  })
})
