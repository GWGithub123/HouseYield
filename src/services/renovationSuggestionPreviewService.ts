/**
 * Renovation Suggestion Preview Service
 * 
 * Generates AI-powered "after" preview images for renovation suggestions
 * using Nano Banana Pro (Gemini 2.5 Flash Image) via the backend API.
 * 
 * Key feature: Uses the REAL products/materials found from live retailer 
 * searches (Home Depot, Lowe's, etc.) so the preview shows exactly what
 * the renovation would look like with those specific materials installed.
 */

import { auth } from '../config/firebase';

export interface RenovationSuggestion {
  id: string;
  name: string;
  type?: string;
  summary: string;
  details?: string;
  cost: number;
  costRange?: { low: number; high: number };
  materialBreakdown?: Array<{
    item: string;
    quantity: number;
    unit: string;
    unitCost?: number;
    totalCost?: number;
  }>;
  shoppableProducts?: {
    totalMaterialEstimate?: number;
    recommendations: Record<string, {
      products: Array<{
        title: string;
        url: string;
        price: number | null;
        image: string | null;
        retailer?: { name: string; hasLocalStores?: boolean };
        snippet?: string;
      }>;
      priceRange?: { low: number; high: number };
    }>;
    localStoreLinks?: Array<{ retailer: string; storeLocatorUrl: string }>;
    note?: string;
  };
  canonicalContext?: {
    primaryKey: string;
    source: string;
    canonicalOpportunityId: string | null;
    canonicalRoomType: string | null;
    canonicalCategory: string | null;
    canonicalScopeType: string | null;
    canonicalTriggerFindingIds?: string[];
    triggerFindingCount?: number;
    measurementMatched?: boolean;
    measuredRoomType?: string | null;
    sourcePhotoIndexes?: number[];
  };
  canonicalResult?: {
    resultId: string;
    primaryKey: string;
    source: string;
    canonicalOpportunityId: string | null;
    canonicalRoomType: string | null;
    canonicalCategory: string | null;
    canonicalScopeType: string | null;
    costEstimateId?: string;
    rentEstimateId?: string;
    valueEstimateId?: string;
    roiResultId?: string;
    triggerFindingIds?: string[];
    triggerFindingCount?: number;
    measurementMatched?: boolean;
    measuredRoomType?: string | null;
    sourcePhotoIndexes?: number[];
    sourcePhotoCount?: number;
  };
  [key: string]: any;
}

export interface PreviewResult {
  success: boolean;
  previewImageUrl?: string;
  previews?: Array<{
    index: number;
    success: boolean;
    previewImageUrl: string | null;
    description: string | null;
    originalImageIndex: number;
  }>;
  description?: string;
  renovationName?: string;
  renovationType?: string;
  totalImages?: number;
  successCount?: number;
  productsUsed?: Array<{
    category: string;
    title: string;
    price: number | null;
    retailer?: string;
    url?: string;
    image?: string;
  }>;
  chosenMaterial?: {
    title: string;
    price: number | null;
    retailer: string | null;
    image: string | null;
    url: string | null;
    snippet: string | null;
    source: 'auto' | 'selected' | 'custom';
  };
  availableProducts?: Array<{
    category: string;
    title: string;
    price: number | null;
    retailer: string | null;
    url: string;
    image: string | null;
    snippet: string | null;
  }>;
  error?: string;
  timestamp?: string;
  // Firebase storage references (set after save)
  firebaseStorageUrls?: Array<{ angleIndex: number; downloadUrl: string; storagePath: string }>;
  firestoreDocId?: string;
}

// Cache to avoid regenerating previews
const previewCache = new Map<string, PreviewResult>();

/**
 * Generate AI renovation previews for a suggestion card.
 * Sends ALL uploaded property images so previews are generated from every angle.
 * Uses the actual products found from live retailer searches.
 * Optionally accepts a user-selected material or custom material description.
 */
export async function generateSuggestionPreview(
  propertyImageDataUrls: string[],
  suggestion: RenovationSuggestion,
  propertyAddress?: string,
  selectedMaterial?: { title: string; price?: number | null; retailer?: string; snippet?: string; image?: string } | null,
  customMaterialDescription?: string | null
): Promise<PreviewResult> {
  // Check cache first
  const materialKey = customMaterialDescription || selectedMaterial?.title || 'auto';
  const cacheKey = `${suggestion.id}-${propertyImageDataUrls.length}-${materialKey}-${propertyImageDataUrls[0]?.substring(0, 40)}`;
  const cached = previewCache.get(cacheKey);
  if (cached) {
    console.log('[Preview Service] Returning cached preview for:', suggestion.name, 'material:', materialKey);
    return cached;
  }

  console.log('[Preview Service] Generating previews for:', suggestion.name, `(${propertyImageDataUrls.length} images, material: ${materialKey})`);

  try {
    const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
    const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
    const url = useProxy
      ? '/api/renovation-preview/generate-suggestion-preview'
      : `${baseEnv}/api/renovation-preview/generate-suggestion-preview`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        images: propertyImageDataUrls,
        suggestion: {
          id: suggestion.id,
          name: suggestion.name,
          type: suggestion.type,
          summary: suggestion.summary,
          details: suggestion.details,
          materialBreakdown: suggestion.materialBreakdown,
          canonicalContext: suggestion.canonicalContext || null,
          canonicalResult: suggestion.canonicalResult || null,
        },
        shoppableProducts: suggestion.shoppableProducts || null,
        propertyAddress: propertyAddress || '',
        selectedMaterial: selectedMaterial || null,
        customMaterialDescription: customMaterialDescription || null,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(errorData.error || `Server error: ${response.status}`);
    }

    const result: PreviewResult = await response.json();

    // Cache successful results
    if (result.success && result.previewImageUrl) {
      previewCache.set(cacheKey, result);
    }

    return result;
  } catch (error: any) {
    console.error('[Preview Service] Error generating preview:', error);
    return {
      success: false,
      error: error.message || 'Failed to generate renovation preview',
    };
  }
}

