import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { updateUserProfileFields } from '../services/firebaseService';

const PRIVACY_POLICY_URL = 'https://gwgithub123.github.io/HouseYield-Privacy-Policy/';
const TERMS_URL = 'https://gwgithub123.github.io/HouseYield-EULA/';

function readOwnerProfile(data: Record<string, unknown> = {}) {
  return data.ownerProfile && typeof data.ownerProfile === 'object'
    ? data.ownerProfile as Record<string, unknown>
    : {};
}

function readOwnerPhone(data: Record<string, unknown> = {}) {
  const ownerProfile = readOwnerProfile(data);
  return String(data.phone || ownerProfile.phone || ownerProfile.contactPhone || '').trim();
}

function readMaintenanceSmsConsent(data: Record<string, unknown> = {}) {
  const ownerProfile = readOwnerProfile(data);
  return Boolean(ownerProfile.maintenanceSmsConsent);
}

export default function OwnerProfileContactSettings() {
  const { user } = useAuth();
  const [phone, setPhone] = useState('');
  const [smsConsent, setSmsConsent] = useState(false);
  const [savedSmsConsent, setSavedSmsConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id || user.role !== 'owner') {
      setLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);

      try {
        const snapshot = await getDoc(doc(db, 'users', user.id));
        if (cancelled) {
          return;
        }

        const data = snapshot.exists() ? snapshot.data() : {};
        setPhone(readOwnerPhone(data));
        const optedIn = readMaintenanceSmsConsent(data);
        setSmsConsent(optedIn);
        setSavedSmsConsent(optedIn);
      } catch (loadError: any) {
        if (!cancelled) {
          setError(loadError.message || 'Failed to load contact information.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.role]);

  if (!user || user.role !== 'owner') {
    return null;
  }

  const handleSave = async () => {
    const trimmedPhone = phone.trim();
    if (!trimmedPhone) {
      setError('Enter a mobile phone number to receive maintenance SMS confirmations.');
      setMessage(null);
      return;
    }

    if (!smsConsent) {
      setError('Check the consent box to agree to receive maintenance text messages.');
      setMessage(null);
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const snapshot = await getDoc(doc(db, 'users', user.id));
      const data = snapshot.exists() ? snapshot.data() : {};
      const existingOwnerProfile = readOwnerProfile(data);
      const now = new Date().toISOString();
      const hadConsent = readMaintenanceSmsConsent(data);

      const result = await updateUserProfileFields(user.id, {
        phone: trimmedPhone,
        ownerProfile: {
          ...existingOwnerProfile,
          phone: trimmedPhone,
          maintenanceSmsConsent: true,
          maintenanceSmsConsentAt: hadConsent
            ? (existingOwnerProfile.maintenanceSmsConsentAt as string) || now
            : now,
        },
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to save phone number.');
      }

      setMessage('Phone number saved. Maintenance SMS confirmations will be sent to this number.');
      setSavedSmsConsent(true);
    } catch (saveError: any) {
      setError(saveError.message || 'Failed to save phone number.');
    } finally {
      setSaving(false);
    }
  };

  const handleRevokeConsent = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const snapshot = await getDoc(doc(db, 'users', user.id));
      const data = snapshot.exists() ? snapshot.data() : {};
      const existingOwnerProfile = readOwnerProfile(data);

      const result = await updateUserProfileFields(user.id, {
        ownerProfile: {
          ...existingOwnerProfile,
          maintenanceSmsConsent: false,
          maintenanceSmsConsentRevokedAt: new Date().toISOString(),
        },
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to update SMS preferences.');
      }

      setSmsConsent(false);
      setSavedSmsConsent(false);
      setMessage('Maintenance SMS notifications are turned off. You can opt back in any time.');
    } catch (saveError: any) {
      setError(saveError.message || 'Failed to update SMS preferences.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border bg-white p-5 mb-6" data-voice-id="owner-contact-settings">
      <div className="text-base font-semibold mb-1">Maintenance Text Alerts</div>
      <p className="text-sm text-gray-600 mb-4">
        Add the mobile number where HouseYield should text you when tenants submit maintenance requests.
        You&apos;ll get a confirmation text before we call a provider.
      </p>

      <div className="space-y-4" data-voice-id="profile-form">
        <div>
          <label htmlFor="owner-maintenance-phone" className="block text-sm font-medium text-gray-700 mb-1.5">
            Mobile phone number
          </label>
          <input
            id="owner-maintenance-phone"
            type="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="(555) 123-4567"
            disabled={loading || saving}
            data-voice-id="profile-phone-input"
            className="w-full max-w-md rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50"
          />
        </div>

        <div className="max-w-2xl rounded-lg border border-gray-200 bg-gray-50 p-4">
          <label htmlFor="owner-maintenance-sms-consent" className="flex items-start gap-3 cursor-pointer">
            <input
              id="owner-maintenance-sms-consent"
              type="checkbox"
              checked={smsConsent}
              onChange={(event) => setSmsConsent(event.target.checked)}
              disabled={loading || saving}
              data-voice-id="profile-sms-consent-checkbox"
              className="mt-1 h-4 w-4 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">
              I agree to receive transactional text messages from HouseYield at the mobile number above
              about maintenance at my rental properties, including new request alerts, dispatch confirmation
              (reply YES or NO), provider connection updates, scheduled visit notices, service completion,
              and payment updates. Message frequency varies based on maintenance activity (typically 1–5
              messages per request). Message and data rates may apply. Reply STOP to opt out or HELP for
              help. See our{' '}
              <a
                href={TERMS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                Terms of Service
              </a>{' '}
              and{' '}
              <a
                href={PRIVACY_POLICY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                Privacy Policy
              </a>
              .
            </span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={loading || saving || !smsConsent}
            data-voice-id="save-profile-btn"
            className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Yes, sign me up for maintenance texts'}
          </button>
          {savedSmsConsent && (
            <button
              type="button"
              onClick={() => void handleRevokeConsent()}
              disabled={loading || saving}
              className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Turn off SMS alerts
            </button>
          )}
          {loading && <span className="text-xs text-gray-500">Loading…</span>}
        </div>

        {message && <div className="text-sm text-emerald-700">{message}</div>}
        {error && <div className="text-sm text-red-600">{error}</div>}
        {!loading && !phone.trim() && !error && !message && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            No maintenance SMS phone is saved yet. Add your number and consent to receive owner confirmations.
          </div>
        )}
      </div>
    </div>
  );
}
