import { describe, expect, it } from 'vitest'
import { createQueryClient } from './query-client'

describe('createQueryClient', () => {
  it('applies the approved defaults', () => {
    const { queries, mutations } = createQueryClient().getDefaultOptions()
    expect(queries).toMatchObject({ staleTime: 30_000, retry: 1, refetchOnWindowFocus: false })
    expect(mutations).toMatchObject({ retry: 0 })
  })
})
