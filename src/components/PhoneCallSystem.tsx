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

interface PhoneCallSystemProps {
  providerPhone?: string;
  providerName?: string;
  issueDescription?: string;
  maintenanceContext?: MaintenanceContext;
  autoFetchLatestIssue?: boolean;
}

// Top OpenAI Realtime voices (marin & cedar recommended for best quality)
const OPENAI_REALTIME_VOICES = [
  { id: 'marin', label: 'Marin', desc: 'Warm & natural (recommended)', emoji: '🌊' },
  { id: 'cedar', label: 'Cedar', desc: 'Clear & confident (recommended)', emoji: '🌲' },
  { id: 'sage', label: 'Sage', desc: 'Calm & articulate', emoji: '🧘' },
  { id: 'coral', label: 'Coral', desc: 'Friendly & upbeat', emoji: '🪸' },
  { id: 'ash', label: 'Ash', desc: 'Smooth & composed', emoji: '✨' },
  { id: 'verse', label: 'Verse', desc: 'Dynamic & expressive', emoji: '🎵' },
  { id: 'ballad', label: 'Ballad', desc: 'Gentle & soothing', emoji: '🎶' },
  { id: 'shimmer', label: 'Shimmer', desc: 'Light & energetic', emoji: '💫' },
  { id: 'alloy', label: 'Alloy', desc: 'Balanced & neutral', emoji: '⚙️' },
  { id: 'echo', label: 'Echo', desc: 'Deep & resonant', emoji: '🔊' },
] as const;

