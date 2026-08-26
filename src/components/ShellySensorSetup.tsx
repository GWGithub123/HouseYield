import React, { useState, useEffect } from 'react';

/**
 * Shelly Account Connection Component
 * Simple button for customers to connect their Shelly account
 */
export default function ShellySensorSetup({ customerId }) {
  const [connected, setConnected] = useState(false);
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkConnection();
  }, []);

  const checkConnection = async () => {
    try {
      const response = await fetch(`/api/shelly/devices?customerId=${customerId}`);
      const data = await response.json();
      
      setConnected(data.connected);
      setDevices(data.devices || []);
    } catch (error) {
      console.error('Error checking Shelly connection:', error);
    } finally {
      setLoading(false);
    }
  };

  const connectShelly = () => {
    // Redirect to Shelly OAuth
    window.location.href = `/api/shelly/connect?customerId=${customerId}`;
  };

  const disconnectShelly = async () => {
    if (!confirm('Are you sure you want to disconnect your Shelly account?')) {
      return;
    }

    try {
      await fetch('/api/shelly/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId })
      });

      setConnected(false);
      setDevices([]);
    } catch (error) {
      console.error('Error disconnecting:', error);
      alert('Failed to disconnect Shelly account');
    }
  };

  if (loading) {
    return <div className="text-gray-500">Loading Shelly status...</div>;
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">
            Shelly Water Leak Sensors
          </h3>
          <p className="text-sm text-gray-600 mt-1">
            Connect your Shelly account to automatically import your flood sensors
          </p>
        </div>
        
        {connected ? (
          <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">
            <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            Connected
          </span>
        ) : (
          <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-gray-100 text-gray-800">
            Not Connected
          </span>
        )}
      </div>

      {!connected ? (
        <div className="mt-4">
          <button
            onClick={connectShelly}
            className="w-full flex items-center justify-center px-4 py-3 border border-transparent text-base font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
          >
            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Connect Shelly Account
          </button>
          
          <div className="mt-4 text-sm text-gray-500">
            <p className="font-medium mb-2">What happens next:</p>
            <ol className="list-decimal list-inside space-y-1 ml-2">
              <li>You'll be redirected to Shelly's secure login</li>
              <li>Approve access to your devices</li>
              <li>Your sensors will automatically appear here</li>
              <li>No manual setup needed!</li>
            </ol>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <div className="bg-gray-50 rounded-md p-4 mb-4">
            <h4 className="text-sm font-medium text-gray-900 mb-2">
              Connected Devices ({devices.length})
            </h4>
            {devices.length > 0 ? (
              <ul className="space-y-2">
                {devices.map((device) => (
                  <li key={device.id} className="flex items-center text-sm">
                    <svg className="w-4 h-4 mr-2 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6z" />
                    </svg>
                    <span className="text-gray-700">{device.name || `Sensor ${device.id.slice(-4)}`}</span>
                    <span className="ml-auto text-gray-500 text-xs">
                      {device.room || 'Unassigned'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500">No flood sensors found in your Shelly account.</p>
            )}
          </div>

          <button
            onClick={disconnectShelly}
            className="w-full px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
          >
            Disconnect Shelly Account
          </button>
        </div>
      )}
    </div>
  );
}
