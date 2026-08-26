/**
 * PlaidLinkButton - Component to connect bank accounts via Plaid
 * Integrates with the native bookkeeping system
 */

import { useState, useCallback, useEffect } from 'react';

interface PlaidLinkButtonProps {
  userId: string;
  propertyId?: string;
  onSuccess?: (connectionId: string, accounts: any[]) => void;
  onError?: (error: string) => void;
}

export default function PlaidLinkButton({ 
  userId, 
  propertyId, 
  onSuccess, 
  onError 
}: PlaidLinkButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load Plaid Link script
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    script.async = true;
    document.body.appendChild(script);
    
    return () => {
      document.body.removeChild(script);
    };
  }, []);

  // Create link token
  const createLinkToken = async () => {
    try {
      setIsLoading(true);
      setError(null);

      console.log('[PlaidLink] Creating link token for user:', userId);

      const response = await fetch('/api/plaid/create-link-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, propertyId }),
      });

      console.log('[PlaidLink] Response status:', response.status);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const text = await response.text();
      console.log('[PlaidLink] Response text:', text);

      let data;
      try {
        data = JSON.parse(text);
      } catch (parseError) {
        console.error('[PlaidLink] JSON parse error:', parseError);
        console.error('[PlaidLink] Response text was:', text);
        throw new Error('Invalid JSON response from server');
      }

      if (!data.ok) {
        throw new Error(data.error || 'Failed to create link token');
      }

      console.log('[PlaidLink] Link token created:', data.link_token);
      setLinkToken(data.link_token);
      return data.link_token;
    } catch (err: any) {
      console.error('[PlaidLink] Error:', err);
      const errorMsg = err.message || 'Failed to initialize Plaid';
      setError(errorMsg);
      if (onError) onError(errorMsg);
      return null;
    } finally {
      setIsLoading(false);
    }
  };

  // Exchange public token for access token
  const exchangePublicToken = async (publicToken: string) => {
    try {
      const response = await fetch('/api/plaid/exchange-public-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          public_token: publicToken, 
          userId, 
          propertyId 
        }),
      });

      const data = await response.json();

      if (!data.ok) {
        throw new Error(data.error || 'Failed to connect bank account');
      }

      console.log('✅ Bank account connected:', data);
      
      if (onSuccess) {
        onSuccess(data.connectionId, data.accounts);
      }

      return data;
    } catch (err: any) {
      const errorMsg = err.message || 'Failed to connect bank account';
      setError(errorMsg);
      if (onError) onError(errorMsg);
      throw err;
    }
  };

  // Open Plaid Link
  const openPlaidLink = useCallback(async () => {
    try {
      // Get link token
      let token = linkToken;
      if (!token) {
        token = await createLinkToken();
        if (!token) return;
      }

      // Check if Plaid is loaded
      if (typeof (window as any).Plaid === 'undefined') {
        setError('Plaid is not loaded. Please refresh the page.');
        return;
      }

      // Initialize Plaid Link
      const handler = (window as any).Plaid.create({
        token,
        onSuccess: async (publicToken: string, metadata: any) => {
          console.log('Plaid Link success:', metadata);
          try {
            await exchangePublicToken(publicToken);
          } catch (err) {
            console.error('Error exchanging token:', err);
          }
        },
        onExit: (err: any, metadata: any) => {
          if (err) {
            console.error('Plaid Link error:', err);
            setError(err.display_message || 'Failed to connect bank account');
            if (onError) onError(err.display_message);
          }
          console.log('Plaid Link exited:', metadata);
        },
        onEvent: (eventName: string, metadata: any) => {
          console.log('Plaid Link event:', eventName, metadata);
        },
      });

      // Open the Link flow
      handler.open();
    } catch (err: any) {
      console.error('Error opening Plaid Link:', err);
      setError(err.message || 'Failed to open Plaid Link');
    }
  }, [linkToken, userId, propertyId, onSuccess, onError]);

  return (
    <div className="plaid-link-container">
      <button
        onClick={openPlaidLink}
        disabled={isLoading}
        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
      >
        {isLoading ? (
          <span className="flex items-center gap-2">
            <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            Connecting...
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Connect Bank Account
          </span>
        )}
      </button>

      {error && (
        <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}
    </div>
  );
}
