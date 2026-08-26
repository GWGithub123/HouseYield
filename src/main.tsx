import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import './design-system/design-system.css'
import { registerServiceWorker } from './services/pushNotifications'

// Debug: pre-render ping
console.log('[Renaissance] Booting React app...')
const rootEl = document.getElementById('root')!
if (rootEl && !rootEl.textContent) {
  rootEl.textContent = 'Loading application...'
}
// Avoid creating multiple roots if HMR or duplicate script runs
const existingKey = '__rr_root__'
// @ts-ignore
if (!(rootEl as any)[existingKey]) {
  // @ts-ignore
  (rootEl as any)[existingKey] = ReactDOM.createRoot(rootEl)
}

// Simple error boundary to surface runtime errors in UI
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; message?: string }>{
  constructor(props: any) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError(err: unknown) {
    return { hasError: true, message: (err as any)?.message ?? String(err) }
  }
  componentDidCatch(error: any, info: any) {
    console.error('[Renaissance] Runtime error:', error, info)
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 16, fontFamily: 'ui-sans-serif, system-ui', color: '#b91c1c' }}>
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>Something went wrong.</h1>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.message}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

// @ts-ignore
(rootEl as any)[existingKey].render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)

// Best-effort register SW after app mounts
registerServiceWorker();
