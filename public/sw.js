// Version tracking for cache management
const CACHE_VERSION = 'v2025-12-02_20:00_REAL_DEPTH';
const CACHE_NAME = `renaissance-realty-${CACHE_VERSION}`;

self.addEventListener('install', (event) => {
  // Clear old caches when new service worker installs
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith('renaissance-realty-') && name !== CACHE_NAME)
          .map((name) => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => {
      console.log('[SW] New version installed:', CACHE_VERSION);
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith('renaissance-realty-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => {
      console.log('[SW] Activated version:', CACHE_VERSION);
      return self.clients.claim();
    })
  );
});

// Required for iOS web push; shows notifications from push payload
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: 'Notification', body: event.data && event.data.text ? event.data.text() : '' };
  }
  const title = data.title || 'Renaissance Realty';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: data.data || {},
    actions: data.actions || [],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification && event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          // If the app is already open, focus it
          if (client.url.includes(self.registration.scope)) {
            return client.focus();
          }
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});
