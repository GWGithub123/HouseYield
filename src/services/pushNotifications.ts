/* Utilities for registering service worker and managing web push subscriptions.
   Note: To actually send push notifications, you need a push server with VAPID keys
   (e.g., using Web Push protocol). Provide the public VAPID key via Vite env
   `VITE_VAPID_PUBLIC_KEY` and implement a backend endpoint to save subscriptions.
*/

export type PushSubscribeResult =
  | { ok: true; endpoint: string; subscription: PushSubscriptionJSON }
  | { ok: false; reason: string };

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    return registration;
  } catch (err) {
    console.error('Service worker registration failed', err);
    return null;
  }
}

export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  return await Notification.requestPermission();
}

export async function subscribeToPush(serverSaveUrl?: string): Promise<PushSubscribeResult> {
  try {
    const permission = await ensureNotificationPermission();
    if (permission !== 'granted') {
      return { ok: false, reason: 'Notifications permission not granted' };
    }

    const registration = await registerServiceWorker();
    if (!registration) return { ok: false, reason: 'Service worker not available' };

    const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
    if (!vapidPublicKey) return { ok: false, reason: 'Missing VAPID public key' };
    const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);

    const existing = await registration.pushManager.getSubscription();
    const subscription = existing || (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }));

    const json = subscription.toJSON();

  const base = serverSaveUrl || (import.meta.env.VITE_PUSH_SERVER_URL as string | undefined)?.replace(/\/$/, '');
  const saveUrl = base ? `${base}/subscribe` : undefined;
  if (saveUrl) {
      await fetch(saveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json),
      });
    }

    return { ok: true, endpoint: subscription.endpoint, subscription: json };
  } catch (err: any) {
    console.error('subscribeToPush error', err);
    return { ok: false, reason: err?.message || 'Unknown error' };
  }
}

export async function unsubscribeFromPush(serverDeleteUrl?: string): Promise<boolean> {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return false;
    const sub = await registration.pushManager.getSubscription();
    if (!sub) return true;
    const json = sub.toJSON();
    const success = await sub.unsubscribe();
  const base = serverDeleteUrl || (import.meta.env.VITE_PUSH_SERVER_URL as string | undefined)?.replace(/\/$/, '');
  const deleteUrl = base ? `${base}/unsubscribe` : undefined;
  if (success && deleteUrl) {
      await fetch(deleteUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json),
      });
    }
    return success;
  } catch (err) {
    console.error('unsubscribeFromPush error', err);
    return false;
  }
}

// Send a test push via the push server's /send endpoint
export async function sendTestPush(
  baseUrl?: string,
  payload?: { title?: string; body?: string; data?: any }
): Promise<{ ok: boolean; reason?: string; count?: number } & Record<string, any>> {
  try {
    const base = baseUrl || (import.meta.env.VITE_PUSH_SERVER_URL as string | undefined)?.replace(/\/$/, '');
    if (!base) return { ok: false, reason: 'Missing VITE_PUSH_SERVER_URL' };
    const body = payload || { title: 'Renaissance Realty', body: 'Test notification', data: { url: '/' } };
    const res = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, ...json } as any;
  } catch (err: any) {
    console.error('sendTestPush error', err);
    return { ok: false, reason: err?.message || 'Unknown error' } as any;
  }
}