export const PhoneCallSystem: React.FC<PhoneCallSystemProps> = ({
  providerPhone = '',
  providerName = '',
  issueDescription = '',
  maintenanceContext,
  autoFetchLatestIssue = true
}) => {
  const defaultApiBase = ((import.meta as any).env?.VITE_PUSH_SERVER_URL || '').trim();
  const phoneCallApiBase = ((import.meta as any).env?.VITE_PHONE_CALL_BACKEND_URL || defaultApiBase).trim();
  const usingDedicatedPhoneBackend = Boolean(phoneCallApiBase && phoneCallApiBase !== defaultApiBase);
  const [phone, setPhone] = useState(providerPhone);
  const [calling, setCalling] = useState(false);
  const [callResult, setCallResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<MaintenanceContext | undefined>(maintenanceContext);
  const [loadingContext, setLoadingContext] = useState(false);
  const [systemStatus, setSystemStatus] = useState<any>(null);
  const [groqStatus, setGroqStatus] = useState<any>(null);
  const [groqElevenLabsStatus, setGroqElevenLabsStatus] = useState<any>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [voiceProvider, setVoiceProvider] = useState<'openai' | 'groq' | 'groq-elevenlabs'>('groq-elevenlabs'); // Toggle between providers
  const [openaiVoice, setOpenaiVoice] = useState<string>('marin');
  const selectedVoiceInfo = OPENAI_REALTIME_VOICES.find(v => v.id === openaiVoice) || OPENAI_REALTIME_VOICES[0];

  // Check phone system status on mount
  useEffect(() => {
    checkPhoneStatus();
    if (autoFetchLatestIssue && !maintenanceContext && !context) {
      fetchLatestMaintenanceIssue();
    } else if (maintenanceContext) {
      setContext(maintenanceContext);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getApiUrl = (path: string, options?: { phoneBackend?: boolean }) => {
    const baseEnv = options?.phoneBackend ? phoneCallApiBase : defaultApiBase;
    const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
    return useProxy ? path : `${baseEnv || 'http://127.0.0.1:3001'}${path}`;
  };

  const checkPhoneStatus = async () => {
    setStatusLoading(true);
    try {
      // Check all voice providers status in parallel
      const [openaiRes, groqRes, groqELRes] = await Promise.all([
        fetch(getApiUrl('/api/voice/status', { phoneBackend: true })).catch(() => null),
        fetch(getApiUrl('/api/voice/groq-status', { phoneBackend: true })).catch(() => null),
        fetch(getApiUrl('/api/voice/groq-elevenlabs-phone-status', { phoneBackend: true })).catch(() => null)
      ]);
      
      if (openaiRes?.ok) {
        const data = await openaiRes.json();
        setSystemStatus(data);
      } else {
        setSystemStatus({ configured: false });
      }
      
      if (groqRes?.ok) {
        const data = await groqRes.json();
        setGroqStatus(data);
      } else {
        setGroqStatus({ configured: false });
      }
      
      if (groqELRes?.ok) {
        const data = await groqELRes.json();
        setGroqElevenLabsStatus(data);
      } else {
        setGroqElevenLabsStatus({ configured: false });
      }
    } catch (e) {
      console.error('[Phone] Status check failed:', e);
      setSystemStatus({ configured: false, error: 'Failed to connect' });
      setGroqStatus({ configured: false, error: 'Failed to connect' });
      setGroqElevenLabsStatus({ configured: false, error: 'Failed to connect' });
    } finally {
      setStatusLoading(false);
    }
  };

  const fetchLatestMaintenanceIssue = async () => {
    setLoadingContext(true);
    try {
      const response = await fetch(getApiUrl('/api/tenant-emails/history?limit=1'));
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
          console.log('[Phone] ✅ Auto-loaded maintenance context:', formattedContext);
        }
      }
    } catch (e) {
      console.error('[Phone] Failed to fetch maintenance issue:', e);
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
      // Format phone to E.164
      let formattedPhone = phone.replace(/\D/g, '');
      if (formattedPhone.length === 10) {
        formattedPhone = '+1' + formattedPhone;
      } else if (formattedPhone.length === 11 && formattedPhone[0] === '1') {
        formattedPhone = '+' + formattedPhone;
      } else if (!formattedPhone.startsWith('+')) {
        formattedPhone = '+' + formattedPhone;
      }

      console.log('[Phone] Initiating call to:', formattedPhone);
      console.log('[Phone] Context:', context);
      console.log('[Phone] Provider:', voiceProvider);

      // Choose endpoint based on selected provider
      const endpoint = voiceProvider === 'groq-elevenlabs' 
        ? '/api/voice/groq-elevenlabs-call' 
        : voiceProvider === 'groq' 
          ? '/api/voice/groq-call' 
          : '/api/voice/call';
      
      const response = await fetch(getApiUrl(endpoint, { phoneBackend: true }), {
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
          maintenanceContext: context,
          ...(voiceProvider === 'openai' && { voice: openaiVoice })
        })
      });

      const json = await response.json();

      if (!json.ok) {
        throw new Error(json.error || 'Call failed');
      }

      setCallResult(json);
      console.log('[Phone] ✅ Call initiated:', json);

    } catch (e: any) {
      console.error('[Phone] Error:', e);
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

  const getUrgencyColor = (urgency?: string) => {
    switch (urgency?.toLowerCase()) {
      case 'emergency':
      case 'high':
        return 'text-red-600 bg-red-50';
      case 'medium':
        return 'text-orange-600 bg-orange-50';
      case 'low':
        return 'text-green-600 bg-green-50';
      default:
        return 'text-gray-600 bg-gray-50';
    }
  };

  return (
    <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
      {/* Header */}
      <div className={`px-4 py-3 text-white ${
        voiceProvider === 'groq-elevenlabs'
          ? 'bg-gradient-to-r from-purple-600 to-indigo-600'
          : voiceProvider === 'groq' 
            ? 'bg-gradient-to-r from-orange-500 to-amber-500' 
            : 'bg-gradient-to-r from-violet-600 to-purple-600'
      }`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-lg">📞</span>
            <div>
              <div className="text-sm font-semibold">AI Phone Call System</div>
              <div className="text-[10px] opacity-80">
                {voiceProvider === 'groq-elevenlabs'
                  ? 'GROQ LPU • Whisper + LLaMA + ElevenLabs Liam'
                  : voiceProvider === 'groq' 
                    ? 'GROQ LPU • Whisper + LLaMA + Orpheus' 
                    : 'OpenAI Realtime • GPT-Realtime-2 • Built-in VAD'}
              </div>
            </div>
          </div>
          {!statusLoading && (
            <div className={`text-[10px] px-2 py-0.5 rounded-full ${
              (voiceProvider === 'groq-elevenlabs' 
                ? groqElevenLabsStatus?.configured 
                : voiceProvider === 'groq' 
                  ? groqStatus?.configured 
                  : systemStatus?.configured)
                ? 'bg-green-400/20 text-green-100' 
                : 'bg-red-400/20 text-red-100'
            }`}>
              {(voiceProvider === 'groq-elevenlabs' 
                ? groqElevenLabsStatus?.configured 
                : voiceProvider === 'groq' 
                  ? groqStatus?.configured 
                  : systemStatus?.configured) ? '● Ready' : '○ Not configured'}
            </div>
          )}
        </div>
      </div>

      {/* Provider Toggle */}
      <div className="px-4 pt-3">
        <div className="flex gap-1 p-1 bg-gray-100 rounded-lg">
          <button
            onClick={() => setVoiceProvider('openai')}
            className={`flex-1 px-2 py-1.5 text-[10px] font-medium rounded-md transition-all ${
              voiceProvider === 'openai'
                ? 'bg-white text-violet-700 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            🤖 OpenAI
          </button>
          <button
            onClick={() => setVoiceProvider('groq')}
            className={`flex-1 px-2 py-1.5 text-[10px] font-medium rounded-md transition-all ${
              voiceProvider === 'groq'
                ? 'bg-white text-orange-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            ⚡ GROQ
          </button>
          <button
            onClick={() => setVoiceProvider('groq-elevenlabs')}
            className={`flex-1 px-2 py-1.5 text-[10px] font-medium rounded-md transition-all ${
              voiceProvider === 'groq-elevenlabs'
                ? 'bg-white text-purple-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            🎙️ GROQ+Liam
          </button>
        </div>
        <div className="text-[10px] text-gray-400 mt-1 text-center">
          {voiceProvider === 'groq-elevenlabs' 
            ? 'Best voice quality • GROQ LPU + ElevenLabs Liam V3' 
            : voiceProvider === 'groq' 
              ? 'Faster inference • Whisper STT → LLaMA → Orpheus TTS' 
              : 'Natural conversation • Built-in voice detection'}
        </div>

        {/* OpenAI Voice Selector */}
        {voiceProvider === 'openai' && (
          <div className="mt-2 p-2 bg-violet-50 rounded-lg border border-violet-100">
            <div className="text-[10px] font-medium text-violet-700 mb-1.5 text-center">Voice: {selectedVoiceInfo.emoji} {selectedVoiceInfo.label}</div>
            <div className="flex flex-wrap items-center justify-center gap-1">
              {OPENAI_REALTIME_VOICES.slice(0, 5).map((v) => (
                <button
                  key={v.id}
                  onClick={() => setOpenaiVoice(v.id)}
                  disabled={calling}
                  title={v.desc}
                  className={`px-2 py-0.5 text-[9px] font-medium rounded-full transition-all ${
                    openaiVoice === v.id
                      ? 'bg-violet-600 text-white shadow-sm'
                      : 'bg-white text-gray-500 hover:bg-violet-100 hover:text-violet-700 border border-gray-200'
                  } ${calling ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {v.emoji} {v.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-1 mt-1">
              {OPENAI_REALTIME_VOICES.slice(5).map((v) => (
                <button
                  key={v.id}
                  onClick={() => setOpenaiVoice(v.id)}
                  disabled={calling}
                  title={v.desc}
                  className={`px-2 py-0.5 text-[9px] font-medium rounded-full transition-all ${
                    openaiVoice === v.id
                      ? 'bg-violet-600 text-white shadow-sm'
                      : 'bg-white text-gray-500 hover:bg-violet-100 hover:text-violet-700 border border-gray-200'
                  } ${calling ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {v.emoji} {v.label}
                </button>
              ))}
            </div>
            <p className="text-[8px] text-violet-500 text-center mt-1">{selectedVoiceInfo.desc}</p>
          </div>
        )}
      </div>

      <div className="p-4">
        {/* System Status */}
        {systemStatus?.configured && (
          <div className="mb-4 p-2 bg-gray-50 rounded-lg text-[10px] text-gray-500 flex flex-wrap gap-x-4 gap-y-1">
            <span>🎤 {systemStatus.models?.stt || 'whisper'}</span>
            <span>🤖 {systemStatus.models?.llm || 'llama'}</span>
            <span>🔊 {systemStatus.models?.voice || 'Fritz'}</span>
            <span>📱 {systemStatus.fromNumber || 'Not set'}</span>
          </div>
        )}

        {groqElevenLabsStatus?.inboundWebhookUrl && (
          <div className="mb-4 p-3 bg-blue-50 rounded-lg border border-blue-100 text-[11px] text-blue-900">
            <div className="font-medium mb-1">Return calls to your Twilio number</div>
            <div className="text-blue-800">
              In Twilio, open your number and set <span className="font-medium">A call comes in</span> to this Cloud Run webhook (POST):
            </div>
            <code className="mt-2 block break-all rounded bg-white px-2 py-1 text-[10px] text-blue-700 border border-blue-100">
              {groqElevenLabsStatus.inboundWebhookUrl}
            </code>
            <div className="mt-2 text-blue-700">
              Providers calling back will reach Ava, with context from recent maintenance calls when available.
            </div>
          </div>
        )}

        {/* Phone Input */}
        <div className="mb-4">
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Service Provider Phone Number
          </label>
          <div className="flex gap-2">
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(555) 123-4567"
              className="flex-1 px-3 py-2 text-sm border rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
              disabled={calling}
            />
            <button
              onClick={initiateCall}
              disabled={calling || !phone.trim() || !(voiceProvider === 'groq' ? groqStatus?.configured : systemStatus?.configured)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                calling 
                  ? (voiceProvider === 'groq' ? 'bg-orange-400' : 'bg-violet-400') + ' text-white cursor-wait'
                  : (voiceProvider === 'groq' ? groqStatus?.configured : systemStatus?.configured)
                    ? (voiceProvider === 'groq' 
                        ? 'bg-orange-500 text-white hover:bg-orange-600 active:scale-95'
                        : 'bg-violet-600 text-white hover:bg-violet-700 active:scale-95')
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'
              }`}
            >
              {calling ? (
                <span className="flex items-center gap-1">
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  Calling...
                </span>
              ) : (
                '📞 Call'
              )}
            </button>
          </div>
          {phone && (
            <>
              {usingDedicatedPhoneBackend && (
                <p className="text-[11px] opacity-90 mt-1">
                  Phone calls routed through Cloud Run backend: {phoneCallApiBase}
                </p>
              )}
              <div className="text-[10px] text-gray-400 mt-1">
                Will call: {formatPhoneForDisplay(phone)}
              </div>
            </>
          )}
        </div>

        {/* Maintenance Context */}
        {loadingContext ? (
          <div className="p-3 bg-gray-50 rounded-lg mb-4">
            <div className="text-xs text-gray-500 flex items-center gap-2">
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
              Loading maintenance context...
            </div>
          </div>
        ) : context ? (
          <div className="p-3 bg-violet-50 rounded-lg mb-4 border border-violet-100">
            <div className="flex items-start justify-between mb-2">
              <div className="text-xs font-medium text-violet-800">📋 Call Context</div>
              {context.urgency && (
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${getUrgencyColor(context.urgency)}`}>
                  {context.urgency.toUpperCase()}
                </span>
              )}
            </div>
            <div className="space-y-1 text-[11px] text-gray-600">
              {context.issue && (
                <div><span className="font-medium">Issue:</span> {context.issue}</div>
              )}
              {context.serviceCategory && (
                <div><span className="font-medium">Category:</span> {context.serviceCategory}</div>
              )}
              {context.propertyAddress && (
                <div><span className="font-medium">Property:</span> {context.propertyAddress}</div>
              )}
              {context.tenantAvailability && (
                <div><span className="font-medium">Availability:</span> {context.tenantAvailability}</div>
              )}
              {context.tenantName && (
                <div><span className="font-medium">Tenant:</span> {context.tenantName}</div>
              )}
            </div>
          </div>
        ) : (
          <div className="p-3 bg-amber-50 rounded-lg mb-4 border border-amber-100">
            <div className="text-xs text-amber-700">
              ⚠️ No maintenance context loaded. The AI will use a generic greeting.
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="p-3 bg-red-50 rounded-lg mb-4 border border-red-200">
            <div className="text-xs text-red-700 font-medium">❌ Error</div>
            <div className="text-xs text-red-600 mt-1">{error}</div>
          </div>
        )}

        {/* Call Result */}
        {callResult && (
          <div className="p-3 bg-green-50 rounded-lg border border-green-200">
            <div className="text-xs text-green-700 font-medium mb-2">✅ Call Initiated!</div>
            <div className="space-y-1 text-[11px] text-gray-600">
              <div><span className="font-medium">Call ID:</span> {callResult.callSid}</div>
              <div><span className="font-medium">To:</span> {callResult.to}</div>
              <div><span className="font-medium">From:</span> {callResult.from}</div>
              <div><span className="font-medium">Status:</span> {callResult.status}</div>
            </div>
            <div className="mt-3 text-[10px] text-gray-500">
              On live calls, Ava waits for the person to say hello first, then introduces herself briefly. On voicemail, she leaves one complete message with all details.
            </div>
          </div>
        )}

        {/* How it Works */}
        <div className="mt-4 pt-4 border-t">
          <div className="text-[10px] text-gray-400">
            <div className="font-medium mb-1">How it works ({voiceProvider === 'groq-elevenlabs' ? 'GROQ + ElevenLabs' : voiceProvider === 'groq' ? 'GROQ' : 'OpenAI'}):</div>
            {voiceProvider === 'groq-elevenlabs' ? (
              <ol className="list-decimal list-inside space-y-0.5">
                <li>AI calls the service provider using Twilio</li>
                <li>GROQ Whisper transcribes their speech (LPU-accelerated)</li>
                <li>GROQ LLaMA generates intelligent responses</li>
                <li>ElevenLabs Liam V3 speaks with best-in-class voice quality</li>
              </ol>
            ) : voiceProvider === 'groq' ? (
              <ol className="list-decimal list-inside space-y-0.5">
                <li>AI calls the service provider using Twilio</li>
                <li>GROQ Whisper transcribes their speech (LPU-accelerated)</li>
                <li>GROQ LLaMA generates intelligent responses</li>
                <li>GROQ Orpheus TTS speaks back with natural voice</li>
              </ol>
            ) : (
              <ol className="list-decimal list-inside space-y-0.5">
                <li>AI calls the service provider using Twilio</li>
                <li>OpenAI Realtime API handles speech detection automatically</li>
                <li>GPT-Realtime-2 processes and responds in real-time</li>
                <li>Natural voice synthesis with minimal latency</li>
              </ol>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PhoneCallSystem;
