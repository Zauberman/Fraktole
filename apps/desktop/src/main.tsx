import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

// StrictMode intentionally omitted: its dev-only double-mount would spawn a
// PTY, kill it on the fake cleanup, and close the tile via tile:exit.

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error };
  }

  override render(): React.ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="fatal">
          <div className="fatal-title">Fraktole hit a fatal error</div>
          <div className="fatal-message">{String(this.state.error)}</div>
          <div className="fatal-hint">relaunch the app to recover — running agents were kept alive</div>
        </div>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById('root');
if (!container) throw new Error('missing #root element');
createRoot(container).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
