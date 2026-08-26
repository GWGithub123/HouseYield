import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ImagePlus,
  Loader2,
  Mic,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import AccessMethodPicker from './AccessMethodPicker';
import AvailabilityPicker from './AvailabilityPicker';
import TicketSummaryCard, { PRIORITY_LABELS, PRIORITY_STYLES } from './TicketSummaryCard';
import {
  buildDefaultPropertyAccess,
  formatAvailabilitySelections,
  sendTriageMessage,
  submitMaintenanceRequest,
  uploadMaintenancePhotos,
  type AvailabilitySelection,
  type MaintenancePhoto,
  type MaintenancePriority,
  type MaintenanceTriage,
  type PropertyAccess,
  type TriageChatMessage,
  type TriageQuestion,
} from '../../services/maintenanceApi';

type Step = 'describe' | 'logistics' | 'review' | 'submitted';

const STEP_ORDER: Step[] = ['describe', 'logistics', 'review'];
const STEP_LABELS: Record<Step, string> = {
  describe: 'Describe the issue',
  logistics: 'Access & timing',
  review: 'Review & submit',
  submitted: 'Submitted',
};

const MAX_PHOTOS = 5;

/** Narrow shim for the vendor-prefixed Web Speech API. */
function getSpeechRecognition(): any {
  if (typeof window === 'undefined') return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

export interface MaintenanceIntakeResult {
  requestId: string;
  firestoreId?: string;
  awaitingOwnerConfirmation?: boolean;
}

interface MaintenanceIntakeFlowProps {
  propertyAddress?: string;
  unit?: string;
  ownerId?: string;
  ownerEmail?: string;
  ownerName?: string;
  propertyId?: string;
  tenantId?: string;
  tenantEmail?: string;
  tenantName?: string;
  submitterRole?: 'owner' | 'tenant';
  onSubmitted?: (result: MaintenanceIntakeResult) => void;
  onSwitchToForm?: () => void;
}

export default function MaintenanceIntakeFlow({
  propertyAddress,
  unit,
  ownerId,
  ownerEmail,
  ownerName,
  propertyId,
  tenantId,
  tenantEmail,
  tenantName,
  submitterRole = 'owner',
  onSubmitted,
  onSwitchToForm,
}: MaintenanceIntakeFlowProps) {
  const [step, setStep] = useState<Step>('describe');
  const [messages, setMessages] = useState<TriageChatMessage[]>([]);
  const [triage, setTriage] = useState<MaintenanceTriage | null>(null);
  const [questionQueue, setQuestionQueue] = useState<TriageQuestion[]>([]);
  const [multiSelection, setMultiSelection] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const [photos, setPhotos] = useState<MaintenancePhoto[]>([]);
  const [uploadingPhotos, setUploadingPhotos] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const [access, setAccess] = useState<PropertyAccess>(() => buildDefaultPropertyAccess());
  const [availability, setAvailability] = useState<AvailabilitySelection[]>([]);

  const [priorityOverride, setPriorityOverride] = useState<MaintenancePriority | null>(null);
  const [locationOverride, setLocationOverride] = useState<string>('');
  const [showAdjust, setShowAdjust] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<MaintenanceIntakeResult | null>(null);

  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  // Answering must never block on the network, so the async refresh loop reads
  // conversation state from refs rather than from a captured render's closure.
  const historyRef = useRef<TriageChatMessage[]>([]);
  const answeredRef = useRef<string[]>([]);
  const draftRef = useRef<MaintenanceTriage | null>(null);
  const queueRef = useRef<TriageQuestion[]>([]);
  const busyRef = useRef(false);
  const rerunRef = useRef(false);

  const speechSupported = useMemo(() => Boolean(getSpeechRecognition()), []);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages.length, sending]);

  useEffect(() => () => {
    try {
      recognitionRef.current?.stop();
    } catch {
      /* recognition may already be stopped */
    }
  }, []);

  /** The ticket as it stands, with any manual overrides layered on top of the AI draft. */
  const effectiveTriage = useMemo<MaintenanceTriage | null>(() => {
    if (!triage) return null;
    return {
      ...triage,
      priority: priorityOverride || triage.priority,
      location: locationOverride || triage.location,
    };
  }, [triage, priorityOverride, locationOverride]);

  /**
   * Asks the assistant to re-read the conversation and refresh what it still needs.
   *
   * Runs at most one request at a time. Answers given while a request is in flight
   * set `rerunRef` so the loop immediately goes again with the fuller history
   * instead of racing a second request against the first.
   */
  const refreshTriage = useCallback(async () => {
    if (busyRef.current) {
      rerunRef.current = true;
      return;
    }

    busyRef.current = true;
    setSending(true);
    setChatError(null);

    try {
      do {
        rerunRef.current = false;

        const history = historyRef.current;
        const lastUserIndex = history.map((line) => line.role).lastIndexOf('user');
        if (lastUserIndex === -1) return;

        const response = await sendTriageMessage({
          message: history[lastUserIndex].content,
          messages: history.slice(0, lastUserIndex),
          currentDraft: draftRef.current,
          submitterRole,
          answeredQuestionIds: answeredRef.current,
        });

        // Answers tapped while this was in flight are already appended, so slot the
        // reply in behind the message it answers rather than at the end.
        const insertAt = lastUserIndex + 1;
        historyRef.current = [
          ...historyRef.current.slice(0, insertAt),
          { role: 'assistant', content: response.reply, at: new Date().toISOString() },
          ...historyRef.current.slice(insertAt),
        ];
        setMessages(historyRef.current);

        draftRef.current = response.triage;
        setTriage(response.triage);

        // Never swap the question already on screen; refresh only what comes after it.
        const answered = new Set(answeredRef.current);
        const onScreen = queueRef.current[0];
        const incoming = (response.questions || []).filter(
          (question) => !answered.has(question.id) && question.id !== onScreen?.id,
        );
        queueRef.current = onScreen ? [onScreen, ...incoming] : incoming;
        setQuestionQueue(queueRef.current);
      } while (rerunRef.current);
    } catch (error: any) {
      setChatError(error?.message || 'Could not reach the intake assistant. Try again.');
    } finally {
      busyRef.current = false;
      setSending(false);
    }
  }, [submitterRole]);

  /** Records one turn from the submitter, then kicks off the background refresh. */
  const submitTurn = useCallback((
    content: string,
    options?: { display?: string; questionId?: string },
  ) => {
    const trimmed = content.trim();
    if (!trimmed) return;

    historyRef.current = [
      ...historyRef.current,
      { role: 'user', content: trimmed, display: options?.display, at: new Date().toISOString() },
    ];
    setMessages(historyRef.current);

    if (options?.questionId) {
      answeredRef.current = [...answeredRef.current, options.questionId];
      queueRef.current = queueRef.current.filter((question) => question.id !== options.questionId);
    } else {
      // Free-form input can change the whole picture, so let the assistant re-derive.
      queueRef.current = [];
    }
    setQuestionQueue(queueRef.current);

    void refreshTriage();
  }, [refreshTriage]);

  const sendMessage = useCallback((text: string) => {
    if (!text.trim()) return;
    setInput('');
    submitTurn(text);
  }, [submitTurn]);

  /** Turns a tapped choice into a turn that carries its question along for context. */
  const answerQuestion = useCallback((question: TriageQuestion, labels: string[]) => {
    if (!labels.length) return;
    const answer = labels.join(', ');
    setMultiSelection([]);
    submitTurn(`${question.question} ${answer}`, { display: answer, questionId: question.id });
  }, [submitTurn]);

  const toggleMultiSelection = (label: string) => {
    setMultiSelection((prev) => (
      prev.includes(label) ? prev.filter((entry) => entry !== label) : [...prev, label]
    ));
  };

  const currentQuestion = questionQueue[0] || null;

  const toggleListening = () => {
    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) return;

    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    let finalText = '';
    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += chunk;
        else interim += chunk;
      }
      setInput((finalText + interim).trimStart());
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  };

  const handlePhotoSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;

    const room = MAX_PHOTOS - photos.length;
    if (room <= 0) {
      setPhotoError(`You can attach up to ${MAX_PHOTOS} photos.`);
      return;
    }

    setUploadingPhotos(true);
    setPhotoError(null);

    try {
      const { photos: uploaded, errors } = await uploadMaintenancePhotos({
        files: files.slice(0, room),
        ownerId,
        kind: 'issue',
      });
      setPhotos((prev) => [...prev, ...uploaded].slice(0, MAX_PHOTOS));
      if (errors.length) {
        setPhotoError(errors[0].error);
      }
    } catch (error: any) {
      setPhotoError(error?.message || 'Photo upload failed.');
    } finally {
      setUploadingPhotos(false);
    }
  };

  const removePhoto = (url: string) => setPhotos((prev) => prev.filter((photo) => photo.url !== url));

  const handleSubmit = async () => {
    if (!effectiveTriage) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      const description = (effectiveTriage.ownerSummary || effectiveTriage.summary || '').trim();
      const response = await submitMaintenanceRequest({
        category: effectiveTriage.category,
        priority: effectiveTriage.priority,
        description,
        location: effectiveTriage.location,
        propertyAddress,
        unit: unit || '',
        ownerId,
        propertyId,
        tenantId,
        tenantEmail,
        tenantName,
        triage: effectiveTriage,
        photos,
        propertyAccess: access,
        availabilityWindows: availability,
        tenantAvailability: formatAvailabilitySelections(availability),
        submittedBy: {
          role: submitterRole,
          userId: submitterRole === 'owner' ? ownerId : tenantId,
          name: submitterRole === 'owner' ? ownerName : tenantName,
          email: submitterRole === 'owner' ? ownerEmail : tenantEmail,
        },
        intake: {
          mode: 'ai_chat',
          transcript: messages,
          extracted: effectiveTriage,
          completedAt: new Date().toISOString(),
        },
        // Provider search still runs; the operator places the call.
        autoBook: true,
      });

      const submitted: MaintenanceIntakeResult = {
        requestId: response.request?.firestoreId || response.request?.id,
        firestoreId: response.request?.firestoreId,
        awaitingOwnerConfirmation: response.awaitingOwnerConfirmation,
      };

      setResult(submitted);
      setStep('submitted');
      onSubmitted?.(submitted);
    } catch (error: any) {
      setSubmitError(error?.message || 'Could not submit the request.');
    } finally {
      setSubmitting(false);
    }
  };

  const resetFlow = () => {
    historyRef.current = [];
    answeredRef.current = [];
    draftRef.current = null;
    queueRef.current = [];
    rerunRef.current = false;

    setStep('describe');
    setMessages([]);
    setTriage(null);
    setQuestionQueue([]);
    setMultiSelection([]);
    setInput('');
    setChatError(null);
    setPhotos([]);
    setPhotoError(null);
    setAccess(buildDefaultPropertyAccess());
    setAvailability([]);
    setPriorityOverride(null);
    setLocationOverride('');
    setShowAdjust(false);
    setSubmitError(null);
    setResult(null);
  };

  const conversationStarted = messages.length > 0;
  const canLeaveDescribe = Boolean(triage);
  const canSubmit = Boolean(effectiveTriage) && !submitting;

  if (step === 'submitted' && result) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-6 text-center">
        <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" />
        <h3 className="mt-3 text-lg font-semibold text-emerald-900">Ticket submitted</h3>
        <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-emerald-800">
          {result.awaitingOwnerConfirmation
            ? 'We texted you to confirm before dispatching a provider. Reply YES and the HouseYield team takes it from there.'
            : 'The HouseYield team is sourcing a provider now. Track every step on the progress timeline below.'}
        </p>
        <button
          type="button"
          onClick={resetFlow}
          className="ds-focus-ring mt-5 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700"
        >
          Report another issue
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Step rail */}
      <div className="flex items-center gap-2">
        {STEP_ORDER.map((id, index) => {
          const currentIndex = STEP_ORDER.indexOf(step);
          const state = index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'todo';
          return (
            <div key={id} className="flex flex-1 items-center gap-2">
              <div
                className={[
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
                  state === 'done'
                    ? 'border-emerald-600 bg-emerald-600 text-white'
                    : state === 'active'
                      ? 'border-emerald-500 bg-white text-emerald-600 ring-4 ring-emerald-100'
                      : 'border-slate-300 bg-white text-slate-400',
                ].join(' ')}
              >
                {state === 'done' ? '✓' : index + 1}
              </div>
              <span
                className={`hidden truncate text-xs sm:inline ${
                  state === 'active' ? 'font-semibold text-slate-900' : 'text-slate-500'
                }`}
              >
                {STEP_LABELS[id]}
              </span>
              {index < STEP_ORDER.length - 1 && (
                <div className={`h-0.5 flex-1 ${state === 'done' ? 'bg-emerald-500' : 'bg-slate-200'}`} />
              )}
            </div>
          );
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          {step === 'describe' && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
              {!conversationStarted ? (
                <>
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-indigo-600" />
                    <h3 className="text-base font-semibold text-slate-900">
                      What&apos;s going on{propertyAddress ? ` at ${propertyAddress}` : ''}?
                    </h3>
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
                    Describe it however you would to a neighbor. No categories, no forms — the assistant
                    asks whatever it still needs and builds the ticket for you.
                  </p>
                </>
              ) : (
                <div className="mb-3 flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-indigo-600" />
                  <h3 className="text-sm font-semibold text-slate-900">Intake assistant</h3>
                  {sending && <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" />}
                </div>
              )}

              {conversationStarted && (
                <div className="mb-3 max-h-[22rem] space-y-3 overflow-y-auto pr-1">
                  {messages.map((line, index) => (
                    <div
                      key={`${line.at || index}-${index}`}
                      className={line.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
                    >
                      <div
                        className={[
                          'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
                          line.role === 'user'
                            ? 'bg-emerald-600 text-white'
                            : 'border border-slate-200 bg-slate-50 text-slate-800',
                        ].join(' ')}
                      >
                        {line.display || line.content}
                      </div>
                    </div>
                  ))}
                  {sending && !currentQuestion && (
                    <div className="flex justify-start">
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-2 text-sm text-slate-500">
                        Thinking…
                      </div>
                    </div>
                  )}
                  <div ref={transcriptEndRef} />
                </div>
              )}

              {triage?.emergencyLevel === 'call_911' && (
                <div className="mb-3 flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 p-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                  <div className="text-sm text-red-800">
                    <span className="font-semibold">Call 911 immediately.</span>{' '}
                    {triage.emergencyGuidance}
                  </div>
                </div>
              )}

              {currentQuestion && (
                <div className="mb-3 rounded-xl border border-indigo-100 bg-indigo-50/50 p-3">
                  <div className="text-sm font-medium text-slate-800">
                    {currentQuestion.question}
                  </div>
                  {currentQuestion.allowMultiple && (
                    <div className="mt-0.5 text-[11px] text-slate-500">Choose all that apply.</div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {currentQuestion.options.map((option) => {
                      const active = multiSelection.includes(option.label);
                      return (
                        <button
                          key={option.id}
                          type="button"
                          aria-pressed={currentQuestion.allowMultiple ? active : undefined}
                          onClick={() =>
                            currentQuestion.allowMultiple
                              ? toggleMultiSelection(option.label)
                              : answerQuestion(currentQuestion, [option.label])
                          }
                          className={[
                            'ds-focus-ring flex flex-col items-start rounded-xl border px-3 py-1.5 text-left transition',
                            active
                              ? 'border-indigo-500 bg-indigo-600 text-white'
                              : 'border-indigo-200 bg-white text-indigo-800 hover:border-indigo-400 hover:bg-indigo-100',
                          ].join(' ')}
                        >
                          <span className="text-xs font-semibold">{option.label}</span>
                          {option.detail && (
                            <span
                              className={`text-[10px] leading-tight ${
                                active ? 'text-indigo-100' : 'text-slate-500'
                              }`}
                            >
                              {option.detail}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {currentQuestion.allowMultiple && (
                    <button
                      type="button"
                      onClick={() => answerQuestion(currentQuestion, multiSelection)}
                      disabled={!multiSelection.length}
                      className="ds-focus-ring mt-2 inline-flex items-center gap-1 rounded-lg bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:opacity-40"
                    >
                      Continue{multiSelection.length ? ` (${multiSelection.length})` : ''}
                    </button>
                  )}
                  <p className="mt-2 text-[11px] text-slate-400">
                    Tap an answer, or type your own below.
                    {questionQueue.length > 1 ? ` ${questionQueue.length - 1} more after this.` : ''}
                  </p>
                </div>
              )}

              <div className="relative">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      sendMessage(input);
                    }
                  }}
                  rows={conversationStarted ? 2 : 4}
                  placeholder={
                    conversationStarted
                      ? 'Answer, or add anything else…'
                      : 'e.g., There\u2019s water pooling under the kitchen sink and the cabinet floor is soft.'
                  }
                  className="ds-focus-ring w-full resize-none rounded-xl border border-slate-300 py-2.5 pl-3.5 pr-24 text-sm"
                />
                <div className="absolute bottom-2.5 right-2 flex items-center gap-1">
                  {speechSupported && (
                    <button
                      type="button"
                      onClick={toggleListening}
                      title={listening ? 'Stop dictating' : 'Dictate'}
                      aria-pressed={listening}
                      className={[
                        'ds-focus-ring rounded-lg p-2 transition',
                        listening
                          ? 'bg-red-50 text-red-600 ring-1 ring-red-200'
                          : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600',
                      ].join(' ')}
                    >
                      <Mic className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => sendMessage(input)}
                    disabled={!input.trim()}
                    className="ds-focus-ring rounded-lg bg-emerald-600 p-2 text-white transition hover:bg-emerald-700 disabled:opacity-40"
                    title="Send"
                  >
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {chatError && (
                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
                  {chatError}
                </div>
              )}

              {/* Photos */}
              <div className="mt-4 border-t border-slate-100 pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    id="intake-photo-upload"
                    className="hidden"
                    onChange={handlePhotoSelect}
                    disabled={uploadingPhotos || photos.length >= MAX_PHOTOS}
                  />
                  <label
                    htmlFor="intake-photo-upload"
                    className={[
                      'ds-focus-ring inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50',
                      uploadingPhotos || photos.length >= MAX_PHOTOS ? 'pointer-events-none opacity-50' : '',
                    ].join(' ')}
                  >
                    {uploadingPhotos ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ImagePlus className="h-4 w-4" />
                    )}
                    Add photos
                  </label>
                  <span className="text-xs text-slate-500">
                    Optional, up to {MAX_PHOTOS}. Photos help the provider quote accurately.
                  </span>
                </div>

                {photoError && (
                  <div className="mt-2 text-xs text-amber-700">{photoError}</div>
                )}

                {photos.length > 0 && (
                  <div className="mt-3 grid grid-cols-5 gap-2">
                    {photos.map((photo) => (
                      <div key={photo.url} className="group relative">
                        <img
                          src={photo.url}
                          alt={photo.name}
                          className="h-16 w-full rounded-lg border border-slate-200 object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => removePhoto(photo.url)}
                          aria-label={`Remove ${photo.name}`}
                          className="absolute right-0.5 top-0.5 rounded-full bg-red-600 p-0.5 text-white opacity-0 transition group-hover:opacity-100"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-4">
                {onSwitchToForm ? (
                  <button
                    type="button"
                    onClick={onSwitchToForm}
                    className="ds-focus-ring text-xs font-medium text-slate-500 underline-offset-2 transition hover:text-slate-700 hover:underline"
                  >
                    Skip the chat, use the classic form
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  onClick={() => setStep('logistics')}
                  disabled={!canLeaveDescribe}
                  className="ds-focus-ring inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-40"
                >
                  Continue <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {step === 'logistics' && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
                <h3 className="text-base font-semibold text-slate-900">How does the provider get in?</h3>
                <p className="mt-1 text-sm text-slate-600">
                  Nobody has to be home if you leave access instructions.
                </p>
                <div className="mt-4">
                  <AccessMethodPicker value={access} onChange={setAccess} />
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
                <h3 className="text-base font-semibold text-slate-900">When works for a visit?</h3>
                <p className="mt-1 text-sm text-slate-600">
                  Pick dates, then narrow to time windows. More options means a faster booking.
                </p>
                <div className="mt-4">
                  <AvailabilityPicker value={availability} onChange={setAvailability} />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setStep('describe')}
                  className="ds-focus-ring inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  <ArrowLeft className="h-4 w-4" /> Back
                </button>
                <button
                  type="button"
                  onClick={() => setStep('review')}
                  className="ds-focus-ring inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  Review ticket <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {step === 'review' && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
                <h3 className="text-base font-semibold text-slate-900">Everything look right?</h3>
                <p className="mt-1 text-sm text-slate-600">
                  This is exactly what the HouseYield dispatch team will see.
                </p>

                <button
                  type="button"
                  onClick={() => setShowAdjust((open) => !open)}
                  className="ds-focus-ring mt-3 text-xs font-medium text-indigo-600 underline-offset-2 transition hover:underline"
                >
                  {showAdjust ? 'Hide manual adjustments' : 'Adjust priority or location'}
                </button>

                {showAdjust && (
                  <div className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div>
                      <span className="mb-1.5 block text-sm font-medium text-slate-700">Priority</span>
                      <div className="flex gap-1.5">
                        {(['low', 'normal', 'urgent'] as MaintenancePriority[]).map((level) => {
                          const active = (priorityOverride || triage?.priority) === level;
                          return (
                            <button
                              key={level}
                              type="button"
                              onClick={() => setPriorityOverride(level)}
                              aria-pressed={active}
                              className={[
                                'ds-focus-ring rounded-full border px-3 py-1 text-xs font-medium transition',
                                active ? PRIORITY_STYLES[level] : 'border-slate-300 bg-white text-slate-500 hover:border-slate-400',
                              ].join(' ')}
                            >
                              {PRIORITY_LABELS[level]}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <label className="block">
                      <span className="mb-1.5 block text-sm font-medium text-slate-700">Location</span>
                      <input
                        type="text"
                        value={locationOverride || triage?.location || ''}
                        onChange={(event) => setLocationOverride(event.target.value)}
                        placeholder="e.g., Kitchen sink, basement utility room"
                        className="ds-focus-ring w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </label>
                  </div>
                )}
              </div>

              <TicketSummaryCard
                triage={effectiveTriage}
                propertyAddress={propertyAddress}
                access={access}
                availability={availability}
                photos={photos}
                variant="review"
              />

              {submitError && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {submitError}
                </div>
              )}

              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setStep('logistics')}
                  className="ds-focus-ring inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  <ArrowLeft className="h-4 w-4" /> Back
                </button>
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={!canSubmit}
                  className="ds-focus-ring inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-40"
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  {submitting ? 'Submitting…' : 'Submit ticket'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Live ticket rail */}
        {step !== 'review' && (
          <div className="xl:sticky xl:top-4 xl:self-start">
            <TicketSummaryCard
              triage={effectiveTriage}
              propertyAddress={propertyAddress}
              access={access}
              availability={availability}
              photos={photos}
            />
          </div>
        )}
      </div>
    </div>
  );
}
