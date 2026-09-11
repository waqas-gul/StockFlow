import { describe, expect, it } from 'vitest'
import * as domain from './index'

describe('@shared/domain entry point', () => {
  it('exposes the public functions', () => {
    const api = domain as unknown as Record<string, unknown>
    const functions = [
      'DomainError',
      'parseMoney',
      'parsePercentToBps',
      'formatMoney',
      'addMinor',
      'subtractMinor',
      'sumMinor',
      'multiplyMinor',
      'divideRoundHalfUp',
      'mulDivRoundHalfUp',
      'basisPointsOf',
      'validateUnits',
      'createUnitSet',
      'toBaseQuantity',
      'totalBaseQuantity',
      'splitBaseQuantity',
      'formatQuantity',
      'calculateQuantityRow',
      'applyDeductions',
      'calculateLine',
      'calculateInvoice',
      'weightedAverageOutflowValue',
      'applyOutflow',
      'integerToWords',
      'amountInWords'
    ]
    for (const name of functions) expect(typeof api[name], name).toBe('function')
    expect(api.BPS_PER_WHOLE).toBe(10_000)
    expect(api.MAX_MINOR_DIGITS).toBe(4)
  })

  it('does not expose internal guards or test helpers', () => {
    expect('assertSafeInteger' in domain).toBe(false)
    expect('thrownCode' in domain).toBe(false)
  })
})
