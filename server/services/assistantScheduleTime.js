/**
 * Pure natural-language / structured schedule resolver for assistant tasks.
 * No Firebase or side effects — safe to unit test in isolation.
 */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const NATURAL_TIME_HINT = /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|at\s+\d|in\s+\d|\d{1,2}:\d{2}\s*(a\.?m\.?|p\.?m\.?)?|\d{1,2}\s*(a\.?m\.?|p\.?m\.?)|noon|midnight|morning|afternoon|evening)\b/i;

export function looksLikeNaturalSchedulePhrase(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return false;
  if (/^\d{13}$/.test(text)) return false;
  return NATURAL_TIME_HINT.test(text);
}

export function parseDateLike(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 1e11) {
    const fromMs = new Date(asNumber);
    return Number.isNaN(fromMs.getTime()) ? null : fromMs;
  }
  const raw = String(value).trim();
  // Reject bare date-only / ambiguous strings that Date() treats as UTC midnight
  // unless they are full ISO timestamps.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number);
    return new Date(year, month - 1, day, 9, 0, 0, 0);
  }
  const fromString = new Date(raw);
  return Number.isNaN(fromString.getTime()) ? null : fromString;
}

function parseClockParts(text, { defaultHour = null } = {}) {
  const lower = String(text || '').toLowerCase();

  if (/\bnoon\b/.test(lower)) return { hours: 12, minutes: 0, found: true };
  if (/\bmidnight\b/.test(lower)) return { hours: 0, minutes: 0, found: true };
  if (/\bmorning\b/.test(lower) && !/\d/.test(lower)) return { hours: 9, minutes: 0, found: true };
  if (/\bafternoon\b/.test(lower) && !/\d/.test(lower)) return { hours: 15, minutes: 0, found: true };
  if (/\bevening\b/.test(lower) && !/\d/.test(lower)) return { hours: 18, minutes: 0, found: true };
  if (/\btonight\b/.test(lower) && !/\d/.test(lower)) return { hours: 19, minutes: 0, found: true };

  // Prefer explicit "at 4:02 pm" / "4pm" / "16:00" patterns.
  const atMatch = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/);
  const looseMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))\s*(a\.?m\.?|p\.?m\.?)?\b/)
    || lower.match(/\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/);
  const match = atMatch || looseMatch;
  if (!match) {
    if (defaultHour == null) return { hours: null, minutes: null, found: false };
    return { hours: defaultHour, minutes: 0, found: false };
  }

  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const meridiem = String(match[3] || '').replace(/\./g, '').toLowerCase();

  if (!Number.isFinite(hours) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return { hours: null, minutes: null, found: false };
  }

  if (meridiem.startsWith('p') && hours < 12) hours += 12;
  if (meridiem.startsWith('a') && hours === 12) hours = 0;
  // Bare 1–7 without meridiem in scheduling speech usually means PM for landlord tasks,
  // but only when the phrase includes "at" and no 24h-style minutes were given as military.
  if (!meridiem && atMatch && hours >= 1 && hours <= 7 && match[2] == null) {
    hours += 12;
  }

  return { hours, minutes, found: true };
}

function parseMonthDay(lower, now) {
  const match = lower.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (!match) return null;
  const month = MONTHS[match[1]];
  const day = Number(match[2]);
  if (month == null || !Number.isFinite(day) || day < 1 || day > 31) return null;
  const year = now.getFullYear();
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setFullYear(year, month, day);
  if (candidate.getTime() < now.getTime() - 12 * 60 * 60 * 1000) {
    candidate.setFullYear(year + 1);
  }
  return candidate;
}

/**
 * Resolve a natural-language or structured schedule into a Date in the local timezone
 * of the Node process (expected to be the owner's local/dev timezone).
 *
 * Important: natural-language `when` always wins over an invented ISO `runAt` from the model.
 */
