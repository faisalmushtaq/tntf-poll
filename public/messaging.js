// messaging.js — Firebase Cloud Messaging (web push) token capture.
// Cross-platform: Android/desktop Chrome work directly; iOS works once the
// app is added to the Home Screen (Apple only allows web push for installed
// PWAs, iOS 16.4+).
import { getFirebaseApp, FB_VERSION, firebaseConfig, FIREBASE_ENABLED } from './firebase.js';

export function pushConfigured() {
  return FIREBASE_ENABLED && !!firebaseConfig.vapidKey;
}
export function pushSupported() {
  return pushConfigured() && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}
// iOS Safari only supports web push when running as an installed PWA.
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
export function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent);
}

// Request permission, register the service worker, return an FCM token.
export async function enablePush() {
  if (!pushSupported()) throw new Error('Push not supported on this device/browser');
  if (isIOS() && !isStandalone()) throw new Error('On iPhone, first add this app to your Home Screen, then open it from there.');

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked — enable them in browser settings.');

  // The service worker needs the config; pass it in the query string so we
  // don't have to hard-code it in a second place.
  const swUrl = './firebase-messaging-sw.js?config=' + encodeURIComponent(JSON.stringify({
    apiKey: firebaseConfig.apiKey, authDomain: firebaseConfig.authDomain, projectId: firebaseConfig.projectId,
    messagingSenderId: firebaseConfig.messagingSenderId, appId: firebaseConfig.appId, storageBucket: firebaseConfig.storageBucket
  }));
  const reg = await navigator.serviceWorker.register(swUrl);

  const app = await getFirebaseApp();
  const m = await import(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-messaging.js`);
  const { getMessaging, getToken, onMessage } = m;
  const messaging = getMessaging(app);

  // Foreground messages: surface them in-app rather than as OS notifications.
  onMessage(messaging, payload => window.dispatchEvent(new CustomEvent('tntf-push', { detail: payload })));

  const token = await getToken(messaging, { vapidKey: firebaseConfig.vapidKey, serviceWorkerRegistration: reg });
  if (!token) throw new Error('Could not get a push token');
  return token;
}
