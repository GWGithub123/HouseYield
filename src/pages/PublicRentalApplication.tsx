import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

interface PublicApplicationInfo {
  token: string;
  ownerId: string;
  ownerName?: string;
  propertyId?: string;
  propertyAddress: string;
}

export default function PublicRentalApplication() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [application, setApplication] = useState<PublicApplicationInfo | null>(null);
  const [formData, setFormData] = useState({
    applicantName: '',
    applicantEmail: '',
    applicantPhone: ''
  });

  useEffect(() => {
    async function loadApplication() {
      if (!token) {
        setError('Invalid application link.');
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(`/api/applications/public/${token}`);
        const data = await response.json();
        if (!data.ok) {
          setError(data.error || 'This application link is no longer available.');
        } else {
          setApplication(data.application);
        }
      } catch (_err) {
        setError('Unable to load the application link right now.');
      } finally {
        setLoading(false);
      }
    }

    loadApplication();
  }, [token]);

  const handleStartApplication = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!token) return;

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/applications/public/${token}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      const data = await response.json();
      if (!data.ok) {
        setError(data.error || 'Unable to start your application.');
        return;
      }
      navigate(`/screening/${data.screeningToken}`);
    } catch (_err) {
      setError('Unable to start your application right now.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-indigo-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading application details...</p>
        </div>
      </div>
    );
  }

  if (error && !application) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-indigo-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md text-center">
          <div className="h-16 w-16 rounded-full bg-rose-100 flex items-center justify-center mx-auto mb-4">
            <svg className="h-8 w-8 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M4.93 19h14.14c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.2 16c-.77 1.33.19 3 1.73 3z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-800 mb-2">Application Link Error</h1>
          <p className="text-gray-600">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-indigo-50">
      <header className="border-b bg-white/80 backdrop-blur-sm">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-purple-600 to-indigo-600 flex items-center justify-center">
              <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 3.75A2.25 2.25 0 019.25 1.5h4.19c.597 0 1.169.237 1.591.659l2.81 2.81c.422.422.659.994.659 1.591v11.19A2.25 2.25 0 0116.25 21h-7.5A2.25 2.25 0 016.5 18.75v-15z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.25 1.875V6a.75.75 0 00.75.75h4.125M9.75 11.25h4.5M9.75 14.25h4.5M9.75 17.25h3" />
              </svg>
            </div>
            <div>
              <h1 className="font-semibold text-gray-800">Rental Application</h1>
              <p className="text-xs text-gray-500">Start your screening and phone interview workflow</p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8">
        <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
          <div className="flex items-start gap-4">
            <div className="h-12 w-12 rounded-lg bg-purple-100 flex items-center justify-center">
              <svg className="h-6 w-6 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
            </div>
            <div className="flex-1">
              <h2 className="font-semibold text-gray-800">Apply for this rental</h2>
              <p className="text-sm text-gray-600 mt-1">{application?.propertyAddress}</p>
              <p className="text-xs text-gray-500 mt-2">
                Enter your contact information to begin the application, screening, and phone interview steps.
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={handleStartApplication} className="bg-white rounded-xl shadow-sm border p-6 space-y-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-800 mb-1">Your Information</h3>
            <p className="text-sm text-gray-500 mb-6">We will use this to create your secure application and interview link.</p>
          </div>

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
            <input
              type="text"
              required
              value={formData.applicantName}
              onChange={(event) => setFormData(prev => ({ ...prev, applicantName: event.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              placeholder="Jane Smith"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email Address</label>
            <input
              type="email"
              required
              value={formData.applicantEmail}
              onChange={(event) => setFormData(prev => ({ ...prev, applicantEmail: event.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
            <input
              type="tel"
              required
              value={formData.applicantPhone}
              onChange={(event) => setFormData(prev => ({ ...prev, applicantPhone: event.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              placeholder="(555) 123-4567"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-purple-600 text-white py-3 text-sm font-medium hover:bg-purple-700 disabled:opacity-50"
          >
            {submitting ? 'Starting Application...' : 'Continue to Secure Application'}
          </button>
        </form>
      </main>
    </div>
  );
}