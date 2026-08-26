import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  name?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

export class ComponentErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(`[${this.props.name || 'Component'}] Error:`, error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      
      return (
        <div style={{
          padding: '16px',
          border: '1px solid #fbbf24',
          borderRadius: '8px',
          backgroundColor: '#fef3c7',
          color: '#92400e'
        }}>
          <h4 style={{ margin: '0 0 8px 0' }}>Component Error</h4>
          <p style={{ margin: 0, fontSize: '14px' }}>
            {this.props.name || 'This component'} encountered an error and couldn't load.
          </p>
        </div>
      );
    }

    return this.props.children;
  }
}
