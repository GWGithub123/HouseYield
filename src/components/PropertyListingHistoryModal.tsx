import React, { useState, useEffect } from 'react';

interface HistoricalListing {
  LISTINGKEY: string;
  UNPARSEDADDRESS: string;
  CITY: string;
  STATEORPROVINCE: string;
  POSTALCODE: string;
  LISTPRICE: number;
  ORIGINALLISTPRICE: number;
  CLOSEPRICE: number | null;
  CLOSEDATE: string | null;
  STANDARDSTATUS: string;
  ONMARKETDATE: string | null;
  OFFMARKETDATE: string | null;
  DAYSONMARKET: number | null;
  LISTINGCONTRACTDATE: string | null;
  MODIFICATIONTIMESTAMP: string;
  BEDROOMSTOTAL: number;
  BATHROOMSTOTALINTEGER: number;
  LIVINGAREA: number;
  images: Array<{
    MEDIAKEY: string;
    LISTINGKEY: string;
    MEDIAURL: string;
    MEDIA_ORDER: number;
    MEDIACATEGORY: string;
    MEDIAMODIFICATIONTIMESTAMP: string;
  }>;
}

interface DuplicateAddress {
  UNPARSEDADDRESS: string;
  CITY: string;
  STATEORPROVINCE: string;
  POSTALCODE: string;
  LISTING_COUNT: number;
  LISTING_KEYS: string;
  FIRST_LISTED: string;
  LAST_LISTED: string;
}

