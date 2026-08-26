/**
 * LandlordBankSetup - Component for landlords to connect their bank account via Stripe Connect
 * This allows them to receive rent payments directly from tenants
 */

import { useState, useEffect } from 'react';
import StripeTransactions from './StripeTransactions';

interface ConnectedAccount {
  accountId: string;
  email: string;
  propertyId: string | null;
  createdAt: string;
  onboardingComplete: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  externalAccounts?: Array<{
    id: string;
    bankName: string;
    last4: string;
    routingNumber: string;
  }>;
}

interface LandlordBankSetupProps {
  userId: string;
  userEmail: string;
  propertyId?: string;
  onAccountConnected?: (accountId: string) => void;
}

export default function LandlordBankSetup({ 
  userId, 
  userEmail, 
  propertyId, 
  onAccountConnected 
}: LandlordBankSetupProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [showTransactions, setShowTransactions] = useState(false);

  // Load connected accounts on mount
  useEffect(() => {
    loadAccounts();
  }, [userId]);

  const loadAccounts = async () => {
    try {
      const response = await fetch(`/api/stripe-connect/accounts/${userId}`);
      const data = await response.json();

      if (data.ok) {
        setAccounts(data.accounts);
        
        // Auto-select the first connected account
        if (data.accounts.length > 0) {
          const connectedAccount = data.accounts.find((acc: ConnectedAccount) => 
            acc.onboardingComplete && acc.chargesEnabled
          );
          if (connectedAccount) {
            setSelectedAccount(connectedAccount.accountId);
            // Notify parent component
            if (onAccountConnected) {
              onAccountConnected(connectedAccount.accountId);
            }
          } else {
            // If we have an account but it's not ready yet, still try to use it
            const anyAccount = data.accounts[0];
            if (anyAccount) {
              setSelectedAccount(anyAccount.accountId);
              if (onAccountConnected) {
                onAccountConnected(anyAccount.accountId);
              }
            }
          }
        }
      }
    } catch (err: any) {
      console.error('Error loading accounts:', err);
    }
  };

  const handleConnectAccount = async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Step 1: Create Stripe Connect account
      const createResponse = await fetch('/api/stripe-connect/create-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          email: userEmail,
          propertyId
        })
      });

      const createData = await createResponse.json();

      if (!createData.ok) {
        throw new Error(createData.error || 'Failed to create account');
      }

      // Step 2: Get onboarding link
      const linkResponse = await fetch('/api/stripe-connect/create-account-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: createData.accountId
        })
      });

      const linkData = await linkResponse.json();

      if (!linkData.ok) {
        throw new Error(linkData.error || 'Failed to create onboarding link');
      }

      // Step 3: Redirect to Stripe onboarding
      window.location.href = linkData.url;

      if (onAccountConnected) {
        onAccountConnected(createData.accountId);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to connect bank account');
      console.error('Connect error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    if (!confirm('Are you sure you want to disconnect this bank account? You will no longer be able to receive payments.')) {
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch(`/api/stripe-connect/disconnect/${userId}/${accountId}`, {
        method: 'DELETE'
      });

      const data = await response.json();

      if (!data.ok) {
        throw new Error(data.error || 'Failed to disconnect account');
      }

      // Reload accounts
      await loadAccounts();
      setSelectedAccount(null);
    } catch (err: any) {
      setError(err.message || 'Failed to disconnect account');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResumeOnboarding = async (accountId: string) => {
    try {
      setIsLoading(true);
      setError(null);

      // Get a new account link to resume onboarding
      const response = await fetch('/api/stripe-connect/create-account-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId
        })
      });

      const data = await response.json();

      if (!data.ok) {
        throw new Error(data.error || 'Failed to create onboarding link');
      }

      // Redirect to Stripe onboarding
      window.location.href = data.url;
    } catch (err: any) {
      setError(err.message || 'Failed to resume onboarding');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCheckStatus = async (accountId: string) => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch(`/api/stripe-connect/account-status/${accountId}`);
      const data = await response.json();

      if (data.ok) {
        // Reload accounts to get updated status
        await loadAccounts();
      } else {
        setError(data.error || 'Failed to check account status');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to check account status');
    } finally {
      setIsLoading(false);
    }
  };

  const handleConnectBankData = async (accountId: string) => {
    try {
      setIsLoading(true);
      setError(null);

      // Get Stripe publishable key
      const configResponse = await fetch('/api/stripe-connect/config');
      const configData = await configResponse.json();
      
      if (!configData.ok || !configData.publishableKey) {
        throw new Error('Failed to get Stripe configuration');
      }

      // Create Financial Connections session
      const response = await fetch('/api/stripe-connect/create-financial-connections-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId,
          userId
        })
      });

      const data = await response.json();

      if (!data.ok) {
        throw new Error(data.error || 'Failed to create Financial Connections session');
      }

      // Load Stripe.js Financial Connections SDK
      const stripe = (window as any).Stripe(configData.publishableKey);
      
      // Collect Financial Connections Account
      const result = await stripe.collectFinancialConnectionsAccounts({
        clientSecret: data.clientSecret,
      });

      if (result.error) {
        throw new Error(result.error.message);
      }

      console.log('Financial Connections linked:', result.financialConnectionsSession);
      
      // Show success message
      alert('✅ Bank account connected successfully! Your transaction history will be available shortly.');
      
      // Reload accounts to get updated status
      await loadAccounts();
    } catch (err: any) {
      setError(err.message || 'Failed to connect bank data');
      console.error('Connect bank data error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* View Toggle */}
      {selectedAccount && (
        <div className="flex gap-2 border-b border-gray-200 pb-4">
          <button
            onClick={() => setShowTransactions(false)}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              !showTransactions
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            🏦 Account Setup
          </button>
          <button
            onClick={() => setShowTransactions(true)}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              showTransactions
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            💳 Transactions & Bookkeeping
          </button>
        </div>
      )}

      {/* Show Transactions View */}
      {showTransactions && selectedAccount ? (
        <StripeTransactions
          accountId={selectedAccount}
          userId={userId}
          propertyId={propertyId}
        />
      ) : (
        <>
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-gray-800">Bank Account Setup</h3>
              <p className="text-sm text-gray-500">Connect your bank account to receive rent payments</p>
            </div>
            {accounts.length === 0 && (
              <button
                onClick={handleConnectAccount}
                disabled={isLoading}
                className="rounded-lg bg-blue-600 text-white px-4 py-2 text-sm hover:bg-blue-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <span className="flex items-center gap-2">
                    <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Connecting...
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                    </svg>
                    Connect Bank Account
                  </span>
                )}
              </button>
            )}
          </div>

          {/* Error Message */}
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4">
              <div className="flex items-start gap-3">
                <svg className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                <div className="flex-1">
                  <div className="text-sm font-medium text-red-800">Connection Error</div>
                  <div className="text-sm text-red-700 mt-1">{error}</div>
                </div>
              </div>
            </div>
          )}

          {/* Connected Accounts */}
          {accounts.length > 0 && (
            <div className="space-y-3">
              {accounts.map((account) => (
                <div
                  key={account.accountId}
                  className={`rounded-lg border p-4 ${
                    selectedAccount === account.accountId
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
                          <svg className="h-5 w-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                          </svg>
                        </div>
                        <div>
                          <div className="font-semibold text-gray-800">{account.email}</div>
                          <div className="text-xs text-gray-500">
                            Connected {new Date(account.createdAt).toLocaleDateString()}
                          </div>
                        </div>
                      </div>

                      {/* Status Badges */}
                      <div className="flex flex-wrap gap-2 mb-3">
                        {account.onboardingComplete ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                            <svg className="h-3 w-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                            </svg>
                            Onboarding Complete
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                            Onboarding Incomplete
                          </span>
                        )}
                        
                        {account.chargesEnabled ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                            ✓ Can Accept Payments
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                            Cannot Accept Payments
                          </span>
                        )}
                        
                        {account.payoutsEnabled && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                            ✓ Payouts Enabled
                          </span>
                        )}
                      </div>

                      {/* Bank Accounts */}
                      {account.externalAccounts && account.externalAccounts.length > 0 && (
                        <div className="space-y-2">
                          {account.externalAccounts.map((bank) => (
                            <div key={bank.id} className="flex items-center gap-2 text-sm text-gray-600">
                              <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                              </svg>
                              <span>{bank.bankName || 'Bank Account'} ••••{bank.last4}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex flex-col gap-2">
                      {account.onboardingComplete && account.chargesEnabled && (
                        <>
                          <button
                            onClick={() => {
                              setSelectedAccount(account.accountId);
                              setShowTransactions(true);
                            }}
                            className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 whitespace-nowrap"
                          >
                            View Transactions
                          </button>
                          <button
                            onClick={() => handleConnectBankData(account.accountId)}
                            disabled={isLoading}
                            className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 whitespace-nowrap"
                          >
                            🔗 Connect Bank Data
                          </button>
                        </>
                      )}
                      {!account.onboardingComplete && (
                        <button
                          onClick={() => handleResumeOnboarding(account.accountId)}
                          disabled={isLoading}
                          className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
                        >
                          Complete Setup
                        </button>
                      )}
                      {!account.chargesEnabled && (
                        <button
                          onClick={() => handleCheckStatus(account.accountId)}
                          disabled={isLoading}
                          className="text-sm text-blue-600 hover:text-blue-700 font-medium disabled:opacity-50 whitespace-nowrap"
                        >
                          Check Status
                        </button>
                      )}
                      <button
                        onClick={() => handleDisconnect(account.accountId)}
                        disabled={isLoading}
                        className="text-sm text-red-600 hover:text-red-700 font-medium disabled:opacity-50"
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                </div>
              ))}

              {/* Add Another Account */}
              <button
                onClick={handleConnectAccount}
                disabled={isLoading}
                className="w-full rounded-lg border-2 border-dashed border-gray-300 p-4 text-sm text-gray-600 hover:border-blue-500 hover:text-blue-600 font-medium"
              >
                + Connect Another Account
              </button>
            </div>
          )}

          {/* Info Box */}
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
            <div className="flex items-start gap-3">
              <div className="h-8 w-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                <svg className="h-4 w-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-blue-900 mb-1">Secure Bank Connection</div>
                <ul className="text-xs text-blue-800 space-y-1">
                  <li>• Bank-level security with Stripe Connect</li>
                  <li>• Payments deposited directly to your account</li>
                  <li>• 2% platform fee on all transactions</li>
                  <li>• Tenants can pay via ACH or credit card</li>
                  <li>• View and sync transactions to your bookkeeping system</li>
                </ul>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
