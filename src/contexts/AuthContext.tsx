import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { 
  loginUser, 
  logoutUser, 
  registerUser, 
  onAuthChange,
  ensureCurrentUserProfile,
  consumePendingGoogleRole,
  signInWithGoogle,
  type UserProfile 
} from '../services/firebaseService';

export type UserRole = 'owner' | 'tenant' | 'contractor' | null;

interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  photoURL?: string; // Profile photo from Google or custom upload
  // For tenants
  tenantId?: string;
  propertyId?: string;
  propertyAddress?: string;
  unit?: string;
  landlordAccountId?: string;
  leaseStart?: string;
  leaseEnd?: string;
  monthlyRent?: number;
  // For owners
  properties?: string[];
  // Onboarding gate: true when onboarding is complete OR the user is a
  // grandfathered pre-existing account (missing onboardingStatus).
  onboardingComplete?: boolean;
  // For contractors
  companyName?: string;
  contractorId?: string;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  login: (email: string, password: string, role: UserRole) => Promise<void>;
  loginWithGoogle: (role: UserRole) => Promise<void>;
  signup: (email: string, password: string, role: UserRole, profileData?: Partial<UserProfile>) => Promise<void>;
  updateUser: (updates: Partial<User>) => void;
  logout: () => Promise<void>;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

function isDemoUser(candidate: unknown): candidate is User {
  return !!candidate && typeof candidate === 'object' && 'id' in candidate && typeof (candidate as User).id === 'string' && (candidate as User).id.startsWith('demo-');
}

function readStoredDemoUser() {
  if (typeof window === 'undefined') return null;

  const savedUser = localStorage.getItem('rr_user');
  if (!savedUser) return null;

  try {
    const parsedUser = JSON.parse(savedUser);
    if (isDemoUser(parsedUser)) {
      return parsedUser;
    }

    localStorage.removeItem('rr_user');
  } catch (error) {
    console.error('Failed to parse saved user:', error);
    localStorage.removeItem('rr_user');
  }

  return null;
}

// Convert Firebase UserProfile to our User type
function profileToUser(profile: UserProfile): User {
  return {
    id: profile.id,
    email: profile.email,
    name: profile.name,
    role: profile.role as UserRole,
    photoURL: profile.photoURL, // Include profile photo
    tenantId: profile.tenantId,
    propertyId: profile.propertyId,
    propertyAddress: profile.propertyAddress,
    unit: profile.unit,
    landlordAccountId: profile.landlordAccountId,
    leaseStart: profile.leaseStart,
    leaseEnd: profile.leaseEnd,
    monthlyRent: profile.monthlyRent ?? undefined,
    properties: profile.properties,
    // Grandfather pre-existing users (no onboardingStatus) as complete so we
    // never lock established accounts out of the app.
    onboardingComplete: profile.onboardingStatus ? profile.onboardingStatus === 'complete' : true,
    companyName: profile.companyName,
    contractorId: profile.role === 'contractor' ? profile.id : undefined
  };
}

