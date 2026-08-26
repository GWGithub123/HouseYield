const DEFAULT_PRACTICE_TEST_PHONES = [
  {
    id: 'griffin-dc',
    label: 'Griffin (DC) — (202) 642-0437',
    e164: '+12026420437',
  },
];

const DEFAULT_PRACTICE_CALL_PHONE = '+12026420437';

function normalizePracticePhone(rawPhone = '') {
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

export function isPracticeModeEnabled() {
  return process.env.MAINTENANCE_PRACTICE_MODE === '1'
    || (process.env.NODE_ENV !== 'production' && !process.env.K_SERVICE);
}

export function getPracticeTestPhoneOptions() {
  const envList = String(process.env.MAINTENANCE_PRACTICE_TEST_PHONES || '').trim();
  if (!envList) {
    return DEFAULT_PRACTICE_TEST_PHONES.map((option) => ({ ...option }));
  }

  return envList
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const [rawLabel, rawPhone] = entry.includes('|')
        ? entry.split('|', 2)
        : [`Test phone ${index + 1}`, entry];
      const e164 = normalizePracticePhone(rawPhone);
      return {
        id: `configured-${index + 1}`,
        label: String(rawLabel || e164).trim(),
        e164,
      };
    })
    .filter((option) => Boolean(option.e164));
}

function getAllowedPracticePhoneSet() {
  return new Set(getPracticeTestPhoneOptions().map((option) => option.e164));
}

/** SMS approval texts route to the UI-selected practice phone. */
export function resolvePracticeSmsPhone(overridePhone) {
  const allowed = getAllowedPracticePhoneSet();
  const normalizedOverride = normalizePracticePhone(overridePhone);
  if (normalizedOverride && allowed.has(normalizedOverride)) {
    return normalizedOverride;
  }

  const configuredDefault = normalizePracticePhone(
    process.env.MAINTENANCE_OWNER_SMS_TEST_PHONE
      || process.env.TWILIO_TEST_TO_NUMBER
      || '',
  );
  if (configuredDefault && allowed.has(configuredDefault)) {
    return configuredDefault;
  }

  return DEFAULT_PRACTICE_TEST_PHONES[0].e164;
}

/** Practice booking calls always route to the configured call target (default Griffin). */
export function resolvePracticeCallPhone(overridePhone) {
  const normalizedOverride = normalizePracticePhone(overridePhone);
  if (normalizedOverride) {
    return normalizedOverride;
  }

  return normalizePracticePhone(
    process.env.MAINTENANCE_PRACTICE_CALL_PHONE
      || process.env.TWILIO_TEST_TO_NUMBER
      || DEFAULT_PRACTICE_CALL_PHONE,
  ) || DEFAULT_PRACTICE_CALL_PHONE;
}

/** Backward-compatible alias for SMS routing. */
export function resolvePracticeTestPhone(overridePhone) {
  return resolvePracticeSmsPhone(overridePhone);
}

export function getPracticeTestPhoneSettings(selectedOverride) {
  const selectedPhone = resolvePracticeSmsPhone(selectedOverride);
  return {
    practiceMode: isPracticeModeEnabled(),
    defaultPhone: resolvePracticeSmsPhone(),
    selectedPhone,
    practiceCallPhone: resolvePracticeCallPhone(),
    options: getPracticeTestPhoneOptions(),
  };
}

export {
  DEFAULT_PRACTICE_TEST_PHONES,
  DEFAULT_PRACTICE_CALL_PHONE,
  normalizePracticePhone,
};
