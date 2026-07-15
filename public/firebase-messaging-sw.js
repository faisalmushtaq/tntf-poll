/* firebase-messaging-sw.js — background push handler.
   Uses the compat build (service workers can't use the modular ESM imports).
   The Firebase config is passed in the registration URL's ?config= param so it
   isn't duplicated across the codebase. */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

try {
  const cfg = JSON.parse(new URL(location).searchParams.get('config') || '{}');
  if (cfg.projectId) {
    firebase.initializeApp(cfg);
    const messaging = firebase.messaging();
    messaging.onBackgroundMessage(({ notification, data }) => {
      const n = notification || data || {};
      self.registration.showNotification(n.title || 'Tuesday Night Total Football', {
        body: n.body || '',
        icon: './icon.svg',
        badge: './icon.svg',
        data: (data && data.url) ? { url: data.url } : {},
        tag: 'tntf-status'
      });
    });
  }
} catch (e) { /* no-op: config missing until the user sets it up */ }

// Focus/open the app when a notification is tapped.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
