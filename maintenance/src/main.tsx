import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@shared/App';
import '@shared/index.css';
import '@shared/design-system/design-system.css';
import { registerServiceWorker } from '@shared/services/pushNotifications';

console.log('[HouseYield Maintenance] Booting orchestration app...');

const rootEl = document.getElementById('root')!;
if (rootEl && !rootEl.textContent) {
  rootEl.textContent = 'Loading application...';
}

const existingKey = '__hy_maintenance_root__';
// @ts-ignore
if (!(rootEl as any)[existingKey]) {
  // @ts-ignore
  (rootEl as any)[existingKey] = ReactDOM.createRoot(rootEl);
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message?: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(err: unknown) {
    return { hasError: true, message: (err as any)?.message ?? String(err) };
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error('[HouseYield Maintenance] Runtime error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 16, fontFamily: 'ui-sans-serif, system-ui', color: '#b91c1c' }}>
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>Something went wrong.</h1>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// @ts-ignore
(rootEl as any)[existingKey].render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

registerServiceWorker();
