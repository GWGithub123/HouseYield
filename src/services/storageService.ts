/**
 * Firebase Storage Service
 * 
 * Centralized service for uploading files to Firebase Storage.
 * All files are organized by user ID for proper data isolation.
 * 
 * Storage Structure:
 * /profile-photos/{userId}/profile.{ext}           - User profile photos
 * /insurance/{ownerId}/{propertyId}/{tenantId}/    - Tenant insurance documents
 * /documents/{ownerId}/{propertyId}/               - Property documents
 * /room-scans/{userId}/{scanId}/                   - 3D room scan photos
 * /renovation-previews/{userId}/{propertyId}/      - AI renovation previews
 * /3d-models/{userId}/{modelId}/                   - Generated 3D models
 */

import { ref, uploadBytes, getDownloadURL, deleteObject, listAll } from 'firebase/storage';
import { storage } from '../config/firebase';

// ============================================================================
// Types
// ============================================================================

export interface UploadResult {
  success: boolean;
  downloadURL?: string;
  storagePath?: string;
  error?: string;
}

export interface UploadOptions {
  contentType?: string;
  customMetadata?: Record<string, string>;
}

// ============================================================================
// Profile Photos
// ============================================================================

/**
 * Upload a profile photo to Firebase Storage
 * Path: /profile-photos/{userId}/profile.{ext}
 */
export async function uploadProfilePhoto(
  userId: string,
  file: File
): Promise<UploadResult> {
  try {
    const fileExtension = file.name.split('.').pop() || 'jpg';
    const storagePath = `profile-photos/${userId}/profile.${fileExtension}`;
    const storageRef = ref(storage, storagePath);
    
    await uploadBytes(storageRef, file, {
      contentType: file.type,
      customMetadata: {
        uploadedBy: userId,
        uploadedAt: new Date().toISOString(),
        originalName: file.name
      }
    });
    
    const downloadURL = await getDownloadURL(storageRef);
    
    return {
      success: true,
      downloadURL,
      storagePath
    };
  } catch (error: any) {
    console.error('[StorageService] uploadProfilePhoto error:', error);
    return {
      success: false,
      error: error.message || 'Failed to upload profile photo'
    };
  }
}

/**
 * Delete a user's profile photo from Storage
 */
export async function deleteProfilePhoto(userId: string): Promise<{ success: boolean; error?: string }> {
  const extensions = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
  
  for (const ext of extensions) {
    try {
      const storageRef = ref(storage, `profile-photos/${userId}/profile.${ext}`);
      await deleteObject(storageRef);
      return { success: true };
    } catch (error: any) {
      if (error.code !== 'storage/object-not-found') {
        console.warn(`[StorageService] Error deleting profile.${ext}:`, error);
      }
    }
  }
  
  // If no files found, still consider it a success (nothing to delete)
  return { success: true };
}

// ============================================================================
// Insurance Documents
// ============================================================================

export type InsuranceEvidenceCategory =
  | 'installation-photos'
  | 'activation-captures'
  | 'invoices'
  | 'attestations'
  | 'partner-credentials'
  | 'supporting';

/** Upload owner-controlled underwriting evidence for a property packet. */
export async function uploadInsurancePacketEvidence(
  ownerId: string,
  propertyId: string,
  category: InsuranceEvidenceCategory,
  file: File,
): Promise<UploadResult> {
  try {
    const timestamp = Date.now();
    const sanitizedFileName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storagePath = `insurance-packets/${ownerId}/${propertyId}/${category}/${timestamp}_${sanitizedFileName}`;
    const storageRef = ref(storage, storagePath);
    await uploadBytes(storageRef, file, {
      contentType: file.type || 'application/octet-stream',
      customMetadata: {
        uploadedBy: ownerId,
        uploadedAt: new Date().toISOString(),
        propertyId,
        evidenceCategory: category,
        originalName: file.name,
      },
    });
    return {
      success: true,
      downloadURL: await getDownloadURL(storageRef),
      storagePath,
    };
  } catch (error: any) {
    console.error('[StorageService] uploadInsurancePacketEvidence error:', error);
    return { success: false, error: error.message || 'Failed to upload packet evidence' };
  }
}

