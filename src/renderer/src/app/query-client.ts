import { QueryClient } from '@tanstack/react-query'

// SQLite in the main process is the source of truth; these queries only cache it.
// Local database errors are not transient, so retries are kept to a minimum.
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false
      },
      mutations: {
        retry: 0
      }
    }
  })
}
