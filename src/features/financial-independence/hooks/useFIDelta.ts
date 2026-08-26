import { useEffect, useRef, useState } from 'react';

/**
 * Tracks how the FI verdict has shifted since the user's previous session.
 *
 * The delta is captured ONCE per mount from the first stable (ready) value and
 * compared against the snapshot persisted from the last visit. Live lever edits
 * within the current session intentionally do NOT move the delta — it reflects
 * "what changed since you were last here", not in-session tinkering. After
 * capturing, the current value becomes the new baseline for next time.
 */

interface FIDeltaSnapshot {
  fiYear: number | null;
  successProbability: number;
  savedAt: number;
}

export interface FIDeltaResult {
  previousFiYear: number | null;
  /** Positive = FI moved later, negative = earlier. Null when no prior visit. */
  deltaYears: number | null;
  previousSuccess: number | null;
  /** Change in success probability (0..1). */
  deltaSuccess: number | null;
  lastSeenLabel: string | null;
}

const EMPTY: FIDeltaResult = {
  previousFiYear: null,
  deltaYears: null,
  previousSuccess: null,
  deltaSuccess: null,
  lastSeenLabel: null,
};

function storageKey(userId: string | null | undefined): string {
  return `houseyield_fi_delta_${userId || 'anon'}`;
}

function relativeLabel(savedAt: number): string {
  const ms = Date.now() - savedAt;
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) {
    const hours = Math.floor(ms / 3_600_000);
    if (hours <= 0) return 'earlier today';
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return 'last week';
  if (weeks < 5) return `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  return months <= 1 ? 'last month' : `${months} months ago`;
}

export function useFIDelta(params: {
  userId?: string | null;
  fiYear: number | null;
  successProbability: number;
  ready: boolean;
}): FIDeltaResult {
  const { userId, fiYear, successProbability, ready } = params;
  const [result, setResult] = useState<FIDeltaResult>(EMPTY);
  const capturedRef = useRef(false);

  useEffect(() => {
    if (!ready || capturedRef.current || typeof window === 'undefined') {
      return;
    }
    capturedRef.current = true;

    const key = storageKey(userId);
    let previous: FIDeltaSnapshot | null = null;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) previous = JSON.parse(raw) as FIDeltaSnapshot;
    } catch {
      previous = null;
    }

    if (previous) {
      const deltaYears = previous.fiYear !== null && fiYear !== null
        ? fiYear - previous.fiYear
        : null;
      const deltaSuccess = Number.isFinite(previous.successProbability)
        ? successProbability - previous.successProbability
        : null;
      setResult({
        previousFiYear: previous.fiYear,
        deltaYears,
        previousSuccess: previous.successProbability,
        deltaSuccess,
        lastSeenLabel: relativeLabel(previous.savedAt),
      });
    }

    const snapshot: FIDeltaSnapshot = {
      fiYear,
      successProbability,
      savedAt: Date.now(),
    };
    try {
      window.localStorage.setItem(key, JSON.stringify(snapshot));
    } catch {
      /* storage full / disabled — non-fatal */
    }
  }, [ready, userId, fiYear, successProbability]);

  return result;
}
