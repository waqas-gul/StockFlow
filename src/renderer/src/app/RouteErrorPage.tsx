import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router'
import { ErrorFallback } from '@renderer/components/common/ErrorFallback'

export function RouteErrorPage(): React.JSX.Element {
  const error = useRouteError()
  const navigate = useNavigate()

  return (
    <ErrorFallback
      title="This screen could not be displayed"
      message={describeError(error)}
      onGoHome={() => navigate('/')}
    />
  )
}

function describeError(error: unknown): string {
  if (isRouteErrorResponse(error)) return `${error.status} ${error.statusText}`
  if (error instanceof Error) return error.message
  return 'An unexpected error occurred.'
}
