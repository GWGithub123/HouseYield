import React, { useState } from 'react';

interface ShellySensorConnectProps {
  customerId: string;
  propertyId?: string;
  onSuccess?: (sensorCount: number) => void;
}

export default function ShellySensorConnect({ 
  customerId, 
  propertyId,
  onSuccess 
}: ShellySensorConnectProps) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');

  const handleConnect = async () => {
    setConnecting(true);
    setError('');

    try {
      // Step 1: Get OAuth URL from your backend
      const response = await fetch(
        `/api/shelly/oauth/connect?customerId=${customerId}${propertyId ? `&propertyId=${propertyId}` : ''}`
      );
      
      if (!response.ok) throw new Error('Failed to initiate OAuth');
      
      const { authUrl } = await response.json();

      // Step 2: Open Shelly OAuth in popup
      const width = 600;
      const height = 700;
      const left = (window.screen.width - width) / 2;
      const top = (window.screen.height - height) / 2;

      const popup = window.open(
        authUrl,
        'Shelly OAuth',
        `width=${width},height=${height},left=${left},top=${top}`
      );

      // Step 3: Listen for OAuth completion
      const checkPopup = setInterval(() => {
        if (!popup || popup.closed) {
          clearInterval(checkPopup);
          setConnecting(false);
          
          // Check if connection was successful
          const params = new URLSearchParams(window.location.search);
          if (params.get('shelly_connected') === 'true') {
            const sensorCount = parseInt(params.get('sensors') || '0');
            onSuccess?.(sensorCount);
            
            // Clean URL
            window.history.replaceState({}, '', window.location.pathname);
          }
        }
      }, 500);

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      setConnecting(false);
    }
  };

  return (
    <div className="shelly-connect-card">
      <div className="flex items-center gap-4">
        <img 
          src="https://shelly.cloud/img/logo.svg" 
          alt="Shelly" 
          className="w-12 h-12"
        />
        <div className="flex-1">
          <h3 className="text-lg font-semibold">Connect Shelly Water Sensors</h3>
          <p className="text-sm text-gray-600">
            Connect your Shelly Flood sensors to monitor water leaks in real-time
          </p>
        </div>
        <button
          onClick={handleConnect}
          disabled={connecting}
          className={`px-6 py-2 rounded-lg font-medium transition-colors ${
            connecting
              ? 'bg-gray-300 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-700 text-white'
          }`}
        >
          {connecting ? 'Connecting...' : 'Connect Shelly'}
        </button>
      </div>

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="mt-4 p-4 bg-blue-50 rounded-lg">
        <p className="text-sm text-blue-900 font-medium mb-2">How it works:</p>
        <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
          <li>Click "Connect Shelly" above</li>
          <li>Log in to your Shelly Cloud account</li>
          <li>Approve access to your devices</li>
          <li>Your sensors will automatically appear here</li>
        </ol>
      </div>
    </div>
  );
}
