import { buildOwnerFinanceUrl, requestOwnerFinanceJson } from './ownerFinanceApi';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const VOICE_FINANCIAL_UNLOCK_STORAGE_PREFIX = 'houseyield.voiceFinancialUnlock.';
const VOICE_FINANCIAL_SESSION_UNLOCK_STORAGE_PREFIX = 'houseyield.voiceFinancialSessionUnlock.';
const TOUCH_ID_CREDENTIAL_STORAGE_PREFIX = 'houseyield.touchIdFinancialCredential.';

type UnlockStorageScope = 'local' | 'session' | 'all';

type StoredTouchIdCredential = {
  credentialId: string;
  createdAt: string;
};

type TouchIdUnlockResult = {
  createdCredential: boolean;
  unlock: VoiceFinancialUnlock;
};

export type VoiceFinancialUnlock = {
  expiresAt?: string;
  verifiedAt: string;
  score: number;
  threshold: number;
  engine?: string;
  method?: 'voice' | 'touchid';
  sessionScoped?: boolean;
};

type VerifyVoiceIdentityOptions = {
  verificationMode?: 'manual' | 'passive';
};

function getUnlockStorageKey(userId: string, scope: Exclude<UnlockStorageScope, 'all'>) {
  return `${scope === 'session' ? VOICE_FINANCIAL_SESSION_UNLOCK_STORAGE_PREFIX : VOICE_FINANCIAL_UNLOCK_STORAGE_PREFIX}${userId}`;
}

function readStoredUnlockValue(storage: Storage | undefined, key: string): VoiceFinancialUnlock | null {
  if (!storage) {
    return null;
  }

  const rawValue = storage.getItem(key);
  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue) as VoiceFinancialUnlock;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

function writeStoredUnlockValue(storage: Storage | undefined, key: string, unlock: VoiceFinancialUnlock) {
  if (!storage) {
    return;
  }

  storage.setItem(key, JSON.stringify(unlock));
}

function removeStoredUnlockValue(userId: string, scope: Exclude<UnlockStorageScope, 'all'>) {
  if (typeof window === 'undefined') {
    return;
  }

  const storage = scope === 'session' ? window.sessionStorage : window.localStorage;
  storage.removeItem(getUnlockStorageKey(userId, scope));
}

function getTouchIdCredentialKey(userId: string) {
  return `${TOUCH_ID_CREDENTIAL_STORAGE_PREFIX}${userId}`;
}

function readStoredTouchIdCredential(userId?: string | null): StoredTouchIdCredential | null {
  if (typeof window === 'undefined' || !userId) {
    return null;
  }

  const rawValue = window.localStorage.getItem(getTouchIdCredentialKey(userId));
  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue) as StoredTouchIdCredential;
  } catch {
    window.localStorage.removeItem(getTouchIdCredentialKey(userId));
    return null;
  }
}

function writeStoredTouchIdCredential(userId: string, credential: StoredTouchIdCredential) {
  if (typeof window === 'undefined' || !userId) {
    return;
  }

  window.localStorage.setItem(getTouchIdCredentialKey(userId), JSON.stringify(credential));
}

function clearStoredTouchIdCredential(userId?: string | null) {
  if (typeof window === 'undefined' || !userId) {
    return;
  }

  window.localStorage.removeItem(getTouchIdCredentialKey(userId));
}

function toBase64Url(value: Uint8Array) {
  let base64 = '';
  value.forEach((byte) => {
    base64 += String.fromCharCode(byte);
  });

  return btoa(base64)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value: string) {
  const normalized = value
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const decoded = atob(padded);
  const bytes = new Uint8Array(decoded.length);

  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }

  return bytes;
}

function createChallenge(length = 32) {
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  return bytes;
}

function createUserHandle(userId: string) {
  const encoded = new TextEncoder().encode(`houseyield:${userId}`);
  return encoded.slice(0, 64);
}

function normalizeTouchIdError(error: unknown) {
  const name = error instanceof DOMException ? error.name : (error as { name?: string } | null)?.name;
  const message = typeof (error as { message?: string } | null)?.message === 'string'
    ? (error as { message: string }).message
    : '';

  if (name === 'NotAllowedError' || name === 'AbortError') {
    return 'Touch ID verification was cancelled.';
  }

  if (name === 'SecurityError') {
    return 'Touch ID unlock requires HTTPS or localhost.';
  }

  if (name === 'NotSupportedError') {
    return 'This browser does not support Touch ID unlock.';
  }

  if (name === 'InvalidStateError') {
    return 'Touch ID on this device needs to be set up again.';
  }

  return message || 'Touch ID verification failed.';
}

async function ensureTouchIdSupport() {
  if (typeof window === 'undefined') {
    throw new Error('Touch ID unlock is only available in the browser.');
  }

  if (!window.isSecureContext) {
    throw new Error('Touch ID unlock requires HTTPS or localhost.');
  }

  if (typeof window.PublicKeyCredential === 'undefined' || !navigator.credentials) {
    throw new Error('This browser does not support Touch ID unlock.');
  }

  if (typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
    const available = await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!available) {
      throw new Error('This device does not have Touch ID or another built-in biometric authenticator available.');
    }
  }
}

