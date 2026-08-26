/**
 * ListingWizard
 * 4-step wizard for property owners to create a contractor marketplace listing.
 *
 * Step 1 — Confirm Details   (pre-filled from AI suggestion or scan)
 * Step 2 — Attach 3D Scan    (select existing, link to scanner, or skip)
 * Step 3 — AI Description    (auto-generated, editable)
 * Step 4 — Review & Submit   (full preview with submit / edit / discard)
 */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createListing as createFirestoreListing
} from '../../services/firebaseService';
import type { MarketplaceListing } from '../../types/contractorMarketplace';

type Step = 1 | 2 | 3 | 4;

interface SavedScan {
  id: string;
  roomName?: string;
  createdAt?: string;
  metadata?: any;
}

interface ListingWizardProps {
  /** AI renovation suggestion data (if triggered from suggestion card) */
  suggestion?: any;
  /** Scan object (if triggered from scan card) */
  sourceScan?: SavedScan | null;
  /** All of the owner's saved room scans */
  savedScans?: SavedScan[];
  propertyAddress?: string;
  user?: any;
  onComplete: (listing: MarketplaceListing) => void;
  onClose: () => void;
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

const RENOVATION_TYPES = [
  'Bathroom Renovation', 'Kitchen Renovation', 'Flooring', 'Painting',
  'Electrical', 'Plumbing', 'Roofing', 'HVAC', 'Landscaping',
  'Basement Finishing', 'General Renovation', 'Other'
];

export default function ListingWizard({
  suggestion,
  sourceScan,
  savedScans = [],
  propertyAddress = '',
  user,
  onComplete,
  onClose
}: ListingWizardProps) {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1 state — editable details
  const [renovationType, setRenovationType] = useState(
    suggestion?.name || suggestion?.type || ''
  );
  const [description, setDescription] = useState(suggestion?.summary || '');
  const [costLow, setCostLow] = useState(String(suggestion?.costRange?.low || suggestion?.cost || ''));
  const [costHigh, setCostHigh] = useState(String(suggestion?.costRange?.high || ''));
  const [startDate, setStartDate] = useState('');
  const [flexible, setFlexible] = useState(true);

  // Step 2 state — scan attachment
  const [selectedScan, setSelectedScan] = useState<SavedScan | null>(sourceScan || null);
  const [scanThumbnailFailed, setScanThumbnailFailed] = useState<Set<string>>(new Set());

  // Step 3 state — AI description
  const [aiDescription, setAiDescription] = useState('');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiGenerated, setAiGenerated] = useState(false);

  // Step 4 state — cover image
  const [coverImageUrl, setCoverImageUrl] = useState('');

  // Auto-generate AI description when entering step 3
  useEffect(() => {
    if (step === 3 && !aiGenerated && !aiGenerating) {
      generateDescription();
    }
  }, [step]);

  // Set cover image from scan thumbnail when scan is selected
  useEffect(() => {
    if (selectedScan && !coverImageUrl) {
      setCoverImageUrl(`/api/room-scanner/scans/${selectedScan.id}/thumbnail`);
    }
  }, [selectedScan]);

