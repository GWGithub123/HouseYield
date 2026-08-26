/**
 * Firebase Auth & Firestore Service
 * Handles authentication and database operations for the marketplace
 */

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  User as FirebaseUser,
  updateProfile,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  addDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  Timestamp,
  deleteDoc,
  arrayUnion,
  increment
} from 'firebase/firestore';
import { auth, db } from '../config/firebase';
import type {
  AssistantMemoryExchange,
  AssistantMemoryProfile,
  AssistantMemorySessionSummary,
} from '../types/assistantMemory';
import type { MarketplaceListing, MarketplaceBid, Contractor, ListingComment } from '../types/contractorMarketplace';

// Google Auth Provider
const googleProvider = new GoogleAuthProvider();
// Always show account picker so the user explicitly chooses their Google account.
// Without this, Firebase silently reuses a cached session, bypassing the picker.
googleProvider.setCustomParameters({ prompt: 'select_account' });

const GOOGLE_REDIRECT_ROLE_KEY = 'rr_google_redirect_role';

function shouldUseGoogleRedirectSignIn(role: UserProfile['role']) {
  return false;
}

function persistPendingGoogleRole(role: UserProfile['role']) {
  if (typeof window === 'undefined') {
    return;
  }

  window.sessionStorage.setItem(GOOGLE_REDIRECT_ROLE_KEY, role);
}

export function consumePendingGoogleRole(): UserProfile['role'] | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const storedRole = window.sessionStorage.getItem(GOOGLE_REDIRECT_ROLE_KEY);
  window.sessionStorage.removeItem(GOOGLE_REDIRECT_ROLE_KEY);

  return storedRole === 'owner' || storedRole === 'tenant' || storedRole === 'contractor'
    ? storedRole
    : null;
}

