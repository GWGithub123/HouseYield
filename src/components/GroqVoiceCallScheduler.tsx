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

interface GroqVoiceCallSchedulerProps {
  providerPhone?: string;
  providerName?: string;
  issueDescription?: string;
  maintenanceContext?: MaintenanceContext;
  autoFetchLatestIssue?: boolean;
}

export const GroqVoiceCallScheduler: React.FC<GroqVoiceCallSchedulerProps> = ({
  providerPhone = '',
  providerName = '',
  issueDescription = '',
  maintenanceContext,
  autoFetchLatestIssue = true
}) => {
  const [phone, setPhone] = useState(providerPhone);
  const [calling, setCalling] = useState(false);
  const [callResult, setCallResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<MaintenanceContext | undefined>(maintenanceContext);
  const [loadingContext, setLoadingContext] = useState(false);
  const [groqStatus, setGroqStatus] = useState<any>(null);

  // Check GROQ status on mount
  useEffect(() => {
    checkGroqStatus();
    if (autoFetchLatestIssue && !maintenanceContext && !context) {
      fetchLatestMaintenanceIssue();
    } else if (maintenanceContext) {
      setContext(maintenanceContext);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkGroqStatus = async () => {
    try {
      const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
      const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
      const url = useProxy 
        ? '/api/voice/groq-status' 
        : `${baseEnv || 'http://127.0.0.1:3001'}/api/voice/groq-status`;
      
      const response = await fetch(url);
      const data = await response.json();
      setGroqStatus(data);
    } catch (e) {
      console.error('[GroqVoice] Status check failed:', e);
    }
  };

  const fetchLatestMaintenanceIssue = async () => {
    setLoadingContext(true);
    try {
      const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
      const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
      const url = useProxy 
        ? '/api/tenant-emails/history?limit=1' 
        : `${baseEnv || 'http://127.0.0.1:3001'}/api/tenant-emails/history?limit=1`;

      const response = await fetch(url);
      const data = await response.json();

      if (data.ok && data.emails && data.emails.length > 0) {
        const latestEmail = data.emails[0];
        
        if (latestEmail.analysis && latestEmail.analysis.isMaintenanceIssue) {
          const analysis = latestEmail.analysis;
          
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
          console.log('[GroqVoice] ✅ Auto-loaded maintenance context:', formattedContext);
        }
      }
    } catch (e) {
      console.error('[GroqVoice] ❌ Failed to fetch maintenance issue:', e);
    } finally {
      setLoadingContext(false);
    }
  };

  const extractTenantName = (email: string): string | undefined => {
    const match = email.match(/^([^@]+)@/);
    if (match) {
      const username = match[1];
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
      // Format phone number
      let formattedPhone = phone.replace(/\D/g, '');
      if (formattedPhone.length === 10) {
        formattedPhone = '+1' + formattedPhone;
      } else if (formattedPhone.length === 11 && formattedPhone[0] === '1') {
        formattedPhone = '+' + formattedPhone;
      } else if (!formattedPhone.startsWith('+')) {
        formattedPhone = '+' + formattedPhone;
      }

      const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
      const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
      const url = useProxy 
        ? '/api/voice/groq-call' 
        : `${baseEnv || 'http://127.0.0.1:3001'}/api/voice/groq-call`;

      console.log('[GroqVoice] Initiating GROQ-powered call to:', formattedPhone);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...(import.meta.env.VITE_VOICE_API_KEY && {
            'X-API-Key': import.meta.env.VITE_VOICE_API_KEY
          })
        },
        body: JSON.stringify({
          to: formattedPhone,
          issue: issueDescription,
          providerName: providerName,
          maintenanceContext: context
        })
      });

      const json = await response.json();

      if (!json.ok) {
        throw new Error(json.error || 'Call failed');
      }

      setCallResult(json);
      console.log('[GroqVoice] ✅ Call initiated:', json);

    } catch (e: any) {
      console.error('[GroqVoice] Error:', e);
      setError(e?.message || 'Failed to initiate call');
    } finally {
      setCalling(false);
    }
  };

  const formatPhoneForDisplay = (phoneNum: string) => {
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
      {/* Header with GROQ branding */}
      <div className="px-4 py-3 bg-gradient-to-r from-orange-50 to-amber-50 border-b">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-orange-100 flex items-center justify-center">
            <svg className="w-4 h-4 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <div className="text-sm font-semibold text-gray-800 flex items-center gap-2">
              GROQ Maintenance
              <span className="text-[9px] px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded-full font-medium">
                LPU POWERED
              </span>
            </div>
            <div className="text-[10px] text-gray-500">Ultra-low latency AI voice calls</div>
          </div>
        </div>
      </div>

      <div className="p-5">
        {/* GROQ Status */}
        {groqStatus && (
          <div className={`mb-4 p-2 rounded-md text-xs ${
            groqStatus.configured 
              ? 'bg-green-50 border border-green-200 text-green-700' 
              : 'bg-red-50 border border-red-200 text-red-700'
          }`}>
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${groqStatus.configured ? 'bg-green-500' : 'bg-red-500'}`} />
              <span>
                {groqStatus.configured 
                  ? `GROQ Ready • ${groqStatus.models?.llm || 'llama-3.3-70b'}` 
                  : 'GROQ Not Configured'}
              </span>
            </div>
          </div>
        )}

        {/* Context Loading */}
        {!context && !loadingContext && (
          <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
            <div className="text-xs text-yellow-800 mb-2">
              <div className="font-medium">💡 No maintenance issue loaded</div>
              <div className="text-[11px] mt-1">
                Use email analysis above or manually provide details.
              </div>
            </div>
            <button
              onClick={fetchLatestMaintenanceIssue}
              className="text-xs text-yellow-700 hover:text-yellow-900 underline"
            >
              🔄 Load from latest email
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
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>

        {/* Maintenance Context Display */}
        {loadingContext && (
          <div className="mb-4 p-3 bg-orange-50 border border-orange-200 rounded-md">
            <div className="flex items-center gap-2 text-orange-700">
              <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="text-xs">Loading maintenance context...</span>
            </div>
          </div>
        )}

        {context && !loadingContext && (
          <div className="mb-4 p-3 bg-orange-50 border border-orange-200 rounded-md space-y-2">
            <div className="text-xs font-semibold text-orange-900 mb-2">
              ⚡ GROQ Will Communicate:
            </div>

            {context.issue && (
              <div>
                <div className="text-[10px] font-medium text-orange-700 uppercase">Issue</div>
                <div className="text-xs text-orange-900 mt-0.5">{context.issue}</div>
              </div>
            )}

            {context.urgency && (
              <div>
                <div className="text-[10px] font-medium text-orange-700 uppercase">Urgency</div>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                  context.urgency === 'emergency' ? 'bg-red-100 text-red-800' :
                  context.urgency === 'high' ? 'bg-orange-100 text-orange-800' :
                  context.urgency === 'medium' ? 'bg-yellow-100 text-yellow-800' :
                  'bg-green-100 text-green-800'
                }`}>
                  {context.urgency.toUpperCase()}
                </span>
              </div>
            )}

            {context.propertyAddress && (
              <div>
                <div className="text-[10px] font-medium text-orange-700 uppercase">Location</div>
                <div className="text-xs text-orange-900 mt-0.5">{context.propertyAddress}</div>
                {context.unitNumber && <div className="text-[11px]">Unit: {context.unitNumber}</div>}
              </div>
            )}

            {context.tenantAvailability && (
              <div className="pt-2 border-t border-orange-300">
                <div className="text-[10px] font-medium text-orange-700 uppercase mb-1">
                  🗓️ Tenant Availability
                </div>
                <div className="text-xs text-orange-900 bg-orange-100 p-2 rounded">
                  {context.tenantAvailability}
                </div>
              </div>
            )}

            <div className="pt-2 border-t border-orange-300">
              <button
                onClick={fetchLatestMaintenanceIssue}
                disabled={loadingContext}
                className="text-[11px] text-orange-600 hover:text-orange-800 underline"
              >
                Refresh context
              </button>
            </div>
          </div>
        )}

        {/* Call Button */}
        <button
          onClick={initiateCall}
          disabled={calling || !phone.trim() || (groqStatus && !groqStatus.configured)}
          className={`w-full rounded-md px-4 py-2.5 text-sm font-medium text-white transition-colors ${
            calling || !phone.trim() || (groqStatus && !groqStatus.configured)
              ? 'bg-gray-400 cursor-not-allowed'
              : 'bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600'
          }`}
        >
          {calling ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Placing GROQ Call...
            </span>
          ) : (
            <span className="flex items-center justify-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Initiate GROQ Voice Call
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
                <div className="text-xs font-medium text-green-800">GROQ Call Initiated</div>
                <div className="text-xs text-green-600 mt-1">
                  Calling {formatPhoneForDisplay(callResult.to)}...
                </div>
                <div className="text-[10px] text-green-600 mt-1 font-mono">
                  Call ID: {callResult.callSid}
                </div>
                <div className="text-[10px] text-green-600 mt-0.5">
                  Provider: {callResult.provider?.toUpperCase() || 'GROQ'}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* GROQ Features Info */}
        <div className="mt-4 p-3 bg-gradient-to-r from-orange-50 to-amber-50 border border-orange-200 rounded-md">
          <div className="text-xs text-orange-800">
            <div className="font-medium mb-1 flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              GROQ LPU Advantages:
            </div>
            <ul className="list-disc list-inside space-y-0.5 text-[11px] text-orange-700">
              <li><strong>10x faster</strong> inference than GPU-based solutions</li>
              <li>Ultra-low latency for natural conversations</li>
              <li>Whisper STT → Llama 3.3 → PlayAI TTS pipeline</li>
              <li>Real-time streaming for immediate responses</li>
              <li>Context-aware maintenance scheduling</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GroqVoiceCallScheduler;
