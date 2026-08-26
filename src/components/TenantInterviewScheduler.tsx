import { useState, useEffect } from 'react';
import { 
  Phone, Calendar, Clock, User, MapPin, Mail, 
  Send, Loader2, Check, X, 
  AlertCircle, MessageSquare, FileText,
  PlayCircle, RefreshCw, Eye
} from 'lucide-react';

// Types
interface Interview {
  id: string;
  applicantId: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string;
  propertyAddress: string;
  ownerId: string;
  monthlyRent?: number;
  scheduledTime?: string;
  status: 'pending_booking' | 'scheduled' | 'calling' | 'in_progress' | 'analyzing' | 'completed' | 'call_failed' | 'cancelled';
  createdAt: string;
  transcript?: Array<{ speaker: string; text: string; timestamp: string }>;
  aiSummary?: string;
  rating?: {
    overall: number;
    employment: { score: number; notes: string };
    rentalHistory: { score: number; notes: string };
    communication: { score: number; notes: string };
  };
  recommendation?: 'APPROVE' | 'CONDITIONAL' | 'DECLINE';
  recommendationReason?: string;
  redFlags?: string[];
  positiveIndicators?: string[];
  suggestedFollowUp?: string[];
  bookingToken?: string;
}

interface TenantApplicant {
  id: string;
  name: string;
  email: string;
  phone?: string;
  appliedDate: string;
  status: 'pending' | 'approved' | 'rejected';
  creditScore?: number;
  backgroundCheck?: 'pending' | 'clear' | 'flagged';
  incomeVerification?: {
    verified: boolean;
    monthlyIncome?: number;
    employmentStatus?: string;
  };
}

interface TenantInterviewSchedulerProps {
  applicant?: TenantApplicant;
  applicants?: TenantApplicant[];
  propertyAddress?: string;
  ownerId?: string;
  ownerName?: string;
  monthlyRent?: number;
  onInterviewScheduled?: (interview: Interview) => void;
  onClose?: () => void;
}

