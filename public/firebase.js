// firebase.js — initialise the Firebase app once and share it.
import { firebaseConfig, FIREBASE_ENABLED } from './firebase-config.js';

export const FB_VERSION = '10.12.2';
export { FIREBASE_ENABLED, firebaseConfig };

let appPromise = null;
export async function getFirebaseApp() {
  if (!FIREBASE_ENABLED) return null;
  if (!appPromise) appPromise = (async () => {
    const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-app.js`);
    return initializeApp(firebaseConfig);
  })();
  return appPromise;
}
