import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Catches a crash while drawing one part of the window, so the rest of Hangar keeps working instead
 * of the whole window going blank. The error is logged (in development it shows in the terminal).
 */
export class ErrorBoundary extends Component<{ children: ReactNode; label: string; onClose?: () => void }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.label}] ${error.stack ?? error.message}${info.componentStack ?? ''}`)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    const close = this.props.onClose
    return (
      <div className={close ? 'modal-backdrop' : 'crash-inline'}>
        <div className="crash card" role="alert">
          <h3>Something went wrong showing {this.props.label}</h3>
          <p className="small muted">{this.state.error.message}</p>
          <div className="row gap-xs">
            <button className="btn btn-sm" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            {close && (
              <button className="btn btn-sm btn-ghost" onClick={close}>
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }
}
