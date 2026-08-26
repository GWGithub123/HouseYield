import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { loadStripe } from '@stripe/stripe-js';

// Initialize Stripe
const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || 'pk_live_51SJJpV2QCUnZJrphFoYhTZpW3FKdNGD2WCwSLiCd5WnnGJAJABT0u2lYfQyv5Wj1aRuGEqLAhNz5qL7aSFX5amUg00Uo0IqMrW');

interface ScreeningRequest {
  applicantName: string;
  applicantEmail: string;
  propertyAddress: string;
  ownerName: string;
  expiresAt: string;
}

interface InterviewFlow {
  interviewId: string;
  bookingToken: string;
  bookingLink: string;
  status: string;
}

export default function ApplicantScreening() {
  const { token } = useParams<{ token: string }>();
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<ScreeningRequest | null>(null);
  
  // Form state
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    ssn: '',
    confirmSsn: '',
    dateOfBirth: '',
    street: '',
    city: '',
    state: '',
    zipCode: ''
  });
  const [submitting, setSubmitting] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_submitted, setSubmitted] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [interviewFlow, setInterviewFlow] = useState<InterviewFlow | null>(null);
  const [startingInterviewNow, setStartingInterviewNow] = useState(false);
  const [interviewStatusMessage, setInterviewStatusMessage] = useState<string | null>(null);
  
  // Load screening request details
  useEffect(() => {
    async function loadRequest() {
      if (!token) {
        setError('Invalid screening link');
        setLoading(false);
        return;
      }
      
      try {
        const response = await fetch(`/api/screening/${token}`);
        const data = await response.json();
        
        if (!data.ok) {
          setError(data.error || 'This screening request is no longer valid');
        } else {
          setRequest(data.request);
        }
      } catch (err) {
        setError('Unable to load screening request');
      } finally {
        setLoading(false);
      }
    }
    
    loadRequest();
  }, [token]);
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (formData.ssn !== formData.confirmSsn) {
      alert('SSN entries do not match');
      return;
    }
    
    if (!consentChecked) {
      alert('Please consent to the background and credit check');
      return;
    }
    
    setSubmitting(true);
    
    try {
      const response = await fetch(`/api/screening/${token}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: formData.firstName,
          lastName: formData.lastName,
          phone: formData.phone,
          ssn: formData.ssn,
          dateOfBirth: formData.dateOfBirth,
          address: {
            street: formData.street,
            city: formData.city,
            state: formData.state,
            zipCode: formData.zipCode
          }
        })
      });
      
      const data = await response.json();
      
      if (data.ok) {
        setSubmitted(true);
        setInterviewFlow(data.interview || null);
        setStep(3);
      } else {
        alert(data.error || 'Failed to submit application');
      }
    } catch (err) {
      alert('Network error - please try again');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartInterviewNow = async () => {
    if (!interviewFlow?.bookingToken) return;
    setStartingInterviewNow(true);
    setInterviewStatusMessage(null);
    try {
      const response = await fetch('/api/interviews/book-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingToken: interviewFlow.bookingToken })
      });
      const data = await response.json();
      if (data.ok) {
        setInterviewStatusMessage('Your phone interview is starting now. Please keep your phone nearby and ready to answer.');
      } else {
        setInterviewStatusMessage(data.error || 'We could not start the phone interview right now. Please schedule a time instead.');
      }
    } catch (_err) {
      setInterviewStatusMessage('We could not start the phone interview right now. Please schedule a time instead.');
    } finally {
      setStartingInterviewNow(false);
    }
  };
  
  const [connectingBank, setConnectingBank] = useState(false);
  
  const handleStartIncomeVerification = async () => {
    // Start Stripe Financial Connections flow
    setConnectingBank(true);
    try {
      const response = await fetch('/api/stripe-connect/create-financial-connections-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: `screening-${token}`
        })
      });
      
      const data = await response.json();
      
      if (data.ok && data.clientSecret) {
        // Load Stripe and collect bank account
        const stripe = await stripePromise;
        if (!stripe) {
          alert('Failed to load Stripe');
          return;
        }
        
        // Use Stripe Financial Connections to collect bank account
        const { financialConnectionsSession, error } = await stripe.collectFinancialConnectionsAccounts({
          clientSecret: data.clientSecret,
        });
        
        if (error) {
          console.error('Financial Connections error:', error);
          alert(error.message || 'Failed to connect bank account');
        } else if (financialConnectionsSession) {
          console.log('Bank accounts connected:', financialConnectionsSession.accounts);
          alert(`Successfully connected ${financialConnectionsSession.accounts?.length || 0} bank account(s)! Your income verification is complete.`);
          
          // Notify backend that income verification is complete
          await fetch(`/api/screening/${token}/income-verified`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: data.sessionId,
              accounts: financialConnectionsSession.accounts
            })
          });
        }
      } else {
        alert(data.error || 'Unable to start income verification - please try again');
      }
    } catch (err) {
      console.error('Income verification error:', err);
      alert('Network error - please try again');
    } finally {
      setConnectingBank(false);
    }
  };
  
  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-indigo-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading screening request...</p>
        </div>
      </div>
    );
  }
  
  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-indigo-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md text-center">
          <div className="h-16 w-16 rounded-full bg-rose-100 flex items-center justify-center mx-auto mb-4">
            <svg className="h-8 w-8 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-800 mb-2">Screening Link Error</h1>
          <p className="text-gray-600 mb-6">{error}</p>
          <p className="text-sm text-gray-500">
            Please contact the property owner for a new screening link.
          </p>
        </div>
      </div>
    );
  }
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-indigo-50">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-purple-600 to-indigo-600 flex items-center justify-center">
              <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <div>
              <h1 className="font-semibold text-gray-800">Tenant Screening</h1>
              <p className="text-xs text-gray-500">Powered by Equifax & Stripe</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-emerald-600" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            <span className="text-xs text-gray-500">256-bit encrypted</span>
          </div>
        </div>
      </header>
      
      <main className="max-w-3xl mx-auto px-4 py-8">
        {/* Property Info Card */}
        <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
          <div className="flex items-start gap-4">
            <div className="h-12 w-12 rounded-lg bg-purple-100 flex items-center justify-center">
              <svg className="h-6 w-6 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
            </div>
            <div className="flex-1">
              <h2 className="font-semibold text-gray-800">Rental Application</h2>
              <p className="text-sm text-gray-600 mt-1">{request?.propertyAddress || 'Property Address'}</p>
              <p className="text-xs text-gray-500 mt-2">
                Hello {request?.applicantName}, please complete this application to proceed with your rental.
              </p>
            </div>
          </div>
        </div>
        
        {/* Progress Steps */}
        <div className="flex items-center justify-center mb-8">
          <div className="flex items-center gap-2">
            <div className={`flex items-center justify-center h-8 w-8 rounded-full ${step >= 1 ? 'bg-purple-600 text-white' : 'bg-gray-200 text-gray-500'}`}>
              1
            </div>
            <div className={`h-1 w-16 ${step >= 2 ? 'bg-purple-600' : 'bg-gray-200'}`}></div>
            <div className={`flex items-center justify-center h-8 w-8 rounded-full ${step >= 2 ? 'bg-purple-600 text-white' : 'bg-gray-200 text-gray-500'}`}>
              2
            </div>
            <div className={`h-1 w-16 ${step >= 3 ? 'bg-purple-600' : 'bg-gray-200'}`}></div>
            <div className={`flex items-center justify-center h-8 w-8 rounded-full ${step >= 3 ? 'bg-purple-600 text-white' : 'bg-gray-200 text-gray-500'}`}>
              3
            </div>
          </div>
        </div>
        <div className="flex justify-center mb-8 text-xs text-gray-500">
          <span className={`px-4 ${step === 1 ? 'font-semibold text-purple-600' : ''}`}>Personal Info</span>
          <span className={`px-4 ${step === 2 ? 'font-semibold text-purple-600' : ''}`}>Address & Consent</span>
          <span className={`px-4 ${step === 3 ? 'font-semibold text-purple-600' : ''}`}>Phone Interview & Income</span>
        </div>
        
        {/* Step 1: Personal Info */}
        {step === 1 && (
          <div className="bg-white rounded-xl shadow-sm border p-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-1">Personal Information</h3>
            <p className="text-sm text-gray-500 mb-6">This information is required for your credit and background check.</p>
            
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">First Name</label>
                  <input
                    type="text"
                    required
                    value={formData.firstName}
                    onChange={(e) => setFormData(prev => ({...prev, firstName: e.target.value}))}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    placeholder="John"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Last Name</label>
                  <input
                    type="text"
                    required
                    value={formData.lastName}
                    onChange={(e) => setFormData(prev => ({...prev, lastName: e.target.value}))}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    placeholder="Smith"
                  />
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Date of Birth</label>
                <input
                  type="date"
                  required
                  value={formData.dateOfBirth}
                  onChange={(e) => setFormData(prev => ({...prev, dateOfBirth: e.target.value}))}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
                <input
                  type="tel"
                  required
                  value={formData.phone}
                  onChange={(e) => setFormData(prev => ({...prev, phone: e.target.value}))}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  placeholder="(555) 123-4567"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Social Security Number
                  <span className="ml-2 text-xs text-gray-400 font-normal">(encrypted & secure)</span>
                </label>
                <input
                  type="password"
                  required
                  pattern="\d{9}"
                  maxLength={9}
                  value={formData.ssn}
                  onChange={(e) => setFormData(prev => ({...prev, ssn: e.target.value.replace(/\D/g, '').slice(0, 9)}))}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  placeholder="•••••••••"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Confirm SSN</label>
                <input
                  type="password"
                  required
                  pattern="\d{9}"
                  maxLength={9}
                  value={formData.confirmSsn}
                  onChange={(e) => setFormData(prev => ({...prev, confirmSsn: e.target.value.replace(/\D/g, '').slice(0, 9)}))}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  placeholder="•••••••••"
                />
                {formData.confirmSsn && formData.ssn !== formData.confirmSsn && (
                  <p className="text-xs text-rose-600 mt-1">SSN entries do not match</p>
                )}
              </div>
              
              <div className="pt-4">
                <button
                  onClick={() => {
                    if (!formData.firstName || !formData.lastName || !formData.phone || !formData.dateOfBirth || !formData.ssn || formData.ssn.length !== 9) {
                      alert('Please fill out all fields');
                      return;
                    }
                    if (formData.ssn !== formData.confirmSsn) {
                      alert('SSN entries do not match');
                      return;
                    }
                    setStep(2);
                  }}
                  className="w-full rounded-lg bg-purple-600 text-white py-3 text-sm font-medium hover:bg-purple-700"
                >
                  Continue to Address
                </button>
              </div>
            </div>
          </div>
        )}
        
        {/* Step 2: Address & Consent */}
        {step === 2 && (
          <form onSubmit={handleSubmit}>
            <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
              <h3 className="text-lg font-semibold text-gray-800 mb-1">Current Address</h3>
              <p className="text-sm text-gray-500 mb-6">Your current residential address for the background check.</p>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Street Address</label>
                  <input
                    type="text"
                    required
                    value={formData.street}
                    onChange={(e) => setFormData(prev => ({...prev, street: e.target.value}))}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    placeholder="123 Main Street"
                  />
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
                    <input
                      type="text"
                      required
                      value={formData.city}
                      onChange={(e) => setFormData(prev => ({...prev, city: e.target.value}))}
                      className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                      placeholder="Atlanta"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
                    <select
                      required
                      value={formData.state}
                      onChange={(e) => setFormData(prev => ({...prev, state: e.target.value}))}
                      className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    >
                      <option value="">Select...</option>
                      {['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'].map(state => (
                        <option key={state} value={state}>{state}</option>
                      ))}
                    </select>
                  </div>
                </div>
                
                <div className="w-1/2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">ZIP Code</label>
                  <input
                    type="text"
                    required
                    pattern="\d{5}"
                    maxLength={5}
                    value={formData.zipCode}
                    onChange={(e) => setFormData(prev => ({...prev, zipCode: e.target.value.replace(/\D/g, '').slice(0, 5)}))}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    placeholder="30301"
                  />
                </div>
              </div>
            </div>
            
            {/* Consent Section */}
            <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
              <h3 className="text-lg font-semibold text-gray-800 mb-1">Authorization & Consent</h3>
              <p className="text-sm text-gray-500 mb-4">Please review and consent to the following:</p>
              
              <div className="rounded-lg bg-gray-50 border p-4 mb-4 text-xs text-gray-600 max-h-40 overflow-y-auto">
                <p className="mb-2"><strong>Consumer Credit Report Authorization</strong></p>
                <p className="mb-2">
                  By checking the box below, I authorize the property owner/manager to obtain a consumer credit report and/or 
                  investigative consumer report about me from Equifax or any other consumer reporting agency. This report may 
                  include information about my credit history, criminal background, eviction history, and other relevant information.
                </p>
                <p className="mb-2"><strong>Fair Credit Reporting Act Disclosure</strong></p>
                <p>
                  Under the Fair Credit Reporting Act, you have the right to receive a copy of your consumer report and dispute 
                  any inaccurate information. If adverse action is taken based on the report, you will be notified of your rights.
                </p>
              </div>
              
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={consentChecked}
                  onChange={(e) => setConsentChecked(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                />
                <span className="text-sm text-gray-700">
                  I authorize the credit and background check described above and certify that all information provided is accurate.
                </span>
              </label>
            </div>
            
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="rounded-lg border px-6 py-3 text-sm font-medium hover:bg-gray-50"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={submitting || !consentChecked}
                className="flex-1 rounded-lg bg-purple-600 text-white py-3 text-sm font-medium hover:bg-purple-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                    Submitting...
                  </>
                ) : (
                  'Submit & Continue'
                )}
              </button>
            </div>
          </form>
        )}
        
        {/* Step 3: Phone Interview + Income Verification */}
        {step === 3 && (
          <div className="bg-white rounded-xl shadow-sm border p-6">
            <div className="text-center mb-6">
              <div className="h-16 w-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
                <svg className="h-8 w-8 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-gray-800 mb-1">Information Submitted!</h3>
              <p className="text-sm text-gray-500">Your credit and background check has been initiated.</p>
            </div>
            
            <div className="border-t pt-6">
              <h4 className="font-semibold text-gray-800 mb-2">Phone Interview</h4>
              <p className="text-sm text-gray-600 mb-4">
                As part of the application review, we also complete a short phone interview. You can do that now or book a time that works better for you.
              </p>

              {interviewStatusMessage && (
                <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-700">
                  {interviewStatusMessage}
                </div>
              )}

              {interviewFlow ? (
                <div className="rounded-lg border border-violet-200 bg-violet-50 p-4 mb-6">
                  <div className="flex items-start gap-3 mb-4">
                    <div className="h-10 w-10 rounded-lg bg-white flex items-center justify-center shadow-sm">
                      <svg className="h-5 w-5 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a2 2 0 011.895 1.368l1.498 4.493a2 2 0 01-.502 2.07l-2.257 2.257a16.001 16.001 0 006.586 6.586l2.257-2.257a2 2 0 012.07-.502l4.493 1.498A2 2 0 0121 18.72V22a2 2 0 01-2 2h-1C9.163 24 0 14.837 0 4V3a2 2 0 012-2h1z" />
                      </svg>
                    </div>
                    <div>
                      <div className="font-semibold text-violet-900">Choose how you want to complete the call</div>
                      <div className="text-sm text-violet-700 mt-1">If you prefer, you can finish income verification below and come back to the interview later.</div>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <button
                      onClick={handleStartInterviewNow}
                      disabled={startingInterviewNow}
                      className="rounded-lg bg-violet-600 text-white py-3 text-sm font-medium hover:bg-violet-700 disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {startingInterviewNow ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                          Starting Call...
                        </>
                      ) : (
                        'Call Me Now'
                      )}
                    </button>

                    <button
                      onClick={() => window.location.href = interviewFlow.bookingLink}
                      className="rounded-lg border border-violet-200 bg-white text-violet-700 py-3 text-sm font-medium hover:bg-violet-100"
                    >
                      Schedule for Later
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                  The phone interview will be scheduled shortly after your application is reviewed.
                </div>
              )}

              <h4 className="font-semibold text-gray-800 mb-2">Income Verification (Optional)</h4>
              <p className="text-sm text-gray-600 mb-4">
                Connect your bank account via Stripe to instantly verify your income. This can speed up your application approval.
              </p>
              
              <div className="rounded-lg bg-gradient-to-br from-emerald-50 to-emerald-100 border border-emerald-200 p-4 mb-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="h-10 w-10 rounded-lg bg-white flex items-center justify-center shadow-sm">
                    <svg className="h-6 w-6 text-emerald-600" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.591-7.305z"/>
                    </svg>
                  </div>
                  <div>
                    <div className="font-semibold text-emerald-800">Stripe Financial Connections</div>
                    <div className="text-xs text-emerald-700">Bank-level security • Read-only access</div>
                  </div>
                </div>
                <ul className="text-xs text-emerald-700 space-y-1 mb-4">
                  <li className="flex items-center gap-2">
                    <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    Instantly verify income from deposit history
                  </li>
                  <li className="flex items-center gap-2">
                    <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    No pay stubs or tax returns needed
                  </li>
                  <li className="flex items-center gap-2">
                    <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    256-bit encryption • FDIC compliant
                  </li>
                </ul>
                <button
                  onClick={handleStartIncomeVerification}
                  disabled={connectingBank}
                  className="w-full rounded-lg bg-emerald-600 text-white py-3 text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {connectingBank ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                      Connecting...
                    </>
                  ) : (
                    <>
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                      </svg>
                      Connect Bank Account
                    </>
                  )}
                </button>
              </div>
              
              <div className="text-center">
                <button
                  onClick={() => window.close()}
                  className="text-sm text-gray-500 hover:text-gray-700"
                >
                  Skip for now - I'll provide income documents later
                </button>
              </div>
            </div>
          </div>
        )}
        
        {/* Security Footer */}
        <div className="mt-8 text-center">
          <div className="flex items-center justify-center gap-4 text-xs text-gray-400">
            <span className="flex items-center gap-1">
              <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
              </svg>
              SSL Encrypted
            </span>
            <span>•</span>
            <span>Powered by Equifax</span>
            <span>•</span>
            <span>Stripe Financial Connections</span>
          </div>
        </div>
      </main>
    </div>
  );
}