export function resolveScheduledRunAt({
  runAt,
  when,
  scheduledFor,
  date,
  time,
  timeZone = null,
  now = new Date(),
} = {}) {
  void timeZone; // reserved for explicit TZ conversion later

  const whenPhrase = String(when || '').trim();
  const scheduledPhrase = String(scheduledFor || '').trim();
  const runAtRaw = runAt;
  const datePart = String(date || '').trim();
  const timePart = String(time || '').trim();

  // Prefer natural language over model-invented ISO timestamps.
  const naturalPhrase = [whenPhrase, scheduledPhrase].find((phrase) => looksLikeNaturalSchedulePhrase(phrase)) || '';
  const phrase = naturalPhrase || whenPhrase || scheduledPhrase || (looksLikeNaturalSchedulePhrase(runAtRaw) ? String(runAtRaw).trim() : '');

  if (!phrase) {
    const direct = parseDateLike(runAtRaw);
    if (direct && direct.getTime() > now.getTime() - 60_000) return direct;
  }

  if (datePart && timePart) {
    const clock = parseClockParts(timePart);
    if (clock.found && clock.hours != null) {
      const base = parseDateLike(datePart);
      if (base) {
        base.setHours(clock.hours, clock.minutes, 0, 0);
        return base;
      }
    }
    const combined = parseDateLike(`${datePart} ${timePart}`);
    if (combined) return combined;
  }

  if (datePart && !timePart && !phrase) {
    const base = parseDateLike(datePart);
    if (base) {
      base.setHours(9, 0, 0, 0);
      return base;
    }
  }

  if (!phrase && !datePart) {
    const direct = parseDateLike(runAtRaw);
    return direct && direct.getTime() > now.getTime() - 60_000 ? direct : null;
  }

  const lower = phrase.toLowerCase();

  const relativeHours = lower.match(/\bin\s+(\d+)\s*(hours?|hrs?|h)\b/);
  if (relativeHours) {
    const hours = Number(relativeHours[1]);
    if (Number.isFinite(hours) && hours > 0) {
      return new Date(now.getTime() + hours * 60 * 60 * 1000);
    }
  }

  const relativeMinutes = lower.match(/\bin\s+(\d+)\s*(minutes?|mins?|m)\b/);
  if (relativeMinutes) {
    const minutes = Number(relativeMinutes[1]);
    if (Number.isFinite(minutes) && minutes > 0) {
      return new Date(now.getTime() + minutes * 60 * 1000);
    }
  }

  const clock = parseClockParts(phrase, { defaultHour: null });
  const timeOnlyClock = !clock.found && timePart ? parseClockParts(timePart) : clock;
  const hours = timeOnlyClock.hours;
  const minutes = timeOnlyClock.minutes;
  const hasExplicitTime = timeOnlyClock.found && hours != null;

  const applyTime = (candidate) => {
    if (hasExplicitTime) {
      candidate.setHours(hours, minutes, 0, 0);
    } else {
      // No explicit clock time — keep a sensible daytime default, but never silently
      // pretend the user asked for 9am when they said "4pm".
      candidate.setHours(9, 0, 0, 0);
    }
    candidate.setSeconds(0, 0);
    return candidate;
  };

  if (/\btomorrow\b/.test(lower)) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + 1);
    return applyTime(candidate);
  }

  if (/\btoday\b|\btonight\b/.test(lower)) {
    const candidate = applyTime(new Date(now));
    // If "today at X" is already past, do NOT silently roll to tomorrow morning —
    // bump to the next day at the same clock time only when an explicit time was given.
    if (candidate.getTime() <= now.getTime()) {
      if (hasExplicitTime) {
        candidate.setDate(candidate.getDate() + 1);
        return candidate;
      }
      return new Date(now.getTime() + 15 * 60 * 1000);
    }
    return candidate;
  }

  for (let index = 0; index < WEEKDAYS.length; index += 1) {
    const day = WEEKDAYS[index];
    if (!new RegExp(`\\b${day}\\b`).test(lower)) continue;
    const currentDay = now.getDay();
    let delta = index - currentDay;
    if (delta < 0) delta += 7;
    const candidate = applyTime(new Date(now));
    if (delta === 0 && candidate.getTime() <= now.getTime()) delta = 7;
    candidate.setDate(now.getDate() + delta);
    return applyTime(candidate);
  }

  const monthDay = parseMonthDay(lower, now);
  if (monthDay) {
    return applyTime(monthDay);
  }

  if (hasExplicitTime) {
    const candidate = applyTime(new Date(now));
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }

  // Last resort: ISO / Date parse of the phrase itself (not a preferred invented runAt).
  const fallback = parseDateLike(phrase);
  if (fallback && fallback.getTime() > now.getTime() - 60_000) return fallback;

  const directRunAt = parseDateLike(runAtRaw);
  if (directRunAt && directRunAt.getTime() > now.getTime() - 60_000) return directRunAt;

  return null;
}
