/**
 * BankAccountManager - Manage connected bank accounts and sync transactions
 */

import { useState, useEffect } from 'react';
import PlaidLinkButton from './PlaidLinkButton';

interface BankAccount {
  connectionId: string;
  itemId: string;
  propertyId: string | null;
  accounts: Array<{
    id: string;
    name: string;
    type: string;
    subtype: string;
    mask: string;
  }>;
  createdAt: string;
}

interface BankAccountManagerProps {
  userId: string;
  propertyId?: string;
  onTransactionsSynced?: (count: number) => void;
}

export default function BankAccountManager({ 
  userId, 
  propertyId,
  onTransactionsSynced 
}: BankAccountManagerProps) {
  const [connections, setConnections] = useState<BankAccount[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncSuccess, setSyncSuccess] = useState<string | null>(null);

  // Load connected accounts
  const loadAccounts = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch(`/api/plaid/accounts/${userId}`);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const text = await response.text();
      console.log('[BankAccountManager] Response text:', text);
      
      let data;
      try {
        data = JSON.parse(text);
      } catch (parseError) {
        console.error('[BankAccountManager] JSON parse error:', parseError);
        console.error('[BankAccountManager] Response text was:', text);
        throw new Error('Invalid JSON response from server');
      }

      if (!data.ok) {
        throw new Error(data.error || 'Failed to load bank accounts');
      }

      setConnections(data.connections || []);
    } catch (err: any) {
      console.error('Error loading accounts:', err);
      setError(err.message || 'Failed to load bank accounts');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (userId) {
      loadAccounts();
    }
  }, [userId]);

  // Handle successful connection
  const handleConnectionSuccess = (_connectionId: string, accounts: any[]) => {
    setSyncSuccess(`Successfully connected ${accounts.length} account(s)!`);
    setTimeout(() => setSyncSuccess(null), 5000);
    loadAccounts();
  };

  // Sync transactions
  const syncTransactions = async (connectionId: string) => {
    try {
      setIsSyncing(connectionId);
      setError(null);
      setSyncSuccess(null);

      const response = await fetch('/api/plaid/sync-transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          connectionId,
          propertyId,
          startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          endDate: new Date().toISOString().split('T')[0],
        }),
      });

      const data = await response.json();

      if (!data.ok) {
        throw new Error(data.error || 'Failed to sync transactions');
      }

      setSyncSuccess(`Synced ${data.imported} new transactions (${data.skipped} duplicates skipped)`);
      setTimeout(() => setSyncSuccess(null), 5000);

      if (onTransactionsSynced) {
        onTransactionsSynced(data.imported);
      }
    } catch (err: any) {
      console.error('Error syncing transactions:', err);
      setError(err.message || 'Failed to sync transactions');
    } finally {
      setIsSyncing(null);
    }
  };

  // Disconnect account
  const disconnectAccount = async (connectionId: string) => {
    if (!confirm('Are you sure you want to disconnect this bank account?')) {
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch(`/api/plaid/disconnect/${userId}/${connectionId}`, {
        method: 'DELETE',
      });

      const data = await response.json();

      if (!data.ok) {
        throw new Error(data.error || 'Failed to disconnect account');
      }

      setSyncSuccess('Bank account disconnected successfully');
      setTimeout(() => setSyncSuccess(null), 5000);
      loadAccounts();
    } catch (err: any) {
      console.error('Error disconnecting account:', err);
      setError(err.message || 'Failed to disconnect account');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bank-account-manager">
      <div className="mb-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">
          Bank Account Integration
        </h3>
        <p className="text-sm text-gray-600 mb-4">
          Connect your bank account to automatically import transactions into your bookkeeping.
        </p>
        
        <PlaidLinkButton
          userId={userId}
          propertyId={propertyId}
          onSuccess={handleConnectionSuccess}
          onError={(err) => setError(err)}
        />
      </div>

      {/* Success message */}
      {syncSuccess && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <p className="text-sm text-green-800">{syncSuccess}</p>
          </div>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            <p className="text-sm text-red-800">{error}</p>
          </div>
        </div>
      )}

      {/* Connected accounts */}
      {isLoading ? (
        <div className="flex items-center justify-center p-8">
          <svg className="animate-spin h-8 w-8 text-blue-600" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        </div>
      ) : connections.length > 0 ? (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-gray-700 mb-3">
            Connected Accounts ({connections.length})
          </h4>
          
          {connections.map((connection) => (
            <div
              key={connection.connectionId}
              className="p-4 bg-white border border-gray-200 rounded-lg shadow-sm"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  {connection.accounts.map((account) => (
                    <div key={account.id} className="mb-2 last:mb-0">
                      <div className="flex items-center gap-2">
                        <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                        </svg>
                        <span className="font-medium text-gray-900">
                          {account.name}
                        </span>
                        {account.mask && (
                          <span className="text-sm text-gray-500">
                            ••••{account.mask}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 ml-7">
                        {account.type} • {account.subtype}
                      </p>
                    </div>
                  ))}
                  
                  <p className="text-xs text-gray-500 mt-2">
                    Connected {new Date(connection.createdAt).toLocaleDateString()}
                  </p>
                </div>

                <div className="flex flex-col gap-2 ml-4">
                  <button
                    onClick={() => syncTransactions(connection.connectionId)}
                    disabled={isSyncing === connection.connectionId}
                    className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                  >
                    {isSyncing === connection.connectionId ? (
                      <span className="flex items-center gap-1">
                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Syncing...
                      </span>
                    ) : (
                      'Sync Transactions'
                    )}
                  </button>

                  <button
                    onClick={() => disconnectAccount(connection.connectionId)}
                    disabled={isLoading}
                    className="px-3 py-1.5 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="p-8 text-center bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
          <svg className="w-12 h-12 text-gray-400 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
          </svg>
          <p className="text-gray-600">No bank accounts connected yet</p>
          <p className="text-sm text-gray-500 mt-1">
            Click "Connect Bank Account" above to get started
          </p>
        </div>
      )}
    </div>
  );
}
