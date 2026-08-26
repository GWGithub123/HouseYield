/**
 * Maintenance call scheduling — business hours, deferred calls, and retry logic.
 */

const STATE_TIMEZONES = {
  AL: 'America/Chicago',
  AK: 'America/Anchorage',
  AZ: 'America/Phoenix',
  AR: 'America/Chicago',
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  CT: 'America/New_York',
  DE: 'America/New_York',
  DC: 'America/New_York',
  FL: 'America/New_York',
  GA: 'America/New_York',
  HI: 'Pacific/Honolulu',
  ID: 'America/Boise',
  IL: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago',
  KS: 'America/Chicago',
  KY: 'America/New_York',
  LA: 'America/Chicago',
  ME: 'America/New_York',
  MD: 'America/New_York',
  MA: 'America/New_York',
  MI: 'America/Detroit',
  MN: 'America/Chicago',
  MS: 'America/Chicago',
  MO: 'America/Chicago',
  MT: 'America/Denver',
  NE: 'America/Chicago',
  NV: 'America/Los_Angeles',
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NM: 'America/Denver',
  NY: 'America/New_York',
  NC: 'America/New_York',
  ND: 'America/Chicago',
  OH: 'America/New_York',
  OK: 'America/Chicago',
  OR: 'America/Los_Angeles',
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  SD: 'America/Chicago',
  TN: 'America/Chicago',
  TX: 'America/Chicago',
  UT: 'America/Denver',
  VT: 'America/New_York',
  VA: 'America/New_York',
  WA: 'America/Los_Angeles',
  WV: 'America/New_York',
  WI: 'America/Chicago',
  WY: 'America/Denver'
};

const DEFAULT_WEEKDAY_HOURS = { openHour: 8, closeHour: 18 };
const scheduledCalls = new Map();

function extractStateCode(address = '') {
  const parts = String(address).split(',').map((part) => part.trim());
  if (parts.length < 2) {
    return '';
  }

  const stateZip = parts[parts.length - 1];
  const match = stateZip.match(/\b([A-Z]{2})\b/);
  return match ? match[1] : '';
}

function getTimezoneForAddress(address = '') {
  const state = extractStateCode(address).toUpperCase();
  return STATE_TIMEZONES[state] || 'America/New_York';
}

function getLocalParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[lookup.weekday] ?? 1;
  const hourMinute = `${lookup.hour}:${lookup.minute}`.replace('24:', '00:');
  const [hourText, minuteText] = hourMinute.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);

  return { weekday, hour, minute };
}

function parseHoursFromNotes(notes = '') {
  const normalized = String(notes).toLowerCase();
  if (normalized.includes('24/7') || normalized.includes('24-7') || normalized.includes('always available')) {
    return { alwaysOpen: true };
  }

  const match = normalized.match(/(\d{1,2})(?::(\d{2}))?\s*(?:am|a\.m\.)?\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?\s*(?:pm|p\.m\.)?/i);
  if (!match) {
    return null;
  }

  let openHour = Number(match[1]);
  let closeHour = Number(match[3]);
  if (normalized.includes('pm') && closeHour < 12) {
    closeHour += 12;
  }
  if (normalized.includes('am') && openHour === 12) {
    openHour = 0;
  }

  return { openHour, closeHour };
}

function resolveBusinessHours(provider = {}, propertyAddress = '') {
  const notesHours = parseHoursFromNotes(provider.notes || provider.trustedNote || '');
  if (notesHours?.alwaysOpen) {
    return { alwaysOpen: true, timeZone: getTimezoneForAddress(propertyAddress) };
  }

  if (provider.openNow !== undefined && Array.isArray(provider.weekdayHours) && provider.weekdayHours.length > 0) {
    return {
      weekdayHours: provider.weekdayHours,
      openNow: provider.openNow,
      timeZone: getTimezoneForAddress(propertyAddress)
    };
  }

  if (notesHours?.openHour !== undefined) {
    return {
      openHour: notesHours.openHour,
      closeHour: notesHours.closeHour,
      timeZone: getTimezoneForAddress(propertyAddress)
    };
  }

  return {
    ...DEFAULT_WEEKDAY_HOURS,
    timeZone: getTimezoneForAddress(propertyAddress)
  };
}

function isWithinBusinessHours(hoursConfig, date = new Date()) {
  if (hoursConfig.alwaysOpen) {
    return true;
  }

  const { weekday, hour, minute } = getLocalParts(date, hoursConfig.timeZone);
  if (weekday === 0) {
    return false;
  }

  if (hoursConfig.openNow === true) {
    return true;
  }
  if (hoursConfig.openNow === false) {
    return false;
  }

  const openHour = hoursConfig.openHour ?? DEFAULT_WEEKDAY_HOURS.openHour;
  const closeHour = hoursConfig.closeHour ?? DEFAULT_WEEKDAY_HOURS.closeHour;
  const currentMinutes = hour * 60 + minute;
  const openMinutes = openHour * 60;
  const closeMinutes = closeHour * 60;

  return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
}