async function createTouchIdCredential(userId: string): Promise<TouchIdUnlockResult> {
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: createChallenge(),
      rp: {
        name: 'HouseYield',
      },
      user: {
        id: createUserHandle(userId),
        name: `houseyield-${userId}`,
        displayName: 'HouseYield Financial Access',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      attestation: 'none',
      timeout: 60000,
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'required',
      },
    },
  }) as PublicKeyCredential | null;

  if (!credential) {
    throw new Error('Touch ID setup was cancelled.');
  }

  writeStoredTouchIdCredential(userId, {
    credentialId: toBase64Url(new Uint8Array(credential.rawId)),
    createdAt: new Date().toISOString(),
  });

  return {
    createdCredential: true,
    unlock: {
      verifiedAt: new Date().toISOString(),
      score: 1,
      threshold: 1,
      engine: 'platform-webauthn',
      method: 'touchid',
      sessionScoped: true,
    },
  };
}

export function readStoredVoiceFinancialUnlock(userId?: string | null): VoiceFinancialUnlock | null {
  if (typeof window === 'undefined' || !userId) {
    return null;
  }

  const sessionUnlock = readStoredUnlockValue(window.sessionStorage, getUnlockStorageKey(userId, 'session'));
  if (sessionUnlock) {
    if (isVoiceFinancialUnlockActive(sessionUnlock)) {
      return sessionUnlock;
    }
    removeStoredUnlockValue(userId, 'session');
  }

  const localUnlock = readStoredUnlockValue(window.localStorage, getUnlockStorageKey(userId, 'local'));
  if (localUnlock) {
    if (isVoiceFinancialUnlockActive(localUnlock)) {
      return localUnlock;
    }
    removeStoredUnlockValue(userId, 'local');
  }

  return null;
}

export function writeStoredVoiceFinancialUnlock(
  userId: string,
  unlock: VoiceFinancialUnlock,
  options?: { scope?: Exclude<UnlockStorageScope, 'all'> },
) {
  if (typeof window === 'undefined' || !userId) {
    return;
  }

  const scope = options?.scope || (unlock.sessionScoped ? 'session' : 'local');
  const storage = scope === 'session' ? window.sessionStorage : window.localStorage;
  writeStoredUnlockValue(storage, getUnlockStorageKey(userId, scope), unlock);
  removeStoredUnlockValue(userId, scope === 'session' ? 'local' : 'session');
}

export function clearStoredVoiceFinancialUnlock(
  userId?: string | null,
  options?: { scope?: UnlockStorageScope },
) {
  if (typeof window === 'undefined' || !userId) {
    return;
  }

  const scope = options?.scope || 'all';
  if (scope === 'all' || scope === 'local') {
    removeStoredUnlockValue(userId, 'local');
  }
  if (scope === 'all' || scope === 'session') {
    removeStoredUnlockValue(userId, 'session');
  }
}

export function isVoiceFinancialUnlockActive(unlock: VoiceFinancialUnlock | null): boolean {
  if (!unlock) {
    return false;
  }

  if (unlock.sessionScoped) {
    return true;
  }

  if (!unlock.expiresAt) {
    return false;
  }

  return new Date(unlock.expiresAt).getTime() > Date.now();
}

export async function verifyBiometricFinancialUnlock(userId: string) {
  if (!userId) {
    throw new Error('Touch ID unlock requires a signed-in user.');
  }

  try {
    await ensureTouchIdSupport();
  } catch (error) {
    throw new Error(normalizeTouchIdError(error));
  }

  const storedCredential = readStoredTouchIdCredential(userId);

  if (!storedCredential?.credentialId) {
    try {
      return await createTouchIdCredential(userId);
    } catch (error) {
      throw new Error(normalizeTouchIdError(error));
    }
  }

  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: createChallenge(),
        timeout: 60000,
        userVerification: 'required',
        allowCredentials: [
          {
            id: fromBase64Url(storedCredential.credentialId),
            type: 'public-key',
          },
        ],
      },
    }) as PublicKeyCredential | null;

    if (!assertion) {
      throw new Error('Touch ID verification was cancelled.');
    }

    return {
      createdCredential: false,
      unlock: {
        verifiedAt: new Date().toISOString(),
        score: 1,
        threshold: 1,
        engine: 'platform-webauthn',
        method: 'touchid',
        sessionScoped: true,
      },
    } as TouchIdUnlockResult;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'InvalidStateError') {
      clearStoredTouchIdCredential(userId);
      try {
        return await createTouchIdCredential(userId);
      } catch (createError) {
        throw new Error(normalizeTouchIdError(createError));
      }
    }

    throw new Error(normalizeTouchIdError(error));
  }
}

export async function getVoiceIdentityStatus() {
  return requestOwnerFinanceJson(buildOwnerFinanceUrl('/api/voice-identity/status'));
}

export async function enrollVoiceIdentitySample(audioBase64: string) {
  return requestOwnerFinanceJson(
    buildOwnerFinanceUrl('/api/voice-identity/enroll'),
    {
      method: 'POST',
      body: JSON.stringify({ audioBase64 }),
    },
    JSON_HEADERS,
  );
}

export async function verifyVoiceIdentitySample(audioBase64: string, options?: VerifyVoiceIdentityOptions) {
  return requestOwnerFinanceJson(
    buildOwnerFinanceUrl('/api/voice-identity/verify'),
    {
      method: 'POST',
      body: JSON.stringify({
        audioBase64,
        verificationMode: options?.verificationMode || 'manual',
      }),
    },
    JSON_HEADERS,
  );
}

export async function resetVoiceIdentityEnrollment() {
  return requestOwnerFinanceJson(
    buildOwnerFinanceUrl('/api/voice-identity/enrollment'),
    {
      method: 'DELETE',
    },
  );
}