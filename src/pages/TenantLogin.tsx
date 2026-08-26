import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getCurrentUserProfile, updateUserProfileFields } from '../services/firebaseService';

export default function TenantLogin() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login, loginWithGoogle, updateUser } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteToken, setInviteToken] = useState(searchParams.get('invite') || '');
  const [inviteData, setInviteData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [validatingInvite, setValidatingInvite] = useState(!!searchParams.get('invite'));
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Validate invite token on load if present
  useEffect(() => {
    if (inviteToken) {
      validateInvite();
    }
  }, []);

  const syncTenantFields = async (firebaseUid: string) => {
    const response = await fetch(`/api/tenants/${firebaseUid}`);
    const data = await response.json();

    if (!response.ok || !data.ok || !data.tenant) {
      return null;
    }

    const tenantUpdates = {
      tenantId: data.tenant.id,
      propertyId: data.tenant.propertyId,
      propertyAddress: data.tenant.propertyAddress,
      unit: data.tenant.unit,
      landlordAccountId: data.tenant.ownerId,
      leaseStart: data.tenant.leaseStart || undefined,
      leaseEnd: data.tenant.leaseEnd || undefined,
      monthlyRent: data.tenant.monthlyRent ?? undefined,
      photoURL: data.tenant.photoURL || undefined,
    };

    const syncResult = await updateUserProfileFields(firebaseUid, tenantUpdates);
    if (!syncResult.success) {
      console.warn('[TenantLogin] Failed to sync tenant profile fields:', syncResult.error);
    }

    updateUser(tenantUpdates);
    return tenantUpdates;
  };

  const validateInvite = async () => {
    setValidatingInvite(true);
    setError(null);

    try {
      const response = await fetch(`/api/tenants/invite/${inviteToken}`);
      const data = await response.json();
      
      if (data.ok) {
        setInviteData(data.invite);
        setEmail(data.invite.tenantEmail || '');
      } else {
        setError(data.error || 'Invalid invite link');
        setInviteToken('');
      }
    } catch (err: any) {
      setError('Failed to validate invite link');
      setInviteToken('');
    } finally {
      setValidatingInvite(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await login(email, password, 'tenant');
      const currentUser = await getCurrentUserProfile();

      if (!currentUser) {
        throw new Error('Authenticated user profile not found');
      }
      
      // If we have an invite token, complete registration
      if (inviteToken && inviteData) {
        const regResponse = await fetch('/api/tenants/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: inviteToken,
            firebaseUid: currentUser.id, // Firebase UID for linking
            tenantEmail: email,
            tenantName: currentUser.name
          })
        });

        const regData = await regResponse.json();
        
        if (regData.ok) {
          const tenantUpdates = {
            tenantId: regData.tenantId,
            propertyId: regData.tenantData?.propertyId,
            propertyAddress: regData.tenantData?.propertyAddress,
            unit: regData.tenantData?.unit,
            landlordAccountId: regData.tenantData?.landlordAccountId,
            leaseStart: regData.tenantData?.leaseStart,
            leaseEnd: regData.tenantData?.leaseEnd,
            monthlyRent: regData.tenantData?.monthlyRent
          };

          const syncResult = await updateUserProfileFields(currentUser.id, tenantUpdates);
          if (!syncResult.success) {
            console.warn('[TenantLogin] Failed to persist tenant fields to Firestore user profile:', syncResult.error);
          }

          updateUser(tenantUpdates);
          console.log('[TenantLogin] ✅ Tenant registered with property:', regData.tenantData?.propertyAddress);
        } else {
          console.warn('[TenantLogin] Registration failed:', regData.error);
        }
      } else {
        await syncTenantFields(currentUser.id);
      }
      
      navigate('/tenant/dashboard');
    } catch (err: any) {
      setError(err.message || 'Login failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    setError(null);

    try {
      await loginWithGoogle('tenant');
      const currentUser = await getCurrentUserProfile();

      if (!currentUser) {
        throw new Error('Authenticated user profile not found');
      }
      
      // If we have an invite token, complete registration after Google sign-in
      if (inviteToken && inviteData) {
        const regResponse = await fetch('/api/tenants/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: inviteToken,
            firebaseUid: currentUser.id,
            tenantEmail: currentUser.email,
            tenantName: currentUser.name,
            photoURL: currentUser.photoURL // Pass Google profile photo
          })
        });

        const regData = await regResponse.json();
        
        if (regData.ok) {
          const tenantUpdates = {
            tenantId: regData.tenantId,
            propertyId: regData.tenantData?.propertyId,
            propertyAddress: regData.tenantData?.propertyAddress,
            unit: regData.tenantData?.unit,
            landlordAccountId: regData.tenantData?.landlordAccountId,
            leaseStart: regData.tenantData?.leaseStart,
            leaseEnd: regData.tenantData?.leaseEnd,
            monthlyRent: regData.tenantData?.monthlyRent
          };

          const syncResult = await updateUserProfileFields(currentUser.id, tenantUpdates);
          if (!syncResult.success) {
            console.warn('[TenantLogin] Failed to persist tenant fields to Firestore user profile:', syncResult.error);
          }

          updateUser(tenantUpdates);
          console.log('[TenantLogin] ✅ Tenant registered via Google with property:', regData.tenantData?.propertyAddress);
        } else {
          console.warn('[TenantLogin] Registration failed:', regData.error);
        }
      } else {
        // No invite token - existing tenant logging back in
        // Sync Google photo to tenant record if available
        if (currentUser.photoURL && currentUser.id) {
          try {
            await fetch(`/api/tenants/${currentUser.id}/photo`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ photoURL: currentUser.photoURL })
            });
            console.log('[TenantLogin] ✅ Synced Google photo to tenant record');
          } catch (syncError) {
            console.error('[TenantLogin] Failed to sync photo:', syncError);
          }
        }

        await syncTenantFields(currentUser.id);
      }
      
      navigate('/tenant/dashboard');
    } catch (err: any) {
      setError(err.message || 'Google sign-in failed. Please try again.');
    } finally {
      setGoogleLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-purple-100 flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        {/* Back Button */}
        <button
          onClick={() => navigate('/')}
          className="mb-6 flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to selection
        </button>

        {/* Login Card */}
        <div className="bg-white rounded-2xl shadow-xl p-8">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </div>
            <h2 className="text-3xl font-bold text-gray-900 mb-2">
              {inviteData ? 'Complete Your Registration' : 'Tenant Login'}
            </h2>
            <p className="text-gray-600">
              {inviteData ? 'Set up your tenant account' : 'Access your tenant portal'}
            </p>
          </div>

          {/* Validating Invite */}
          {validatingInvite && (
            <div className="text-center py-8">
              <svg className="animate-spin h-8 w-8 text-purple-600 mx-auto mb-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <p className="text-gray-600">Validating your invitation...</p>
            </div>
          )}

          {/* Show Property Info After Invite Validation */}
          {!validatingInvite && inviteData && (
            <div className="mb-6 bg-green-50 border border-green-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <div>
                  <div className="text-sm font-semibold text-green-900">Invitation Validated ✓</div>
                  <div className="text-sm text-green-700 mt-1 space-y-0.5">
                    <div><strong>Property:</strong> {inviteData.propertyAddress}</div>
                    {inviteData.unit && <div><strong>Unit:</strong> {inviteData.unit}</div>}
                    <div><strong>Landlord:</strong> {inviteData.landlordName}</div>
                    {inviteData.leaseStart && inviteData.leaseEnd && (
                      <div><strong>Lease:</strong> {new Date(inviteData.leaseStart).toLocaleDateString()} - {new Date(inviteData.leaseEnd).toLocaleDateString()}</div>
                    )}
                    {inviteData.monthlyRent && (
                      <div><strong>Monthly Rent:</strong> ${inviteData.monthlyRent.toLocaleString()}</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
          {/* Error Message */}
          {error && (
            <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                <div className="text-sm text-red-800">{error}</div>
              </div>
            </div>
          )}

          {/* Login Form */}
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2">
                Email Address
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
                placeholder="tenant@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
                placeholder="••••••••"
              />
            </div>

            <div className="flex items-center justify-between">
              <label className="flex items-center">
                <input type="checkbox" className="w-4 h-4 text-purple-600 border-gray-300 rounded focus:ring-purple-500" />
                <span className="ml-2 text-sm text-gray-600">Remember me</span>
              </label>
              <a href="#" className="text-sm text-purple-600 hover:text-purple-700">
                Forgot password?
              </a>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Logging in...
                </span>
              ) : (
                'Login'
              )}
            </button>
          </form>

          {/* Divider */}
          <div className="my-6 flex items-center">
            <div className="flex-1 border-t border-gray-300"></div>
            <span className="px-4 text-sm text-gray-500">or</span>
            <div className="flex-1 border-t border-gray-300"></div>
          </div>

          {/* Google Sign-In Button */}
          <button
            onClick={handleGoogleSignIn}
            disabled={googleLoading}
            className="w-full flex items-center justify-center gap-3 bg-white border border-gray-300 hover:bg-gray-50 disabled:bg-gray-100 text-gray-700 font-medium py-3 px-6 rounded-lg transition-colors duration-200"
          >
            {googleLoading ? (
              <svg className="animate-spin h-5 w-5 text-gray-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
            )}
            {googleLoading ? 'Signing in...' : 'Continue with Google'}
          </button>

          {/* Sign Up Link */}
          <div className="mt-6 pt-6 border-t border-gray-200">
            <p className="text-center text-sm text-gray-600">
              Don't have an account?{' '}
              <button 
                onClick={() => navigate('/signup/tenant')}
                className="text-purple-600 hover:text-purple-700 font-medium"
              >
                Sign up
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
