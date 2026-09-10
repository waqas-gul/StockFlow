import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ErrorFallback } from '@renderer/components/common/ErrorFallback'

type Props = { children: ReactNode }
type State = { error: Error | null }

/** Catches failures outside the router (providers, router setup) so the window is never left blank. */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled renderer error', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <ErrorFallback title="StockFlow ran into a problem" message={this.state.error.message} />
      )
    }
    return this.props.children
  }
}