function getNextBusinessOpenTime(hoursConfig, date = new Date()) {
  if (hoursConfig.alwaysOpen) {
    return date;
  }

  const openHour = hoursConfig.openHour ?? DEFAULT_WEEKDAY_HOURS.openHour;
  const timeZone = hoursConfig.timeZone || 'America/New_York';

  for (let offsetDays = 0; offsetDays < 8; offsetDays += 1) {
    const candidate = new Date(date.getTime() + offsetDays * 24 * 60 * 60 * 1000);
    const { weekday, hour, minute } = getLocalParts(candidate, timeZone);
    if (weekday === 0) {
      continue;
    }

    const currentMinutes = hour * 60 + minute;
    const openMinutes = openHour * 60;
    if (offsetDays === 0 && currentMinutes >= openMinutes) {
      if (isWithinBusinessHours(hoursConfig, candidate)) {
        return candidate;
      }
      continue;
    }

    const localDateString = candidate.toLocaleDateString('en-CA', { timeZone });
    const openDate = new Date(`${localDateString}T${String(openHour).padStart(2, '0')}:00:00`);
    return openDate;
  }

  return new Date(date.getTime() + 60 * 60 * 1000);
}

function scheduleCall(id, callPayload, scheduledFor) {
  scheduledCalls.set(id, {
    ...callPayload,
    scheduledFor: scheduledFor.toISOString(),
    createdAt: new Date().toISOString()
  });
}

export function getScheduledMaintenanceCalls() {
  return Array.from(scheduledCalls.entries()).map(([id, payload]) => ({ id, ...payload }));
}

export async function initiateMaintenanceProviderCall({
  voiceModule,
  callOptions,
  propertyAddress,
  provider = {},
  maintenanceRequest = null,
  onScheduled = null
}) {
  if (!voiceModule?.findProviderAndCall) {
    return {
      ok: false,
      error: 'Voice call module unavailable'
    };
  }

  const hoursConfig = resolveBusinessHours(provider, propertyAddress || callOptions?.location || '');
  const now = new Date();
  const practiceCallMode = process.env.MAINTENANCE_PRACTICE_MODE === '1'
    || (Boolean(process.env.TWILIO_TEST_TO_NUMBER) && process.env.NODE_ENV !== 'production' && !process.env.K_SERVICE);

  if (!practiceCallMode && !isWithinBusinessHours(hoursConfig, now)) {
    const scheduledFor = getNextBusinessOpenTime(hoursConfig, now);
    const scheduleId = maintenanceRequest?.id || `call_${Date.now()}`;

    scheduleCall(scheduleId, {
      callOptions,
      propertyAddress,
      provider,
      maintenanceRequestId: maintenanceRequest?.id || null,
      firestoreId: maintenanceRequest?.firestoreId || null,
      reason: 'outside_business_hours'
    }, scheduledFor);

    if (onScheduled) {
      onScheduled({
        scheduledFor,
        reason: 'outside_business_hours',
        hoursConfig
      });
    }

    return {
      ok: true,
      scheduled: true,
      scheduledFor: scheduledFor.toISOString(),
      reason: 'Provider is currently closed. Call scheduled for next business opening.',
      hoursConfig
    };
  }

  const callResult = await voiceModule.findProviderAndCall(callOptions);
  return {
    ...callResult,
    scheduled: false
  };
}

export async function scheduleMaintenanceCallRetry({
  voiceModule,
  callOptions,
  propertyAddress,
  provider = {},
  maintenanceRequest = null,
  reason = 'no_answer',
  delayMinutes = 30
}) {
  const hoursConfig = resolveBusinessHours(provider, propertyAddress || callOptions?.location || '');
  const retryAt = getNextBusinessOpenTime(hoursConfig, new Date(Date.now() + delayMinutes * 60 * 1000));
  const scheduleId = `${maintenanceRequest?.id || 'retry'}_${Date.now()}`;

  scheduleCall(scheduleId, {
    callOptions,
    propertyAddress,
    provider,
    maintenanceRequestId: maintenanceRequest?.id || null,
    firestoreId: maintenanceRequest?.firestoreId || null,
    reason
  }, retryAt);

  return {
    ok: true,
    scheduledFor: retryAt.toISOString(),
    reason
  };
}

export async function processScheduledMaintenanceCalls(voiceModule) {
  if (!voiceModule?.findProviderAndCall) {
    return { processed: 0 };
  }

  const now = Date.now();
  let processed = 0;

  for (const [id, payload] of scheduledCalls.entries()) {
    if (Date.parse(payload.scheduledFor) > now) {
      continue;
    }

    try {
      const result = await voiceModule.findProviderAndCall(payload.callOptions);
      scheduledCalls.delete(id);
      processed += 1;

      if (!result.ok && payload.firestoreId) {
        console.warn('[MaintenanceCallScheduler] Scheduled call failed:', id, result.error);
      }
    } catch (error) {
      console.warn('[MaintenanceCallScheduler] Scheduled call error:', id, error.message);
      scheduledCalls.delete(id);
    }
  }

  return { processed };
}

export function startMaintenanceCallScheduler(voiceModule) {
  import('node-cron').then(({ default: cron }) => {
    cron.schedule('*/5 * * * *', () => {
      processScheduledMaintenanceCalls(voiceModule).catch((error) => {
        console.warn('[MaintenanceCallScheduler] Cron run failed:', error.message);
      });
    });
    console.log('[MaintenanceCallScheduler] Scheduled call processor running every 5 minutes');
  }).catch(() => {
    console.warn('[MaintenanceCallScheduler] node-cron unavailable — deferred calls will not auto-run');
  });
}

export {
  extractStateCode,
  getTimezoneForAddress,
  isWithinBusinessHours,
  getNextBusinessOpenTime,
  resolveBusinessHours
};