  const generateDescription = async () => {
    setAiGenerating(true);
    setAiError(null);
    try {
      const scanMeta = selectedScan?.metadata || {};
      const resp = await fetch('/api/listing-ai/generate-description', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          suggestionData: suggestion || {
            name: renovationType,
            summary: description,
            costRange: { low: parseFloat(costLow) || 0, high: parseFloat(costHigh) || 0 }
          },
          propertyAddress,
          scanMetadata: scanMeta
        })
      });
      const data = await resp.json();
      if (data.success && data.description) {
        setAiDescription(data.description);
        setAiGenerated(true);
      } else {
        setAiError('AI description generation failed. You can write your own description below.');
        setAiDescription(description || suggestion?.summary || '');
      }
    } catch {
      setAiError('Could not connect to AI service. You can write your own description below.');
      setAiDescription(description || suggestion?.summary || '');
    } finally {
      setAiGenerating(false);
    }
  };

  const buildListing = (): MarketplaceListing => {
    const scanMeta = selectedScan?.metadata || {};
    const modelFiles = scanMeta.modelFiles || {};
    const buildModelUrl = (filename: string) =>
      selectedScan ? `/api/room-scanner/scans/${selectedScan.id}/model/${filename.split('/').pop()}` : '';

    return {
      id: `listing-${Date.now()}`,
      propertyOwnerId: user?.id || 'owner-1',
      propertyAddress: propertyAddress || '—',
      propertyZipCode: (propertyAddress.match(/\b\d{5}\b/) || [])[0] || '',
      scanId: selectedScan?.id || '',
      scanThumbnailUrl: selectedScan ? `/api/room-scanner/scans/${selectedScan.id}/thumbnail` : '',
      renovationType,
      renovationDescription: description,
      aiDescription: aiDescription || undefined,
      coverImageUrl: coverImageUrl || undefined,
      estimatedCostRange: {
        low: parseFloat(costLow) || 0,
        high: parseFloat(costHigh) || parseFloat(costLow) || 0
      },
      desiredStartDate: startDate || undefined,
      flexibleTimeline: flexible,
      roomDimensions: scanMeta.roomDimensions,
      modelFiles: selectedScan ? {
        obj: modelFiles.obj ? buildModelUrl(modelFiles.obj) : undefined,
        mtl: modelFiles.mtl ? buildModelUrl(modelFiles.mtl) : undefined,
        glb: modelFiles.glb ? buildModelUrl(modelFiles.glb) : undefined,
        texture: modelFiles.texture ? buildModelUrl(modelFiles.texture) : undefined,
        ply: modelFiles.ply ? buildModelUrl(modelFiles.ply) : undefined
      } : undefined,
      processingResult: scanMeta.processingResult,
      // Cost breakdowns from suggestion
      materialBreakdown: suggestion?.materialBreakdown?.map((m: any) => ({
        item: m.item || m.name || '',
        quantity: m.quantity,
        unit: m.unit,
        unitCost: m.unitCost || 0,
        totalCost: m.totalCost || 0
      })),
      laborBreakdown: suggestion?.laborBreakdown?.map((l: any) => ({
        task: l.task || l.name || '',
        hours: l.hours,
        ratePerHour: l.ratePerHour,
        totalCost: l.totalCost || 0
      })),
      photos: [],
      aiAfterImages: suggestion?.previewImages || [],
      sourceType: suggestion ? 'suggestion' : 'scan',
      suggestionId: suggestion?.id,
      status: 'active',
      bids: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  };

  const handleSubmit = async () => {
    if (!renovationType) { setError('Please select a renovation type.'); return; }
    setSubmitting(true);
    setError(null);
    try {
      const listing = buildListing();

      // Save to Firestore
      const result = await createFirestoreListing(listing);
      if (result.success && result.listing?.id) {
        listing.id = result.listing.id;
      }

      onComplete(listing);
    } catch (err: any) {
      setError(err.message || 'Failed to post listing. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const stepLabels = ['Details', 'Attach Scan', 'Description', 'Review'];

  const previewListing = step === 4 ? buildListing() : null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[92vh] flex flex-col overflow-hidden shadow-2xl">

        {/* Header */}
        <div className="p-5 border-b shrink-0">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-gray-900">List on Contractor Marketplace</h2>
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Step indicator */}
          <div className="flex items-center">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="flex items-center flex-1 last:flex-none">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-colors ${
                  step > n ? 'bg-emerald-600 text-white' :
                  step === n ? 'bg-emerald-600 text-white ring-4 ring-emerald-100' :
                  'bg-gray-200 text-gray-500'
                }`}>
                  {step > n ? (
                    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  ) : n}
                </div>
                {n < 4 && <div className={`flex-1 h-0.5 mx-1.5 transition-colors ${step > n ? 'bg-emerald-600' : 'bg-gray-200'}`} />}
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-1.5">
            {stepLabels.map((label, i) => (
              <span key={i} className={`text-xs font-medium ${step === i + 1 ? 'text-emerald-600' : 'text-gray-400'}`}>
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mx-5 mt-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 shrink-0">
            {error}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">

          {/* ─── Step 1: Confirm Details ─── */}
          {step === 1 && (
            <div className="space-y-4">
              {suggestion && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-800 flex gap-2">
                  <svg className="w-4 h-4 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                  </svg>
                  Pre-filled from AI renovation analysis. Review and edit as needed.
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Renovation Type *</label>
                <select value={renovationType} onChange={e => setRenovationType(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm">
                  <option value="">Select a type...</option>
                  {RENOVATION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Brief Description *</label>
                <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm resize-none"
                  placeholder="Briefly describe the renovation project..." />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Min Budget</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                    <input type="number" value={costLow} onChange={e => setCostLow(e.target.value)} min="0"
                      className="w-full pl-7 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm"
                      placeholder="15000" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Max Budget</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                    <input type="number" value={costHigh} onChange={e => setCostHigh(e.target.value)} min="0"
                      className="w-full pl-7 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm"
                      placeholder="25000" />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Desired Start Date</label>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm"
                  min={new Date().toISOString().split('T')[0]} />
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" checked={flexible} onChange={e => setFlexible(e.target.checked)}
                  className="w-4 h-4 text-emerald-600 rounded focus:ring-emerald-500" />
                <span className="text-sm text-gray-700">I'm flexible on the start date</span>
              </label>
            </div>
          )}

          {/* ─── Step 2: Attach 3D Scan ─── */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                <p className="text-sm font-medium text-blue-900 mb-1">Attach a 3D Room Scan (Optional)</p>
                <p className="text-sm text-blue-700">
                  A 3D model lets contractors virtually walk through the space and make accurate measurements,
                  resulting in more competitive and precise bids.
                </p>
              </div>

              {/* Existing scans */}
              {savedScans.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-700 mb-2">Your Room Scans</h3>
                  <div className="grid grid-cols-2 gap-3 max-h-56 overflow-y-auto pr-1">
                    {savedScans.map(scan => (
                      <button key={scan.id} type="button"
                        onClick={() => setSelectedScan(selectedScan?.id === scan.id ? null : scan)}
                        className={`rounded-xl border-2 overflow-hidden text-left transition-all ${
                          selectedScan?.id === scan.id
                            ? 'border-emerald-500 ring-2 ring-emerald-200'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}>
                        <div className="bg-gray-100 h-24 relative">
                          {!scanThumbnailFailed.has(scan.id) ? (
                            <img
                              src={`/api/room-scanner/scans/${scan.id}/thumbnail`}
                              alt={scan.roomName || 'Room scan'}
                              className="w-full h-full object-cover"
                              onError={() => setScanThumbnailFailed(prev => new Set(prev).add(scan.id))}
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.069A1 1 0 0121 8.845v6.31a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
                              </svg>
                            </div>
                          )}
                          {selectedScan?.id === scan.id && (
                            <div className="absolute inset-0 bg-emerald-500/20 flex items-center justify-center">
                              <div className="w-7 h-7 bg-emerald-600 rounded-full flex items-center justify-center">
                                <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                </svg>
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="p-2">
                          <p className="text-sm font-medium text-gray-900 truncate">{scan.roomName || 'Room Scan'}</p>
                          <p className="text-xs text-gray-400 truncate">{scan.id.slice(0, 12)}...</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Create new scan option */}
              <button
                type="button"
                onClick={() => navigate(`/room-scanner?return=${encodeURIComponent('/renovations')}`)}
                className="w-full flex items-center gap-3 p-4 border-2 border-dashed border-gray-300 rounded-xl text-gray-600 hover:border-emerald-400 hover:text-emerald-700 hover:bg-emerald-50 transition-all">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.069A1 1 0 0121 8.845v6.31a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
                </svg>
                <div className="text-left">
                  <p className="font-medium">Create a New 3D Room Scan</p>
                  <p className="text-sm text-gray-400">Opens the room scanner — you'll be returned here after</p>
                </div>
              </button>

              {selectedScan && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm text-emerald-800">
                    <svg className="w-4 h-4 text-emerald-600" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span><strong>{selectedScan.roomName || 'Scan'}</strong> attached</span>
                  </div>
                  <button onClick={() => setSelectedScan(null)} className="text-xs text-emerald-700 hover:text-emerald-900 underline">Remove</button>
                </div>
              )}
            </div>
          )}

          {/* ─── Step 3: AI Description ─── */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-700">Listing Description</h3>
                <button type="button" onClick={() => { setAiGenerated(false); generateDescription(); }}
                  disabled={aiGenerating}
                  className="flex items-center gap-1.5 text-sm text-violet-600 hover:text-violet-800 disabled:opacity-50 transition-colors">
                  <svg className={`w-4 h-4 ${aiGenerating ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  {aiGenerating ? 'Generating...' : 'Regenerate with AI'}
                </button>
              </div>

              {aiGenerating && (
                <div className="flex items-center gap-3 py-8 justify-center text-gray-500">
                  <svg className="w-5 h-5 text-violet-500 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span className="text-sm">Generating listing description with AI...</span>
                </div>
              )}

              {!aiGenerating && (
                <>
                  {aiGenerated && (
                    <div className="flex items-center gap-2 text-xs text-violet-600 bg-violet-50 border border-violet-200 rounded-lg px-3 py-2">
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                      </svg>
                      AI-generated — edit as needed before submitting
                    </div>
                  )}
                  {aiError && (
                    <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
                      {aiError}
                    </div>
                  )}
                  <textarea
                    value={aiDescription}
                    onChange={e => setAiDescription(e.target.value)}
                    rows={10}
                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm resize-none leading-relaxed"
                    placeholder="Write a description of the renovation project for contractors..."
                  />
                  <p className="text-xs text-gray-400">
                    This description will be shown to contractors on the marketplace.
                  </p>
                </>
              )}
            </div>
          )}

          {/* ─── Step 4: Review & Submit ─── */}
          {step === 4 && previewListing && (
            <div className="space-y-5">
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-800">
                Review your listing before posting. Once submitted, contractors in your area will be able to see it and place bids.
              </div>

              {/* Cover image */}
              {(selectedScan || coverImageUrl) && (
                <div className="rounded-xl overflow-hidden border border-gray-200 h-40 bg-gray-100">
                  <img
                    src={coverImageUrl || (selectedScan ? `/api/room-scanner/scans/${selectedScan.id}/thumbnail` : '')}
                    alt="Cover"
                    className="w-full h-full object-cover"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                </div>
              )}

              {/* Title block */}
              <div className="border border-gray-200 rounded-xl p-4 space-y-2">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-bold text-gray-900">{renovationType}</h3>
                    <p className="text-sm text-gray-500">{propertyAddress}</p>
                  </div>
                  <span className="px-2.5 py-1 bg-green-100 text-green-700 text-xs rounded-full">Active</span>
                </div>
                <div className="flex items-center gap-4 text-sm text-gray-600">
                  <span>Budget: <strong>{formatCurrency(parseFloat(costLow) || 0)} – {formatCurrency(parseFloat(costHigh) || parseFloat(costLow) || 0)}</strong></span>
                  {startDate && <span>Starts: <strong>{new Date(startDate).toLocaleDateString()}</strong></span>}
                  {flexible && <span className="text-gray-400">Flexible timeline</span>}
                </div>
              </div>

              {/* AI Description preview */}
              <div className="border border-gray-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Listing Description</p>
                <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{aiDescription || description}</p>
              </div>

              {/* Cost breakdown preview */}
              {(suggestion?.materialBreakdown?.length > 0 || suggestion?.laborBreakdown?.length > 0) && (
                <div className="border border-gray-200 rounded-xl p-4">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">AI Cost Estimate</p>
                  <div className="grid grid-cols-2 gap-4">
                    {suggestion?.materialBreakdown?.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-gray-600 mb-1.5">Materials</p>
                        <div className="space-y-1">
                          {suggestion.materialBreakdown.slice(0, 4).map((m: any, i: number) => (
                            <div key={i} className="flex justify-between text-xs text-gray-600">
                              <span className="truncate">{m.item || m.name}</span>
                              <span className="ml-2 font-medium shrink-0">{formatCurrency(m.totalCost)}</span>
                            </div>
                          ))}
                          {suggestion.materialBreakdown.length > 4 && (
                            <p className="text-xs text-gray-400">+{suggestion.materialBreakdown.length - 4} more</p>
                          )}
                        </div>
                      </div>
                    )}
                    {suggestion?.laborBreakdown?.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-gray-600 mb-1.5">Labor</p>
                        <div className="space-y-1">
                          {suggestion.laborBreakdown.slice(0, 4).map((l: any, i: number) => (
                            <div key={i} className="flex justify-between text-xs text-gray-600">
                              <span className="truncate">{l.task || l.name}</span>
                              <span className="ml-2 font-medium shrink-0">{formatCurrency(l.totalCost)}</span>
                            </div>
                          ))}
                          {suggestion.laborBreakdown.length > 4 && (
                            <p className="text-xs text-gray-400">+{suggestion.laborBreakdown.length - 4} more</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 3D scan badge */}
              {selectedScan && (
                <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  3D scan attached: <strong>{selectedScan.roomName || selectedScan.id}</strong>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="p-5 border-t bg-gray-50 shrink-0">
          {step < 4 ? (
            <div className="flex gap-3">
              {step > 1 && (
                <button type="button" onClick={() => { setStep((step - 1) as Step); setError(null); }}
                  className="px-5 py-2.5 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-100 transition-colors">
                  Back
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  if (step === 1 && !renovationType) { setError('Please select a renovation type.'); return; }
                  setStep((step + 1) as Step);
                }}
                className="flex-1 py-2.5 bg-emerald-600 text-white rounded-lg font-semibold hover:bg-emerald-700 transition-colors">
                {step === 3 ? 'Preview Listing' : 'Continue'}
              </button>
            </div>
          ) : (
            <div className="flex gap-3">
              <button type="button" onClick={() => { setStep(1); setError(null); }}
                className="px-5 py-2.5 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-100 transition-colors">
                Edit
              </button>
              <button type="button" onClick={onClose}
                className="px-5 py-2.5 border border-red-200 text-red-600 rounded-lg font-medium hover:bg-red-50 transition-colors">
                Discard
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                className="flex-1 py-2.5 bg-emerald-600 text-white rounded-lg font-semibold hover:bg-emerald-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2">
                {submitting ? (
                  <><svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Posting...</>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                    Submit Listing
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
