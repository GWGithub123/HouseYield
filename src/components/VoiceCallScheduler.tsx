import React, { useState, useEffect } from 'react';

interface MaintenanceContext {
  issue?: string;
  urgency?: string;
  location?: string;
  serviceCategory?: string;
  tenantAvailability?: string;
  tenantName?: string;
  tenantEmail?: string;
  tenantPhone?: string;
  propertyAddress?: string;
  unitNumber?: string;
}

interface VoiceCallSchedulerProps {
  providerPhone?: string;
  providerName?: string;
  issueDescription?: string;
  maintenanceContext?: MaintenanceContext;
  autoFetchLatestIssue?: boolean;  // New prop to auto-load from email analysis
}

export const VoiceCallScheduler: React.FC<VoiceCallSchedulerProps> = ({
  providerPhone = '',
  providerName = '',
  issueDescription = '',
  maintenanceContext,
  autoFetchLatestIssue = true  // Default to true
}) => {
  const [phone, setPhone] = useState(providerPhone);
  const [calling, setCalling] = useState(false);
  const [callResult, setCallResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<MaintenanceContext | undefined>(maintenanceContext);
  const [loadingContext, setLoadingContext] = useState(false);

  // Auto-fetch latest maintenance issue on component mount
  useEffect(() => {
    if (autoFetchLatestIssue && !maintenanceContext && !context) {
      console.log('[VoiceCall] Auto-fetching latest maintenance issue...');
      fetchLatestMaintenanceIssue();
    } else if (maintenanceContext) {
      console.log('[VoiceCall] Using provided maintenance context');
      setContext(maintenanceContext);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchLatestMaintenanceIssue = async () => {
    setLoadingContext(true);
    try {
      const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
      const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
      const url = useProxy 
        ? '/api/tenant-emails/history?limit=1' 
        : `${baseEnv || 'http://127.0.0.1:3001'}/api/tenant-emails/history?limit=1`;

      console.log('[VoiceCall] Fetching from:', url);
      const response = await fetch(url);
      const data = await response.json();

      console.log('[VoiceCall] Email history response:', data);

      if (data.ok && data.emails && data.emails.length > 0) {
        const latestEmail = data.emails[0];
        console.log('[VoiceCall] Latest email:', latestEmail);
        
        // Check if it has maintenance analysis
        if (latestEmail.analysis && latestEmail.analysis.isMaintenanceIssue) {
          const analysis = latestEmail.analysis;
          
          // Format context from email analysis
          const formattedContext: MaintenanceContext = {
            issue: analysis.issue,
            urgency: analysis.urgency,
            location: analysis.location,
            serviceCategory: analysis.serviceCategory,
            tenantAvailability: analysis.tenantAvailability,
            tenantPhone: analysis.tenantPhone,
            propertyAddress: analysis.propertyAddress,
            unitNumber: analysis.unitNumber,
            tenantEmail: latestEmail.from,
            tenantName: extractTenantName(latestEmail.from)
          };

          setContext(formattedContext);
          console.log('[VoiceCall] ✅ Auto-loaded maintenance context:', formattedContext);
        } else {
          console.log('[VoiceCall] ⚠️ Latest email is not a maintenance issue');
        }
      } else {
        console.log('[VoiceCall] ⚠️ No emails found in history');
      }
    } catch (e) {
      console.error('[VoiceCall] ❌ Failed to fetch latest maintenance issue:', e);
    } finally {
      setLoadingContext(false);
    }
  };

  const extractTenantName = (email: string): string | undefined => {
    // Simple email to name extraction (firstname from email)
    const match = email.match(/^([^@]+)@/);
    if (match) {
      const username = match[1];
      // Convert firstname.lastname to Firstname Lastname
      const parts = username.split(/[._-]/);
      return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
    }
    return undefined;
  };

  const initiateCall = async () => {
    if (!phone.trim()) {
      setError('Phone number is required');
      return;
    }

    setCalling(true);
    setError(null);
    setCallResult(null);

    try {
      // Format phone number to E.164 format (+1XXXXXXXXXX)
      let formattedPhone = phone.replace(/\D/g, ''); // Remove non-digits
      if (formattedPhone.length === 10) {
        formattedPhone = '+1' + formattedPhone; // Add +1 for US numbers
      } else if (formattedPhone.length === 11 && formattedPhone[0] === '1') {
        formattedPhone = '+' + formattedPhone; // Add + if it starts with 1
      } else if (!formattedPhone.startsWith('+')) {
        formattedPhone = '+' + formattedPhone; // Add + if missing
      }

      const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
      const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
      // Use GROQ voice endpoint for ultra-low latency LPU-powered calls
      const url = useProxy 
        ? '/api/voice/groq-call' 
        : `${baseEnv || 'http://127.0.0.1:3001'}/api/voice/groq-call`;

      console.log('[VoiceCall] Initiating call to:', formattedPhone);
      console.log('[VoiceCall] Using context:', context);
      if (context) {
        console.log('[VoiceCall] ✅ Will communicate:');
        console.log('  - Issue:', context.issue);
        console.log('  - Urgency:', context.urgency);
        console.log('  - Tenant Availability:', context.tenantAvailability);
        console.log('  - Property Address:', context.propertyAddress);
      } else {
        console.log('[VoiceCall] ⚠️ No maintenance context - call will be generic');
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          // Add API key for authentication (only if configured)
          ...(import.meta.env.VITE_VOICE_API_KEY && {
            'X-API-Key': import.meta.env.VITE_VOICE_API_KEY
          })
        },
        body: JSON.stringify({
          to: formattedPhone,
          issue: issueDescription,
          providerName: providerName,
          maintenanceContext: context  // Use the state context (auto-loaded or passed in)
        })
      });

      const text = await response.text();
      let json;
      
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Invalid response from server (status ${response.status})`);
      }

      if (!json.ok) {
        throw new Error(json.error || 'Call failed');
      }

      setCallResult(json);
      console.log('[VoiceCall] Call initiated successfully:', json);

    } catch (e: any) {
      console.error('[VoiceCall] Error:', e);
      setError(e?.message || 'Failed to initiate call');
    } finally {
      setCalling(false);
    }
  };

  const formatPhoneForDisplay = (phoneNum: string) => {
    // Simple US phone formatting
    const cleaned = phoneNum.replace(/\D/g, '');
    if (cleaned.length === 10) {
      return `(${cleaned.slice(0,3)}) ${cleaned.slice(3,6)}-${cleaned.slice(6)}`;
    } else if (cleaned.length === 11 && cleaned[0] === '1') {
      return `+1 (${cleaned.slice(1,4)}) ${cleaned.slice(4,7)}-${cleaned.slice(7)}`;
    }
    return phoneNum;
  };

  return (
    <div className="rounded-xl border bg-white overflow-hidden">
      <div className="px-4 py-3 bg-gradient-to-r from-purple-50 to-blue-50 border-b">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center">
            <svg className="w-4 h-4 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
            </svg>
          </div>
          <div>
            <div className="text-sm font-semibold text-gray-800">AI Voice Call Scheduler</div>
            <div className="text-[10px] text-gray-500">Automated phone call to schedule maintenance</div>
          </div>
        </div>
      </div>

      <div className="p-5">
        {/* Manual email text input for testing */}
        {!context && !loadingContext && (
          <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
            <div className="text-xs text-yellow-800 mb-2">
              <div className="font-medium">💡 No maintenance issue loaded</div>
              <div className="text-[11px] mt-1">
                To test: Use the "Check for New Tenant Emails" feature in the Maintenance section above, 
                or manually analyze an email using the API, then refresh this component.
              </div>
            </div>
            <button
              onClick={fetchLatestMaintenanceIssue}
              className="text-xs text-yellow-700 hover:text-yellow-900 underline"
            >
              🔄 Try loading again
            </button>
          </div>
        )}

        {/* Phone Input */}
        <div className="mb-4">
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Provider Phone Number
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 (555) 123-4567"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
        </div>

        {/* Provider Info (if available) */}
        {(providerName || context || loadingContext) && (
          <div className="mb-4 space-y-3">
            {providerName && (
              <div className="p-3 bg-gray-50 rounded-md">
                <div className="text-xs font-medium text-gray-700 mb-1">Calling:</div>
                <div className="text-sm text-gray-900">{providerName}</div>
              </div>
            )}

            {loadingContext && (
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
                <div className="flex items-center gap-2 text-blue-700">
                  <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <span className="text-xs">Loading latest maintenance issue...</span>
                </div>
              </div>
            )}

            {context && !loadingContext && (
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-md space-y-2">
                <div className="text-xs font-semibold text-blue-900 mb-2">
                  Maintenance Details to Communicate:
                </div>

                {context.issue && (
                  <div>
                    <div className="text-[10px] font-medium text-blue-700 uppercase">Issue</div>
                    <div className="text-xs text-blue-900 mt-0.5">{context.issue}</div>
                  </div>
                )}

                {context.urgency && (
                  <div>
                    <div className="text-[10px] font-medium text-blue-700 uppercase">Urgency</div>
                    <div className="text-xs">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        context.urgency === 'emergency' ? 'bg-red-100 text-red-800' :
                        context.urgency === 'high' ? 'bg-orange-100 text-orange-800' :
                        context.urgency === 'medium' ? 'bg-yellow-100 text-yellow-800' :
                        'bg-green-100 text-green-800'
                      }`}>
                        {context.urgency.toUpperCase()}
                      </span>
                    </div>
                  </div>
                )}

                {(context.propertyAddress || context.location) && (
                  <div>
                    <div className="text-[10px] font-medium text-blue-700 uppercase">Location</div>
                    <div className="text-xs text-blue-900 mt-0.5">
                      {context.propertyAddress && (
                        <div>{context.propertyAddress}</div>
                      )}
                      {context.unitNumber && (
                        <div className="text-[11px]">Unit: {context.unitNumber}</div>
                      )}
                      {context.location && !context.unitNumber && (
                        <div className="text-[11px]">{context.location}</div>
                      )}
                    </div>
                  </div>
                )}

                {context.tenantAvailability && (
                  <div className="pt-2 border-t border-blue-300">
                    <div className="text-[10px] font-medium text-blue-700 uppercase mb-1">
                      🗓️ Tenant Availability
                    </div>
                    <div className="text-xs text-blue-900 bg-blue-100 p-2 rounded">
                      {context.tenantAvailability}
                    </div>
                  </div>
                )}

                {(context.tenantName || context.tenantEmail || context.tenantPhone) && (
                  <div className="pt-2 border-t border-blue-300 text-[11px] text-blue-800">
                    {context.tenantName && (
                      <div>Tenant: {context.tenantName}</div>
                    )}
                    {context.tenantEmail && (
                      <div>Email: {context.tenantEmail}</div>
                    )}
                    {context.tenantPhone && (
                      <div>Phone: {context.tenantPhone}</div>
                    )}
                  </div>
                )}

                {/* Refresh button */}
                <div className="pt-2 border-t border-blue-300">
                  <button
                    onClick={fetchLatestMaintenanceIssue}
                    disabled={loadingContext}
                    className="text-[11px] text-blue-600 hover:text-blue-800 underline"
                  >
                    Refresh from latest email
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Call Button */}
        <button
          onClick={initiateCall}
          disabled={calling || !phone.trim()}
          className={`w-full rounded-md px-4 py-2.5 text-sm font-medium text-white transition-colors ${
            calling || !phone.trim()
              ? 'bg-gray-400 cursor-not-allowed'
              : 'bg-purple-600 hover:bg-purple-700'
          }`}
        >
          {calling ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Placing Call...
            </span>
          ) : (
            <span className="flex items-center justify-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
              </svg>
              Initiate AI Voice Call
            </span>
          )}
        </button>

        {/* Error Display */}
        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-md">
            <div className="flex items-start gap-2">
              <svg className="w-4 h-4 text-red-600 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
              <div>
                <div className="text-xs font-medium text-red-800">Call Failed</div>
                <div className="text-xs text-red-600 mt-0.5">{error}</div>
              </div>
            </div>
          </div>
        )}

        {/* Success Display */}
        {callResult && callResult.ok && (
          <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-md">
            <div className="flex items-start gap-2">
              <svg className="w-4 h-4 text-green-600 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <div className="flex-1">
                <div className="text-xs font-medium text-green-800">Call Initiated Successfully</div>
                <div className="text-xs text-green-600 mt-1">
                  Calling {formatPhoneForDisplay(callResult.to)}...
                </div>
                <div className="text-[10px] text-green-600 mt-1 font-mono">
                  Call ID: {callResult.callSid}
                </div>
                {callResult.status && (
                  <div className="text-[10px] text-green-600 mt-0.5">
                    Status: {callResult.status}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Info Box */}
        <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
          <div className="text-xs text-blue-800">
            <div className="font-medium mb-1">How AI Voice Automation Works:</div>
            <ul className="list-disc list-inside space-y-1 text-[11px]">
              <li>AI calls the provider's phone number</li>
              <li>Explains the maintenance issue in detail</li>
              {context?.tenantAvailability && (
                <li>Communicates tenant's availability schedule</li>
              )}
              <li>Coordinates and schedules an appointment</li>
              <li>Confirms all details before ending call</li>
              <li>Natural, human-like conversation</li>
            </ul>
            {autoFetchLatestIssue && !context && !loadingContext && (
              <div className="mt-2 text-[10px] text-blue-600">
                💡 Tip: The system will automatically load details from the latest tenant email when available
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default VoiceCallScheduler;
