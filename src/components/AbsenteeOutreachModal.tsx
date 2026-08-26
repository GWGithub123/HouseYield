/**
 * Absentee Owner Outreach Modal
 * 
 * A comprehensive modal for generating and sending AI-powered outreach emails
 * to absentee property owners. Features:
 * - Contact information lookup
 * - AI-generated personalized emails
 * - Offer amount input
 * - Custom questions
 * - Email preview and editing
 * - Direct sending via Gmail
 */

import { useState, useEffect, useCallback } from 'react';
import {
  X,
  Mail,
  Phone,
  User,
  Building2,
  DollarSign,
  Send,
  Loader2,
  Sparkles,
  Copy,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Search,
  Edit3,
  Zap,
  FileText
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getUserPreference, setUserPreference } from '../services/userPreferencesService';
import InsurancePremiumEstimatorCard from './insurance/InsurancePremiumEstimatorCard';
import { authenticatedFetch } from '../utils/authenticatedFetch';
import { getOpsBackendUrl } from '../utils/opsBackendUrl';

const BACKEND_URL = getOpsBackendUrl();
const BUYER_INFO_STORAGE_KEY = 'absentee_buyer_info';
const DEFAULT_BUYER_INFO: BuyerInfo = {
  name: '',
  company: '',
  phone: '',
  email: '',
  investmentStyle: 'Buy and Hold',
  paymentMethod: 'Cash',
};

interface AbsenteeOwner {
  name: string;
  name2?: string | null;
  isCorporate: boolean;
  mailingAddress: string;
  mailingCity?: string;
  mailingState?: string;
  mailingZip?: string;
}

interface AbsenteeLead {
  attomId?: string;
  address: string;
  streetAddress?: string;
  city: string;
  state: string;
  zipCode: string;
  propertyType: string;
  beds: number;
  baths: number;
  sqft: number;
  lotSizeAcres?: number;
  yearBuilt: number;
  assessedValue: number;
  marketValue: number;
  owner: AbsenteeOwner;
  ownershipYears: number;
  likelyFreeAndClear: boolean;
  motivationScore: number;
  motivationFactors: string[];
  insuranceEstimate?: import('../types/iot').InsurancePremiumEstimate;
  dbId?: number;
  rentalConfidence?: number;
  rentalConfidenceLabel?: string;
  rentalSignals?: string[];
  rentEstimate?: number | null;
  grossYield?: number | null;
  leakRiskScore?: number;
  leakRiskLabel?: string;
  leakRiskSignals?: string[];
  protectionLeadScore?: number;
}

interface ContactInfo {
  email: string | null;
  phone: string | null;
  emailConfidence: string;
  phoneConfidence: string;
  overallConfidence: string;
  sources: Array<{ type: string; source?: string }>;
}

interface BuyerInfo {
  name: string;
  company: string;
  phone: string;
  email: string;
  investmentStyle: string;
  paymentMethod: string;
}

interface OfferDetails {
  amount: string;
  terms: string;
  closingTimeline: string;
  paymentType: string;
  flexibility: string;
}

interface OutreachModalProps {
  isOpen: boolean;
  onClose: () => void;
  lead: AbsenteeLead | null;
  purpose?: 'acquisition' | 'iot_protection';
  onEmailSent?: (lead: AbsenteeLead) => void;
}

