import { useEffect, useMemo, useRef, useState } from 'react';

// ── Tunnel auth: attach mobile scan token to all API requests ────────
function getMobileScanToken(): string | null {
  if (typeof window === 'undefined') return null;
  const stored = sessionStorage.getItem('mobileScanToken');
  if (stored) return stored;
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (token) {
      sessionStorage.setItem('mobileScanToken', token);
      return token;
    }
  } catch { /* ignore */ }
  return null;
}

const isAccessedViaTunnel = typeof window !== 'undefined' && (
  window.location.hostname.includes('ngrok') ||
  window.location.hostname.includes('trycloudflare.com')
);

function getAuthHeaders(): Record<string, string> {
  if (!isAccessedViaTunnel) return {};
  const token = getMobileScanToken();
  if (token) return { 'X-Mobile-Token': token };
  return {};
}

type MaintenancePriority = 'low' | 'normal' | 'urgent';
type EmergencyLevel = 'none' | 'urgent' | 'call_911';

interface TranscriptEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface ApplianceInfo {
  isVisible: boolean;
  type: string;
  brand: string;
  model: string;
  confidence: 'high' | 'medium' | 'low';
}

interface TroubleshootingSearchResult {
  title: string;
  link: string;
  snippet: string;
  displayLink?: string;
}

interface ApplianceTroubleshooting {
  searchQuery?: string;
  steps: string[];
  safetyWarnings?: string[];
  needsProfessional?: boolean;
  reason?: string;
  results: TroubleshootingSearchResult[];
}

interface LiveFrameAnalysis {
  reply: string;
  visionSummary: string;
  hazardDetected: boolean;
  hazardType: string;
  shouldCreateMaintenanceRequest: boolean;
  issueCategory: string;
  priority: MaintenancePriority;
  location: string;
  troubleshootingSteps: string[];
  recommendedProfessional: string;
  appliance: ApplianceInfo;
  requestDraft: {
    summary: string;
    ownerSummary: string;
    emergencyLevel: EmergencyLevel;
    emergencyGuidance: string;
    suggestedActions: string[];
  };
  applianceTroubleshooting?: ApplianceTroubleshooting | null;
}

export interface LiveMaintenanceDraft {
  category: string;
  priority: MaintenancePriority;
  location: string;
  description: string;
  ownerSummary: string;
  emergencyLevel: EmergencyLevel;
  emergencyGuidance: string;
  suggestedActions: string[];
  liveAssistantSummary: string;
  appliance?: ApplianceInfo | null;
  applianceTroubleshooting?: ApplianceTroubleshooting | null;
  transcript: Array<{ role: 'user' | 'assistant'; content: string }>;
}

interface LiveMaintenanceAssistantProps {
  propertyAddress?: string;
  unit?: string;
  tenantName?: string;
  currentDescription?: string;
  onApplyDraft: (draft: LiveMaintenanceDraft) => void;
}

