import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui';
import Icon from './Icon';

interface Props {
  children: ReactNode;
  /** Changing this resets the boundary, so navigating to another document recovers. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

/**
 * Keeps one bad document from blanking the whole app. The editor is the most
 * likely place to throw, because it renders content that other clients wrote.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ParaDOCs render error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="text-3xl opacity-40">
          <Icon name="exclamation-triangle" />
        </div>
        <p className="text-sm font-medium">This document could not be rendered</p>
        <p className="max-w-md text-xs text-[var(--color-muted)]">{this.state.error.message}</p>
        <Button variant="subtle" className="text-xs" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    );
  }
}