function firebaseUserToFallbackUser(firebaseUser: { uid: string; email: string | null; displayName: string | null; photoURL?: string | null }): User {
  return {
    id: firebaseUser.uid,
    email: firebaseUser.email || '',
    name: firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'User',
    role: 'owner',
    photoURL: firebaseUser.photoURL || undefined,
    onboardingComplete: true,
  };
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(() => readStoredDemoUser());
  const [loading, setLoading] = useState(true);
  // Tracks whether an explicit sign-in flow (Google or email) is in flight.
  // Prevents the onAuthChange listener from clearing user state or resetting
  // loading while loginWithGoogle / login is still executing.
  const isSigningInRef = useRef(false);

  const updateUser = (updates: Partial<User>) => {
    setUser((currentUser) => {
      if (!currentUser) return currentUser;
      return {
        ...currentUser,
        ...updates
      };
    });
  };

  // Listen to Firebase auth state changes.
  // Keep loading true until Firebase resolves the initial session so protected routes
  // do not treat stale cached users as authenticated.
  useEffect(() => {
    const unsubscribe = onAuthChange(async (firebaseUser) => {
      // If an explicit sign-in flow (loginWithGoogle / login) is in flight, skip
      // this event. The sign-in function will set user state directly when it
      // completes, so we don't want the background listener to race with it.
      if (isSigningInRef.current) return;

      if (firebaseUser) {
        // User is logged in via Firebase - sync profile
        try {
          const profile = await Promise.race([
            ensureCurrentUserProfile(consumePendingGoogleRole()),
            new Promise<null>((resolve) => {
              window.setTimeout(() => resolve(null), 8000);
            }),
          ]);
          if (profile) {
            const appUser = profileToUser(profile);
            // Also include photoURL from Firebase Auth if not in profile
            // This ensures Google photos are available even if not saved to Firestore
            if (!appUser.photoURL && firebaseUser.photoURL) {
              appUser.photoURL = firebaseUser.photoURL;
            }
            setUser(appUser);
            localStorage.removeItem('rr_user');
          } else {
            console.warn('Falling back to Firebase auth user before profile load completes');
            setUser(firebaseUserToFallbackUser(firebaseUser));
          }
        } catch (error) {
          console.error('Error fetching user profile:', error);
          setUser(firebaseUserToFallbackUser(firebaseUser));
        }
      } else {
        const savedUser = localStorage.getItem('rr_user');
        if (savedUser) {
          try {
            const parsed = JSON.parse(savedUser);
            if (isDemoUser(parsed)) {
              setUser(parsed);
            } else {
              localStorage.removeItem('rr_user');
              setUser(null);
            }
          } catch (e) {
            // Invalid saved user, clear it
            localStorage.removeItem('rr_user');
            setUser(null);
          }
        } else {
          setUser(null);
        }
      }

      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const login = async (email: string, password: string, role: UserRole) => {
    isSigningInRef.current = true;
    setLoading(true);
    try {
      const result = await loginUser(email, password, role);
      
      if (!result.success || !result.user) {
        throw new Error(result.error || 'Authentication failed');
      }

      // Check if role matches (if user has a role already)
      if (result.user.role && result.user.role !== role) {
        console.warn(`User role mismatch: expected ${role}, got ${result.user.role}`);
        // Allow login but use the stored role
      }

      const appUser = profileToUser(result.user);
      setUser(appUser);
      localStorage.removeItem('rr_user');
    } catch (error: any) {
      console.error('Firebase login error:', error);
      
      // DEMO MODE: Allow demo login if Firebase fails OR if password is 'demo' or 'demo123'
      const isDemoPassword = password === 'demo' || password === 'demo123' || password === 'password';
      const isAuthError = error.message?.includes('auth/invalid-credential') || 
                          error.message?.includes('auth/user-not-found') ||
                          error.message?.includes('auth/wrong-password');
      const isNetworkError = error.message?.includes('auth/network') || error.code === 'unavailable';
      
      if (email && role && (isNetworkError || (isDemoPassword && isAuthError))) {
        console.log('Using demo mode for role:', role);
        const demoUser: User = {
          id: `demo-${role}-${Date.now()}`,
          email: email,
          name: role === 'contractor' ? 'Demo Contractor' : role === 'owner' ? 'Demo Owner' : 'Griffin White',
          role: role,
          properties: role === 'owner' ? ['123 Main St', '456 Oak Ave'] : undefined,
          companyName: role === 'contractor' ? 'Demo Contracting Co.' : undefined,
          contractorId: role === 'contractor' ? `contractor-${Date.now()}` : undefined,
          propertyAddress: role === 'tenant' ? '123 Main St' : undefined,
          unit: role === 'tenant' ? 'Unit 1A' : undefined,
          landlordAccountId: role === 'tenant' ? 'owner-1' : undefined
        };
        setUser(demoUser);
        localStorage.setItem('rr_user', JSON.stringify(demoUser));
        return;
      }
      
      throw error;
    } finally {
      isSigningInRef.current = false;
      setLoading(false);
    }
  };

  const signup = async (email: string, password: string, role: UserRole, profileData: Partial<UserProfile> = {}) => {
    if (!role) throw new Error('Role is required for signup');
    
    setLoading(true);
    try {
      const result = await registerUser(email, password, role, profileData);
      
      if (!result.success || !result.user) {
        throw new Error(result.error || 'Registration failed');
      }

      const appUser = profileToUser(result.user);
      setUser(appUser);
      localStorage.removeItem('rr_user');
    } catch (error: any) {
      console.error('Firebase signup error:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const loginWithGoogle = async (role: UserRole) => {
    if (!role) throw new Error('Role is required for Google sign-in');
    
    isSigningInRef.current = true;
    setLoading(true);
    try {
      const result = await signInWithGoogle(role);
      
      if (!result.success || !result.user) {
        throw new Error(result.error || 'Google sign-in failed');
      }

      const appUser = profileToUser(result.user);
      setUser(appUser);
      localStorage.removeItem('rr_user');
    } catch (error: any) {
      console.error('Google sign-in error:', error);
      throw error;
    } finally {
      isSigningInRef.current = false;
      setLoading(false);
    }
  };

  const logout = async () => {
    try {
      await logoutUser();
    } catch (error) {
      console.error('Logout error:', error);
    }
    setUser(null);
    localStorage.removeItem('rr_user');
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        login,
        loginWithGoogle,
        signup,
        updateUser,
        logout,
        loading
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