async function ensureContractorProfile(firebaseUser: FirebaseUser) {
  const contractorRef = doc(db, 'contractors', firebaseUser.uid);
  const contractorDoc = await getDoc(contractorRef);
  if (contractorDoc.exists()) {
    return;
  }

  await setDoc(contractorRef, {
    id: firebaseUser.uid,
    companyName: firebaseUser.displayName || 'My Company',
    email: firebaseUser.email || '',
    phone: '',
    licenseNumber: '',
    serviceArea: '',
    specialties: [],
    yearsInBusiness: 0,
    rating: { overall: 0, totalReviews: 0 },
    verified: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

async function upsertGoogleUserProfile(
  firebaseUser: FirebaseUser,
  role: UserProfile['role']
): Promise<UserProfile> {
  const userRef = doc(db, 'users', firebaseUser.uid);
  const userDoc = await getDoc(userRef);

  if (!userDoc.exists()) {
    const userProfile: UserProfile = {
      id: firebaseUser.uid,
      email: firebaseUser.email || '',
      name: firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'User',
      role,
      // Only include photoURL when it exists — Firestore rejects undefined values.
      ...(firebaseUser.photoURL ? { photoURL: firebaseUser.photoURL } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // New owners start with an empty portfolio and enter the onboarding wizard.
      // Real properties are created via the owner-properties API during onboarding.
      ...(role === 'owner' ? { onboardingStatus: 'not_started' as const, onboardingStep: 0 } : {}),
    };

    await setDoc(userRef, userProfile);

    if (role === 'contractor') {
      await ensureContractorProfile(firebaseUser);
    }

    return userProfile;
  }

  const existingProfile = userDoc.data() as UserProfile;
  const needsPhotoUpdate = !existingProfile.photoURL && firebaseUser.photoURL;
  const resolvedPhotoURL = existingProfile.photoURL || firebaseUser.photoURL || null;
  const nextProfile: UserProfile = {
    ...existingProfile,
    role,
    ...(resolvedPhotoURL ? { photoURL: resolvedPhotoURL } : {}),
    updatedAt: new Date().toISOString(),
    properties: existingProfile.properties,
  };

  const updateData: Partial<UserProfile> = {
    updatedAt: nextProfile.updatedAt,
  };

  if (existingProfile.role !== role) {
    updateData.role = role;
  }

  if (needsPhotoUpdate && firebaseUser.photoURL) {
    updateData.photoURL = firebaseUser.photoURL;
  }

  if (existingProfile.role !== role || needsPhotoUpdate) {
    await updateDoc(userRef, updateData as Record<string, unknown>);
  }

  if (role === 'contractor') {
    await ensureContractorProfile(firebaseUser);
  }

  return nextProfile;
}

// ============================================================================
// User Types
// ============================================================================

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'tenant' | 'contractor';
  createdAt: string;
  updatedAt: string;
  photoURL?: string; // Profile photo URL (from Google or custom upload)
  // Owner fields
  properties?: string[];
  // Owner onboarding + subscription (platform billing) fields
  onboardingStatus?: 'not_started' | 'in_progress' | 'complete';
  onboardingStep?: number;
  selectedPlanId?: 'light' | 'standard' | 'premium' | null;
  planId?: 'light' | 'standard' | 'premium' | null;
  subscriptionStatus?: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  ownerProfile?: Record<string, unknown> | null;
  // Tenant fields
  tenantId?: string;
  propertyId?: string;
  propertyAddress?: string;
  unit?: string;
  landlordAccountId?: string;
  leaseStart?: string;
  leaseEnd?: string;
  monthlyRent?: number | null;
  // User preference fields
  retirementScenarios?: Array<Record<string, unknown>>;
  trustedProviders?: Array<Record<string, unknown>>;
  absenteeBuyerInfo?: Record<string, unknown> | null;
  financialPlannerSnapshot?: Record<string, unknown> | null;
  financialPlannerDraftScenarios?: Array<Record<string, unknown>>;
  financialPlannerWorkspaceUpdatedAt?: string | null;
  assistantMemoryProfile?: AssistantMemoryProfile | null;
  assistantMemoryRecentExchanges?: AssistantMemoryExchange[];
  assistantMemoryRecentSessions?: AssistantMemorySessionSummary[];
  // Contractor fields
  companyName?: string;
  phone?: string;
  licenseNumber?: string;
  serviceArea?: string;
  specialties?: string[];
  yearsInBusiness?: number;
  rating?: { overall: number; totalReviews: number };
}

// ============================================================================
// Authentication Functions
// ============================================================================

/**
 * Register a new user with email and password
 */
export async function registerUser(
  email: string,
  password: string,
  role: 'owner' | 'tenant' | 'contractor',
  profileData: Partial<UserProfile>
): Promise<{ success: boolean; user?: UserProfile; error?: string }> {
  try {
    // Create auth user
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const firebaseUser = userCredential.user;

    // Update display name
    const displayName = profileData.name || profileData.companyName || email.split('@')[0];
    await updateProfile(firebaseUser, { displayName });

    // Create user profile in Firestore.
    // Strip undefined values — Firestore rejects them and throws "Unsupported field value: undefined".
    const userProfile: UserProfile = {
      id: firebaseUser.uid,
      email: email,
      name: displayName,
      role: role,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...profileData
    };
    const cleanProfile = Object.fromEntries(
      Object.entries(userProfile).filter(([, v]) => v !== undefined)
    );

    await setDoc(doc(db, 'users', firebaseUser.uid), cleanProfile);

    if (role === 'contractor') {
      const extProfile = profileData as any;
      await setDoc(doc(db, 'contractors', firebaseUser.uid), {
        id: firebaseUser.uid,
        companyName: profileData.companyName || displayName,
        email: email,
        phone: profileData.phone || '',
        licenseNumber: profileData.licenseNumber || '',
        serviceArea: profileData.serviceArea || extProfile.zipCode || '',
        specialties: profileData.specialties || [],
        yearsInBusiness: profileData.yearsInBusiness || 0,
        // DUNS verification
        dunsNumber: extProfile.dunsNumber || '',
        dunsVerified: extProfile.dunsVerified || false,
        dunsVerifiedAt: extProfile.dunsVerified ? new Date().toISOString() : null,
        dunsData: extProfile.dunsData || null,
        // Location for region-based filtering
        location: {
          city: extProfile.dunsData?.primaryAddress?.city || '',
          state: extProfile.dunsData?.primaryAddress?.state || '',
          zipCode: extProfile.zipCode || '',
          serviceRadius: extProfile.serviceRadius || 50
        },
        rating: { overall: 0, totalReviews: 0 },
        verified: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }

    return { success: true, user: userProfile };
  } catch (error: any) {
    console.error('[FirebaseService] registerUser error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Sign in with email and password
 */
export async function loginUser(
  email: string,
  password: string,
  expectedRole: UserProfile['role'] | null = null
): Promise<{ success: boolean; user?: UserProfile; error?: string }> {
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const firebaseUser = userCredential.user;
    const userRef = doc(db, 'users', firebaseUser.uid);

    // Get user profile from Firestore
    const userDoc = await getDoc(userRef);
    
    if (!userDoc.exists()) {
      // Profile doesn't exist, create a basic one
      const role = expectedRole || 'owner';
      const basicProfile: UserProfile = {
        id: firebaseUser.uid,
        email: firebaseUser.email || email,
        name: firebaseUser.displayName || email.split('@')[0],
        role,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await setDoc(userRef, basicProfile);

      if (role === 'contractor') {
        await ensureContractorProfile(firebaseUser);
      }

      return { success: true, user: basicProfile };
    }

    const currentProfile = userDoc.data() as UserProfile;
    if (expectedRole && currentProfile.role !== expectedRole) {
      const repairedProfile: UserProfile = {
        ...currentProfile,
        email: currentProfile.email || firebaseUser.email || email,
        name: currentProfile.name || firebaseUser.displayName || email.split('@')[0],
        role: expectedRole,
        updatedAt: new Date().toISOString(),
      };

      await setDoc(userRef, repairedProfile, { merge: true });

      if (expectedRole === 'contractor') {
        await ensureContractorProfile(firebaseUser);
      }

      return { success: true, user: repairedProfile };
    }

    if (currentProfile.role === 'contractor') {
      await ensureContractorProfile(firebaseUser);
    }

    return { success: true, user: currentProfile };
  } catch (error: any) {
    console.error('[FirebaseService] loginUser error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Sign out the current user
 */
export async function logoutUser(): Promise<void> {
  await signOut(auth);
}

/**
 * Sign in with Google
 */
export async function signInWithGoogle(
  role: 'owner' | 'tenant' | 'contractor'
): Promise<{ success: boolean; user?: UserProfile; error?: string }> {
  try {
    if (shouldUseGoogleRedirectSignIn(role)) {
      persistPendingGoogleRole(role);
      await signInWithRedirect(auth, googleProvider);
      // Redirect-based auth navigates away immediately; keep this promise pending
      // so callers do not continue local navigation before Firebase returns.
      return await new Promise(() => {});
    }

    const result = await signInWithPopup(auth, googleProvider);
    const firebaseUser = result.user;
    const userProfile = await upsertGoogleUserProfile(firebaseUser, role);
    return { success: true, user: userProfile };
  } catch (error: any) {
    console.error('[FirebaseService] signInWithGoogle error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get current user profile
 */
/**
 * Add a property address to the user's profile properties array (append, not replace)
 */
export async function addPropertyToUserProfile(userId: string, propertyAddress: string): Promise<{ success: boolean; error?: string }> {
  try {
    const userRef = doc(db, 'users', userId);
    const userDoc = await getDoc(userRef);
    
    if (!userDoc.exists()) {
      return { success: false, error: 'User profile not found' };
    }
    
    // Use arrayUnion to append without duplicating
    await updateDoc(userRef, {
      properties: arrayUnion(propertyAddress),
      updatedAt: new Date().toISOString()
    });
    
    console.log('[FirebaseService] Added property to user profile:', propertyAddress);
    return { success: true };
  } catch (error: any) {
    console.error('[FirebaseService] addPropertyToUserProfile error:', error);
    return { success: false, error: error.message };
  }
}

export async function getCurrentUserProfile(): Promise<UserProfile | null> {
  const firebaseUser = auth.currentUser;
  if (!firebaseUser) return null;

  const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
  return userDoc.exists() ? (userDoc.data() as UserProfile) : null;
}

export async function ensureCurrentUserProfile(
  fallbackRole: UserProfile['role'] | null = null
): Promise<UserProfile | null> {
  const firebaseUser = auth.currentUser;
  if (!firebaseUser) {
    return null;
  }

  const existingProfile = await getCurrentUserProfile();
  if (existingProfile) {
    if (fallbackRole && existingProfile.role !== fallbackRole) {
      return upsertGoogleUserProfile(firebaseUser, fallbackRole);
    }

    if (existingProfile.role === 'contractor') {
      await ensureContractorProfile(firebaseUser);
    }

    if (!existingProfile.photoURL && firebaseUser.photoURL) {
      await updateDoc(doc(db, 'users', firebaseUser.uid), {
        photoURL: firebaseUser.photoURL,
        updatedAt: new Date().toISOString(),
      });

      return {
        ...existingProfile,
        photoURL: firebaseUser.photoURL,
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      ...existingProfile,
      photoURL: existingProfile.photoURL || firebaseUser.photoURL || undefined,
    };
  }

  return upsertGoogleUserProfile(firebaseUser, fallbackRole || 'owner');
}

/**
 * Listen to auth state changes
 */
export function onAuthChange(callback: (user: FirebaseUser | null) => void) {
  return onAuthStateChanged(auth, callback);
}

// ============================================================================
// Marketplace Listings Functions
// ============================================================================

/**
 * Create a new marketplace listing
 * Ensures the propertyOwnerId is set to the Firebase auth UID for proper permissions
 */
export async function createListing(
  listingData: Omit<MarketplaceListing, 'id' | 'createdAt' | 'updatedAt' | 'bids'>
): Promise<{ success: boolean; listing?: MarketplaceListing; error?: string }> {
  try {
    const firebaseUser = auth.currentUser;
    
    // Warn if creating listing without Firebase auth (permissions may fail on edit/delete)
    if (!firebaseUser) {
      console.warn('[FirebaseService] createListing: No Firebase user logged in. Listing may not be editable/deletable.');
    }
    
    // Override propertyOwnerId with Firebase UID if available (critical for permissions)
    const finalListingData = {
      ...listingData,
      propertyOwnerId: firebaseUser?.uid || listingData.propertyOwnerId,
      bids: [],
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now()
    };
    
    const listingRef = await addDoc(collection(db, 'marketplace_listings'), finalListingData);

    const newListing: MarketplaceListing = {
      id: listingRef.id,
      ...listingData,
      propertyOwnerId: finalListingData.propertyOwnerId,
      bids: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as MarketplaceListing;

    return { success: true, listing: newListing };
  } catch (error: any) {
    console.error('[FirebaseService] createListing error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get all active marketplace listings
 */
export async function getActiveListings(): Promise<MarketplaceListing[]> {
  try {
    const q = query(
      collection(db, 'marketplace_listings'),
      where('status', '==', 'active'),
      orderBy('createdAt', 'desc')
    );
    
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || doc.data().createdAt,
      updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() || doc.data().updatedAt
    })) as MarketplaceListing[];
  } catch (error: any) {
    console.error('[FirebaseService] getActiveListings error:', error);
    return [];
  }
}

/**
 * Get listings by owner ID
 */
export async function getOwnerListings(ownerId: string): Promise<MarketplaceListing[]> {
  try {
    const q = query(
      collection(db, 'marketplace_listings'),
      where('propertyOwnerId', '==', ownerId),
      orderBy('createdAt', 'desc')
    );
    
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || doc.data().createdAt,
      updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() || doc.data().updatedAt
    })) as MarketplaceListing[];
  } catch (error: any) {
    console.error('[FirebaseService] getOwnerListings error:', error);
    return [];
  }
}

/**
 * Subscribe to listing updates (real-time)
 */
export function subscribeToListings(
  callback: (listings: MarketplaceListing[]) => void
) {
  const q = query(
    collection(db, 'marketplace_listings'),
    where('status', '==', 'active'),
    orderBy('createdAt', 'desc')
  );

  return onSnapshot(q, (snapshot) => {
    const listings = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || doc.data().createdAt,
      updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() || doc.data().updatedAt
    })) as MarketplaceListing[];
    callback(listings);
  });
}

/**
 * Update a listing
 * Requires the user to be authenticated via Firebase and be the listing owner
 */
export async function updateListing(
  listingId: string,
  updates: Partial<MarketplaceListing>
): Promise<{ success: boolean; error?: string }> {
  try {
    const firebaseUser = auth.currentUser;
    
    // Check if user is authenticated via Firebase
    if (!firebaseUser) {
      console.warn('[FirebaseService] updateListing: No Firebase user logged in');
      return { 
        success: false, 
        error: 'You must be logged in with a Firebase account to update listings. Please sign in with Google or create an account.' 
      };
    }
    
    // Verify the user owns this listing before attempting update
    const listingRef = doc(db, 'marketplace_listings', listingId);
    const listingDoc = await getDoc(listingRef);
    
    if (!listingDoc.exists()) {
      return { success: false, error: 'Listing not found' };
    }
    
    const listingData = listingDoc.data();
    if (listingData.propertyOwnerId !== firebaseUser.uid) {
      console.warn(`[FirebaseService] updateListing: UID mismatch. Firebase UID: ${firebaseUser.uid}, Listing owner: ${listingData.propertyOwnerId}`);
      return { 
        success: false, 
        error: 'You do not have permission to update this listing. The listing may have been created with a different account.' 
      };
    }
    
    // Don't allow changing the owner ID
    const { propertyOwnerId: _ignored, ...safeUpdates } = updates as any;
    
    await updateDoc(listingRef, {
      ...safeUpdates,
      updatedAt: Timestamp.now()
    });
    return { success: true };
  } catch (error: any) {
    console.error('[FirebaseService] updateListing error:', error);
    
    // Provide more helpful error messages
    if (error.code === 'permission-denied' || error.message?.includes('permissions')) {
      return { 
        success: false, 
        error: 'Missing or insufficient permissions. Please ensure you are logged in with the same account that created this listing.' 
      };
    }
    
    return { success: false, error: error.message };
  }
}

/**
 * Delete a listing
 * Requires the user to be authenticated via Firebase and be the listing owner
 */
export async function deleteListing(listingId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const firebaseUser = auth.currentUser;
    
    // Check if user is authenticated via Firebase
    if (!firebaseUser) {
      console.warn('[FirebaseService] deleteListing: No Firebase user logged in');
      return { 
        success: false, 
        error: 'You must be logged in with a Firebase account to delete listings. Please sign in with Google or create an account.' 
      };
    }
    
    // Verify the user owns this listing before attempting delete
    const listingRef = doc(db, 'marketplace_listings', listingId);
    const listingDoc = await getDoc(listingRef);
    
    if (!listingDoc.exists()) {
      return { success: false, error: 'Listing not found' };
    }
    
    const listingData = listingDoc.data();
    if (listingData.propertyOwnerId !== firebaseUser.uid) {
      console.warn(`[FirebaseService] deleteListing: UID mismatch. Firebase UID: ${firebaseUser.uid}, Listing owner: ${listingData.propertyOwnerId}`);
      return { 
        success: false, 
        error: 'You do not have permission to delete this listing. The listing may have been created with a different account.' 
      };
    }
    
    await deleteDoc(listingRef);
    return { success: true };
  } catch (error: any) {
    console.error('[FirebaseService] deleteListing error:', error);
    
    // Provide more helpful error messages
    if (error.code === 'permission-denied' || error.message?.includes('permissions')) {
      return { 
        success: false, 
        error: 'Missing or insufficient permissions. Please ensure you are logged in with the same account that created this listing.' 
      };
    }
    
    return { success: false, error: error.message };
  }
}

// ============================================================================
// Bid Functions
// ============================================================================

/**
 * Submit a bid on a listing
 */
export async function submitBid(
  listingId: string,
  bidData: Omit<MarketplaceBid, 'id' | 'createdAt' | 'updatedAt'>
): Promise<{ success: boolean; bid?: MarketplaceBid; error?: string }> {
  try {
    // Add bid to bids subcollection
    const bidRef = await addDoc(collection(db, 'marketplace_listings', listingId, 'bids'), {
      ...bidData,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now()
    });

    // Also update the listing's bids array for denormalization
    const listingRef = doc(db, 'marketplace_listings', listingId);
    const listingDoc = await getDoc(listingRef);
    
    if (listingDoc.exists()) {
      const existingBids = listingDoc.data().bids || [];
      const newBid = {
        id: bidRef.id,
        ...bidData,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      await updateDoc(listingRef, {
        bids: [...existingBids, newBid],
        updatedAt: Timestamp.now()
      });

      return { success: true, bid: newBid as MarketplaceBid };
    }

    return { success: false, error: 'Listing not found' };
  } catch (error: any) {
    console.error('[FirebaseService] submitBid error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get bids for a listing
 */
export async function getListingBids(listingId: string): Promise<MarketplaceBid[]> {
  try {
    const q = query(
      collection(db, 'marketplace_listings', listingId, 'bids'),
      orderBy('createdAt', 'desc')
    );
    
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || doc.data().createdAt,
      updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() || doc.data().updatedAt
    })) as MarketplaceBid[];
  } catch (error: any) {
    console.error('[FirebaseService] getListingBids error:', error);
    return [];
  }
}

/**
 * Get contractor's submitted bids
 */
export async function getContractorBids(contractorId: string): Promise<MarketplaceBid[]> {
  try {
    // This requires a collection group query across all bids subcollections
    const q = query(
      collection(db, 'contractor_bids'),
      where('contractorId', '==', contractorId),
      orderBy('createdAt', 'desc')
    );
    
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || doc.data().createdAt,
      updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() || doc.data().updatedAt
    })) as MarketplaceBid[];
  } catch (error: any) {
    console.error('[FirebaseService] getContractorBids error:', error);
    return [];
  }
}

// ============================================================================
// Contractor Functions
// ============================================================================

/**
 * Get contractor profile
 */
export async function getContractorProfile(contractorId: string): Promise<Contractor | null> {
  try {
    const contractorDoc = await getDoc(doc(db, 'contractors', contractorId));
    return contractorDoc.exists() ? (contractorDoc.data() as Contractor) : null;
  } catch (error: any) {
    console.error('[FirebaseService] getContractorProfile error:', error);
    return null;
  }
}

/**
 * Update contractor profile
 */
export async function updateContractorProfile(
  contractorId: string,
  updates: Partial<Contractor>
): Promise<{ success: boolean; error?: string }> {
  try {
    await updateDoc(doc(db, 'contractors', contractorId), {
      ...updates,
      updatedAt: Timestamp.now()
    });
    return { success: true };
  } catch (error: any) {
    console.error('[FirebaseService] updateContractorProfile error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Update user profile photo
 */
export async function updateUserProfilePhoto(
  userId: string,
  photoURL: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await updateDoc(doc(db, 'users', userId), {
      photoURL,
      updatedAt: new Date().toISOString()
    });
    return { success: true };
  } catch (error: any) {
    console.error('[FirebaseService] updateUserProfilePhoto error:', error);
    return { success: false, error: error.message };
  }
}

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item)) as T;
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, stripUndefinedDeep(entryValue)])
    ) as T;
  }

  return value;
}

/**
 * Update arbitrary Firestore user profile fields.
 */
export async function updateUserProfileFields(
  userId: string,
  updates: Partial<UserProfile>
): Promise<{ success: boolean; error?: string }> {
  try {
    await setDoc(doc(db, 'users', userId), {
      ...stripUndefinedDeep(updates),
      updatedAt: new Date().toISOString()
    }, { merge: true });

    return { success: true };
  } catch (error: any) {
    console.error('[FirebaseService] updateUserProfileFields error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Add a DM-style comment to a listing.
 * Creates a comment document in the `comments` subcollection and increments the counter.
 */
export async function addListingComment(
  listingId: string,
  comment: Omit<ListingComment, 'id' | 'createdAt' | 'updatedAt'>
): Promise<{ success: boolean; comment?: ListingComment; error?: string }> {
  try {
    const now = new Date().toISOString();
    const ref = await addDoc(
      collection(db, 'marketplace_listings', listingId, 'comments'),
      { ...comment, createdAt: Timestamp.now(), updatedAt: Timestamp.now() }
    );
    await updateDoc(doc(db, 'marketplace_listings', listingId), {
      commentsCount: increment(1),
      updatedAt: Timestamp.now()
    });
    return {
      success: true,
      comment: { id: ref.id, ...comment, createdAt: now, updatedAt: now }
    };
  } catch (error: any) {
    console.error('[FirebaseService] addListingComment error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Subscribe to real-time comment updates for a listing.
 * Returns an unsubscribe function.
 */
export function subscribeToListingComments(
  listingId: string,
  callback: (comments: ListingComment[]) => void
): () => void {
  const q = query(
    collection(db, 'marketplace_listings', listingId, 'comments'),
    orderBy('createdAt', 'asc')
  );
  return onSnapshot(q, (snapshot) => {
    const comments = snapshot.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data(),
      createdAt: docSnap.data().createdAt?.toDate?.()?.toISOString() || docSnap.data().createdAt,
      updatedAt: docSnap.data().updatedAt?.toDate?.()?.toISOString() || docSnap.data().updatedAt
    })) as ListingComment[];
    callback(comments);
  });
}
