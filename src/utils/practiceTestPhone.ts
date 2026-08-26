export const PRACTICE_TEST_PHONE_STORAGE_KEY = 'houseyield_practice_test_phone';

export interface PracticeTestPhoneOption {
  id: string;
  label: string;
  e164: string;
}

export const DEFAULT_PRACTICE_TEST_PHONE_OPTIONS: PracticeTestPhoneOption[] = [
  {
    id: 'griffin-dc',
    label: 'Griffin (DC) — (202) 642-0437',
    e164: '+12026420437',
  },
];

export function normalizePracticePhone(rawPhone = ''): string {
  let digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) {
    return '';
  }
  if (digits.length === 10) {
    digits = `1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  if (String(rawPhone).trim().startsWith('+')) {
    return `+${digits}`;
  }
  return digits.startsWith('+') ? digits : `+${digits}`;
}

export function getStoredPracticeTestPhone(): string {
  const defaultPhone = DEFAULT_PRACTICE_TEST_PHONE_OPTIONS[0].e164;
  if (typeof window === 'undefined') {
    return defaultPhone;
  }

  const stored = normalizePracticePhone(window.localStorage.getItem(PRACTICE_TEST_PHONE_STORAGE_KEY) || '');
  const allowed = new Set(DEFAULT_PRACTICE_TEST_PHONE_OPTIONS.map((option) => option.e164));
  if (stored && allowed.has(stored)) {
    return stored;
  }

  window.localStorage.setItem(PRACTICE_TEST_PHONE_STORAGE_KEY, defaultPhone);
  return defaultPhone;
}

export function setStoredPracticeTestPhone(phone: string): string {
  const normalized = normalizePracticePhone(phone);
  const allowed = new Set(DEFAULT_PRACTICE_TEST_PHONE_OPTIONS.map((option) => option.e164));
  const nextPhone = normalized && allowed.has(normalized)
    ? normalized
    : DEFAULT_PRACTICE_TEST_PHONE_OPTIONS[0].e164;

  if (typeof window !== 'undefined') {
    window.localStorage.setItem(PRACTICE_TEST_PHONE_STORAGE_KEY, nextPhone);
  }

  return nextPhone;
}

export function formatPracticePhoneLabel(phone: string): string {
  const normalized = normalizePracticePhone(phone);
  const match = normalized.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (match) {
    return `(${match[1]}) ${match[2]}-${match[3]}`;
  }
  return phone;
}