/**
 * Clear the preview cache (e.g., when images change)
 */
export function clearPreviewCache(): void {
  previewCache.clear();
}

/**
 * Get a cached preview if available
 */
export function getCachedPreview(suggestionId: string): PreviewResult | null {
  for (const [key, value] of previewCache.entries()) {
    if (key.startsWith(suggestionId)) {
      return value;
    }
  }
  return null;
}

// ============================================================================
// Backend persistence — preview assets + Firestore docs saved by Cloud Run
// ============================================================================

function getRenovationPreviewApiUrl(path: string): string {
  const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
  const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
  return useProxy ? `/api/renovation-preview${path}` : `${baseEnv}/api/renovation-preview${path}`;
}

async function getRenovationPreviewHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Authentication required to persist renovation previews');
  }

  headers.Authorization = `Bearer ${await currentUser.getIdToken()}`;
  return headers;
}

/**
 * Save all preview images to Firebase Storage and metadata to Firestore.
 * Links them to the user's account and their property.
 */
export async function savePreviewToFirebase(
  userId: string,
  propertyId: string,
  propertyAddress: string,
  suggestion: Pick<RenovationSuggestion, 'id' | 'name' | 'type' | 'summary' | 'canonicalContext' | 'canonicalResult'>,
  previewResult: PreviewResult,
  originalImageUrls: string[]
): Promise<{ firestoreDocId: string; storageUrls: Array<{ angleIndex: number; downloadUrl: string; storagePath: string }> }> {
  const response = await fetch(getRenovationPreviewApiUrl('/save-preview'), {
    method: 'POST',
    headers: await getRenovationPreviewHeaders(),
    body: JSON.stringify({
      userId,
      propertyId,
      propertyAddress,
      suggestion,
      previewResult,
      originalImageUrls,
    }),
  });

  const result = await response.json().catch(() => ({ ok: false, error: 'invalid_preview_save_response' }));
  if (!response.ok || !result?.ok) {
    throw new Error(result?.error || `Failed to save preview (${response.status})`);
  }

  return {
    firestoreDocId: result.firestoreDocId,
    storageUrls: result.storageUrls || [],
  };
}

/**
 * Load saved renovation previews for a user's property from Firestore
 */
export async function loadSavedPreviews(
  userId: string,
  propertyId: string
): Promise<Array<{
  id: string;
  renovationId: string;
  renovationName: string;
  renovationType: string;
  renovationSummary?: string;
  canonicalResultId?: string;
  canonicalPrimaryKey?: string | null;
  canonicalSource?: string | null;
  canonicalOpportunityId?: string | null;
  canonicalRoomType?: string | null;
  canonicalCategory?: string | null;
  canonicalScopeType?: string | null;
  canonicalMeasuredScope?: boolean | null;
  canonicalTriggerFindingCount?: number | null;
  chosenMaterial: any;
  previewImages: Array<{ angleIndex: number; downloadUrl: string }>;
  originalImages: Array<{ angleIndex: number; downloadUrl: string }>;
  productsUsed: any[];
  createdAt: string;
}>> {
  try {
    const url = new URL(getRenovationPreviewApiUrl('/saved-previews'), window.location.origin);
    url.searchParams.set('userId', userId);
    url.searchParams.set('propertyId', propertyId);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: await getRenovationPreviewHeaders(),
    });
    const result = await response.json().catch(() => ({ ok: false, error: 'invalid_saved_preview_response' }));

    if (!response.ok || !result?.ok) {
      throw new Error(result?.error || `Failed to load saved previews (${response.status})`);
    }

    return result.previews || [];
  } catch (err) {
    console.error('[Preview Service] Failed to load saved previews via backend:', err);
    return [];
  }
}

/**
 * Update saved preview when user regenerates with a different material
 */
export async function updateSavedPreviewMaterial(
  firestoreDocId: string,
  newPreviewResult: PreviewResult,
  userId: string,
  propertyId: string,
  suggestionId: string,
  suggestion?: Pick<RenovationSuggestion, 'name' | 'canonicalContext' | 'canonicalResult'>
): Promise<void> {
  const response = await fetch(getRenovationPreviewApiUrl('/update-saved-preview-material'), {
    method: 'POST',
    headers: await getRenovationPreviewHeaders(),
    body: JSON.stringify({
      firestoreDocId,
      newPreviewResult,
      userId,
      propertyId,
      suggestionId,
      suggestion,
    }),
  });

  const result = await response.json().catch(() => ({ ok: false, error: 'invalid_preview_update_response' }));
  if (!response.ok || !result?.ok) {
    throw new Error(result?.error || `Failed to update saved preview (${response.status})`);
  }

  console.log(`[Preview Service] ✅ Updated preview ${firestoreDocId} via backend`);
}