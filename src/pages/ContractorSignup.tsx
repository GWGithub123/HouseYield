import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

interface DunsData {
  dunsNumber: string;
  registeredName: string;
  primaryAddress: {
    streetAddress?: string;
    city?: string;
    state?: string;
    postalCode?: string;
  };
  operatingStatus?: string;
  employeeCount?: number | null;
  sicCodes?: string[];
}

export default function ContractorSignup() {
  const navigate = useNavigate();
  const { signup } = useAuth();

  // Multi-step form state
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1 — Account Info
  const [formData, setFormData] = useState({
    companyName: '',
    contactName: '',
    email: '',
    password: '',
    confirmPassword: '',
    phone: '',
    licenseNumber: '',
    zipCode: '',
    serviceRadius: '50',
    specialties: [] as string[],
    yearsInBusiness: ''
  });

  // Step 2 — DUNS Verification
  const [dunsInput, setDunsInput] = useState('');
  const [dunsVerifying, setDunsVerifying] = useState(false);
  const [dunsVerified, setDunsVerified] = useState(false);
  const [dunsData, setDunsData] = useState<DunsData | null>(null);
  const [dunsError, setDunsError] = useState<string | null>(null);

  const specialtyOptions = [
    'Bathroom Renovation',
    'Kitchen Renovation',
    'Flooring',
    'Painting',
    'Electrical',
    'Plumbing',
    'Roofing',
    'HVAC',
    'Landscaping',
    'General Renovation'
  ];

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const toggleSpecialty = (specialty: string) => {
    setFormData(prev => ({
      ...prev,
      specialties: prev.specialties.includes(specialty)
        ? prev.specialties.filter(s => s !== specialty)
        : [...prev.specialties, specialty]
    }));
  };

  const validateStep1 = () => {
    if (!formData.companyName || !formData.contactName || !formData.email) {
      setError('Please fill in Company Name, Contact Name, and Email.');
      return false;
    }
    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match.');
      return false;
    }
    if (formData.password.length < 6) {
      setError('Password must be at least 6 characters.');
      return false;
    }
    return true;
  };

  const handleStep1Next = () => {
    setError(null);
    if (validateStep1()) setStep(2);
  };

  const formatDuns = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 9);
    return digits.replace(/(\d{3})(\d{0,3})(\d{0,3})/, (_: string, a: string, b: string, c: string) =>
      [a, b, c].filter(Boolean).join('-')
    );
  };

  const verifyDUNS = async () => {
    setDunsVerifying(true);
    setDunsError(null);
    try {
      const resp = await fetch('/api/duns/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dunsNumber: dunsInput })
      });
      const data = await resp.json();
      if (data.success) {
        setDunsVerified(true);
        setDunsData(data.data);
        // Pre-fill company name if blank
        if (!formData.companyName && data.data.registeredName) {
          setFormData(prev => ({ ...prev, companyName: data.data.registeredName }));
        }
      } else {
        setDunsError(data.error || 'Verification failed. Please check the number and try again.');
      }
    } catch {
      setDunsError('Network error. Please check your connection and try again.');
    } finally {
      setDunsVerifying(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (formData.specialties.length === 0) {
      setError('Please select at least one specialty.');
      return;
    }
    if (!formData.phone || !formData.zipCode || !formData.yearsInBusiness) {
      setError('Please fill in all required fields.');
      return;
    }

    setLoading(true);
    try {
      await signup(formData.email, formData.password, 'contractor', {
        name: formData.contactName,
        companyName: formData.companyName,
        phone: formData.phone,
        licenseNumber: formData.licenseNumber,
        serviceArea: formData.zipCode,
        specialties: formData.specialties,
        yearsInBusiness: parseInt(formData.yearsInBusiness) || 0,
        // DUNS fields
        dunsNumber: dunsVerified ? dunsInput.replace(/\D/g, '') : '',
        dunsVerified,
        dunsData: dunsVerified ? dunsData : null,
        // Location
        zipCode: formData.zipCode,
        serviceRadius: parseInt(formData.serviceRadius) || 50
      } as any);

      navigate('/contractor/marketplace');
    } catch (err: any) {
      let msg = err.message || 'Registration failed. Please try again.';
      if (msg.includes('auth/email-already-in-use')) msg = 'This email is already registered. Please log in instead.';
      else if (msg.includes('auth/weak-password')) msg = 'Password is too weak. Please use a stronger password.';
      else if (msg.includes('auth/invalid-email')) msg = 'Please enter a valid email address.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const stepLabels = ['Account Info', 'Verify Business', 'Service Details'];
  const dunsDigits = dunsInput.replace(/\D/g, '');

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-50 via-white to-teal-50 flex items-center justify-center p-4">
      <div className="max-w-lg w-full">
        {/* Back Button */}
        <button
          onClick={() => navigate('/login/contractor')}
          className="mb-6 flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to login
        </button>

        <div className="bg-white rounded-2xl shadow-xl p-8">
          {/* Header */}
          <div className="text-center mb-6">
            <div className="w-14 h-14 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <svg className="w-7 h-7 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Register Your Business</h2>
            <p className="text-gray-500 text-sm mt-1">Join our contractor marketplace</p>
          </div>

          {/* Step Indicator */}
          <div className="mb-7">
            <div className="flex items-center">
              {[1, 2, 3].map((n) => (
                <div key={n} className="flex items-center flex-1 last:flex-none">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 transition-colors ${
                    step > n ? 'bg-emerald-600 text-white' :
                    step === n ? 'bg-emerald-600 text-white ring-4 ring-emerald-100' :
                    'bg-gray-200 text-gray-500'
                  }`}>
                    {step > n ? (
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    ) : n}
                  </div>
                  {n < 3 && (
                    <div className={`flex-1 h-0.5 mx-2 transition-colors ${step > n ? 'bg-emerald-600' : 'bg-gray-200'}`} />
                  )}
                </div>
              ))}
            </div>
            <div className="flex justify-between mt-2">
              {stepLabels.map((label, i) => (
                <span key={i} className={`text-xs font-medium ${step === i + 1 ? 'text-emerald-600' : 'text-gray-400'}`}>
                  {label}
                </span>
              ))}
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-5 bg-red-50 border border-red-200 rounded-lg p-3 flex gap-2">
              <svg className="w-5 h-5 text-red-500 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
              <p className="text-red-700 text-sm">{error}</p>
            </div>
          )}

          {/* ─── Step 1: Account Info ─── */}
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Company Name *</label>
                <input name="companyName" type="text" required value={formData.companyName} onChange={handleChange}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  placeholder="Your Business Name" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Contact Name *</label>
                <input name="contactName" type="text" required value={formData.contactName} onChange={handleChange}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  placeholder="Your Full Name" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
                <input name="email" type="email" required value={formData.email} onChange={handleChange}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  placeholder="email@company.com" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Password *</label>
                <input name="password" type="password" required value={formData.password} onChange={handleChange}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  placeholder="At least 6 characters" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Confirm Password *</label>
                <input name="confirmPassword" type="password" required value={formData.confirmPassword} onChange={handleChange}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  placeholder="Re-enter your password" />
              </div>
              <button type="button" onClick={handleStep1Next}
                className="w-full py-3 bg-emerald-600 text-white rounded-lg font-semibold hover:bg-emerald-700 transition-colors">
                Continue
              </button>
            </div>
          )}

          {/* ─── Step 2: DUNS Verification ─── */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <div className="flex gap-3">
                  <svg className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  <div>
                    <p className="text-sm font-medium text-blue-900">D&B Business Verification</p>
                    <p className="text-sm text-blue-700 mt-0.5">
                      Enter your 9-digit D-U-N-S number to verify your business with Dun & Bradstreet.
                      Verified businesses earn a trust badge on the marketplace. You may skip this step.
                    </p>
                  </div>
                </div>
              </div>

              {/* DUNS Input */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">D-U-N-S Number</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={dunsInput}
                    onChange={e => {
                      const formatted = formatDuns(e.target.value);
                      setDunsInput(formatted);
                      setDunsVerified(false);
                      setDunsData(null);
                      setDunsError(null);
                    }}
                    placeholder="123-456-789"
                    className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
                    maxLength={11}
                  />
                  <button
                    type="button"
                    onClick={verifyDUNS}
                    disabled={dunsDigits.length !== 9 || dunsVerifying}
                    className="px-5 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                  >
                    {dunsVerifying ? (
                      <span className="flex items-center gap-2">
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Verifying
                      </span>
                    ) : 'Verify'}
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-1">Format: 123-456-789  •  Find yours at dnb.com/duns-number/lookup.html</p>
              </div>

              {/* Verified state */}
              {dunsVerified && dunsData && (
                <div className="bg-emerald-50 border border-emerald-300 rounded-xl p-4">
                  <div className="flex items-center gap-2 text-emerald-700 font-semibold mb-1.5">
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    Business Verified
                  </div>
                  <p className="font-medium text-gray-900">{dunsData.registeredName}</p>
                  {(dunsData.primaryAddress.city || dunsData.primaryAddress.state) && (
                    <p className="text-sm text-gray-600 mt-0.5">
                      {[dunsData.primaryAddress.city, dunsData.primaryAddress.state].filter(Boolean).join(', ')}
                      {dunsData.operatingStatus && ` • ${dunsData.operatingStatus}`}
                    </p>
                  )}
                  {dunsData.employeeCount && (
                    <p className="text-sm text-gray-500">{dunsData.employeeCount.toLocaleString()} employees</p>
                  )}
                </div>
              )}

              {/* DUNS error */}
              {dunsError && !dunsVerifying && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                  {dunsError}
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => { setStep(1); setError(null); }}
                  className="flex-1 py-3 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 transition-colors">
                  Back
                </button>
                <button type="button" onClick={() => { setError(null); setStep(3); }}
                  className={`flex-1 py-3 rounded-lg font-semibold transition-colors ${
                    dunsVerified
                      ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                      : 'border border-gray-300 text-gray-600 hover:bg-gray-50'
                  }`}>
                  {dunsVerified ? 'Continue' : 'Skip — No DUNS'}
                </button>
              </div>
            </div>
          )}

          {/* ─── Step 3: Service Details ─── */}
          {step === 3 && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Phone *</label>
                  <input name="phone" type="tel" required value={formData.phone} onChange={handleChange}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                    placeholder="(555) 123-4567" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">License Number</label>
                  <input name="licenseNumber" type="text" value={formData.licenseNumber} onChange={handleChange}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                    placeholder="Optional" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Base ZIP Code *</label>
                  <input name="zipCode" type="text" required value={formData.zipCode} onChange={handleChange}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                    placeholder="20001" maxLength={5} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Service Radius *</label>
                  <select name="serviceRadius" value={formData.serviceRadius} onChange={handleChange}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500">
                    <option value="10">10 miles</option>
                    <option value="25">25 miles</option>
                    <option value="50">50 miles</option>
                    <option value="100">100 miles</option>
                    <option value="200">200 miles</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Years in Business *</label>
                <input name="yearsInBusiness" type="number" required min="0" value={formData.yearsInBusiness} onChange={handleChange}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  placeholder="5" />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Specialties * <span className="text-gray-400 font-normal">(select all that apply)</span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {specialtyOptions.map(specialty => (
                    <button key={specialty} type="button" onClick={() => toggleSpecialty(specialty)}
                      className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${
                        formData.specialties.includes(specialty)
                          ? 'bg-emerald-100 border-emerald-500 text-emerald-700'
                          : 'bg-gray-50 border-gray-300 text-gray-600 hover:border-gray-400'
                      }`}>
                      {specialty}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => { setStep(2); setError(null); }}
                  className="px-6 py-3 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 transition-colors">
                  Back
                </button>
                <button type="submit" disabled={loading}
                  className="flex-1 py-3 bg-emerald-600 text-white rounded-lg font-semibold hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2">
                  {loading ? (
                    <>
                      <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Creating Account...
                    </>
                  ) : (
                    <>
                      {dunsVerified && (
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                      )}
                      Create{dunsVerified ? ' Verified' : ''} Account
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {/* Login Link */}
          <p className="text-center text-gray-500 mt-6 text-sm">
            Already have an account?{' '}
            <Link to="/login/contractor" className="text-emerald-600 hover:text-emerald-700 font-semibold">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
