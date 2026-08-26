/**
 * ContractorListingModal
 * Expanded listing view for contractors — 4 tabs:
 * Overview | Gallery | 3D Model | Bids
 * Includes inline bid submission.
 */

import React, { useState, lazy, Suspense } from 'react';
import type { MarketplaceListing, MarketplaceBid } from '../types/contractorMarketplace';
import { submitBid as submitFirestoreBid } from '../services/firebaseService';
import { calculateBidAnalytics } from '../services/contractorMarketplaceService';

const Model3DViewer = lazy(() => import('./Model3DViewer'));

type Tab = 'overview' | 'gallery' | '3d' | 'bids';

interface ContractorListingModalProps {
  listing: MarketplaceListing;
  onClose: () => void;
  currentUser: any;
  onBidSubmitted?: () => void;
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function formatDate(s: string) {
  return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(i => (
        <svg key={i} className={`w-3.5 h-3.5 ${i <= Math.round(rating) ? 'text-yellow-400' : 'text-gray-200'}`} fill="currentColor" viewBox="0 0 20 20">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
    </div>
  );
}

function getModelUrl(listing: MarketplaceListing): string | null {
  return listing.modelFiles?.glb || listing.modelFiles?.obj || null;
}

function getCoverImageUrl(listing: MarketplaceListing): string {
  return listing.coverImageUrl ||
    listing.photos?.[0] ||
    (listing.scanId && !listing.scanId.startsWith('scan-')
      ? `/api/room-scanner/scans/${listing.scanId}/thumbnail`
      : '');
}

export default function ContractorListingModal({ listing, onClose, currentUser, onBidSubmitted }: ContractorListingModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [bidAmount, setBidAmount] = useState('');
  const [bidDuration, setBidDuration] = useState('');
  const [bidScope, setBidScope] = useState('');
  const [bidNotes, setBidNotes] = useState('');
  const [submittingBid, setSubmittingBid] = useState(false);
  const [bidSuccess, setBidSuccess] = useState(false);
  const [bidError, setBidError] = useState<string | null>(null);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);

  const contractorId = currentUser?.id || currentUser?.contractorId || 'contractor-1';
  const hasBid = listing.bids?.some(b => b.contractorId === contractorId) || false;
  const analytics = calculateBidAnalytics(listing);
  const modelUrl = getModelUrl(listing);
  const coverUrl = getCoverImageUrl(listing);
  const hasGallery = (listing.photos?.length || 0) > 0 || (listing.aiAfterImages?.length || 0) > 0;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'gallery', label: `Gallery${hasGallery ? '' : ''}` },
    { id: '3d', label: '3D Model' },
    { id: 'bids', label: `Bids (${listing.bids?.length || 0})` }
  ];

  const handleSubmitBid = async () => {
    if (!bidAmount || !bidScope || !bidDuration) return;
    setSubmittingBid(true);
    setBidError(null);
    try {
      const result = await submitFirestoreBid(listing.id, {
        listingId: listing.id,
        contractorId,
        contractor: currentUser,
        bidAmount: parseFloat(bidAmount),
        estimatedDuration: bidDuration,
        scope: bidScope,
        notes: bidNotes,
        status: 'pending'
      });
      if (!result.success) throw new Error(result.error || 'Submission failed');
      setBidSuccess(true);
      onBidSubmitted?.();
      setBidAmount('');
      setBidDuration('');
      setBidScope('');
      setBidNotes('');
    } catch (err: any) {
      setBidError(err.message);
    } finally {
      setSubmittingBid(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[92vh] flex flex-col overflow-hidden shadow-2xl">

        {/* Hero Image Header */}
        <div className="relative h-52 bg-gray-900 shrink-0">
          {coverUrl && !thumbnailFailed ? (
            <img
              src={coverUrl}
              alt={listing.renovationType}
              className="w-full h-full object-cover opacity-80"
              onError={() => setThumbnailFailed(true)}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <svg className="w-16 h-16 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5" />
              </svg>
            </div>
          )}
          {/* Gradient overlay */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />

          {/* Title overlay */}
          <div className="absolute bottom-0 left-0 right-0 p-5">
            <div className="flex items-end justify-between">
              <div>
                <h2 className="text-xl font-bold text-white leading-tight">{listing.renovationType}</h2>
                <p className="text-white/75 text-sm mt-0.5">{listing.propertyAddress}</p>
              </div>
              <div className="text-right">
                {analytics && analytics.totalBids > 0 && (
                  <p className="text-white/90 text-sm font-medium">{analytics.totalBids} {analytics.totalBids === 1 ? 'bid' : 'bids'}</p>
                )}
                <p className="text-white font-semibold text-sm">
                  {formatCurrency(listing.estimatedCostRange.low)}–{formatCurrency(listing.estimatedCostRange.high)}
                </p>
              </div>
            </div>
          </div>

          {/* Close button */}
          <button onClick={onClose}
            className="absolute top-4 right-4 w-8 h-8 bg-black/50 hover:bg-black/70 text-white rounded-full flex items-center justify-center transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          {/* Status badge */}
          <div className="absolute top-4 left-4">
            <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
              listing.status === 'active' ? 'bg-green-500/90 text-white' : 'bg-gray-500/90 text-white'
            }`}>
              {listing.status === 'active' ? 'Open for Bids' : listing.status}
            </span>
          </div>
        </div>

        {/* Tab Bar */}
        <div className="flex border-b border-gray-200 shrink-0 bg-white">
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'border-b-2 border-emerald-600 text-emerald-700'
                  : 'text-gray-500 hover:text-gray-700'
              }`}>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto">

          {/* ── Overview ── */}
          {activeTab === 'overview' && (
            <div className="p-6 space-y-5">
              {/* Description */}
              <div>
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Project Description</h3>
                <p className="text-gray-700 leading-relaxed">
                  {listing.aiDescription || listing.renovationDescription || 'No description provided.'}
                </p>
              </div>

              {/* Key metrics */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-500 mb-1">Budget Range</p>
                  <p className="text-sm font-bold text-gray-900">{formatCurrency(listing.estimatedCostRange.low)}</p>
                  <p className="text-xs text-gray-500">to {formatCurrency(listing.estimatedCostRange.high)}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-500 mb-1">Room Size</p>
                  <p className="text-sm font-bold text-gray-900">
                    {listing.roomDimensions ? `${listing.roomDimensions.floorAreaSqFt} sq ft` : '—'}
                  </p>
                  {listing.roomDimensions && (
                    <p className="text-xs text-gray-500">{listing.roomDimensions.widthFeet}'×{listing.roomDimensions.lengthFeet}'</p>
                  )}
                </div>
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-500 mb-1">Start Date</p>
                  <p className="text-sm font-bold text-gray-900">
                    {listing.desiredStartDate ? formatDate(listing.desiredStartDate) : 'Flexible'}
                  </p>
                </div>
              </div>

              {/* Scope tags */}
              {listing.highlightedAreas && listing.highlightedAreas.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Scope of Work</h3>
                  <div className="flex flex-wrap gap-2">
                    {listing.highlightedAreas.map((area, i) => (
                      <span key={i} className="px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-xs font-medium border border-blue-200">
                        {area.description}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Materials breakdown */}
              {listing.materialBreakdown && listing.materialBreakdown.length > 0 && (
                <details className="group">
                  <summary className="flex items-center justify-between cursor-pointer py-2 text-sm font-semibold text-gray-700 hover:text-gray-900">
                    <span>Materials Breakdown ({listing.materialBreakdown.length} items)</span>
                    <svg className="w-4 h-4 text-gray-400 group-open:rotate-180 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </summary>
                  <div className="mt-2 rounded-lg border border-gray-200 overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">Item</th>
                          <th className="text-right px-3 py-2 text-xs font-medium text-gray-500">Est. Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {listing.materialBreakdown.map((m, i) => (
                          <tr key={i} className="border-t border-gray-100">
                            <td className="px-3 py-2 text-gray-700">{m.item}</td>
                            <td className="px-3 py-2 text-right font-medium text-gray-900">{formatCurrency(m.totalCost)}</td>
                          </tr>
                        ))}
                        <tr className="border-t-2 border-gray-200 bg-gray-50">
                          <td className="px-3 py-2 font-semibold text-gray-900">Materials Total</td>
                          <td className="px-3 py-2 text-right font-bold text-gray-900">
                            {formatCurrency(listing.materialBreakdown.reduce((s, m) => s + m.totalCost, 0))}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </details>
              )}

              {/* Labor breakdown */}
              {listing.laborBreakdown && listing.laborBreakdown.length > 0 && (
                <details className="group">
                  <summary className="flex items-center justify-between cursor-pointer py-2 text-sm font-semibold text-gray-700 hover:text-gray-900">
                    <span>Labor Breakdown ({listing.laborBreakdown.length} tasks)</span>
                    <svg className="w-4 h-4 text-gray-400 group-open:rotate-180 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </summary>
                  <div className="mt-2 rounded-lg border border-gray-200 overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">Task</th>
                          <th className="text-right px-3 py-2 text-xs font-medium text-gray-500">Est. Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {listing.laborBreakdown.map((l, i) => (
                          <tr key={i} className="border-t border-gray-100">
                            <td className="px-3 py-2 text-gray-700">{l.task}</td>
                            <td className="px-3 py-2 text-right font-medium text-gray-900">{formatCurrency(l.totalCost)}</td>
                          </tr>
                        ))}
                        <tr className="border-t-2 border-gray-200 bg-gray-50">
                          <td className="px-3 py-2 font-semibold text-gray-900">Labor Total</td>
                          <td className="px-3 py-2 text-right font-bold text-gray-900">
                            {formatCurrency(listing.laborBreakdown.reduce((s, l) => s + l.totalCost, 0))}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </div>
          )}

          {/* ── Gallery ── */}
          {activeTab === 'gallery' && (
            <div className="p-6">
              {!hasGallery ? (
                <div className="text-center py-12 text-gray-400">
                  <svg className="w-12 h-12 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <p className="text-sm">No photos uploaded for this listing.</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Renovation photos */}
                  {listing.photos && listing.photos.length > 0 && (
                    <div>
                      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Current Condition</h3>
                      <div className="grid grid-cols-2 gap-3">
                        {listing.photos.map((url, i) => (
                          <img key={i} src={url} alt={`Photo ${i + 1}`}
                            className="w-full h-36 object-cover rounded-lg border border-gray-200" />
                        ))}
                      </div>
                    </div>
                  )}
                  {/* AI after images */}
                  {listing.aiAfterImages && listing.aiAfterImages.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-3">
                        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">AI Renovation Vision</h3>
                        <span className="px-2 py-0.5 bg-violet-100 text-violet-700 rounded-full text-xs font-medium">AI Generated</span>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        {listing.aiAfterImages.map((img, i) => (
                          <div key={i} className="relative">
                            <img src={img.url} alt={`AI Vision ${i + 1}`}
                              className="w-full h-36 object-cover rounded-lg border-2 border-violet-200" />
                            <span className="absolute bottom-2 left-2 px-2 py-0.5 bg-violet-600/80 text-white text-xs rounded-full">
                              Angle {img.angleIndex + 1}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── 3D Model ── */}
          {activeTab === '3d' && (
            <div className="p-6">
              {modelUrl ? (
                <div className="space-y-3">
                  <div className="rounded-xl overflow-hidden border border-gray-200" style={{ height: 400 }}>
                    <Suspense fallback={
                      <div className="w-full h-full bg-gray-100 flex items-center justify-center">
                        <div className="text-center">
                          <div className="w-8 h-8 border-4 border-gray-300 border-t-emerald-600 rounded-full animate-spin mx-auto mb-2" />
                          <p className="text-sm text-gray-500">Loading 3D model...</p>
                        </div>
                      </div>
                    }>
                      <Model3DViewer modelUrl={modelUrl} showControls />
                    </Suspense>
                  </div>
                  {listing.scanId && (
                    <a href={`/contractor/scan/${encodeURIComponent(listing.scanId)}/${encodeURIComponent(listing.id)}`}
                      target="_blank" rel="noopener noreferrer"
                      className="flex items-center justify-center gap-2 w-full py-2.5 border border-emerald-300 text-emerald-700 rounded-lg text-sm font-medium hover:bg-emerald-50 transition-colors">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                      Open Full Scan Viewer with Measurement Tools
                    </a>
                  )}
                  {listing.processingResult && (
                    <div className="grid grid-cols-3 gap-2 text-center">
                      {listing.processingResult.numVertices != null && (
                        <div className="bg-gray-50 rounded-lg p-2">
                          <p className="text-xs text-gray-500">Vertices</p>
                          <p className="text-sm font-semibold">{listing.processingResult.numVertices.toLocaleString()}</p>
                        </div>
                      )}
                      {listing.processingResult.numFaces != null && (
                        <div className="bg-gray-50 rounded-lg p-2">
                          <p className="text-xs text-gray-500">Faces</p>
                          <p className="text-sm font-semibold">{listing.processingResult.numFaces.toLocaleString()}</p>
                        </div>
                      )}
                      {listing.processingResult.numViewpoints != null && (
                        <div className="bg-gray-50 rounded-lg p-2">
                          <p className="text-xs text-gray-500">Viewpoints</p>
                          <p className="text-sm font-semibold">{listing.processingResult.numViewpoints}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-12 text-gray-400">
                  <svg className="w-12 h-12 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5" />
                  </svg>
                  <p className="text-sm font-medium text-gray-600 mb-1">No 3D model for this listing</p>
                  <p className="text-xs text-gray-400">The property owner did not attach a 3D scan to this listing.</p>
                </div>
              )}
            </div>
          )}

          {/* ── Bids ── */}
          {activeTab === 'bids' && (
            <div className="p-6 space-y-5">
              {/* Bid stats summary */}
              {analytics && analytics.totalBids > 0 && (
                <div className="grid grid-cols-4 gap-2">
                  <div className="text-center bg-gray-50 rounded-lg p-2.5">
                    <p className="text-xs text-gray-500">Total Bids</p>
                    <p className="text-lg font-bold text-gray-900">{analytics.totalBids}</p>
                  </div>
                  <div className="text-center bg-green-50 rounded-lg p-2.5">
                    <p className="text-xs text-gray-500">Lowest</p>
                    <p className="text-sm font-bold text-green-700">{formatCurrency(analytics.lowBid.amount)}</p>
                  </div>
                  <div className="text-center bg-gray-50 rounded-lg p-2.5">
                    <p className="text-xs text-gray-500">Average</p>
                    <p className="text-sm font-bold text-gray-900">{formatCurrency(analytics.averageBid)}</p>
                  </div>
                  <div className="text-center bg-red-50 rounded-lg p-2.5">
                    <p className="text-xs text-gray-500">Highest</p>
                    <p className="text-sm font-bold text-red-700">{formatCurrency(analytics.highBid.amount)}</p>
                  </div>
                </div>
              )}

              {/* Existing bids */}
              {listing.bids && listing.bids.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Competing Bids</h3>
                  {[...listing.bids]
                    .sort((a, b) => a.bidAmount - b.bidAmount)
                    .map(bid => (
                      <div key={bid.id}
                        className={`rounded-xl border p-4 ${bid.contractorId === contractorId ? 'border-emerald-500 bg-emerald-50' : 'border-gray-200 bg-white'}`}>
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-semibold text-gray-900">{bid.contractor?.companyName || 'Unknown Contractor'}</p>
                              {bid.contractorId === contractorId && (
                                <span className="px-2 py-0.5 bg-emerald-600 text-white text-xs rounded-full">Your Bid</span>
                              )}
                              {(bid.contractor as any)?.dunsVerified && (
                                <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full flex items-center gap-1">
                                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                  </svg>
                                  D&B Verified
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              {bid.contractor?.rating && (
                                <>
                                  <StarRating rating={bid.contractor.rating.overall} />
                                  <span className="text-xs text-gray-500">
                                    {bid.contractor.rating.overall.toFixed(1)} ({bid.contractor.rating.totalReviews} reviews)
                                  </span>
                                </>
                              )}
                              {bid.contractor?.yearsInBusiness && (
                                <span className="text-xs text-gray-400">• {bid.contractor.yearsInBusiness}yr exp</span>
                              )}
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-xl font-bold text-gray-900">{formatCurrency(bid.bidAmount)}</p>
                            <p className="text-xs text-gray-500">{bid.estimatedDuration || '—'}</p>
                          </div>
                        </div>
                        {bid.scope && <p className="text-sm text-gray-600 line-clamp-2">{bid.scope}</p>}
                        {bid.contractor?.specialties && bid.contractor.specialties.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {bid.contractor.specialties.slice(0, 3).map((s, i) => (
                              <span key={i} className="px-2 py-0.5 bg-gray-100 text-gray-500 text-xs rounded-full">{s}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              )}

              {/* Bid submission form */}
              {!hasBid && !bidSuccess && (
                <div className="border-t border-gray-200 pt-5">
                  <h3 className="text-sm font-semibold text-gray-700 mb-4">Place Your Bid</h3>

                  {/* Reference */}
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4">
                    <p className="text-sm text-blue-800">
                      <span className="font-medium">Owner's Budget:</span>{' '}
                      {formatCurrency(listing.estimatedCostRange.low)} – {formatCurrency(listing.estimatedCostRange.high)}
                    </p>
                  </div>

                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Bid Amount *</label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                          <input type="number" value={bidAmount} onChange={e => setBidAmount(e.target.value)}
                            className="w-full pl-7 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm"
                            placeholder="35000" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Duration *</label>
                        <input type="text" value={bidDuration} onChange={e => setBidDuration(e.target.value)}
                          className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm"
                          placeholder="e.g. 3–4 weeks" />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Scope of Work *</label>
                      <textarea value={bidScope} onChange={e => setBidScope(e.target.value)} rows={3}
                        className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm resize-none"
                        placeholder="Describe what's included: materials, labor, permits, demolition..." />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Additional Notes</label>
                      <textarea value={bidNotes} onChange={e => setBidNotes(e.target.value)} rows={2}
                        className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm resize-none"
                        placeholder="Warranty, special terms, questions..." />
                    </div>
                    {bidError && <p className="text-sm text-red-600">{bidError}</p>}
                    <button onClick={handleSubmitBid}
                      disabled={submittingBid || !bidAmount || !bidScope || !bidDuration}
                      className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold disabled:opacity-50 transition-colors flex items-center justify-center gap-2">
                      {submittingBid ? (
                        <><svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Submitting...</>
                      ) : 'Submit Bid'}
                    </button>
                  </div>
                </div>
              )}

              {/* Success state */}
              {bidSuccess && (
                <div className="bg-emerald-50 border border-emerald-300 rounded-xl p-5 text-center">
                  <svg className="w-10 h-10 text-emerald-500 mx-auto mb-2" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  <p className="font-semibold text-emerald-800">Bid submitted successfully!</p>
                  <p className="text-sm text-emerald-600 mt-1">The property owner will be notified of your bid.</p>
                </div>
              )}

              {/* Already bid state */}
              {hasBid && !bidSuccess && (
                <div className="mt-4 bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800 text-center">
                  You've already submitted a bid on this project.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