const TenantInterviewScheduler: React.FC<TenantInterviewSchedulerProps> = ({
  applicant,
  applicants = [],
  propertyAddress: initialPropertyAddress = '',
  ownerId: initialOwnerId = '',
  ownerName = '',
  monthlyRent: initialMonthlyRent,
  onInterviewScheduled,
  onClose
}) => {
  // State
  const [activeTab, setActiveTab] = useState<'schedule' | 'pending' | 'completed'>('schedule');
  const [selectedApplicantId, setSelectedApplicantId] = useState<string>('');
  const [applicantName, setApplicantName] = useState(applicant?.name || '');
  const [applicantEmail, setApplicantEmail] = useState(applicant?.email || '');
  const [applicantPhone, setApplicantPhone] = useState(applicant?.phone || '');
  const [propertyAddress, setPropertyAddress] = useState(initialPropertyAddress);
  const [ownerId] = useState(initialOwnerId || `owner_${Date.now()}`);
  const [monthlyRent, setMonthlyRent] = useState<number | undefined>(initialMonthlyRent);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message?: string; interview?: Interview } | null>(null);
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [selectedInterview, setSelectedInterview] = useState<Interview | null>(null);
  const [systemStatus, setSystemStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Fetch system status and interviews on mount
  useEffect(() => {
    fetchSystemStatus();
    fetchInterviews();
  }, []);

  const getApiUrl = (path: string) => {
    const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
    const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
    return useProxy ? path : `${baseEnv || 'http://127.0.0.1:3001'}${path}`;
  };

  const fetchSystemStatus = async () => {
    try {
      const response = await fetch(getApiUrl('/api/interviews/status'));
      if (response.ok) {
        const data = await response.json();
        setSystemStatus(data);
      }
    } catch (error) {
      console.error('[Interview] Failed to fetch status:', error);
    }
  };

  const fetchInterviews = async () => {
    setLoading(true);
    try {
      const response = await fetch(getApiUrl(`/api/interviews?ownerId=${ownerId}`));
      if (response.ok) {
        const data = await response.json();
        setInterviews(data.interviews || []);
      }
    } catch (error) {
      console.error('[Interview] Failed to fetch interviews:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleScheduleInterview = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setResult(null);

    try {
      const response = await fetch(getApiUrl('/api/interviews/schedule'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicantId: applicant?.id || `applicant_${Date.now()}`,
          applicantName,
          applicantEmail,
          applicantPhone,
          propertyAddress,
          ownerId,
          ownerName,
          monthlyRent
        })
      });

      const data = await response.json();

      if (data.ok) {
        setResult({
          ok: true,
          message: 'Interview scheduling email sent successfully!',
          interview: data.interview
        });
        if (onInterviewScheduled) {
          onInterviewScheduled(data.interview);
        }
        // Refresh interviews list
        fetchInterviews();
      } else {
        setResult({
          ok: false,
          message: data.error || 'Failed to schedule interview'
        });
      }
    } catch (error) {
      console.error('[Interview] Error scheduling:', error);
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to schedule interview'
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleInitiateCall = async (interviewId: string) => {
    try {
      const response = await fetch(getApiUrl(`/api/interviews/${interviewId}/call`), {
        method: 'POST'
      });
      const data = await response.json();
      if (data.ok) {
        fetchInterviews();
      }
    } catch (error) {
      console.error('[Interview] Failed to initiate call:', error);
    }
  };

  const formatPhoneNumber = (phone: string) => {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 10) {
      return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
    } else if (cleaned.length === 11 && cleaned[0] === '1') {
      return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
    }
    return phone;
  };

  const getStatusBadge = (status: Interview['status']) => {
    const statusConfig: Record<string, { color: string; icon: React.ReactNode; text: string }> = {
      pending_booking: { color: 'bg-amber-100 text-amber-700 border-amber-200', icon: <Calendar className="h-3 w-3" />, text: 'Awaiting Booking' },
      scheduled: { color: 'bg-blue-100 text-blue-700 border-blue-200', icon: <Clock className="h-3 w-3" />, text: 'Scheduled' },
      calling: { color: 'bg-purple-100 text-purple-700 border-purple-200', icon: <Phone className="h-3 w-3 animate-pulse" />, text: 'Calling...' },
      in_progress: { color: 'bg-green-100 text-green-700 border-green-200', icon: <MessageSquare className="h-3 w-3" />, text: 'In Progress' },
      analyzing: { color: 'bg-indigo-100 text-indigo-700 border-indigo-200', icon: <Loader2 className="h-3 w-3 animate-spin" />, text: 'Analyzing' },
      completed: { color: 'bg-emerald-100 text-emerald-700 border-emerald-200', icon: <Check className="h-3 w-3" />, text: 'Completed' },
      call_failed: { color: 'bg-red-100 text-red-700 border-red-200', icon: <AlertCircle className="h-3 w-3" />, text: 'Call Failed' },
      cancelled: { color: 'bg-gray-100 text-gray-600 border-gray-200', icon: <X className="h-3 w-3" />, text: 'Cancelled' }
    };

    const config = statusConfig[status] || statusConfig.pending_booking;

    return (
      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${config.color}`}>
        {config.icon}
        {config.text}
      </span>
    );
  };

  const getRecommendationBadge = (rec?: string) => {
    if (!rec) return null;
    const config: Record<string, { color: string; icon: React.ReactNode }> = {
      APPROVE: { color: 'bg-green-500 text-white', icon: <Check className="h-4 w-4" /> },
      CONDITIONAL: { color: 'bg-amber-500 text-white', icon: <AlertCircle className="h-4 w-4" /> },
      DECLINE: { color: 'bg-red-500 text-white', icon: <X className="h-4 w-4" /> }
    };
    const c = config[rec] || config.CONDITIONAL;
    return (
      <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold ${c.color}`}>
        {c.icon}
        {rec}
      </span>
    );
  };

  const renderScheduleTab = () => (
    <div className="space-y-4">
      {/* System Status */}
      {systemStatus && (
        <div className={`p-3 rounded-lg border ${systemStatus.configured ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
          <div className="flex items-center gap-2 text-sm">
            {systemStatus.configured ? (
              <>
                <Check className="h-4 w-4 text-green-600" />
                <span className="text-green-700 font-medium">Interview system ready</span>
              </>
            ) : (
              <>
                <AlertCircle className="h-4 w-4 text-amber-600" />
                <span className="text-amber-700 font-medium">Interview system not fully configured</span>
              </>
            )}
          </div>
          {systemStatus.configured && (
            <div className="mt-2 text-xs text-gray-500 flex flex-wrap gap-3">
              <span>📞 From: {systemStatus.fromNumber}</span>
              <span>📅 Scheduled: {systemStatus.scheduledCount}</span>
              <span>✅ Completed: {systemStatus.completedCount}</span>
            </div>
          )}
        </div>
      )}

      {/* Success/Error Message */}
      {result && (
        <div className={`p-4 rounded-lg border ${result.ok ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
          <div className="flex items-start gap-3">
            {result.ok ? (
              <Check className="h-5 w-5 text-green-600 mt-0.5" />
            ) : (
              <AlertCircle className="h-5 w-5 text-red-600 mt-0.5" />
            )}
            <div>
              <div className={`font-medium ${result.ok ? 'text-green-800' : 'text-red-800'}`}>
                {result.ok ? 'Success!' : 'Error'}
              </div>
              <div className={`text-sm ${result.ok ? 'text-green-600' : 'text-red-600'}`}>
                {result.message}
              </div>
              {result.interview && (
                <div className="mt-2 text-xs text-gray-600">
                  A booking link has been emailed to the applicant.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Schedule Form */}
      <form onSubmit={handleScheduleInterview} className="space-y-4">
        {/* Select from existing applicants */}
        {applicants.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Select Existing Applicant (optional)
            </label>
            <select
              value={selectedApplicantId}
              onChange={(e) => {
                const selected = applicants.find(a => a.id === e.target.value);
                setSelectedApplicantId(e.target.value);
                if (selected) {
                  setApplicantName(selected.name);
                  setApplicantEmail(selected.email);
                  setApplicantPhone(selected.phone || '');
                }
              }}
              className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
            >
              <option value="">-- Enter new applicant info --</option>
              {applicants.map(a => (
                <option key={a.id} value={a.id}>{a.name} - {a.email}</option>
              ))}
            </select>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Applicant Name *
            </label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                value={applicantName}
                onChange={(e) => setApplicantName(e.target.value)}
                required
                className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                placeholder="John Smith"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email Address *
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="email"
                value={applicantEmail}
                onChange={(e) => setApplicantEmail(e.target.value)}
                required
                className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                placeholder="applicant@email.com"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Phone Number * (for interview call)
            </label>
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="tel"
                value={applicantPhone}
                onChange={(e) => setApplicantPhone(e.target.value)}
                required
                className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                placeholder="(555) 123-4567"
              />
            </div>
            <p className="mt-1 text-xs text-gray-500">
              The screening assistant will call this number at the scheduled time
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Property Address *
            </label>
            <div className="relative">
              <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                value={propertyAddress}
                onChange={(e) => setPropertyAddress(e.target.value)}
                required
                className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                placeholder="123 Main St, City, State 12345"
              />
            </div>
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Monthly Rent (optional)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
              <input
                type="number"
                value={monthlyRent || ''}
                onChange={(e) => setMonthlyRent(e.target.value ? Number(e.target.value) : undefined)}
                className="w-full pl-8 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                placeholder="2000"
              />
            </div>
          </div>
        </div>

        <button
          type="submit"
          disabled={isSubmitting || !applicantName || !applicantEmail || !applicantPhone}
          className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg font-medium transition-all ${
            isSubmitting
              ? 'bg-green-400 text-white cursor-wait'
              : !applicantName || !applicantEmail || !applicantPhone
              ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
              : 'bg-green-600 text-white hover:bg-green-700 active:scale-[0.98]'
          }`}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" />
              Sending...
            </>
          ) : (
            <>
              <Send className="h-5 w-5" />
              Send Interview Invitation
            </>
          )}
        </button>
      </form>

      {/* How It Works */}
      <div className="mt-6 p-4 bg-gradient-to-br from-green-50 to-emerald-50 rounded-xl border border-green-100">
        <h4 className="text-sm font-semibold text-gray-800 mb-3">📞 How AI Interviews Work</h4>
        <div className="space-y-2 text-xs text-gray-600">
          <div className="flex items-start gap-2">
            <span className="font-bold text-green-600">1.</span>
            <span>Applicant receives an email with a link to book their interview time</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="font-bold text-green-600">2.</span>
            <span>At the scheduled time, our screening assistant calls them and conducts a 10-15 minute interview</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="font-bold text-green-600">3.</span>
            <span>The interview covers employment, rental history, move-in timeline, and more</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="font-bold text-green-600">4.</span>
            <span>You receive a full transcript, summary, and recommendation score</span>
          </div>
        </div>
      </div>
    </div>
  );

  const renderPendingTab = () => {
    const pendingInterviews = interviews.filter(i => 
      ['pending_booking', 'scheduled', 'calling', 'in_progress', 'analyzing', 'call_failed'].includes(i.status)
    );

    return (
      <div className="space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : pendingInterviews.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <Calendar className="h-12 w-12 mx-auto mb-3 text-gray-300" />
            <p>No pending interviews</p>
            <p className="text-xs mt-1">Schedule a new interview to get started</p>
          </div>
        ) : (
          pendingInterviews.map(interview => (
            <div 
              key={interview.id}
              className="p-4 bg-white border rounded-xl hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className="h-10 w-10 rounded-full bg-green-100 flex items-center justify-center text-green-600 font-semibold">
                    {interview.applicantName.split(' ').map(n => n[0]).join('').slice(0, 2)}
                  </div>
                  <div>
                    <div className="font-medium text-gray-900">{interview.applicantName}</div>
                    <div className="text-xs text-gray-500">{interview.applicantEmail}</div>
                    {interview.applicantPhone && (
                      <div className="text-xs text-gray-500">{formatPhoneNumber(interview.applicantPhone)}</div>
                    )}
                  </div>
                </div>
                {getStatusBadge(interview.status)}
              </div>

              <div className="mt-3 pt-3 border-t flex items-center justify-between">
                <div className="text-xs text-gray-500">
                  {interview.scheduledTime ? (
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(interview.scheduledTime).toLocaleString()}
                    </span>
                  ) : (
                    <span>Waiting for applicant to book</span>
                  )}
                </div>
                <div className="flex gap-2">
                  {interview.status === 'scheduled' && (
                    <button
                      onClick={() => handleInitiateCall(interview.id)}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700"
                    >
                      <PlayCircle className="h-3 w-3" />
                      Call Now
                    </button>
                  )}
                  {interview.status === 'call_failed' && (
                    <button
                      onClick={() => handleInitiateCall(interview.id)}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-amber-600 text-white rounded-lg hover:bg-amber-700"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Retry Call
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    );
  };

  const renderCompletedTab = () => {
    const completedInterviews = interviews.filter(i => i.status === 'completed');

    return (
      <div className="space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : completedInterviews.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <FileText className="h-12 w-12 mx-auto mb-3 text-gray-300" />
            <p>No completed interviews yet</p>
          </div>
        ) : (
          completedInterviews.map(interview => (
            <div 
              key={interview.id}
              className="p-4 bg-white border rounded-xl hover:shadow-md transition-shadow cursor-pointer"
              onClick={() => setSelectedInterview(interview)}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className="h-10 w-10 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 font-semibold">
                    {interview.applicantName.split(' ').map(n => n[0]).join('').slice(0, 2)}
                  </div>
                  <div>
                    <div className="font-medium text-gray-900">{interview.applicantName}</div>
                    <div className="text-xs text-gray-500">{interview.propertyAddress}</div>
                  </div>
                </div>
                {getRecommendationBadge(interview.recommendation)}
              </div>

              {interview.rating && (
                <div className="mt-3 pt-3 border-t">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="text-center">
                        <div className="text-2xl font-bold text-gray-900">{interview.rating.overall}</div>
                        <div className="text-[10px] text-gray-500">Score</div>
                      </div>
                      <div className="flex gap-3 text-xs">
                        <div>
                          <span className="text-gray-500">Employment:</span>
                          <span className="ml-1 font-medium">{interview.rating.employment?.score}/10</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Rental:</span>
                          <span className="ml-1 font-medium">{interview.rating.rentalHistory?.score}/10</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Communication:</span>
                          <span className="ml-1 font-medium">{interview.rating.communication?.score}/10</span>
                        </div>
                      </div>
                    </div>
                    <button className="flex items-center gap-1 text-xs text-green-600 hover:text-green-700">
                      <Eye className="h-3 w-3" />
                      View Details
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    );
  };

  // Interview Details Modal
  const renderInterviewModal = () => {
    if (!selectedInterview) return null;

    return (
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-green-600 to-emerald-600 px-6 py-4 flex items-center justify-between text-white">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-full bg-white/20 flex items-center justify-center font-bold text-lg">
                {selectedInterview.applicantName.split(' ').map(n => n[0]).join('').slice(0, 2)}
              </div>
              <div>
                <h2 className="text-lg font-semibold">{selectedInterview.applicantName}</h2>
                <p className="text-green-200 text-sm">{selectedInterview.propertyAddress}</p>
              </div>
            </div>
            <button 
              onClick={() => setSelectedInterview(null)}
              className="text-white/80 hover:text-white"
            >
              <X className="h-6 w-6" />
            </button>
          </div>

          <div className="p-6 overflow-y-auto max-h-[calc(90vh-100px)]">
            {/* Recommendation */}
            {selectedInterview.recommendation && (
              <div className="flex items-center justify-between mb-6 p-4 bg-gray-50 rounded-xl">
                <div>
                  <div className="text-sm text-gray-500 mb-1">AI Recommendation</div>
                  {getRecommendationBadge(selectedInterview.recommendation)}
                </div>
                <div className="text-right">
                  <div className="text-sm text-gray-500 mb-1">Overall Score</div>
                  <div className="text-3xl font-bold text-gray-900">
                    {selectedInterview.rating?.overall}<span className="text-lg text-gray-400">/100</span>
                  </div>
                </div>
              </div>
            )}

            {/* Reason */}
            {selectedInterview.recommendationReason && (
              <div className="mb-6 p-4 bg-blue-50 border border-blue-100 rounded-xl">
                <div className="text-sm font-medium text-blue-800 mb-1">Recommendation Reason</div>
                <div className="text-sm text-blue-700">{selectedInterview.recommendationReason}</div>
              </div>
            )}

            {/* Scores Grid */}
            {selectedInterview.rating && (
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="p-4 bg-gray-50 rounded-xl text-center">
                  <div className="text-2xl font-bold text-gray-900">{selectedInterview.rating.employment?.score}</div>
                  <div className="text-xs text-gray-500 mt-1">Employment</div>
                  <div className="text-xs text-gray-400 mt-2 line-clamp-2">{selectedInterview.rating.employment?.notes}</div>
                </div>
                <div className="p-4 bg-gray-50 rounded-xl text-center">
                  <div className="text-2xl font-bold text-gray-900">{selectedInterview.rating.rentalHistory?.score}</div>
                  <div className="text-xs text-gray-500 mt-1">Rental History</div>
                  <div className="text-xs text-gray-400 mt-2 line-clamp-2">{selectedInterview.rating.rentalHistory?.notes}</div>
                </div>
                <div className="p-4 bg-gray-50 rounded-xl text-center">
                  <div className="text-2xl font-bold text-gray-900">{selectedInterview.rating.communication?.score}</div>
                  <div className="text-xs text-gray-500 mt-1">Communication</div>
                  <div className="text-xs text-gray-400 mt-2 line-clamp-2">{selectedInterview.rating.communication?.notes}</div>
                </div>
              </div>
            )}

            {/* Red Flags & Positives */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              {selectedInterview.positiveIndicators && selectedInterview.positiveIndicators.length > 0 && (
                <div className="p-4 bg-green-50 border border-green-100 rounded-xl">
                  <div className="text-sm font-medium text-green-800 mb-2 flex items-center gap-1">
                    <Check className="h-4 w-4" />
                    Positive Indicators
                  </div>
                  <ul className="space-y-1">
                    {selectedInterview.positiveIndicators.map((item, i) => (
                      <li key={i} className="text-xs text-green-700">• {item}</li>
                    ))}
                  </ul>
                </div>
              )}
              {selectedInterview.redFlags && selectedInterview.redFlags.length > 0 && (
                <div className="p-4 bg-red-50 border border-red-100 rounded-xl">
                  <div className="text-sm font-medium text-red-800 mb-2 flex items-center gap-1">
                    <AlertCircle className="h-4 w-4" />
                    Red Flags
                  </div>
                  <ul className="space-y-1">
                    {selectedInterview.redFlags.map((item, i) => (
                      <li key={i} className="text-xs text-red-700">• {item}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* AI Summary */}
            {selectedInterview.aiSummary && (
              <div className="mb-6">
                <div className="text-sm font-medium text-gray-700 mb-2">AI Summary</div>
                <div className="p-4 bg-gray-50 rounded-xl text-sm text-gray-600 whitespace-pre-wrap">
                  {selectedInterview.aiSummary}
                </div>
              </div>
            )}

            {/* Transcript */}
            {selectedInterview.transcript && selectedInterview.transcript.length > 0 && (
              <div>
                <div className="text-sm font-medium text-gray-700 mb-2">Interview Transcript</div>
                <div className="p-4 bg-gray-50 rounded-xl max-h-64 overflow-y-auto space-y-3">
                  {selectedInterview.transcript.map((entry, i) => (
                    <div key={i} className={`text-sm ${entry.speaker === 'AI' ? 'text-gray-600' : 'text-gray-800 font-medium'}`}>
                      <span className={`text-xs ${entry.speaker === 'AI' ? 'text-blue-600' : 'text-green-600'}`}>
                        {entry.speaker}:
                      </span>
                      <span className="ml-2">{entry.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Suggested Follow-up */}
            {selectedInterview.suggestedFollowUp && selectedInterview.suggestedFollowUp.length > 0 && (
              <div className="mt-6 p-4 bg-amber-50 border border-amber-100 rounded-xl">
                <div className="text-sm font-medium text-amber-800 mb-2">Suggested Follow-up</div>
                <ul className="space-y-1">
                  {selectedInterview.suggestedFollowUp.map((item, i) => (
                    <li key={i} className="text-xs text-amber-700">• {item}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-green-600 to-emerald-600 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-white">
            <div className="h-10 w-10 rounded-full bg-white/20 flex items-center justify-center">
              <Phone className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-lg font-semibold">Phone Interview</h3>
              <p className="text-green-200 text-sm">Automated tenant screening calls</p>
            </div>
          </div>
          {onClose && (
            <button onClick={onClose} className="text-white/80 hover:text-white">
              <X className="h-6 w-6" />
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b">
        <div className="flex">
          <button
            onClick={() => setActiveTab('schedule')}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'schedule'
                ? 'text-green-600 border-b-2 border-green-600 bg-green-50'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Send className="h-4 w-4 inline mr-2" />
            Schedule New
          </button>
          <button
            onClick={() => { setActiveTab('pending'); fetchInterviews(); }}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'pending'
                ? 'text-green-600 border-b-2 border-green-600 bg-green-50'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Clock className="h-4 w-4 inline mr-2" />
            Pending
          </button>
          <button
            onClick={() => { setActiveTab('completed'); fetchInterviews(); }}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'completed'
                ? 'text-green-600 border-b-2 border-green-600 bg-green-50'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <FileText className="h-4 w-4 inline mr-2" />
            Completed
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="p-6">
        {activeTab === 'schedule' && renderScheduleTab()}
        {activeTab === 'pending' && renderPendingTab()}
        {activeTab === 'completed' && renderCompletedTab()}
      </div>

      {/* Interview Details Modal */}
      {renderInterviewModal()}
    </div>
  );
};

export default TenantInterviewScheduler;