interface PropertyListingHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const PropertyListingHistoryModal: React.FC<PropertyListingHistoryModalProps> = ({ isOpen, onClose }) => {
  const [searchAddress, setSearchAddress] = useState('');
  const [duplicateAddresses, setDuplicateAddresses] = useState<DuplicateAddress[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<DuplicateAddress | null>(null);
  const [listings, setListings] = useState<HistoricalListing[]>([]);
  const [selectedListingIndex, setSelectedListingIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'slideshow'>('slideshow');
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  // Fetch properties with multiple listings on mount
  useEffect(() => {
    if (isOpen) {
      fetchDuplicateAddresses();
    }
  }, [isOpen]);

  const fetchDuplicateAddresses = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/snowflake/duplicate-addresses');
      const data = await res.json();
      if (data.ok) {
        setDuplicateAddresses(data.data);
      } else {
        setError(data.error);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchPropertyHistory = async (address: string) => {
    setLoadingHistory(true);
    setError(null);
    setCurrentImageIndex(0);
    try {
      const res = await fetch(`/api/snowflake/property-history/${encodeURIComponent(address)}`);
      const data = await res.json();
      if (data.ok) {
        // Sort by date, newest first
        const sorted = data.data.sort((a: HistoricalListing, b: HistoricalListing) => {
          const dateA = new Date(a.ONMARKETDATE || a.MODIFICATIONTIMESTAMP).getTime();
          const dateB = new Date(b.ONMARKETDATE || b.MODIFICATIONTIMESTAMP).getTime();
          return dateB - dateA;
        });
        setListings(sorted);
        setSelectedListingIndex(0);
      } else {
        setError(data.error);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoadingHistory(false);
    }
  };

  const handleAddressSelect = (addr: DuplicateAddress) => {
    setSelectedAddress(addr);
    // Extract just the street address part (before the city)
    const streetAddress = addr.UNPARSEDADDRESS.split(',')[0].trim();
    fetchPropertyHistory(streetAddress);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchAddress.trim()) {
      fetchPropertyHistory(searchAddress.trim());
      setSelectedAddress(null);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'active': return 'bg-green-500 text-white';
      case 'pending': return 'bg-yellow-500 text-white';
      case 'coming soon': return 'bg-blue-500 text-white';
      case 'closed': return 'bg-gray-600 text-white';
      case 'canceled': return 'bg-red-500 text-white';
      case 'expired': return 'bg-orange-500 text-white';
      default: return 'bg-gray-400 text-white';
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getListingYear = (listing: HistoricalListing) => {
    const date = listing.ONMARKETDATE || listing.MODIFICATIONTIMESTAMP;
    if (!date) return 'Unknown';
    return new Date(date).getFullYear();
  };

  const selectedListing = listings[selectedListingIndex];
  const currentImages = selectedListing?.images || [];

  const nextImage = () => {
    if (currentImages.length > 0) {
      setCurrentImageIndex((prev) => (prev + 1) % currentImages.length);
    }
  };

  const prevImage = () => {
    if (currentImages.length > 0) {
      setCurrentImageIndex((prev) => (prev - 1 + currentImages.length) % currentImages.length);
    }
  };

  // Reset image index when switching listings
  useEffect(() => {
    setCurrentImageIndex(0);
  }, [selectedListingIndex]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black bg-opacity-50 overflow-hidden">
      <div className="h-full flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-7xl h-[90vh] flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b bg-gradient-to-r from-indigo-600 to-purple-600">
            <div>
              <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                <span>📜</span> Property Listing History
              </h2>
              <p className="text-indigo-100 text-sm mt-1">
                Compare listings over time to see renovations and price changes
              </p>
            </div>
            <button 
              onClick={onClose}
              className="text-white hover:bg-white/20 rounded-full p-2 transition"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Search Bar */}
          <div className="p-4 border-b bg-gray-50">
            <form onSubmit={handleSearchSubmit} className="flex gap-4">
              <div className="flex-1">
                <input
                  type="text"
                  placeholder="Search by address (e.g., 2185 Alpine Dr)"
                  className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  value={searchAddress}
                  onChange={(e) => setSearchAddress(e.target.value)}
                />
              </div>
              <button
                type="submit"
                disabled={!searchAddress.trim() || loadingHistory}
                className="px-6 py-2 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50 transition"
              >
                {loadingHistory ? 'Searching...' : '🔍 Search'}
              </button>
            </form>
          </div>

          {/* Main Content */}
          <div className="flex-1 overflow-hidden flex">
            {/* Left Sidebar - Properties with Multiple Listings */}
            <div className="w-80 border-r overflow-y-auto bg-gray-50">
              <div className="p-4">
                <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                  <span>🔄</span> Properties with Multiple Listings
                </h3>
                
                {loading && (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
                  </div>
                )}

                {!loading && duplicateAddresses.length === 0 && (
                  <p className="text-sm text-gray-500 text-center py-4">No properties with multiple listings found</p>
                )}

                <div className="space-y-2">
                  {duplicateAddresses.map((addr, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleAddressSelect(addr)}
                      className={`w-full text-left p-3 rounded-lg border transition ${
                        selectedAddress?.UNPARSEDADDRESS === addr.UNPARSEDADDRESS
                          ? 'bg-indigo-50 border-indigo-300 ring-2 ring-indigo-500'
                          : 'bg-white border-gray-200 hover:bg-gray-50 hover:border-gray-300'
                      }`}
                    >
                      <p className="font-medium text-gray-900 text-sm truncate">{addr.UNPARSEDADDRESS}</p>
                      <p className="text-xs text-gray-500">{addr.CITY}, {addr.STATEORPROVINCE}</p>
                      <div className="flex items-center justify-between mt-2">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800">
                          {addr.LISTING_COUNT} listings
                        </span>
                        <span className="text-xs text-gray-400">
                          {formatDate(addr.FIRST_LISTED)} - {formatDate(addr.LAST_LISTED)}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Right Content - Listing Details with Tabs */}
            <div className="flex-1 overflow-hidden flex flex-col">
              {listings.length === 0 && !loadingHistory && (
                <div className="flex-1 flex flex-col items-center justify-center text-gray-500">
                  <svg className="w-16 h-16 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                  <p className="text-lg font-medium">Select a property to view its listing history</p>
                  <p className="text-sm mt-1">Choose from the list or search by address</p>
                </div>
              )}

              {loadingHistory && (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
                    <p className="text-gray-600">Loading listing history...</p>
                  </div>
                </div>
              )}

              {listings.length > 0 && !loadingHistory && (
                <>
                  {/* Listing Period Tabs */}
                  <div className="border-b bg-white px-4 pt-4">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-lg font-semibold text-gray-900">
                        {selectedListing?.UNPARSEDADDRESS}
                      </h3>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-gray-500">View:</span>
                        <button
                          onClick={() => setViewMode('slideshow')}
                          className={`px-3 py-1 rounded-lg text-sm font-medium transition ${
                            viewMode === 'slideshow'
                              ? 'bg-indigo-100 text-indigo-700'
                              : 'text-gray-600 hover:bg-gray-100'
                          }`}
                        >
                          📷 Slideshow
                        </button>
                        <button
                          onClick={() => setViewMode('grid')}
                          className={`px-3 py-1 rounded-lg text-sm font-medium transition ${
                            viewMode === 'grid'
                              ? 'bg-indigo-100 text-indigo-700'
                              : 'text-gray-600 hover:bg-gray-100'
                          }`}
                        >
                          🖼️ All Photos
                        </button>
                      </div>
                    </div>
                    
                    {/* Tabs for each listing period */}
                    <div className="flex gap-1 overflow-x-auto pb-0">
                      {listings.map((listing, idx) => (
                        <button
                          key={listing.LISTINGKEY}
                          onClick={() => setSelectedListingIndex(idx)}
                          className={`flex-shrink-0 px-4 py-3 rounded-t-lg border-b-2 transition ${
                            selectedListingIndex === idx
                              ? 'bg-indigo-50 border-indigo-600 text-indigo-700'
                              : 'border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className={`text-xs px-2 py-0.5 rounded-full ${getStatusColor(listing.STANDARDSTATUS)}`}>
                              {listing.STANDARDSTATUS}
                            </span>
                            <span className="font-semibold">{getListingYear(listing)}</span>
                          </div>
                          <div className="text-sm mt-1">
                            ${listing.LISTPRICE?.toLocaleString()}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Selected Listing Content */}
                  {selectedListing && (
                    <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
                      <div className="grid grid-cols-2 gap-6">
                        {/* Left Column - Images */}
                        <div>
                          {viewMode === 'slideshow' ? (
                            /* Slideshow View */
                            <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                              <div className="relative aspect-video bg-gray-200">
                                {currentImages.length > 0 ? (
                                  <>
                                    <img
                                      src={currentImages[currentImageIndex]?.MEDIAURL}
                                      alt={`Photo ${currentImageIndex + 1}`}
                                      className="w-full h-full object-cover"
                                      onError={(e) => {
                                        (e.target as HTMLImageElement).src = 'https://via.placeholder.com/800x600?text=Image+Not+Available';
                                      }}
                                    />
                                    {/* Navigation arrows */}
                                    <button
                                      onClick={prevImage}
                                      className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white p-2 rounded-full transition"
                                    >
                                      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                                      </svg>
                                    </button>
                                    <button
                                      onClick={nextImage}
                                      className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white p-2 rounded-full transition"
                                    >
                                      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                      </svg>
                                    </button>
                                    {/* Image counter */}
                                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-black/60 text-white px-3 py-1 rounded-full text-sm">
                                      {currentImageIndex + 1} / {currentImages.length}
                                    </div>
                                  </>
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-gray-400">
                                    <div className="text-center">
                                      <svg className="w-16 h-16 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                      </svg>
                                      <p>No photos available</p>
                                    </div>
                                  </div>
                                )}
                              </div>
                              
                              {/* Thumbnail strip */}
                              {currentImages.length > 1 && (
                                <div className="p-3 bg-gray-100 flex gap-2 overflow-x-auto">
                                  {currentImages.slice(0, 10).map((img, idx) => (
                                    <button
                                      key={img.MEDIAKEY}
                                      onClick={() => setCurrentImageIndex(idx)}
                                      className={`flex-shrink-0 w-16 h-12 rounded overflow-hidden border-2 transition ${
                                        currentImageIndex === idx
                                          ? 'border-indigo-500'
                                          : 'border-transparent opacity-70 hover:opacity-100'
                                      }`}
                                    >
                                      <img
                                        src={img.MEDIAURL}
                                        alt={`Thumb ${idx + 1}`}
                                        className="w-full h-full object-cover"
                                        onError={(e) => {
                                          (e.target as HTMLImageElement).style.display = 'none';
                                        }}
                                      />
                                    </button>
                                  ))}
                                  {currentImages.length > 10 && (
                                    <div className="flex-shrink-0 w-16 h-12 rounded bg-gray-300 flex items-center justify-center text-xs text-gray-600 font-medium">
                                      +{currentImages.length - 10}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          ) : (
                            /* Grid View - All Photos */
                            <div className="bg-white rounded-xl shadow-sm p-4">
                              <h4 className="text-sm font-semibold text-gray-700 mb-3">
                                All Photos ({currentImages.length})
                              </h4>
                              <div className="grid grid-cols-3 gap-2 max-h-[500px] overflow-y-auto">
                                {currentImages.map((img, idx) => (
                                  <div
                                    key={img.MEDIAKEY}
                                    className="aspect-square bg-gray-200 rounded-lg overflow-hidden cursor-pointer hover:opacity-90 transition"
                                    onClick={() => {
                                      setCurrentImageIndex(idx);
                                      setViewMode('slideshow');
                                    }}
                                  >
                                    <img
                                      src={img.MEDIAURL}
                                      alt={`Photo ${idx + 1}`}
                                      className="w-full h-full object-cover"
                                      onError={(e) => {
                                        (e.target as HTMLImageElement).src = 'https://via.placeholder.com/200x200?text=N/A';
                                      }}
                                    />
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Right Column - Property Metrics */}
                        <div className="space-y-4">
                          {/* Price Information */}
                          <div className="bg-white rounded-xl shadow-sm p-4">
                            <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                              Pricing
                            </h4>
                            <div className="space-y-3">
                              <div className="flex justify-between items-center">
                                <span className="text-gray-600">List Price</span>
                                <span className="text-2xl font-bold text-gray-900">
                                  ${selectedListing.LISTPRICE?.toLocaleString()}
                                </span>
                              </div>
                              {selectedListing.ORIGINALLISTPRICE && selectedListing.ORIGINALLISTPRICE !== selectedListing.LISTPRICE && (
                                <div className="flex justify-between items-center">
                                  <span className="text-gray-600">Original List Price</span>
                                  <span className="text-lg text-gray-500 line-through">
                                    ${selectedListing.ORIGINALLISTPRICE?.toLocaleString()}
                                  </span>
                                </div>
                              )}
                              {selectedListing.CLOSEPRICE && (
                                <div className="flex justify-between items-center pt-2 border-t">
                                  <span className="text-gray-600 font-medium">Sold Price</span>
                                  <span className="text-2xl font-bold text-green-600">
                                    ${selectedListing.CLOSEPRICE?.toLocaleString()}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Property Stats Grid */}
                          <div className="bg-white rounded-xl shadow-sm p-4">
                            <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                              Property Details
                            </h4>
                            <div className="grid grid-cols-2 gap-4">
                              <div className="text-center p-3 bg-gray-50 rounded-lg">
                                <p className="text-3xl font-bold text-gray-900">{selectedListing.BEDROOMSTOTAL || 0}</p>
                                <p className="text-sm text-gray-500">Bedrooms</p>
                              </div>
                              <div className="text-center p-3 bg-gray-50 rounded-lg">
                                <p className="text-3xl font-bold text-gray-900">{selectedListing.BATHROOMSTOTALINTEGER || 0}</p>
                                <p className="text-sm text-gray-500">Bathrooms</p>
                              </div>
                              <div className="text-center p-3 bg-gray-50 rounded-lg">
                                <p className="text-3xl font-bold text-gray-900">
                                  {selectedListing.LIVINGAREA?.toLocaleString() || 'N/A'}
                                </p>
                                <p className="text-sm text-gray-500">Sq Ft</p>
                              </div>
                              <div className="text-center p-3 bg-gray-50 rounded-lg">
                                <p className="text-3xl font-bold text-gray-900">
                                  {selectedListing.DAYSONMARKET ?? 'N/A'}
                                </p>
                                <p className="text-sm text-gray-500">Days on Market</p>
                              </div>
                            </div>
                          </div>

                          {/* Timeline Information */}
                          <div className="bg-white rounded-xl shadow-sm p-4">
                            <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                              Listing Timeline
                            </h4>
                            <div className="space-y-2">
                              <div className="flex justify-between text-sm">
                                <span className="text-gray-600">Status</span>
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getStatusColor(selectedListing.STANDARDSTATUS)}`}>
                                  {selectedListing.STANDARDSTATUS}
                                </span>
                              </div>
                              <div className="flex justify-between text-sm">
                                <span className="text-gray-600">On Market</span>
                                <span className="font-medium">{formatDate(selectedListing.ONMARKETDATE)}</span>
                              </div>
                              <div className="flex justify-between text-sm">
                                <span className="text-gray-600">Off Market</span>
                                <span className="font-medium">{formatDate(selectedListing.OFFMARKETDATE)}</span>
                              </div>
                              {selectedListing.CLOSEDATE && (
                                <div className="flex justify-between text-sm">
                                  <span className="text-gray-600">Closed Date</span>
                                  <span className="font-medium text-green-600">{formatDate(selectedListing.CLOSEDATE)}</span>
                                </div>
                              )}
                              <div className="flex justify-between text-sm">
                                <span className="text-gray-600">Photos</span>
                                <span className="font-medium">{currentImages.length} photos</span>
                              </div>
                            </div>
                          </div>

                          {/* Comparison with other listings */}
                          {listings.length > 1 && (
                            <div className="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl p-4 border border-indigo-100">
                              <h4 className="text-sm font-semibold text-indigo-700 mb-2">
                                📊 Listing Comparison
                              </h4>
                              <p className="text-sm text-gray-600 mb-3">
                                This property has been listed <span className="font-bold">{listings.length} times</span>
                              </p>
                              <div className="space-y-2">
                                {listings.map((listing, idx) => (
                                  <div
                                    key={listing.LISTINGKEY}
                                    className={`flex items-center justify-between text-sm p-2 rounded ${
                                      idx === selectedListingIndex ? 'bg-indigo-100' : 'bg-white/50'
                                    }`}
                                  >
                                    <div className="flex items-center gap-2">
                                      <span className={`w-2 h-2 rounded-full ${
                                        listing.STANDARDSTATUS === 'Closed' ? 'bg-green-500' :
                                        listing.STANDARDSTATUS === 'Active' ? 'bg-blue-500' :
                                        listing.STANDARDSTATUS === 'Expired' ? 'bg-orange-500' :
                                        'bg-gray-400'
                                      }`}></span>
                                      <span className="font-medium">{getListingYear(listing)}</span>
                                      <span className="text-gray-500 text-xs">{listing.STANDARDSTATUS}</span>
                                    </div>
                                    <div className="text-right">
                                      <span className="font-medium">${listing.LISTPRICE?.toLocaleString()}</span>
                                      {listing.CLOSEPRICE && (
                                        <span className="text-green-600 text-xs ml-2">
                                          → ${listing.CLOSEPRICE?.toLocaleString()}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}

              {error && (
                <div className="m-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
                  {error}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="p-3 border-t bg-gray-50 text-center text-sm text-gray-500">
            Historical MLS data from Snowflake • Compare listings over time to track property changes
          </div>
        </div>
      </div>
    </div>
  );
};

export default PropertyListingHistoryModal;
