import { useState, useRef } from 'react';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { storage } from '../config/firebase';
import { updateUserProfilePhoto } from '../services/firebaseService';
import { useAuth } from '../contexts/AuthContext';

interface ProfilePhotoUploadProps {
  currentPhotoURL?: string;
  userId: string;
  userName: string;
  onPhotoUpdated: (photoURL: string) => void;
}

// Helper to update tenant photo in the backend
async function updateTenantPhoto(tenantId: string, photoURL: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/tenants/${tenantId}/photo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photoURL })
    });
    const data = await response.json();
    return data.ok === true;
  } catch (error) {
    console.error('[ProfilePhotoUpload] Failed to update tenant photo:', error);
    return false;
  }
}

export default function ProfilePhotoUpload({
  currentPhotoURL,
  userId,
  userName,
  onPhotoUpdated
}: ProfilePhotoUploadProps) {
  const { updateUser } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewURL, setPreviewURL] = useState<string | null>(currentPhotoURL || null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file');
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      setError('Image must be less than 5MB');
      return;
    }

    setError(null);
    setUploading(true);

    try {
      // Upload image to Firebase Storage (not base64 in Firestore!)
      // Path: /profile-photos/{userId}/profile.{ext}
      const fileExtension = file.name.split('.').pop() || 'jpg';
      const storageRef = ref(storage, `profile-photos/${userId}/profile.${fileExtension}`);
      
      // Upload the file directly (not as base64)
      await uploadBytes(storageRef, file, {
        contentType: file.type,
        customMetadata: {
          uploadedBy: userId,
          uploadedAt: new Date().toISOString()
        }
      });
      
      // Get the public download URL
      const downloadURL = await getDownloadURL(storageRef);
      
      // Update Firestore with just the URL (tiny string, not huge base64)
      const result = await updateUserProfilePhoto(userId, downloadURL);
      
      // Also update tenant record with the URL
      await updateTenantPhoto(userId, downloadURL);
      
      if (result.success) {
        setPreviewURL(downloadURL);
        onPhotoUpdated(downloadURL);
        updateUser({ photoURL: downloadURL });
      } else {
        setError(result.error || 'Failed to update photo');
      }
      
      setUploading(false);
    } catch (err: any) {
      console.error('[ProfilePhotoUpload] Upload error:', err);
      setError(err.message || 'Failed to upload photo');
      setUploading(false);
    }
  };

  const handleRemovePhoto = async () => {
    if (!confirm('Remove your profile photo?')) return;
    
    setUploading(true);
    setError(null);

    try {
      // Try to delete from Firebase Storage
      // We don't know the exact extension, so try common ones
      const extensions = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
      for (const ext of extensions) {
        try {
          const storageRef = ref(storage, `profile-photos/${userId}/profile.${ext}`);
          await deleteObject(storageRef);
          console.log(`[ProfilePhotoUpload] Deleted profile.${ext} from Storage`);
          break; // Successfully deleted, stop trying
        } catch (deleteErr: any) {
          // File doesn't exist with this extension, try next
          if (deleteErr.code !== 'storage/object-not-found') {
            console.warn(`[ProfilePhotoUpload] Error deleting profile.${ext}:`, deleteErr);
          }
        }
      }
      
      // Remove URL from user profile in Firestore
      const result = await updateUserProfilePhoto(userId, '');
      
      // Also remove from tenant record
      await updateTenantPhoto(userId, '');
      
      if (result.success) {
        setPreviewURL(null);
        onPhotoUpdated('');
        updateUser({ photoURL: undefined });
      } else {
        setError(result.error || 'Failed to remove photo');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to remove photo');
    } finally {
      setUploading(false);
    }
  };

  // Generate initials for fallback avatar
  const getInitials = () => {
    return userName
      .split(' ')
      .map(n => n[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  };

  return (
    <div className="flex flex-col items-center gap-4">
      {/* Profile Photo Display */}
      <div className="relative">
        {previewURL ? (
          <img
            src={previewURL}
            alt="Profile"
            className="h-32 w-32 rounded-full object-cover border-4 border-purple-100"
          />
        ) : (
          <div className="h-32 w-32 rounded-full bg-purple-100 flex items-center justify-center text-3xl font-semibold text-purple-600 border-4 border-purple-200">
            {getInitials()}
          </div>
        )}
        
        {/* Upload/Edit Button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="absolute bottom-0 right-0 h-10 w-10 rounded-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white shadow-lg flex items-center justify-center transition-colors"
          title="Change photo"
        >
          {uploading ? (
            <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          ) : (
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          )}
        </button>
      </div>

      {/* Hidden File Input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
      />

      {/* Action Buttons */}
      <div className="flex gap-2">
        {previewURL && (
          <button
            onClick={handleRemovePhoto}
            disabled={uploading}
            className="text-sm text-red-600 hover:text-red-700 disabled:text-gray-400 font-medium"
          >
            Remove Photo
          </button>
        )}
      </div>

      {/* Error Message */}
      {error && (
        <div className="w-full bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* Helper Text */}
      <p className="text-sm text-gray-500 text-center">
        {previewURL 
          ? 'Click the camera icon to change your photo'
          : 'Add a profile photo to personalize your account'}
      </p>
    </div>
  );
}
