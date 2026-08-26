/**
 * RenovationListingsTab
 * Shows a property owner's posted marketplace listings, received bids,
 * contractor comment threads, and AI-powered bid analysis/ranking.
 */

import React, { useState, useEffect } from 'react';
import {
  subscribeToListingComments,
  addListingComment,
  updateListing
} from '../../services/firebaseService';
import type {
  MarketplaceListing,
  MarketplaceBid,
  ListingComment,
  BidWithAIAnalysis
} from '../../types/contractorMarketplace';

interface RenovationListingsTabProps {
  listings: MarketplaceListing[];
  user: any;
  onNewListing?: () => void;
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function formatDate(s: string) {
  return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function ScoreBar({ label, score, color }: { label: string; score: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between mb-1">
        <span className="text-xs text-gray-500">{label}</span>
        <span className="text-xs font-semibold text-gray-700">{score}/100</span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full ${color}`}
          style={{ width: `${Math.min(score, 100)}%` }}
        />
      </div>
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const config = rank === 1
    ? { bg: 'bg-yellow-400', text: 'text-yellow-900', label: '🥇 Best Value' }
    : rank === 2
    ? { bg: 'bg-gray-300', text: 'text-gray-800', label: '🥈 2nd' }
    : rank === 3
    ? { bg: 'bg-amber-600', text: 'text-amber-100', label: '🥉 3rd' }
    : { bg: 'bg-gray-100', text: 'text-gray-600', label: `#${rank}` };

  return (
    <span className={`px-2 py-0.5 ${config.bg} ${config.text} rounded-full text-xs font-bold`}>
      {config.label}
    </span>
  );
}

function CommentThread({ listingId, user }: { listingId: string; user: any }) {
  const [comments, setComments] = useState<ListingComment[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const unsub = subscribeToListingComments(listingId, setComments);
    return () => unsub();
  }, [listingId]);

  const sendMessage = async () => {
    if (!newMessage.trim()) return;
    setSending(true);
    await addListingComment(listingId, {
      listingId,
      authorId: user?.id || 'owner-1',
      authorName: user?.name || 'Property Owner',
      authorRole: 'owner',
      message: newMessage.trim()
    });
    setNewMessage('');
    setSending(false);
  };

  return (
    <div className="border-t border-gray-100 pt-4 mt-4">
      <h4 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
        <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
        Contractor Messages
        {comments.length > 0 && <span className="px-1.5 py-0.5 bg-gray-200 text-gray-600 text-xs rounded-full">{comments.length}</span>}
      </h4>

      {comments.length === 0 ? (
        <p className="text-xs text-gray-400 italic mb-3">No messages yet. Contractors can post questions here.</p>
      ) : (
        <div className="space-y-2 mb-3 max-h-40 overflow-y-auto">
          {comments.map(c => (
            <div key={c.id} className={`flex gap-2 ${c.authorRole === 'owner' ? 'flex-row-reverse' : ''}`}>
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                c.authorRole === 'owner' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'
              }`}>
                {(c.authorName || c.authorCompanyName || '?')[0].toUpperCase()}
              </div>
              <div className={`max-w-xs ${c.authorRole === 'owner' ? 'items-end' : 'items-start'} flex flex-col`}>
                <div className={`px-3 py-2 rounded-xl text-sm ${
                  c.authorRole === 'owner'
                    ? 'bg-emerald-600 text-white rounded-tr-none'
                    : 'bg-gray-100 text-gray-800 rounded-tl-none'
                }`}>
                  {c.message}
                </div>
                <p className="text-xs text-gray-400 mt-0.5">
                  {c.authorRole === 'contractor' && (c.authorCompanyName || c.authorName)}
                  {' '}{new Date(c.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={newMessage}
          onChange={e => setNewMessage(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
          placeholder="Reply to contractors..."
          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
        />
        <button
          onClick={sendMessage}
          disabled={!newMessage.trim() || sending}
          className="px-3 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors">
          Send
        </button>
      </div>
    </div>
  );
}

function ListingCard({
  listing,
  user
}: {
  listing: MarketplaceListing;
  user: any;
}) {
  const [expanded, setExpanded] = useState(false);
  const [analyzedBids, setAnalyzedBids] = useState<BidWithAIAnalysis[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analyzed, setAnalyzed] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);

  const coverUrl = listing.coverImageUrl ||
    listing.photos?.[0] ||
    (listing.scanId && !listing.scanId.startsWith('scan-')
      ? `/api/room-scanner/scans/${listing.scanId}/thumbnail`
      : null);

  const analyzeBids = async () => {
    if (!listing.bids?.length) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const resp = await fetch('/api/bid-analysis/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bids: listing.bids,
          listingDetails: {
            renovationType: listing.renovationType,
            propertyAddress: listing.propertyAddress,
            estimatedCostRange: listing.estimatedCostRange
          }
        })
      });
      const data = await resp.json();
      if (data.success) {
        setAnalyzedBids(data.analyzedBids);
        setAnalyzed(true);
      } else {
        setAnalyzeError(data.error || 'Analysis failed');
      }
    } catch (err: any) {
      setAnalyzeError('Could not connect to AI service.');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleAcceptBid = async (bid: MarketplaceBid) => {
    if (!window.confirm(`Accept bid from ${bid.contractor?.companyName || 'this contractor'} for ${formatCurrency(bid.bidAmount)}?`)) return;
    try {
      const updatedBids = listing.bids.map(b => ({
        ...b,
        status: b.id === bid.id ? 'accepted' : 'rejected'
      })) as MarketplaceBid[];
      await updateListing(listing.id, {
        status: 'in_progress',
        bids: updatedBids
      });
    } catch (err: any) {
      alert(`Failed to accept bid: ${err.message}`);
    }
  };

  const bidsToShow = analyzed && analyzedBids.length > 0 ? analyzedBids : listing.bids || [];

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
      {/* Card header — always visible */}
      <button
        className="w-full text-left flex items-center gap-4 p-4 hover:bg-gray-50 transition-colors"
        onClick={() => setExpanded(!expanded)}>

        {/* Thumbnail */}
        <div className="w-16 h-16 rounded-xl overflow-hidden bg-gray-100 shrink-0">
          {coverUrl && !thumbnailFailed ? (
            <img src={coverUrl} alt={listing.renovationType} className="w-full h-full object-cover"
              onError={() => setThumbnailFailed(true)} />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5" />
              </svg>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-gray-900 truncate">{listing.renovationType}</h3>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${
              listing.status === 'active' ? 'bg-green-100 text-green-700' :
              listing.status === 'in_progress' ? 'bg-blue-100 text-blue-700' :
              listing.status === 'completed' ? 'bg-gray-100 text-gray-600' :
              'bg-yellow-100 text-yellow-700'
            }`}>
              {listing.status === 'active' ? 'Active' :
               listing.status === 'in_progress' ? 'In Progress' :
               listing.status === 'completed' ? 'Completed' :
               listing.status}
            </span>
          </div>
          <p className="text-sm text-gray-500 truncate">{listing.propertyAddress}</p>
          <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
            <span>{formatCurrency(listing.estimatedCostRange.low)}–{formatCurrency(listing.estimatedCostRange.high)}</span>
            <span>•</span>
            <span className="font-medium text-blue-600">{listing.bids?.length || 0} {listing.bids?.length === 1 ? 'bid' : 'bids'}</span>
            {listing.commentsCount ? <><span>•</span><span>{listing.commentsCount} messages</span></> : null}
          </div>
        </div>

        {/* Chevron */}
        <svg className={`w-5 h-5 text-gray-400 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-gray-100 p-4 space-y-5">

          {/* Description */}
          {(listing.aiDescription || listing.renovationDescription) && (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Description</p>
              <p className="text-sm text-gray-700 leading-relaxed line-clamp-4">
                {listing.aiDescription || listing.renovationDescription}
              </p>
            </div>
          )}

          {/* Bids section */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700">
                Contractor Bids ({listing.bids?.length || 0})
              </p>
              {listing.bids && listing.bids.length > 0 && !analyzed && (
                <button
                  onClick={analyzeBids}
                  disabled={analyzing}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white text-xs font-medium rounded-lg disabled:opacity-50 transition-colors">
                  {analyzing ? (
                    <><svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Analyzing...</>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                      </svg>
                      Analyze Bids with AI
                    </>
                  )}
                </button>
              )}
              {analyzed && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 bg-violet-100 text-violet-700 text-xs rounded-full font-medium">
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  AI Analysis Complete
                </span>
              )}
            </div>

            {analyzeError && (
              <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
                {analyzeError}
              </div>
            )}

            {listing.bids?.length === 0 ? (
              <p className="text-sm text-gray-400 italic py-3 text-center">
                No bids yet. Contractors will be notified when this listing is active.
              </p>
            ) : (
              <div className="space-y-3">
                {bidsToShow.map((bid: any, idx: number) => (
                  <div key={bid.id}
                    className={`rounded-xl border p-4 ${
                      bid.status === 'accepted' ? 'border-emerald-400 bg-emerald-50' : 'border-gray-200'
                    }`}>
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold text-gray-900">{bid.contractor?.companyName || 'Contractor'}</p>
                          {bid.aiAnalysis?.rank && <RankBadge rank={bid.aiAnalysis.rank} />}
                          {bid.status === 'accepted' && (
                            <span className="px-2 py-0.5 bg-emerald-600 text-white text-xs rounded-full">Accepted</span>
                          )}
                          {(bid.contractor as any)?.dunsVerified && (
                            <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full">D&B Verified</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {bid.contractor?.yearsInBusiness}yr experience
                          {bid.contractor?.licenseNumber && ` • License: ${bid.contractor.licenseNumber}`}
                        </p>
                      </div>
                      <div className="text-right shrink-0 ml-3">
                        <p className="text-xl font-bold text-gray-900">{formatCurrency(bid.bidAmount)}</p>
                        <p className="text-xs text-gray-500">{bid.estimatedDuration || '—'}</p>
                      </div>
                    </div>

                    {bid.scope && <p className="text-sm text-gray-600 mb-2 line-clamp-2">{bid.scope}</p>}

                    {/* AI Analysis */}
                    {bid.aiAnalysis && (
                      <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
                        <p className="text-xs text-gray-700 leading-relaxed">{bid.aiAnalysis.companySearchSummary}</p>
                        <div className="grid grid-cols-3 gap-2">
                          <ScoreBar label="Quality" score={bid.aiAnalysis.qualityScore} color="bg-blue-500" />
                          <ScoreBar label="Value" score={bid.aiAnalysis.valueScore} color="bg-emerald-500" />
                          <ScoreBar label="Credibility" score={bid.aiAnalysis.credibilityScore} color="bg-violet-500" />
                        </div>
                        <p className="text-xs text-gray-500 italic">"{bid.aiAnalysis.recommendation}"</p>
                      </div>
                    )}

                    {/* Actions */}
                    {listing.status === 'active' && bid.status === 'pending' && (
                      <div className="flex gap-2 mt-3 pt-3 border-t border-gray-100">
                        <button onClick={() => handleAcceptBid(bid)}
                          className="flex-1 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors">
                          Accept Bid
                        </button>
                        <button onClick={async () => {
                          const updatedBids = listing.bids.map(b => ({
                            ...b,
                            status: b.id === bid.id ? 'rejected' : b.status
                          })) as MarketplaceBid[];
                          await updateListing(listing.id, { bids: updatedBids });
                        }}
                          className="flex-1 py-2 border border-gray-300 text-gray-600 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">
                          Decline
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Comment thread */}
          <CommentThread listingId={listing.id} user={user} />

          {/* Metadata footer */}
          <div className="text-xs text-gray-400 pt-2 border-t border-gray-100 flex justify-between">
            <span>Listed: {formatDate(listing.createdAt)}</span>
            {listing.desiredStartDate && <span>Start: {formatDate(listing.desiredStartDate)}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function RenovationListingsTab({ listings, user, onNewListing }: RenovationListingsTabProps) {
  const activeListing = listings.filter(l => l.status === 'active');
  const otherListings = listings.filter(l => l.status !== 'active');

  if (listings.length === 0) {
    return (
      <div className="py-16 text-center">
        <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-gray-900 mb-1">No listings yet</h3>
        <p className="text-gray-500 text-sm mb-5">
          Go to the <span className="font-medium">AI Analysis</span> tab, run an analysis,
          and click "List on Marketplace" on any renovation suggestion.
        </p>
        {onNewListing && (
          <button onClick={onNewListing}
            className="px-5 py-2.5 bg-emerald-600 text-white rounded-lg font-semibold hover:bg-emerald-700 transition-colors text-sm">
            Go to AI Analysis
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Active listings */}
      {activeListing.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <h3 className="font-semibold text-gray-900">Active Listings</h3>
            <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full font-medium">
              {activeListing.length}
            </span>
          </div>
          <div className="space-y-3">
            {activeListing.map(listing => (
              <ListingCard key={listing.id} listing={listing} user={user} />
            ))}
          </div>
        </div>
      )}

      {/* Archived / completed */}
      {otherListings.length > 0 && (
        <div>
          <h3 className="font-semibold text-gray-700 mb-3">Past Listings</h3>
          <div className="space-y-3">
            {otherListings.map(listing => (
              <ListingCard key={listing.id} listing={listing} user={user} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