function formatStatusLabel(value: string) {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function LiveMaintenanceAssistant({
  propertyAddress,
  unit,
  tenantName,
  currentDescription,
  onApplyDraft
}: LiveMaintenanceAssistantProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const captureIntervalRef = useRef<number | null>(null);
  const analysisInFlightRef = useRef(false);

  const [isStarting, setIsStarting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [lastAnalyzedAt, setLastAnalyzedAt] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [latestAnalysis, setLatestAnalysis] = useState<LiveFrameAnalysis | null>(null);

  const transcriptPreview = useMemo(() => transcript.slice(-6), [transcript]);

  const addTranscriptEntry = (role: 'user' | 'assistant', content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;

    setTranscript((prev) => {
      const next = [...prev, { role, content: trimmed, timestamp: new Date().toISOString() }];
      return next.slice(-20);
    });
  };

  const stopCaptureLoop = () => {
    if (captureIntervalRef.current) {
      window.clearInterval(captureIntervalRef.current);
      captureIntervalRef.current = null;
    }
  };

  const disconnect = () => {
    stopCaptureLoop();

    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
      remoteAudioRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsConnected(false);
    setIsStarting(false);
  };

  useEffect(() => disconnect, []);

  const pushVisionUpdateToRealtime = (analysis: LiveFrameAnalysis) => {
    if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') return;

    const summary = [
      `VISION UPDATE: ${analysis.visionSummary}`,
      analysis.hazardDetected ? `Hazard: ${formatStatusLabel(analysis.hazardType)}` : 'Hazard: none detected',
      analysis.appliance?.isVisible
        ? `Appliance visible: ${[analysis.appliance.brand, analysis.appliance.model, analysis.appliance.type].filter(Boolean).join(' ')}`
        : 'Appliance visible: no confirmed model information',
      analysis.requestDraft?.summary ? `Suggested request summary: ${analysis.requestDraft.summary}` : ''
    ].filter(Boolean).join('\n');

    try {
      dataChannelRef.current.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: summary
            }
          ]
        }
      }));
      dataChannelRef.current.send(JSON.stringify({
        type: 'response.create',
        response: {}
      }));
    } catch (error) {
      console.warn('[LiveMaintenanceAssistant] Failed to push vision update to realtime session:', error);
    }
  };

  const analyzeCurrentFrame = async (reason: 'manual' | 'interval' = 'manual') => {
    if (!videoRef.current || analysisInFlightRef.current) return;

    const video = videoRef.current;
    if (!video.videoWidth || !video.videoHeight) return;

    analysisInFlightRef.current = true;
    setIsAnalyzing(true);
    setAnalysisError(null);

    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('Camera frame could not be prepared for analysis');
      }

      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageDataUrl = canvas.toDataURL('image/jpeg', 0.76);

      const response = await fetch('/api/maintenance/live/frame-analysis', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({
          imageDataUrl,
          propertyAddress,
          unit,
          issueSummary: currentDescription || '',
          latestNotes: reason === 'manual' ? 'Manual frame review requested by tenant.' : 'Periodic live maintenance monitoring frame.',
          transcript: transcript.map((entry) => ({ role: entry.role, content: entry.content }))
        })
      });

      const data = await response.json();
      if (!response.ok || !data.ok || !data.analysis) {
        throw new Error(data.error || 'Failed to analyze the live camera frame');
      }

      setLatestAnalysis(data.analysis);
      setLastAnalyzedAt(new Date().toISOString());
      pushVisionUpdateToRealtime(data.analysis);
    } catch (error: any) {
      setAnalysisError(error.message || 'Failed to analyze the live camera frame');
    } finally {
      analysisInFlightRef.current = false;
      setIsAnalyzing(false);
    }
  };

  const startCaptureLoop = () => {
    stopCaptureLoop();
    captureIntervalRef.current = window.setInterval(() => {
      void analyzeCurrentFrame('interval');
    }, 12000);
  };

  const startSession = async () => {
    setIsStarting(true);
    setConnectionError(null);
    setAnalysisError(null);

    try {
      const localStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        }
      });

      localStreamRef.current = localStream;
      if (videoRef.current) {
        videoRef.current.srcObject = localStream;
      }

      const tokenResponse = await fetch('/api/maintenance/live/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({
          tenantName,
          propertyAddress,
          unit,
          issueSummary: currentDescription || ''
        })
      });

      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok || !tokenData.ok || !tokenData.token) {
        throw new Error(tokenData.error || 'Failed to create a live maintenance session');
      }

      const peerConnection = new RTCPeerConnection();
      peerConnectionRef.current = peerConnection;

      const remoteAudio = document.createElement('audio');
      remoteAudio.autoplay = true;
      remoteAudio.playsInline = true;
      remoteAudioRef.current = remoteAudio;

      peerConnection.ontrack = (event) => {
        remoteAudio.srcObject = event.streams[0];
      };

      const audioTrack = localStream.getAudioTracks()[0];
      if (!audioTrack) {
        throw new Error('Microphone access is required for the live assistant');
      }
      peerConnection.addTrack(audioTrack, localStream);

      const dataChannel = peerConnection.createDataChannel('oai-events');
      dataChannelRef.current = dataChannel;

      dataChannel.addEventListener('open', () => {
        setIsConnected(true);
        setIsStarting(false);
        startCaptureLoop();
        void analyzeCurrentFrame('manual');
      });

      dataChannel.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'conversation.item.input_audio_transcription.completed' && payload.transcript) {
            addTranscriptEntry('user', payload.transcript);
          }
          if (payload.type === 'response.audio_transcript.done' && payload.transcript) {
            addTranscriptEntry('assistant', payload.transcript);
          }
          if (payload.type === 'error') {
            setConnectionError(payload.error?.message || 'The live assistant session hit an error');
          }
        } catch {
          // Ignore malformed events from the realtime channel.
        }
      });

      dataChannel.addEventListener('close', () => {
        setIsConnected(false);
      });

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const sdpResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenData.token}`,
          'Content-Type': 'application/sdp'
        },
        body: offer.sdp
      });

      if (!sdpResponse.ok) {
        const errorText = await sdpResponse.text();
        throw new Error(errorText || `Realtime SDP exchange failed with status ${sdpResponse.status}`);
      }

      const answerSdp = await sdpResponse.text();
      await peerConnection.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    } catch (error: any) {
      setConnectionError(error.message || 'Failed to start the live maintenance assistant');
      disconnect();
    } finally {
      setIsStarting(false);
    }
  };

  const applyLatestAnalysis = () => {
    if (!latestAnalysis) return;

    const draft: LiveMaintenanceDraft = {
      category: latestAnalysis.issueCategory || 'Other',
      priority: latestAnalysis.priority || 'normal',
      location: latestAnalysis.location || '',
      description: latestAnalysis.requestDraft.summary || latestAnalysis.visionSummary || 'Maintenance issue observed during live assistant session.',
      ownerSummary: latestAnalysis.requestDraft.ownerSummary || latestAnalysis.visionSummary || 'Maintenance issue observed during live assistant session.',
      emergencyLevel: latestAnalysis.requestDraft.emergencyLevel || 'none',
      emergencyGuidance: latestAnalysis.requestDraft.emergencyGuidance || '',
      suggestedActions: Array.from(new Set([
        ...(latestAnalysis.requestDraft.suggestedActions || []),
        ...(latestAnalysis.troubleshootingSteps || []),
        ...(latestAnalysis.applianceTroubleshooting?.steps || [])
      ])).slice(0, 8),
      liveAssistantSummary: latestAnalysis.visionSummary || latestAnalysis.reply,
      appliance: latestAnalysis.appliance?.isVisible ? latestAnalysis.appliance : null,
      applianceTroubleshooting: latestAnalysis.applianceTroubleshooting || null,
      transcript: transcript.map((entry) => ({ role: entry.role, content: entry.content }))
    };

    onApplyDraft(draft);
  };

  return (
    <div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-cyan-50 p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Live AI Maintenance Assistant</h3>
          <p className="mt-1 text-sm text-slate-600">
            Start a live voice session, point your phone camera at the issue, and let the system build a maintenance draft or model-specific appliance guidance.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!isConnected ? (
            <button
              type="button"
              onClick={startSession}
              disabled={isStarting}
              className="inline-flex items-center justify-center rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isStarting ? 'Starting live session...' : 'Start live session'}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void analyzeCurrentFrame('manual')}
                disabled={isAnalyzing}
                className="inline-flex items-center justify-center rounded-xl border border-emerald-300 bg-white px-4 py-2.5 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
              >
                {isAnalyzing ? 'Analyzing frame...' : 'Analyze current view'}
              </button>
              <button
                type="button"
                onClick={disconnect}
                className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                End session
              </button>
            </>
          )}
        </div>
      </div>

      {connectionError && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {connectionError}
        </div>
      )}

      {analysisError && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {analysisError}
        </div>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-4">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-950">
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 text-xs uppercase tracking-[0.18em] text-slate-300">
              <span>Phone camera preview</span>
              <span className={isConnected ? 'text-emerald-300' : 'text-slate-500'}>
                {isConnected ? 'Live' : 'Not connected'}
              </span>
            </div>
            <div className="aspect-[4/3] bg-slate-900">
              <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-cover" />
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-slate-900">Live transcript</div>
              <div className="text-xs text-slate-500">
                {lastAnalyzedAt ? `Last frame review ${new Date(lastAnalyzedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Frame review starts after connection'}
              </div>
            </div>
            <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
              {transcriptPreview.length === 0 ? (
                <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">
                  The live session transcript will appear here after the assistant and tenant start speaking.
                </div>
              ) : (
                transcriptPreview.map((entry, index) => (
                  <div key={`${entry.timestamp}-${index}`} className={`rounded-xl px-4 py-3 text-sm ${entry.role === 'user' ? 'bg-slate-900 text-white' : 'border border-emerald-100 bg-emerald-50 text-slate-800'}`}>
                    <div className="mb-1 text-[11px] uppercase tracking-[0.16em] opacity-70">{entry.role === 'user' ? 'Tenant' : 'Assistant'}</div>
                    <div>{entry.content}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-sm font-semibold text-slate-900">Visual assessment</div>
            {!latestAnalysis ? (
              <div className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">
                Once the session is live, the app reviews camera frames and surfaces hazards, appliance details, and a request draft here.
              </div>
            ) : (
              <div className="mt-3 space-y-4">
                <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-700">
                  {latestAnalysis.visionSummary}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Category</div>
                    <div className="mt-1 font-medium text-slate-900">{latestAnalysis.issueCategory}</div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Priority</div>
                    <div className="mt-1 font-medium text-slate-900">{formatStatusLabel(latestAnalysis.priority)}</div>
                  </div>
                </div>

                {latestAnalysis.hazardDetected && (
                  <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
                    <div className="font-semibold">Hazard detected: {formatStatusLabel(latestAnalysis.hazardType)}</div>
                    {latestAnalysis.requestDraft.emergencyGuidance && (
                      <div className="mt-1">{latestAnalysis.requestDraft.emergencyGuidance}</div>
                    )}
                  </div>
                )}

                {latestAnalysis.appliance?.isVisible && (
                  <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-4 text-sm text-slate-800">
                    <div className="font-semibold text-slate-900">Appliance spotted</div>
                    <div className="mt-2">
                      {[latestAnalysis.appliance.brand, latestAnalysis.appliance.model, latestAnalysis.appliance.type].filter(Boolean).join(' ') || 'Model details were only partially visible.'}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">Confidence: {formatStatusLabel(latestAnalysis.appliance.confidence)}</div>
                  </div>
                )}

                {latestAnalysis.applianceTroubleshooting?.steps?.length ? (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-slate-800">
                    <div className="font-semibold text-slate-900">Model-specific troubleshooting</div>
                    <div className="mt-3 space-y-2">
                      {latestAnalysis.applianceTroubleshooting.steps.map((step) => (
                        <div key={step}>- {step}</div>
                      ))}
                    </div>
                    {latestAnalysis.applianceTroubleshooting.safetyWarnings?.length ? (
                      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
                        {latestAnalysis.applianceTroubleshooting.safetyWarnings.map((warning) => (
                          <div key={warning}>- {warning}</div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {latestAnalysis.applianceTroubleshooting?.results?.length ? (
                  <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
                    <div className="font-semibold text-slate-900">Reference links</div>
                    <div className="mt-3 space-y-3">
                      {latestAnalysis.applianceTroubleshooting.results.slice(0, 3).map((result) => (
                        <a
                          key={result.link}
                          href={result.link}
                          target="_blank"
                          rel="noreferrer"
                          className="block rounded-xl border border-slate-200 px-3 py-3 transition hover:border-emerald-300 hover:bg-emerald-50"
                        >
                          <div className="font-medium text-slate-900">{result.title}</div>
                          {result.displayLink ? <div className="mt-1 text-xs uppercase tracking-[0.16em] text-slate-500">{result.displayLink}</div> : null}
                          <div className="mt-1 text-sm text-slate-600">{result.snippet}</div>
                        </a>
                      ))}
                    </div>
                  </div>
                ) : null}

                <button
                  type="button"
                  onClick={applyLatestAnalysis}
                  className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  Use this live assessment in my request
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}