/**
 * Upload an insurance document to Firebase Storage
 * Path: /insurance/{ownerId}/{propertyId}/{tenantId}/{filename}
 */
export async function uploadInsuranceDocument(
  ownerId: string,
  propertyId: string,
  tenantId: string,
  file: File
): Promise<UploadResult> {
  try {
    const timestamp = Date.now();
    const sanitizedFileName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storagePath = `insurance/${ownerId}/${propertyId}/${tenantId}/${timestamp}_${sanitizedFileName}`;
    const storageRef = ref(storage, storagePath);
    
    await uploadBytes(storageRef, file, {
      contentType: file.type,
      customMetadata: {
        uploadedBy: tenantId,
        uploadedAt: new Date().toISOString(),
        originalName: file.name,
        propertyId: propertyId,
        ownerId: ownerId
      }
    });
    
    const downloadURL = await getDownloadURL(storageRef);
    
    return {
      success: true,
      downloadURL,
      storagePath
    };
  } catch (error: any) {
    console.error('[StorageService] uploadInsuranceDocument error:', error);
    return {
      success: false,
      error: error.message || 'Failed to upload insurance document'
    };
  }
}

/**
 * Upload insurance document from base64 (for backward compatibility during migration)
 */
export async function uploadInsuranceFromBase64(
  ownerId: string,
  propertyId: string,
  tenantId: string,
  base64Data: string,
  fileName: string,
  contentType: string
): Promise<UploadResult> {
  try {
    // Convert base64 to blob
    const base64WithoutPrefix = base64Data.replace(/^data:[^;]+;base64,/, '');
    const binaryString = atob(base64WithoutPrefix);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: contentType });
    
    const timestamp = Date.now();
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storagePath = `insurance/${ownerId}/${propertyId}/${tenantId}/${timestamp}_${sanitizedFileName}`;
    const storageRef = ref(storage, storagePath);
    
    await uploadBytes(storageRef, blob, {
      contentType: contentType,
      customMetadata: {
        uploadedBy: tenantId,
        uploadedAt: new Date().toISOString(),
        originalName: fileName,
        propertyId: propertyId,
        ownerId: ownerId
      }
    });
    
    const downloadURL = await getDownloadURL(storageRef);
    
    return {
      success: true,
      downloadURL,
      storagePath
    };
  } catch (error: any) {
    console.error('[StorageService] uploadInsuranceFromBase64 error:', error);
    return {
      success: false,
      error: error.message || 'Failed to upload insurance document'
    };
  }
}

// ============================================================================
// Property Documents
// ============================================================================

/**
 * Upload a property document to Firebase Storage
 * Path: /documents/{ownerId}/{propertyId}/{filename}
 */
export async function uploadPropertyDocument(
  ownerId: string,
  propertyId: string,
  file: File
): Promise<UploadResult> {
  try {
    const timestamp = Date.now();
    const sanitizedFileName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storagePath = `documents/${ownerId}/${propertyId}/${timestamp}_${sanitizedFileName}`;
    const storageRef = ref(storage, storagePath);
    
    await uploadBytes(storageRef, file, {
      contentType: file.type,
      customMetadata: {
        uploadedBy: ownerId,
        uploadedAt: new Date().toISOString(),
        originalName: file.name,
        propertyId: propertyId
      }
    });
    
    const downloadURL = await getDownloadURL(storageRef);
    
    return {
      success: true,
      downloadURL,
      storagePath
    };
  } catch (error: any) {
    console.error('[StorageService] uploadPropertyDocument error:', error);
    return {
      success: false,
      error: error.message || 'Failed to upload document'
    };
  }
}

/**
 * Upload document from base64 (for backward compatibility)
 */
