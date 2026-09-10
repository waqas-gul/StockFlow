import { createHashRouter } from 'react-router'
import { routes } from './routes'

// Hash routing works with the file:// URL the production build is loaded from.
export function createAppRouter(): ReturnType<typeof createHashRouter> {
  return createHashRouter(routes)
}
