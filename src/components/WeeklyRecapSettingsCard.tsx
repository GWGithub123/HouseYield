import React, { useEffect, useState } from 'react';
import {
  getWeeklyDigestPreferences,
  sendWeeklyDigestNow,
  updateWeeklyDigestPreferences,
  type WeeklyDigestPreferences,
} from '../services/weeklyDigestClient';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export default function WeeklyRecapSettingsCard() {
  const [preferences, setPreferences] = useState<WeeklyDigestPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;
    getWeeklyDigestPreferences()
      .then((prefs) => {
        if (isActive) setPreferences(prefs);
      })
      .catch((loadError: Error) => {
        if (isActive) setError(loadError.message);
      })
      .finally(() => {
        if (isActive) setLoading(false);
      });
    return () => {
      isActive = false;
    };
  }, []);

  const save = async (updates: Parameters<typeof updateWeeklyDigestPreferences>[0]) => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const next = await updateWeeklyDigestPreferences(updates);
      setPreferences(next);
      setMessage('Saved');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setSending(true);
    setMessage(null);
    setError(null);
    const result = await sendWeeklyDigestNow(preferences?.recipientEmail || undefined);
    if (result.ok) {
      setMessage('Test recap sent — check your inbox.');
    } else {
      setError(result.error || 'Send failed');
    }
    setSending(false);
  };

  return (
    <div className="rounded-xl border bg-white p-5 mb-6" data-voice-id="weekly-recap-settings">
      <div className="text-base font-semibold mb-1">Weekly Recap Email</div>
      <p className="mb-4 text-xs text-gray-500">
        A Sunday-morning email with your week in review: rent collected, expenses, maintenance, leases, and a local market note.
      </p>

      {loading ? (
        <div className="text-sm text-gray-500">Loading settings…</div>
      ) : !preferences ? (
        <div className="text-sm text-rose-600">{error || 'Unable to load settings.'}</div>
      ) : (
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={preferences.enabled}
              disabled={saving}
              onChange={(event) => void save({ enabled: event.target.checked })}
            />
            Send me the weekly recap
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-gray-600">Recipient email</span>
              <input
                type="email"
                defaultValue={preferences.recipientEmail}
                placeholder="you@example.com"
                className="w-full rounded-lg border px-3 py-1.5 text-sm"
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (value !== preferences.recipientEmail) {
                    void save({ recipientEmail: value });
                  }
                }}
              />
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-gray-600">Delivery day &amp; time</span>
              <span className="flex items-center gap-2">
                <select
                  className="rounded-lg border px-2 py-1.5 text-sm capitalize"
                  value={preferences.schedule.weekday}
                  disabled={saving}
                  onChange={(event) => void save({ weekday: event.target.value })}
                >
                  {WEEKDAYS.map((day) => (
                    <option key={day} value={day} className="capitalize">{day}</option>
                  ))}
                </select>
                <select
                  className="rounded-lg border px-2 py-1.5 text-sm"
                  value={preferences.schedule.localHour}
                  disabled={saving}
                  onChange={(event) => void save({ localHour: Number(event.target.value) })}
                >
                  {Array.from({ length: 24 }, (_, hour) => (
                    <option key={hour} value={hour}>
                      {hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-gray-500">{preferences.schedule.timeZone}</span>
              </span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50"
              disabled={sending}
              data-voice-id="send-test-weekly-recap-btn"
              onClick={() => void sendTest()}
            >
              {sending ? 'Sending…' : 'Send Test Recap Now'}
            </button>
            {preferences.lastSentAt ? (
              <span className="text-xs text-gray-500">
                Last sent {new Date(preferences.lastSentAt).toLocaleString()}
              </span>
            ) : (
              <span className="text-xs text-gray-500">Never sent yet</span>
            )}
          </div>

          {preferences.lastError ? (
            <div className="text-xs text-rose-600">Last delivery error: {preferences.lastError}</div>
          ) : null}
          {message ? <div className="text-xs text-emerald-600">{message}</div> : null}
          {error ? <div className="text-xs text-rose-600">{error}</div> : null}
        </div>
      )}
    </div>
  );
}
