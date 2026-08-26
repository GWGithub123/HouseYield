import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { 
  Calendar, Clock, Phone, MapPin, Check, Loader2, 
  AlertCircle, User, Sparkles
} from 'lucide-react';

interface InterviewInfo {
  applicantName: string;
  propertyAddress: string;
  status: string;
  calendlyLink?: string;
}

export default function InterviewBooking() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');
  
  const [loading, setLoading] = useState(true);
  const [interviewInfo, setInterviewInfo] = useState<InterviewInfo | null>(null);
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedTime, setSelectedTime] = useState('');
  const [booking, setBooking] = useState(false);
  const [booked, setBooked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getApiUrl = (path: string) => {
    const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
    return baseEnv ? `${baseEnv}${path}` : `http://127.0.0.1:3001${path}`;
  };

  // Generate min date (tomorrow)
  const getMinDate = () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  };

  // Generate max date (30 days out)
  const getMaxDate = () => {
    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + 30);
    return maxDate.toISOString().split('T')[0];
  };

  useEffect(() => {
    if (!token) {
      setError('Invalid booking link. Please check the link in your email.');
      setLoading(false);
      return;
    }
    fetchInterviewInfo();
  }, [token]);

  const fetchInterviewInfo = async () => {
    try {
      const response = await fetch(getApiUrl(`/api/interviews/booking/${token}`));
      const data = await response.json();
      
      if (data.ok) {
        setInterviewInfo(data.interview);
        
        // If there's a Calendly link configured, we could redirect there instead
        // But we'll show both options
      } else {
        setError(data.error || 'This booking link is invalid or has expired.');
      }
    } catch (err) {
      setError('Failed to load interview information. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleBook = async () => {
    if (!selectedDate || !selectedTime || !token) return;
    
    // Combine date and time
    const scheduledTime = new Date(`${selectedDate}T${selectedTime}`);
    
    // Validate it's in the future
    if (scheduledTime <= new Date()) {
      setError('Please select a future date and time.');
      return;
    }
    
    setBooking(true);
    setError(null);
    
    try {
      const response = await fetch(getApiUrl('/api/interviews/book'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookingToken: token,
          selectedTime: scheduledTime.toISOString()
        })
      });
      
      const data = await response.json();
      
      if (data.ok) {
        setBooked(true);
      } else {
        setError(data.error || 'Failed to book interview. Please try again.');
      }
    } catch (err) {
      setError('Failed to book interview. Please check your connection and try again.');
    } finally {
      setBooking(false);
    }
  };

  // Open Google Calendar to create event
  const handleAddToGoogleCalendar = () => {
    if (!selectedDate || !selectedTime) return;
    
    const startTime = new Date(`${selectedDate}T${selectedTime}`);
    const endTime = new Date(startTime.getTime() + 15 * 60000); // 15 minutes later
    
    const formatGoogleDate = (date: Date) => {
      return date.toISOString().replace(/-|:|\.\d+/g, '').slice(0, 15) + 'Z';
    };
    
    const googleUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=AI+Phone+Interview&dates=${formatGoogleDate(startTime)}/${formatGoogleDate(endTime)}&details=Your+scheduled+AI+phone+interview+for+${encodeURIComponent(interviewInfo?.propertyAddress || 'the rental property')}.+Make+sure+you're+in+a+quiet+location+with+good+phone+reception.&location=Phone+Call`;
    
    window.open(googleUrl, '_blank');
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
          <Loader2 className="h-12 w-12 animate-spin text-green-600 mx-auto mb-4" />
          <p className="text-gray-600">Loading interview details...</p>
        </div>
      </div>
    );
  }

  if (error && !interviewInfo) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-red-50 to-orange-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 text-center max-w-md">
          <div className="h-16 w-16 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="h-8 w-8 text-red-600" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Booking Error</h2>
          <p className="text-gray-600 mb-6">{error}</p>
          <button
            onClick={() => navigate('/')}
            className="px-6 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
          >
            Go Home
          </button>
        </div>
      </div>
    );
  }

  if (booked) {
    const scheduledDateTime = new Date(`${selectedDate}T${selectedTime}`);
    
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 text-center max-w-md">
          <div className="h-20 w-20 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-6">
            <Check className="h-10 w-10 text-green-600" />
          </div>
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Interview Scheduled!</h2>
          <p className="text-gray-600 mb-6">
            Our screening assistant will call you at your scheduled time.
          </p>
          
          <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-6">
            <div className="flex items-center justify-center gap-2 text-green-700 font-medium">
              <Calendar className="h-5 w-5" />
              {scheduledDateTime.toLocaleString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
              })}
            </div>
          </div>

          {/* Add to Calendar */}
          <button
            onClick={handleAddToGoogleCalendar}
            className="w-full mb-4 py-3 px-4 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 flex items-center justify-center gap-2 text-gray-700"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Add to Google Calendar
          </button>

          <div className="text-sm text-gray-500 space-y-2">
            <p><strong>What happens next:</strong></p>
            <ol className="text-left pl-4 space-y-1">
              <li>1. You'll receive a confirmation email</li>
              <li>2. Our screening assistant will call you at the scheduled time</li>
              <li>3. The interview takes about 10-15 minutes</li>
              <li>4. You'll hear back within 2-3 business days</li>
            </ol>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 py-8 px-4">
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className="bg-white rounded-2xl shadow-xl overflow-hidden mb-6">
          <div className="bg-gradient-to-r from-green-600 to-emerald-600 px-6 py-8 text-white text-center">
            <div className="h-16 w-16 rounded-full bg-white/20 flex items-center justify-center mx-auto mb-4">
              <Phone className="h-8 w-8" />
            </div>
            <h1 className="text-2xl font-bold mb-2">Schedule Your Interview</h1>
            <p className="text-green-100">Pick any date and time that works for you</p>
          </div>

          <div className="p-6">
            {/* Interview Details */}
            <div className="bg-gray-50 rounded-xl p-4 mb-6">
              <div className="flex items-start gap-4">
                <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center text-green-600 font-bold">
                  <User className="h-6 w-6" />
                </div>
                <div>
                  <div className="font-medium text-gray-900">{interviewInfo?.applicantName}</div>
                  <div className="flex items-center gap-1 text-sm text-gray-500 mt-1">
                    <MapPin className="h-4 w-4" />
                    {interviewInfo?.propertyAddress}
                  </div>
                </div>
              </div>
            </div>

            {/* Screening assistant availability */}
            <div className="bg-gradient-to-r from-violet-50 to-purple-50 border border-violet-200 rounded-xl p-4 mb-6">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-violet-100 flex items-center justify-center">
                  <Sparkles className="h-5 w-5 text-violet-600" />
                </div>
                <div>
                  <div className="font-medium text-violet-800">Phone Interview Available</div>
                  <div className="text-sm text-violet-600">Interview scheduling is available 24/7, so pick any time that works for you.</div>
                </div>
              </div>
            </div>

            {/* Error Message */}
            {error && (
              <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
                {error}
              </div>
            )}

            {/* Date & Time Selection */}
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <Calendar className="h-4 w-4 inline mr-1" />
                  Select Date
                </label>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  min={getMinDate()}
                  max={getMaxDate()}
                  className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-green-500 text-lg"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <Clock className="h-4 w-4 inline mr-1" />
                  Select Time
                </label>
                <input
                  type="time"
                  value={selectedTime}
                  onChange={(e) => setSelectedTime(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-green-500 text-lg"
                />
                <p className="mt-2 text-xs text-gray-500">
                  Select a time in your local timezone. We recommend scheduling at least 1 hour from now.
                </p>
              </div>

              {/* Quick Time Options */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-2">Quick Select</label>
                <div className="flex flex-wrap gap-2">
                  {['09:00', '12:00', '14:00', '17:00', '19:00'].map((time) => (
                    <button
                      key={time}
                      onClick={() => setSelectedTime(time)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                        selectedTime === time
                          ? 'bg-green-600 text-white'
                          : 'bg-gray-100 text-gray-600 hover:bg-green-50 hover:text-green-700'
                      }`}
                    >
                      {new Date(`2000-01-01T${time}`).toLocaleTimeString('en-US', {
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true
                      })}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Book Button */}
        <button
          onClick={handleBook}
          disabled={!selectedDate || !selectedTime || booking}
          className={`w-full py-4 rounded-xl font-semibold text-lg transition-all ${
            !selectedDate || !selectedTime
              ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
              : booking
              ? 'bg-green-400 text-white cursor-wait'
              : 'bg-green-600 text-white hover:bg-green-700 shadow-lg hover:shadow-xl active:scale-[0.98]'
          }`}
        >
          {booking ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              Scheduling...
            </span>
          ) : selectedDate && selectedTime ? (
            `Schedule for ${new Date(`${selectedDate}T${selectedTime}`).toLocaleString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true
            })}`
          ) : (
            'Select Date & Time'
          )}
        </button>

        {/* Tips */}
        <div className="mt-6 bg-white rounded-xl p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-800 mb-2">📞 Interview Tips</h3>
          <ul className="text-xs text-gray-600 space-y-1">
            <li>• Find a quiet location with good phone reception</li>
            <li>• Have your employment and rental history details ready</li>
            <li>• The interview takes about 10-15 minutes</li>
            <li>• Be yourself - we just want to get to know you!</li>
          </ul>
        </div>

        {/* Alternative: Use Calendly */}
        {interviewInfo?.calendlyLink && (
          <div className="mt-4 text-center">
            <p className="text-sm text-gray-500 mb-2">Or schedule using:</p>
            <a
              href={interviewInfo.calendlyLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <Calendar className="h-4 w-4" />
              Book with Calendly
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
