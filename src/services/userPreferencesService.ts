import { doc, getDoc } from 'firebase/firestore';
import { db } from '../config/firebase';
import { updateUserProfileFields, type UserProfile } from './firebaseService';

export type UserPreferenceKey = 'retirementScenarios' | 'trustedProviders' | 'absenteeBuyerInfo';

export async function getUserPreference<T>(
  userId: string,
  fieldName: UserPreferenceKey,
  fallbackValue: T,
): Promise<T> {
  if (!userId) {
    return fallbackValue;
  }

  try {
    const snapshot = await getDoc(doc(db, 'users', userId));
    if (!snapshot.exists()) {
      return fallbackValue;
    }

    const value = snapshot.data()?.[fieldName];
    return value === undefined || value === null ? fallbackValue : (value as T);
  } catch (error) {
    console.error(`[UserPreferences] Failed to load ${fieldName}:`, error);
    return fallbackValue;
  }
}

export async function setUserPreference<T>(
  userId: string,
  fieldName: UserPreferenceKey,
  value: T,
): Promise<{ success: boolean; error?: string }> {
  if (!userId) {
    return { success: false, error: 'User ID required' };
  }

  return updateUserProfileFields(userId, {
    [fieldName]: value,
  } as Partial<UserProfile>);
}