// Test-only helpers for the domain tests. Excluded from coverage and never imported by application code.
import { DomainError } from './errors'

/** The DomainError code thrown by `fn`, the raw error for anything else, or undefined if nothing is thrown. */
export function thrownCode(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error instanceof DomainError ? error.code : error
  }
  return undefined
}

/**
 * Deterministic pseudo-random integers (mulberry32), so the property-style tests are reproducible.
 * Returns a function giving an integer from 0 to `max` inclusive (`max` ≤ Number.MAX_SAFE_INTEGER).
 */
export function createRandom(seed: number): (max: number) => number {
  let state = seed >>> 0
  return (max) => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296
    return Math.min(max, Math.floor(unit * (max + 1)))
  }
}
