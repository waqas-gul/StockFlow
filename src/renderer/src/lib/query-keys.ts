import type { ProductListInput } from '@shared/products'

/** TanStack Query keys for every query in the renderer, from one factory (plan §15). */
export const queryKeys = {
  app: {
    info: ['app', 'info'] as const
  },
  settings: ['settings'] as const,
  backup: {
    status: ['backup', 'status'] as const
  },
  companies: ['companies'] as const,
  products: {
    /** Every product query: invalidated after any product or company change. */
    all: ['products'] as const,
    list: (input: ProductListInput) => ['products', 'list', input] as const,
    detail: (id: number) => ['products', 'detail', id] as const
  }
}