export async function uploadDocumentFromBase64(
  ownerId: string,
  propertyId: string,
  base64Data: string,
  fileName: string,
  contentType: string
): Promise<UploadResult> {
  try {
    // Convert base64 to blob
    const base64WithoutPrefix = base64Data.replace(/^data:[^;]+;base64,/, '');
    const binaryString = atob(base64WithoutPrefix);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: contentType });
    
    const timestamp = Date.now();
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storagePath = `documents/${ownerId}/${propertyId}/${timestamp}_${sanitizedFileName}`;
    const storageRef = ref(storage, storagePath);
    
    await uploadBytes(storageRef, blob, {
      contentType: contentType,
      customMetadata: {
        uploadedBy: ownerId,
        uploadedAt: new Date().toISOString(),
        originalName: fileName,
        propertyId: propertyId
      }
    });
    
    const downloadURL = await getDownloadURL(storageRef);
    
    return {
      success: true,
      downloadURL,
      storagePath
    };
  } catch (error: any) {
    console.error('[StorageService] uploadDocumentFromBase64 error:', error);
    return {
      success: false,
      error: error.message || 'Failed to upload document'
    };
  }
}

// ============================================================================
// Room Scan Photos
// ============================================================================

/**
 * Upload a room scan photo to Firebase Storage
 * Path: /room-scans/{userId}/{scanId}/{filename}
 */
export async function uploadRoomScanPhoto(
  userId: string,
  scanId: string,
  file: File | Blob,
  photoIndex: number
): Promise<UploadResult> {
  try {
    const fileExtension = file instanceof File ? file.name.split('.').pop() || 'jpg' : 'jpg';
    const storagePath = `room-scans/${userId}/${scanId}/photo_${photoIndex.toString().padStart(3, '0')}.${fileExtension}`;
    const storageRef = ref(storage, storagePath);
    
    await uploadBytes(storageRef, file, {
      contentType: file instanceof File ? file.type : 'image/jpeg',
      customMetadata: {
        uploadedBy: userId,
        uploadedAt: new Date().toISOString(),
        scanId: scanId,
        photoIndex: photoIndex.toString()
      }
    });
    
    const downloadURL = await getDownloadURL(storageRef);
    
    return {
      success: true,
      downloadURL,
      storagePath
    };
  } catch (error: any) {
    console.error('[StorageService] uploadRoomScanPhoto error:', error);
    return {
      success: false,
      error: error.message || 'Failed to upload scan photo'
    };
  }
}

/**
 * Upload room scan photo from base64
 */
export async function uploadRoomScanFromBase64(
  userId: string,
  scanId: string,
  base64Data: string,
  photoIndex: number
): Promise<UploadResult> {
  try {
    // Convert base64 to blob
    const base64WithoutPrefix = base64Data.replace(/^data:[^;]+;base64,/, '');
    const binaryString = atob(base64WithoutPrefix);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    
    return uploadRoomScanPhoto(userId, scanId, blob, photoIndex);
  } catch (error: any) {
    console.error('[StorageService] uploadRoomScanFromBase64 error:', error);
    return {
      success: false,
      error: error.message || 'Failed to upload scan photo'
    };
  }
}

/**
 * Delete all photos for a room scan
 */
export async function deleteRoomScanPhotos(userId: string, scanId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const folderRef = ref(storage, `room-scans/${userId}/${scanId}`);
    const listResult = await listAll(folderRef);
    
    await Promise.all(listResult.items.map(itemRef => deleteObject(itemRef)));
    
    return { success: true };
  } catch (error: any) {
    console.error('[StorageService] deleteRoomScanPhotos error:', error);
    return {
      success: false,
      error: error.message || 'Failed to delete scan photos'
    };
  }
}

// ============================================================================
// Renovation Previews
// ============================================================================

/**
 * Upload a renovation preview image to Firebase Storage
 * Path: /renovation-previews/{userId}/{propertyId}/{filename}
 */
