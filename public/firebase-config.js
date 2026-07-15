// firebase-config.js
// ---------------------------------------------------------------------------
// PASTE YOUR FIREBASE PROJECT CONFIG HERE to turn on shared, multi-device mode.
//
// How to get it (takes ~3 minutes, free — the Spark plan is plenty):
//   1. Go to https://console.firebase.google.com and "Add project".
//   2. In the project, open Build → Firestore Database → Create database
//      (Start in *production mode*, pick a region near you).
//   3. Firestore → Rules tab → paste the contents of firestore.rules → Publish.
//   4. Project settings (gear icon) → "Your apps" → Web app (</>) → register.
//      Copy the firebaseConfig object it shows you into the object below.
//
// Until you fill this in, the app runs in single-device DEMO mode using this
// browser's localStorage (great for trying it out; not shared between people).
//
// NOTE: these values are NOT secret — Firebase web config is meant to be public.
// Access is controlled by firestore.rules, not by hiding these keys.
// ---------------------------------------------------------------------------
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
  // For PUSH notifications only. Firebase console → Project settings → Cloud
  // Messaging → Web Push certificates → "Generate key pair" → paste the key.
  // Leave blank if you only want email notifications.
  vapidKey: ''
};

// Set to true only after you've pasted a real config above.
export const FIREBASE_ENABLED = Boolean(firebaseConfig.projectId);
