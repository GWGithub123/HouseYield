/**
 * Contractor Marketplace
 * Main marketplace view — region + cost filters, redesigned cards, expanded listing modal.
 */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import type { MarketplaceListing, MarketplaceBid } from '../types/contractorMarketplace';
import { getMockListings, getMockContractors, calculateBidAnalytics } from '../services/contractorMarketplaceService';
import {
  subscribeToListings,
  submitBid as submitFirestoreBid
} from '../services/firebaseService';
import ContractorListingModal from '../components/ContractorListingModal';

const USE_FIREBASE = true;

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function formatDate(s: string) {
  return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getCoverImageUrl(listing: MarketplaceListing, thumbnailFailed: boolean): string {
  if (listing.coverImageUrl) return listing.coverImageUrl;
  if (listing.photos?.[0]) return listing.photos[0];
  if (!thumbnailFailed && listing.scanId && !listing.scanId.startsWith('scan-')) {
    return `/api/room-scanner/scans/${listing.scanId}/thumbnail`;
  }
  return '';
}

const ContractorMarketplace: React.FC = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedListing, setExpandedListing] = useState<MarketplaceListing | null>(null);

  // Filters
  const [filterType, setFilterType] = useState<string>('all');
  const [filterZip, setFilterZip] = useState('');
  const [filterMinBudget, setFilterMinBudget] = useState('');
  const [filterMaxBudget, setFilterMaxBudget] = useState('');
  const [sortBy, setSortBy] = useState<'newest' | 'budget' | 'deadline'>('newest');

  // Failed thumbnail tracking
  const [failedThumbnails, setFailedThumbnails] = useState<Set<string>>(new Set());

  // My bids
  const [showMyBids, setShowMyBids] = useState(false);
  const [myBids, setMyBids] = useState<Array<{ bid: MarketplaceBid; listing: MarketplaceListing }>>([]);

  useEffect(() => {
    setLoading(true);

    if (USE_FIREBASE) {
      const unsubscribe = subscribeToListings((firestoreListings) => {
        setListings(firestoreListings);

        const contractorId = user?.id || user?.contractorId || 'contractor-1';
        const contractorBids: Array<{ bid: MarketplaceBid; listing: MarketplaceListing }> = [];
        firestoreListings.forEach(listing => {
          listing.bids?.forEach(bid => {
            if (bid.contractorId === contractorId) contractorBids.push({ bid, listing });
          });
        });
        setMyBids(contractorBids);
        setLoading(false);
      });
      return () => unsubscribe();
    } else {
      const mockListings = getMockListings();
      setListings(mockListings);
      const contractorBids: Array<{ bid: MarketplaceBid; listing: MarketplaceListing }> = [];
      mockListings.forEach(listing => {
        listing.bids.forEach(bid => {
          if (bid.contractorId === 'contractor-1') contractorBids.push({ bid, listing });
        });
      });
      setMyBids(contractorBids);
      setLoading(false);
    }
  }, [user]);

  const filteredListings = listings
    .filter(l => {
      if (filterType !== 'all' && !l.renovationType.toLowerCase().includes(filterType.toLowerCase())) return false;
      if (filterZip.length >= 3) {
        const listingZip = (l as any).propertyZipCode || '';
        if (listingZip && !listingZip.startsWith(filterZip.substring(0, Math.min(filterZip.length, 5)))) return false;
      }
      if (filterMinBudget && l.estimatedCostRange.high < parseFloat(filterMinBudget)) return false;
      if (filterMaxBudget && l.estimatedCostRange.low > parseFloat(filterMaxBudget)) return false;
      return true;
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'budget': return b.estimatedCostRange.high - a.estimatedCostRange.high;
        case 'deadline': return new Date(a.desiredStartDate || '').getTime() - new Date(b.desiredStartDate || '').getTime();
        default: return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
    });

  const activeFilterCount = [
    filterType !== 'all',
    filterZip.length >= 3,
    !!filterMinBudget,
    !!filterMaxBudget
  ].filter(Boolean).length;

  const handleLogout = () => { logout(); navigate('/'); };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-600">Loading marketplace...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b shadow-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-emerald-100 rounded-lg flex items-center justify-center">
                <svg className="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                </svg>
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">Contractor Marketplace</h1>
                <p className="text-sm text-gray-500">Find and bid on renovation projects</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <button
                onClick={() => navigate('/contractor/payments')}
                className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-white px-4 py-2 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-50"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a5 5 0 00-10 0v2m-2 0h14a1 1 0 011 1v10a1 1 0 01-1 1H5a1 1 0 01-1-1V10a1 1 0 011-1z" />
                </svg>
                Payments
              </button>
              <button onClick={() => setShowMyBids(true)}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 transition-colors text-sm font-medium">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                My Bids
                {myBids.length > 0 && (
                  <span className="w-5 h-5 bg-emerald-600 text-white text-xs rounded-full flex items-center justify-center font-bold">
                    {myBids.length}
                  </span>
                )}
              </button>
              <div className="flex items-center gap-3">
                <div className="text-right hidden sm:block">
                  <p className="text-sm font-medium text-gray-900">{user?.name || 'Demo Contractor'}</p>
                  <p className="text-xs text-gray-500">{user?.email || 'demo@contractor.com'}</p>
                </div>
                <button onClick={handleLogout} title="Logout"
                  className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Filters */}
      <div className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            {/* Type */}
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-gray-600">Type:</label>
              <select value={filterType} onChange={e => setFilterType(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500">
                <option value="all">All Projects</option>
                <option value="kitchen">Kitchen</option>
                <option value="bathroom">Bathroom</option>
                <option value="flooring">Flooring</option>
                <option value="painting">Painting</option>
                <option value="basement">Basement</option>
                <option value="roofing">Roofing</option>
                <option value="hvac">HVAC</option>
                <option value="electrical">Electrical</option>
                <option value="plumbing">Plumbing</option>
              </select>
            </div>

            {/* ZIP */}
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-gray-600">Near ZIP:</label>
              <input
                type="text"
                value={filterZip}
                onChange={e => setFilterZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
                placeholder="e.g. 20001"
                className="w-28 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
            </div>

            {/* Budget */}
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-gray-600">Budget:</label>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">$</span>
                <input type="number" value={filterMinBudget} onChange={e => setFilterMinBudget(e.target.value)}
                  placeholder="Min" className="w-24 pl-5 pr-2 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500" />
              </div>
              <span className="text-gray-400 text-sm">–</span>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">$</span>
                <input type="number" value={filterMaxBudget} onChange={e => setFilterMaxBudget(e.target.value)}
                  placeholder="Max" className="w-24 pl-5 pr-2 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500" />
              </div>
            </div>

            {/* Sort */}
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-gray-600">Sort:</label>
              <select value={sortBy} onChange={e => setSortBy(e.target.value as any)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500">
                <option value="newest">Newest First</option>
                <option value="budget">Highest Budget</option>
                <option value="deadline">Start Date</option>
              </select>
            </div>

            {/* Clear filters */}
            {activeFilterCount > 0 && (
              <button
                onClick={() => { setFilterType('all'); setFilterZip(''); setFilterMinBudget(''); setFilterMaxBudget(''); }}
                className="flex items-center gap-1 px-3 py-2 text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                Clear ({activeFilterCount})
              </button>
            )}

            <div className="flex-1" />
            <div className="text-sm text-gray-500 font-medium">
              {filteredListings.length} project{filteredListings.length !== 1 ? 's' : ''}
            </div>
          </div>
        </div>
      </div>

      {/* Listings Grid */}
      <div className="max-w-7xl mx-auto px-4 py-8">
        {filteredListings.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
            <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">No Projects Found</h3>
            <p className="text-gray-500 text-sm">
              {activeFilterCount > 0 ? 'Try adjusting your filters.' : 'No listings currently available. Check back soon!'}
            </p>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredListings.map(listing => {
              const analytics = calculateBidAnalytics(listing);
              const contractorId = user?.id || user?.contractorId || 'contractor-1';
              const hasBid = listing.bids?.some(b => b.contractorId === contractorId) || false;
              const thumbnailFailed = failedThumbnails.has(listing.scanId || listing.id);
              const coverUrl = getCoverImageUrl(listing, thumbnailFailed);
              const lowestBid = listing.bids?.length
                ? Math.min(...listing.bids.map(b => b.bidAmount))
                : null;
              const hasModel = !!(listing.modelFiles?.obj || listing.modelFiles?.glb);

              return (
                <div key={listing.id}
                  className="bg-white rounded-2xl border border-gray-200 overflow-hidden hover:shadow-xl transition-all duration-200 cursor-pointer group"
                  onClick={() => setExpandedListing(listing)}>

                  {/* Cover Image */}
                  <div className="relative h-52 bg-gray-900 overflow-hidden">
                    {coverUrl ? (
                      <img
                        src={coverUrl}
                        alt={listing.renovationType}
                        className="w-full h-full object-cover opacity-85 group-hover:scale-105 transition-transform duration-300"
                        loading="lazy"
                        onError={() => {
                          if (listing.scanId) setFailedThumbnails(prev => new Set(prev).add(listing.scanId));
                        }}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-gray-700 to-gray-900">
                        <svg className="w-16 h-16 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={0.75} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5" />
                        </svg>
                      </div>
                    )}

                    {/* Gradient overlay */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />

                    {/* Text overlay */}
                    <div className="absolute bottom-0 left-0 right-0 p-4">
                      <h3 className="font-bold text-white text-base leading-tight">{listing.renovationType}</h3>
                      <p className="text-white/70 text-xs mt-0.5 truncate">{listing.propertyAddress}</p>
                      <p className="text-white font-semibold text-sm mt-1">
                        {formatCurrency(listing.estimatedCostRange.low)} – {formatCurrency(listing.estimatedCostRange.high)}
                      </p>
                    </div>

                    {/* Badges */}
                    <div className="absolute top-3 left-3 flex gap-1.5">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                        listing.status === 'active' ? 'bg-green-500/90 text-white' : 'bg-gray-600/90 text-white'
                      }`}>
                        {listing.status === 'active' ? 'Open for Bids' : listing.status}
                      </span>
                      {hasBid && (
                        <span className="px-2.5 py-1 bg-blue-500/90 text-white rounded-full text-xs font-medium">
                          ✓ Bid Placed
                        </span>
                      )}
                    </div>

                    <div className="absolute top-3 right-3 flex gap-1.5">
                      {hasModel && (
                        <span className="px-2 py-1 bg-black/50 text-white rounded-lg text-xs font-medium flex items-center gap-1">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5" />
                          </svg>
                          3D
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Card body */}
                  <div className="p-4">
                    {/* Description */}
                    <p className="text-sm text-gray-600 line-clamp-2 mb-3 leading-relaxed">
                      {listing.aiDescription || listing.renovationDescription || 'No description provided.'}
                    </p>

                    {/* Bid stats */}
                    <div className="flex items-center justify-between mb-3 py-2 border-t border-b border-gray-100">
                      <div className="text-center">
                        <p className="text-xs text-gray-400">Bids</p>
                        <p className="text-sm font-bold text-gray-900">{listing.bids?.length || 0}</p>
                      </div>
                      {lowestBid !== null && (
                        <div className="text-center">
                          <p className="text-xs text-gray-400">Lowest Bid</p>
                          <p className="text-sm font-bold text-emerald-700">{formatCurrency(lowestBid)}</p>
                        </div>
                      )}
                      {analytics && analytics.totalBids > 0 && (
                        <div className="text-center">
                          <p className="text-xs text-gray-400">Avg Bid</p>
                          <p className="text-sm font-bold text-gray-700">{formatCurrency(analytics.averageBid)}</p>
                        </div>
                      )}
                      <div className="text-center">
                        <p className="text-xs text-gray-400">Start</p>
                        <p className="text-sm font-medium text-gray-700 text-xs">
                          {listing.desiredStartDate ? formatDate(listing.desiredStartDate) : 'Flexible'}
                        </p>
                      </div>
                    </div>

                    {/* Scope tags */}
                    {listing.highlightedAreas && listing.highlightedAreas.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        {listing.highlightedAreas.slice(0, 2).map((area, i) => (
                          <span key={i} className="px-2 py-0.5 bg-blue-50 text-blue-600 rounded-full text-xs font-medium">
                            {area.description}
                          </span>
                        ))}
                        {listing.highlightedAreas.length > 2 && (
                          <span className="px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full text-xs">
                            +{listing.highlightedAreas.length - 2} more
                          </span>
                        )}
                      </div>
                    )}

                    {/* CTA */}
                    <div className="flex gap-2" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => setExpandedListing(listing)}
                        className="flex-1 py-2.5 border border-emerald-300 text-emerald-700 rounded-xl text-sm font-semibold hover:bg-emerald-50 transition-colors">
                        View Details
                      </button>
                      {!hasBid ? (
                        <button
                          onClick={() => setExpandedListing(listing)}
                          className="flex-1 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-700 transition-colors">
                          Place Bid
                        </button>
                      ) : (
                        <div className="flex-1 py-2.5 bg-blue-50 text-blue-700 rounded-xl text-sm font-semibold text-center">
                          ✓ Bid Placed
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Expanded Listing Modal */}
      {expandedListing && (
        <ContractorListingModal
          listing={expandedListing}
          onClose={() => setExpandedListing(null)}
          currentUser={user}
          onBidSubmitted={() => {
            // Optimistically update local hasBid state — real-time sub will refresh
            setExpandedListing(null);
          }}
        />
      )}

      {/* My Bids Modal */}
      {showMyBids && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden shadow-2xl">
            <div className="p-6 border-b flex items-center justify-between">
              <h2 className="text-xl font-bold text-gray-900">My Bids</h2>
              <button onClick={() => setShowMyBids(false)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
                <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6 overflow-y-auto max-h-[calc(90vh-8rem)]">
              {myBids.length === 0 ? (
                <div className="text-center py-12">
                  <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                  <p className="text-gray-600">You haven't submitted any bids yet.</p>
                  <p className="text-sm text-gray-400 mt-1">Browse projects and place your first bid!</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {myBids.map(({ bid, listing }) => (
                    <div key={bid.id}
                      className="border border-gray-200 rounded-xl p-4 cursor-pointer hover:border-emerald-300 transition-colors"
                      onClick={() => { setShowMyBids(false); setExpandedListing(listing); }}>
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <h4 className="font-semibold text-gray-900">{listing.renovationType}</h4>
                          <p className="text-sm text-gray-500">{listing.propertyAddress}</p>
                        </div>
                        <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                          bid.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                          bid.status === 'accepted' ? 'bg-green-100 text-green-700' :
                          bid.status === 'rejected' ? 'bg-red-100 text-red-700' :
                          'bg-gray-100 text-gray-700'
                        }`}>
                          {bid.status.charAt(0).toUpperCase() + bid.status.slice(1)}
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-3 text-sm">
                        <div>
                          <p className="text-gray-400 text-xs">Your Bid</p>
                          <p className="font-bold text-gray-900">{formatCurrency(bid.bidAmount)}</p>
                        </div>
                        <div>
                          <p className="text-gray-400 text-xs">Duration</p>
                          <p className="font-medium text-gray-700">{bid.estimatedDuration || '—'}</p>
                        </div>
                        <div>
                          <p className="text-gray-400 text-xs">Submitted</p>
                          <p className="font-medium text-gray-700">{formatDate(bid.createdAt)}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ContractorMarketplace;