export async function uploadRenovationPreview(
  userId: string,
  propertyId: string,
  imageBlob: Blob,
  renovationId: string
): Promise<UploadResult> {
  try {
    const timestamp = Date.now();
    const storagePath = `renovation-previews/${userId}/${propertyId}/${renovationId}_${timestamp}.jpg`;
    const storageRef = ref(storage, storagePath);
    
    await uploadBytes(storageRef, imageBlob, {
      contentType: 'image/jpeg',
      customMetadata: {
        uploadedBy: userId,
        uploadedAt: new Date().toISOString(),
        propertyId: propertyId,
        renovationId: renovationId
      }
    });
    
    const downloadURL = await getDownloadURL(storageRef);
    
    return {
      success: true,
      downloadURL,
      storagePath
    };
  } catch (error: any) {
    console.error('[StorageService] uploadRenovationPreview error:', error);
    return {
      success: false,
      error: error.message || 'Failed to upload renovation preview'
    };
  }
}

/**
 * Upload renovation preview from base64
 */
export async function uploadRenovationPreviewFromBase64(
  userId: string,
  propertyId: string,
  base64Data: string,
  renovationId: string
): Promise<UploadResult> {
  try {
    // Convert base64 to blob
    const base64WithoutPrefix = base64Data.replace(/^data:[^;]+;base64,/, '');
    const binaryString = atob(base64WithoutPrefix);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    
    return uploadRenovationPreview(userId, propertyId, blob, renovationId);
  } catch (error: any) {
    console.error('[StorageService] uploadRenovationPreviewFromBase64 error:', error);
    return {
      success: false,
      error: error.message || 'Failed to upload renovation preview'
    };
  }
}

// ============================================================================
// 3D Models
// ============================================================================

/**
 * Upload a 3D model to Firebase Storage
 * Path: /3d-models/{userId}/{modelId}/{filename}
 */
export async function upload3DModel(
  userId: string,
  modelId: string,
  modelBlob: Blob,
  fileName: string
): Promise<UploadResult> {
  try {
    const storagePath = `3d-models/${userId}/${modelId}/${fileName}`;
    const storageRef = ref(storage, storagePath);
    
    // Determine content type based on file extension
    const extension = fileName.split('.').pop()?.toLowerCase();
    let contentType = 'application/octet-stream';
    if (extension === 'glb') contentType = 'model/gltf-binary';
    else if (extension === 'gltf') contentType = 'model/gltf+json';
    else if (extension === 'ply') contentType = 'application/x-ply';
    
    await uploadBytes(storageRef, modelBlob, {
      contentType: contentType,
      customMetadata: {
        uploadedBy: userId,
        uploadedAt: new Date().toISOString(),
        modelId: modelId,
        originalName: fileName
      }
    });
    
    const downloadURL = await getDownloadURL(storageRef);
    
    return {
      success: true,
      downloadURL,
      storagePath
    };
  } catch (error: any) {
    console.error('[StorageService] upload3DModel error:', error);
    return {
      success: false,
      error: error.message || 'Failed to upload 3D model'
    };
  }
}

/**
 * Delete a 3D model and all associated files
 */
export async function delete3DModel(userId: string, modelId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const folderRef = ref(storage, `3d-models/${userId}/${modelId}`);
    const listResult = await listAll(folderRef);
    
    await Promise.all(listResult.items.map(itemRef => deleteObject(itemRef)));
    
    return { success: true };
  } catch (error: any) {
    console.error('[StorageService] delete3DModel error:', error);
    return {
      success: false,
      error: error.message || 'Failed to delete 3D model'
    };
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert a base64 data URL to a Blob
 */
export function base64ToBlob(base64Data: string, contentType?: string): Blob {
  const base64WithoutPrefix = base64Data.replace(/^data:[^;]+;base64,/, '');
  
  // Try to extract content type from data URL if not provided
  if (!contentType) {
    const match = base64Data.match(/^data:([^;]+);base64,/);
    contentType = match ? match[1] : 'application/octet-stream';
  }
  
  const binaryString = atob(base64WithoutPrefix);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  return new Blob([bytes], { type: contentType });
}

/**
 * Check if a URL is a Firebase Storage URL (vs base64 or external URL)
 */
export function isFirebaseStorageURL(url: string): boolean {
  return url.includes('firebasestorage.googleapis.com') || 
         url.includes('storage.googleapis.com');
}

/**
 * Check if a string is a base64 data URL
 */
export function isBase64DataURL(str: string): boolean {
  return str.startsWith('data:');
}
