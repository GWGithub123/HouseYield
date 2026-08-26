/**
 * Encryption utilities for sensitive data (Plaid tokens, etc.)
 * Uses AES-256-GCM encryption with Node.js native crypto module
 * 
 * Security: Uses OpenSSL via Node.js crypto (FIPS 140-2 compliant)
 */

import crypto from 'crypto';

// Algorithm: AES-256-GCM (Galois/Counter Mode)
// GCM provides both confidentiality and authenticity
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
const KEY_LENGTH = 32; // 256 bits

// Get encryption key from environment or generate one
// IMPORTANT: In production, use a strong key stored in environment variables
let ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!ENCRYPTION_KEY) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('❌ ENCRYPTION_KEY must be set in production environment!');
  }
  // Auto-generate for development only
  ENCRYPTION_KEY = crypto.randomBytes(KEY_LENGTH).toString('hex');
  console.warn('⚠️  WARNING: Using auto-generated encryption key in development.');
  console.warn('   Generate a permanent key with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  console.warn('   Add to .env: ENCRYPTION_KEY=your_generated_key_here');
}

// Convert hex string to Buffer
const keyBuffer = Buffer.from(ENCRYPTION_KEY, 'hex');

if (keyBuffer.length !== KEY_LENGTH) {
  throw new Error(`Encryption key must be ${KEY_LENGTH * 2} hex characters (${KEY_LENGTH} bytes)`);
}

/**
 * Encrypt sensitive data using AES-256-GCM
 * @param {string} plaintext - Data to encrypt
 * @returns {string} Encrypted data as hex string (iv:authTag:ciphertext)
 */
export function encrypt(plaintext) {
  if (!plaintext) return null;
  
  try {
    // Generate random IV (Initialization Vector)
    const iv = crypto.randomBytes(IV_LENGTH);
    
    // Create cipher
    const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv);
    
    // Encrypt the plaintext
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Get authentication tag (for GCM)
    const authTag = cipher.getAuthTag();
    
    // Combine IV + authTag + encrypted data (all as hex)
    // Format: iv:authTag:ciphertext
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  } catch (error) {
    console.error('Encryption error:', error);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Decrypt sensitive data
 * @param {string} encryptedData - Encrypted data (iv:authTag:ciphertext)
 * @returns {string} Decrypted plaintext
 */
export function decrypt(encryptedData) {
  if (!encryptedData) return null;
  
  try {
    // Split the encrypted data
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    
    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, iv);
    decipher.setAuthTag(authTag);
    
    // Decrypt
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error.message);
    throw new Error('Failed to decrypt data - data may be corrupted or key is incorrect');
  }
}

/**
 * Generate a new encryption key (for initial setup)
 * Run this once and add the output to your .env file
 */
export function generateEncryptionKey() {
  return crypto.randomBytes(KEY_LENGTH).toString('hex');
}
