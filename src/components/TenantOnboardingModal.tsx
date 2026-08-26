import React, { useState } from 'react';
import { X, Send, User, Mail, MapPin, Home, Calendar, Loader2, Check, Copy, ExternalLink } from 'lucide-react';
import { buildOwnerFinanceUrl } from '../services/ownerFinanceApi';

interface TenantOnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  propertyId: string;
  propertyAddress: string;
  ownerId: string;
  ownerName?: string;
  ownerEmail?: string;
}

interface InviteResult {
  ok: boolean;
  inviteLink?: string;
  emailSent?: boolean;
  expiresAt?: string;
  error?: string;
}

const TenantOnboardingModal: React.FC<TenantOnboardingModalProps> = ({
  isOpen,
  onClose,
  propertyId,
  propertyAddress,
  ownerId,
  ownerName = '',
  ownerEmail = ''
}) => {
  const [tenantName, setTenantName] = useState('');
  const [tenantEmail, setTenantEmail] = useState('');
  const [unit, setUnit] = useState('');
  const [leaseStart, setLeaseStart] = useState('');
  const [leaseEnd, setLeaseEnd] = useState('');
  const [monthlyRent, setMonthlyRent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<InviteResult | null>(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setResult(null);

    try {
      const response = await fetch(buildOwnerFinanceUrl('/api/tenants/invite'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerId,
          ownerName,
          ownerEmail,
          propertyId,
          propertyAddress,
          unit,
          tenantEmail,
          tenantName,
          leaseStart,
          leaseEnd,
          monthlyRent: monthlyRent ? parseFloat(monthlyRent) : undefined
        })
      });

      const data = await response.json();
      setResult(data);

      if (data.ok) {
        console.log('[TenantOnboarding] ✅ Invite sent successfully');
      }
    } catch (error) {
      console.error('[TenantOnboarding] Error:', error);
      setResult({ 
        ok: false, 
        error: error instanceof Error ? error.message : 'Failed to send invite' 
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleClose = () => {
    setTenantName('');
    setTenantEmail('');
    setUnit('');
    setLeaseStart('');
    setLeaseEnd('');
    setMonthlyRent('');
    setResult(null);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-purple-600 to-purple-700 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3 text-white">
            <div className="h-10 w-10 rounded-full bg-white/20 flex items-center justify-center">
              <User className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Onboard New Tenant</h2>
              <p className="text-purple-200 text-sm">Send a tenant portal invitation</p>
            </div>
          </div>
          <button 
            onClick={handleClose}
            className="text-white/80 hover:text-white transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto max-h-[calc(90vh-80px)]">
          {/* Property Info */}
          <div className="mb-6 p-4 bg-purple-50 rounded-xl border border-purple-100">
            <div className="flex items-start gap-3">
              <MapPin className="h-5 w-5 text-purple-600 mt-0.5" />
              <div>
                <div className="text-sm text-purple-600 font-medium">Property</div>
                <div className="text-gray-900">{propertyAddress}</div>
              </div>
            </div>
          </div>

          {result?.ok ? (
            /* Success State */
            <div className="space-y-6">
              <div className="text-center py-6">
                <div className="h-16 w-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                  <Check className="h-8 w-8 text-green-600" />
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-2">Invitation Sent!</h3>
                <p className="text-gray-600">
                  {result.emailSent 
                    ? `An email has been sent to ${tenantEmail}`
                    : 'The invite link was generated successfully'}
                </p>
              </div>

              {/* Invite Link */}
              <div className="bg-gray-50 rounded-xl p-4 space-y-3">
                <div className="text-sm font-medium text-gray-700">Invite Link</div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={result.inviteLink || ''}
                    className="flex-1 bg-white border rounded-lg px-3 py-2 text-sm font-mono text-gray-600"
                  />
                  <button
                    onClick={() => result.inviteLink && copyToClipboard(result.inviteLink)}
                    className="p-2 bg-white border rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    {copied ? (
                      <Check className="h-5 w-5 text-green-600" />
                    ) : (
                      <Copy className="h-5 w-5 text-gray-500" />
                    )}
                  </button>
                  <a
                    href={result.inviteLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2 bg-white border rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <ExternalLink className="h-5 w-5 text-gray-500" />
                  </a>
                </div>
                <p className="text-xs text-gray-500">
                  This link expires on {result.expiresAt ? new Date(result.expiresAt).toLocaleString() : '48 hours'}
                </p>
              </div>

              <button
                onClick={handleClose}
                className="w-full bg-purple-600 text-white py-3 rounded-xl font-medium hover:bg-purple-700 transition-colors"
              >
                Done
              </button>
            </div>
          ) : (
            /* Form */
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Error Message */}
              {result?.error && (
                <div className="p-4 bg-red-50 border border-red-100 rounded-xl text-red-700 text-sm">
                  {result.error}
                </div>
              )}

              {/* Tenant Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <User className="h-4 w-4 inline mr-2" />
                  Tenant Name *
                </label>
                <input
                  type="text"
                  required
                  value={tenantName}
                  onChange={(e) => setTenantName(e.target.value)}
                  placeholder="John Smith"
                  className="w-full border border-gray-300 rounded-xl px-4 py-3 focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-all"
                />
              </div>

              {/* Tenant Email */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <Mail className="h-4 w-4 inline mr-2" />
                  Tenant Email *
                </label>
                <input
                  type="email"
                  required
                  value={tenantEmail}
                  onChange={(e) => setTenantEmail(e.target.value)}
                  placeholder="tenant@email.com"
                  className="w-full border border-gray-300 rounded-xl px-4 py-3 focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-all"
                />
              </div>

              {/* Unit Number */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <Home className="h-4 w-4 inline mr-2" />
                  Unit Number (optional)
                </label>
                <input
                  type="text"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  placeholder="Apt 101"
                  className="w-full border border-gray-300 rounded-xl px-4 py-3 focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-all"
                />
              </div>

              {/* Lease Dates */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    <Calendar className="h-4 w-4 inline mr-2" />
                    Lease Start
                  </label>
                  <input
                    type="date"
                    value={leaseStart}
                    onChange={(e) => setLeaseStart(e.target.value)}
                    className="w-full border border-gray-300 rounded-xl px-4 py-3 focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-all"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Lease End
                  </label>
                  <input
                    type="date"
                    value={leaseEnd}
                    onChange={(e) => setLeaseEnd(e.target.value)}
                    className="w-full border border-gray-300 rounded-xl px-4 py-3 focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-all"
                  />
                </div>
              </div>

              {/* Monthly Rent */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Monthly Rent
                </label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                  <input
                    type="number"
                    value={monthlyRent}
                    onChange={(e) => setMonthlyRent(e.target.value)}
                    placeholder="2,500"
                    className="w-full border border-gray-300 rounded-xl pl-8 pr-4 py-3 focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-all"
                  />
                </div>
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                disabled={isSubmitting || !tenantName || !tenantEmail}
                className="w-full bg-gradient-to-r from-purple-600 to-purple-700 text-white py-3 rounded-xl font-medium hover:from-purple-700 hover:to-purple-800 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-purple-500/25"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Sending Invitation...
                  </>
                ) : (
                  <>
                    <Send className="h-5 w-5" />
                    Send Onboarding Invite
                  </>
                )}
              </button>

              <p className="text-xs text-gray-500 text-center">
                The tenant will receive an email with a link to create their HouseYield account, 
                which will be connected to this property.
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default TenantOnboardingModal;