export default function AbsenteeOutreachModal({ 
  isOpen, 
  onClose, 
  lead,
  purpose = 'acquisition',
  onEmailSent 
}: OutreachModalProps) {
  const { user } = useAuth();
  // Contact lookup state
  const [contactInfo, setContactInfo] = useState<ContactInfo | null>(null);
  const [lookingUpContact, setLookingUpContact] = useState(false);
  const [manualEmail, setManualEmail] = useState('');
  const [manualPhone, setManualPhone] = useState('');
  
  const [buyerInfo, setBuyerInfo] = useState<BuyerInfo>(DEFAULT_BUYER_INFO);
  const [buyerInfoHydrated, setBuyerInfoHydrated] = useState(false);
  
  // Offer details state
  const [offerDetails, setOfferDetails] = useState<OfferDetails>({
    amount: '',
    terms: 'As-is, no contingencies',
    closingTimeline: '2-3 weeks',
    paymentType: 'All Cash',
    flexibility: 'Flexible on closing date'
  });
  
  // Additional questions
  const [questions, setQuestions] = useState<string[]>([]);
  const [newQuestion, setNewQuestion] = useState('');
  
  // Email generation state
  const [generatingEmail, setGeneratingEmail] = useState(false);
  const [emailTone, setEmailTone] = useState<'casual' | 'professional' | 'formal'>('professional');
  const [generatedSubject, setGeneratedSubject] = useState('');
  const [generatedBody, setGeneratedBody] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  
  // Sending state
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  
  // UI state
  const [showBuyerForm, setShowBuyerForm] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadBuyerInfo = async () => {
      if (!user?.id) {
        setBuyerInfo(DEFAULT_BUYER_INFO);
        setBuyerInfoHydrated(true);
        return;
      }

      setBuyerInfoHydrated(false);
      const storedBuyerInfo = await getUserPreference<BuyerInfo>(user.id, 'absenteeBuyerInfo', DEFAULT_BUYER_INFO);
      if (!cancelled) {
        setBuyerInfo({ ...DEFAULT_BUYER_INFO, ...storedBuyerInfo });
        setBuyerInfoHydrated(true);
      }

      if (typeof window !== 'undefined') {
        localStorage.removeItem(BUYER_INFO_STORAGE_KEY);
      }
    };

    void loadBuyerInfo();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  useEffect(() => {
    if (!buyerInfoHydrated || !user?.id) {
      return;
    }

    const timer = window.setTimeout(() => {
      void setUserPreference(user.id, 'absenteeBuyerInfo', buyerInfo);
      localStorage.removeItem(BUYER_INFO_STORAGE_KEY);
    }, 400);

    return () => window.clearTimeout(timer);
  }, [buyerInfo, buyerInfoHydrated, user?.id]);

  // Set initial offer amount based on market value
  useEffect(() => {
    if (lead && !offerDetails.amount) {
      const suggestedOffer = Math.round((lead.marketValue || lead.assessedValue) * 0.85);
      setOfferDetails(prev => ({ ...prev, amount: suggestedOffer.toString() }));
    }
  }, [lead]);

  // Reset state when modal opens with new lead
  useEffect(() => {
    if (isOpen && lead) {
      setContactInfo(null);
      setGeneratedSubject('');
      setGeneratedBody('');
      setSendStatus('idle');
      setStatusMessage('');
      setIsEditing(false);
    }
  }, [isOpen, lead?.address]);

  // Look up owner contact information
  const handleLookupContact = useCallback(async () => {
    if (!lead) return;
    
    setLookingUpContact(true);
    try {
      const response = await authenticatedFetch(`${BACKEND_URL}/api/outreach/lookup-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner: lead.owner,
          property: {
            address: lead.address,
            city: lead.city,
            state: lead.state
          }
        })
      });
      
      const data = await response.json();
      if (data.ok && data.contact) {
        setContactInfo(data.contact);
        if (data.contact.email) {
          setManualEmail(data.contact.email);
        }
        if (data.contact.phone) {
          setManualPhone(data.contact.phone);
        }
      }
    } catch (error) {
      console.error('Contact lookup error:', error);
    } finally {
      setLookingUpContact(false);
    }
  }, [lead]);

  // Generate AI email
  const handleGenerateEmail = useCallback(async () => {
    if (!lead) return;
    
    setGeneratingEmail(true);
    try {
      const response = await authenticatedFetch(`${BACKEND_URL}/api/outreach/generate-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property: {
            address: lead.address,
            city: lead.city,
            state: lead.state,
            propertyType: lead.propertyType,
            beds: lead.beds,
            baths: lead.baths,
            sqft: lead.sqft,
            yearBuilt: lead.yearBuilt,
            assessedValue: lead.assessedValue,
            marketValue: lead.marketValue,
            lotSizeAcres: lead.lotSizeAcres
          },
          owner: {
            name: lead.owner.name,
            name2: lead.owner.name2,
            isCorporate: lead.owner.isCorporate,
            mailingAddress: lead.owner.mailingAddress,
            ownershipYears: lead.ownershipYears,
            likelyFreeAndClear: lead.likelyFreeAndClear,
            motivationScore: lead.motivationScore,
            motivationFactors: lead.motivationFactors
          },
          buyer: buyerInfo,
          tone: emailTone,
          questions,
          purpose,
          insuranceEstimate: lead.insuranceEstimate || null,
          enrichmentContext: [
            lead.rentalConfidence != null ? `Rental confidence: ${lead.rentalConfidence}/100 (${lead.rentalConfidenceLabel || 'unknown'})` : '',
            lead.rentEstimate ? `Estimated rent: $${lead.rentEstimate.toLocaleString()}/month` : '',
            lead.grossYield ? `Gross yield: ${lead.grossYield}%` : '',
            lead.leakRiskScore != null ? `Leak risk: ${lead.leakRiskLabel || 'unknown'} (${lead.leakRiskScore}/100)` : '',
            lead.leakRiskSignals?.length ? `Leak risk factors: ${lead.leakRiskSignals.join('; ')}` : '',
            lead.rentalSignals?.length ? `Rental signals: ${lead.rentalSignals.join('; ')}` : '',
          ].filter(Boolean).join('\n'),
          offer: purpose === 'iot_protection' ? {} : {
            amount: offerDetails.amount,
            terms: offerDetails.terms,
            closingTimeline: offerDetails.closingTimeline,
            paymentType: offerDetails.paymentType,
            flexibility: offerDetails.flexibility
          }
        })
      });
      
      const data = await response.json();
      if (data.ok && data.email) {
        setGeneratedSubject(data.email.subject);
        setGeneratedBody(data.email.body);
      } else {
        setStatusMessage(data.error || 'Failed to generate email');
        setSendStatus('error');
      }
    } catch (error) {
      console.error('Email generation error:', error);
      setStatusMessage('Failed to generate email. Please try again.');
      setSendStatus('error');
    } finally {
      setGeneratingEmail(false);
    }
  }, [lead, buyerInfo, emailTone, questions, offerDetails, purpose]);

  // Send email
  const handleSendEmail = useCallback(async () => {
    if (!manualEmail || !generatedSubject || !generatedBody) {
      setStatusMessage('Please provide recipient email and generate email content');
      setSendStatus('error');
      return;
    }
    
    setSending(true);
    setSendStatus('idle');
    
    try {
      const response = await authenticatedFetch(`${BACKEND_URL}/api/outreach/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: manualEmail,
          subject: generatedSubject,
          body: generatedBody,
          leadId: lead?.dbId || lead?.attomId,
          propertyAddress: lead?.address
        })
      });
      
      const data = await response.json();
      if (data.ok) {
        setSendStatus('success');
        setStatusMessage('Email sent successfully!');
        if (onEmailSent && lead) {
          onEmailSent(lead);
        }
      } else {
        setSendStatus('error');
        setStatusMessage(data.error || 'Failed to send email');
      }
    } catch (error) {
      console.error('Send email error:', error);
      setSendStatus('error');
      setStatusMessage('Failed to send email. Please check your Gmail configuration.');
    } finally {
      setSending(false);
    }
  }, [manualEmail, generatedSubject, generatedBody, lead, onEmailSent]);

  // Copy email to clipboard
  const handleCopyEmail = useCallback(() => {
    const fullEmail = `Subject: ${generatedSubject}\n\n${generatedBody}`;
    navigator.clipboard.writeText(fullEmail);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [generatedSubject, generatedBody]);

  // Add question
  const handleAddQuestion = () => {
    if (newQuestion.trim()) {
      setQuestions([...questions, newQuestion.trim()]);
      setNewQuestion('');
    }
  };

  // Remove question
  const handleRemoveQuestion = (index: number) => {
    setQuestions(questions.filter((_, i) => i !== index));
  };

  if (!isOpen || !lead) return null;

  const recipientEmail = manualEmail || contactInfo?.email || '';
  const hasEmail = !!recipientEmail;
  const hasGeneratedEmail = !!generatedBody;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="bg-gradient-to-r from-purple-600 to-indigo-600 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3 text-white">
            <Mail className="h-6 w-6" />
            <div>
              <h2 className="text-lg font-semibold">
                {purpose === 'iot_protection' ? 'Remote Water Protection Outreach' : 'AI Outreach'}
              </h2>
              <p className="text-purple-200 text-sm">{lead.address}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-white/80 hover:text-white transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Property & Owner Summary */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Property Card */}
            <div className="bg-gray-50 rounded-xl p-4">
              <h3 className="font-medium text-gray-700 mb-3 flex items-center gap-2">
                <Building2 className="h-4 w-4" />
                Property Details
              </h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Type</span>
                  <span className="font-medium">{lead.propertyType}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Size</span>
                  <span className="font-medium">{lead.beds}bd / {lead.baths}ba / {lead.sqft?.toLocaleString()} sqft</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Market Value</span>
                  <span className="font-medium text-green-600">${lead.marketValue?.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Motivation Score</span>
                  <span className={`font-medium px-2 py-0.5 rounded ${
                    lead.motivationScore >= 70 ? 'bg-green-100 text-green-700' :
                    lead.motivationScore >= 50 ? 'bg-yellow-100 text-yellow-700' :
                    'bg-gray-100 text-gray-700'
                  }`}>
                    {lead.motivationScore}/100
                  </span>
                </div>
              </div>
            </div>

            {/* Owner Card */}
            <div className="bg-gray-50 rounded-xl p-4">
              <h3 className="font-medium text-gray-700 mb-3 flex items-center gap-2">
                <User className="h-4 w-4" />
                Owner Information
              </h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Name</span>
                  <span className="font-medium">{lead.owner.name}</span>
                </div>
                {lead.owner.isCorporate && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Type</span>
                    <span className="font-medium text-blue-600">Corporate/LLC</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-gray-500">Years Owned</span>
                  <span className="font-medium">{lead.ownershipYears} years</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Mortgage</span>
                  <span className={`font-medium ${lead.likelyFreeAndClear ? 'text-green-600' : 'text-gray-600'}`}>
                    {lead.likelyFreeAndClear ? 'Likely Free & Clear' : 'Has Mortgage'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Contact Lookup Section */}
          <div className="border rounded-xl p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-medium text-gray-700 flex items-center gap-2">
                <Search className="h-4 w-4" />
                Contact Information
              </h3>
              <button
                onClick={handleLookupContact}
                disabled={lookingUpContact}
                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-purple-100 text-purple-700 rounded-lg hover:bg-purple-200 disabled:opacity-50"
              >
                {lookingUpContact ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4" />
                )}
                {lookingUpContact ? 'Searching...' : 'Auto-Find Contact'}
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Email Address</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="email"
                    value={manualEmail}
                    onChange={(e) => setManualEmail(e.target.value)}
                    placeholder="owner@email.com"
                    className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500"
                  />
                </div>
                {contactInfo?.emailConfidence && contactInfo.emailConfidence !== 'none' && (
                  <p className={`text-xs mt-1 ${
                    contactInfo.emailConfidence === 'high' ? 'text-green-600' :
                    contactInfo.emailConfidence === 'medium' ? 'text-yellow-600' :
                    'text-gray-500'
                  }`}>
                    Confidence: {contactInfo.emailConfidence}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm text-gray-600 mb-1">Phone Number</label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="tel"
                    value={manualPhone}
                    onChange={(e) => setManualPhone(e.target.value)}
                    placeholder="(555) 123-4567"
                    className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500"
                  />
                </div>
                {contactInfo?.phoneConfidence && contactInfo.phoneConfidence !== 'none' && (
                  <p className={`text-xs mt-1 ${
                    contactInfo.phoneConfidence === 'high' ? 'text-green-600' :
                    contactInfo.phoneConfidence === 'medium' ? 'text-yellow-600' :
                    'text-gray-500'
                  }`}>
                    Confidence: {contactInfo.phoneConfidence}
                  </p>
                )}
              </div>
            </div>

            <p className="text-xs text-gray-500 mt-2">
              Mailing Address: {lead.owner.mailingAddress}
            </p>
          </div>

          {purpose === 'iot_protection' && lead.insuranceEstimate && (
            <InsurancePremiumEstimatorCard
              estimate={lead.insuranceEstimate}
              title="Estimated insurance savings pitch"
            />
          )}

          {/* Offer Details */}
          {purpose === 'acquisition' && (
          <div className="border rounded-xl p-4">
            <h3 className="font-medium text-gray-700 mb-4 flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Your Offer
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Offer Amount</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400">$</span>
                  <input
                    type="text"
                    value={offerDetails.amount ? Number(offerDetails.amount).toLocaleString() : ''}
                    onChange={(e) => setOfferDetails({
                      ...offerDetails,
                      amount: e.target.value.replace(/[^0-9]/g, '')
                    })}
                    placeholder="500,000"
                    className="w-full pl-8 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500"
                  />
                </div>
                {lead.marketValue && offerDetails.amount && (
                  <p className="text-xs text-gray-500 mt-1">
                    {((Number(offerDetails.amount) / lead.marketValue) * 100).toFixed(1)}% of market value
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm text-gray-600 mb-1">Closing Timeline</label>
                <select
                  value={offerDetails.closingTimeline}
                  onChange={(e) => setOfferDetails({ ...offerDetails, closingTimeline: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500"
                >
                  <option value="1-2 weeks">1-2 weeks</option>
                  <option value="2-3 weeks">2-3 weeks</option>
                  <option value="30 days">30 days</option>
                  <option value="45 days">45 days</option>
                  <option value="Flexible">Flexible</option>
                </select>
              </div>

              <div>
                <label className="block text-sm text-gray-600 mb-1">Payment Type</label>
                <select
                  value={offerDetails.paymentType}
                  onChange={(e) => setOfferDetails({ ...offerDetails, paymentType: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500"
                >
                  <option value="All Cash">All Cash</option>
                  <option value="Cash + Financing">Cash + Financing</option>
                  <option value="Seller Financing">Seller Financing</option>
                  <option value="Subject To">Subject To</option>
                </select>
              </div>
            </div>

            <div className="mt-4">
              <label className="block text-sm text-gray-600 mb-1">Additional Terms</label>
              <input
                type="text"
                value={offerDetails.terms}
                onChange={(e) => setOfferDetails({ ...offerDetails, terms: e.target.value })}
                placeholder="e.g., As-is, no contingencies"
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500"
              />
            </div>
          </div>
          )}

          {/* Buyer Info (Collapsible) */}
          <div className="border rounded-xl overflow-hidden">
            <button
              onClick={() => setShowBuyerForm(!showBuyerForm)}
              className="w-full px-4 py-3 flex items-center justify-between bg-gray-50 hover:bg-gray-100"
            >
              <span className="font-medium text-gray-700 flex items-center gap-2">
                <User className="h-4 w-4" />
                Your Contact Information
                {buyerInfo.name && <span className="text-sm text-gray-500 font-normal">({buyerInfo.name})</span>}
              </span>
              {showBuyerForm ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>

            {showBuyerForm && (
              <div className="p-4 space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">Your Name *</label>
                    <input
                      type="text"
                      value={buyerInfo.name}
                      onChange={(e) => setBuyerInfo({ ...buyerInfo, name: e.target.value })}
                      placeholder="John Smith"
                      className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">Company (Optional)</label>
                    <input
                      type="text"
                      value={buyerInfo.company}
                      onChange={(e) => setBuyerInfo({ ...buyerInfo, company: e.target.value })}
                      placeholder="ABC Investments LLC"
                      className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">Your Phone</label>
                    <input
                      type="tel"
                      value={buyerInfo.phone}
                      onChange={(e) => setBuyerInfo({ ...buyerInfo, phone: e.target.value })}
                      placeholder="(555) 123-4567"
                      className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">Your Email</label>
                    <input
                      type="email"
                      value={buyerInfo.email}
                      onChange={(e) => setBuyerInfo({ ...buyerInfo, email: e.target.value })}
                      placeholder="you@email.com"
                      className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Custom Questions (Collapsible) */}
          <div className="border rounded-xl overflow-hidden">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full px-4 py-3 flex items-center justify-between bg-gray-50 hover:bg-gray-100"
            >
              <span className="font-medium text-gray-700 flex items-center gap-2">
                <MessageSquare className="h-4 w-4" />
                Custom Questions
                {questions.length > 0 && (
                  <span className="bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full text-xs">
                    {questions.length}
                  </span>
                )}
              </span>
              {showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>

            {showAdvanced && (
              <div className="p-4">
                <div className="flex gap-2 mb-3">
                  <input
                    type="text"
                    value={newQuestion}
                    onChange={(e) => setNewQuestion(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleAddQuestion()}
                    placeholder="e.g., Are there any tenants currently in the property?"
                    className="flex-1 px-3 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500"
                  />
                  <button
                    onClick={handleAddQuestion}
                    className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
                  >
                    Add
                  </button>
                </div>

                {questions.length > 0 && (
                  <ul className="space-y-2">
                    {questions.map((q, i) => (
                      <li key={i} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
                        <span className="flex-1 text-sm">{q}</span>
                        <button
                          onClick={() => handleRemoveQuestion(i)}
                          className="text-gray-400 hover:text-red-500"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Email Generation Controls */}
          <div className="flex items-center gap-4 flex-wrap">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Email Tone</label>
              <div className="flex gap-2">
                {(['casual', 'professional', 'formal'] as const).map((tone) => (
                  <button
                    key={tone}
                    onClick={() => setEmailTone(tone)}
                    className={`px-3 py-1.5 rounded-lg text-sm capitalize ${
                      emailTone === tone
                        ? 'bg-purple-600 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {tone}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={handleGenerateEmail}
              disabled={generatingEmail || !buyerInfo.name}
              className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-lg hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
            >
              {generatingEmail ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {generatingEmail ? 'Generating...' : hasGeneratedEmail ? 'Regenerate Email' : 'Generate with AI'}
            </button>
          </div>

          {/* Generated Email Preview */}
          {hasGeneratedEmail && (
            <div className="border rounded-xl overflow-hidden">
              <div className="bg-gray-50 px-4 py-2 flex items-center justify-between">
                <h3 className="font-medium text-gray-700 flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Generated Email
                </h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => setIsEditing(!isEditing)}
                    className="flex items-center gap-1 px-2 py-1 text-sm text-gray-600 hover:text-gray-800"
                  >
                    <Edit3 className="h-3 w-3" />
                    {isEditing ? 'Preview' : 'Edit'}
                  </button>
                  <button
                    onClick={handleCopyEmail}
                    className="flex items-center gap-1 px-2 py-1 text-sm text-gray-600 hover:text-gray-800"
                  >
                    {copied ? <CheckCircle2 className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>

              <div className="p-4">
                {isEditing ? (
                  <>
                    <div className="mb-3">
                      <label className="block text-sm text-gray-600 mb-1">Subject</label>
                      <input
                        type="text"
                        value={generatedSubject}
                        onChange={(e) => setGeneratedSubject(e.target.value)}
                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-600 mb-1">Body</label>
                      <textarea
                        value={generatedBody}
                        onChange={(e) => setGeneratedBody(e.target.value)}
                        rows={12}
                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500 font-mono text-sm"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mb-3">
                      <span className="text-sm text-gray-500">Subject: </span>
                      <span className="font-medium">{generatedSubject}</span>
                    </div>
                    <div className="bg-white border rounded-lg p-4 whitespace-pre-wrap text-sm">
                      {generatedBody}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Status Message */}
          {statusMessage && (
            <div className={`flex items-center gap-2 p-3 rounded-lg ${
              sendStatus === 'success' ? 'bg-green-50 text-green-700' :
              sendStatus === 'error' ? 'bg-red-50 text-red-700' :
              'bg-gray-50 text-gray-700'
            }`}>
              {sendStatus === 'success' ? (
                <CheckCircle2 className="h-5 w-5" />
              ) : sendStatus === 'error' ? (
                <AlertCircle className="h-5 w-5" />
              ) : null}
              {statusMessage}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t px-6 py-4 bg-gray-50 flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-600 hover:text-gray-800"
          >
            Cancel
          </button>

          <div className="flex gap-3">
            {hasGeneratedEmail && (
              <>
                <button
                  onClick={handleCopyEmail}
                  className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100"
                >
                  <Copy className="h-4 w-4" />
                  Copy to Clipboard
                </button>

                <button
                  onClick={handleSendEmail}
                  disabled={sending || !hasEmail || sendStatus === 'success'}
                  className="flex items-center gap-2 px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : sendStatus === 'success' ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  {sending ? 'Sending...' : sendStatus === 'success' ? 'Sent!' : 'Send Email'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
