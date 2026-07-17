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
  apiKey: 'AIzaSyCbF8HQtfAF7PXZK0AtUp6Qc9gku7nl9MU',
  authDomain: 'tntf-428e3.firebaseapp.com',
  projectId: 'tntf-428e3',
  storageBucket: 'tntf-428e3.firebasestorage.app',
  messagingSenderId: '869349849601',
  appId: '1:869349849601:web:75a15814fa334b2be35e00',
  // For PUSH notifications only. Firebase console → Project settings → Cloud
  // Messaging → Web Push certificates → "Generate key pair" → paste the key.
  // Leave blank if you only want email notifications.
  vapidKey: 'BD8Cvp7s87szvBI-LdX7gWL_RkT1mT_gjoBLgocLCLesILQMLAk2szc0Kbs7sLGufRxD1fe2-csn8XCi25A0KY4'
};

// One-tap OAuth providers offered on the Join screen. People sign in with one
// of these, then the organiser merges the new account into their historic
// record.
//
// 'google' works out of the box once you enable it in the Firebase console
// (Authentication → Sign-in method → Google → Enable). To offer more, enable
// them in the console too and add them here:
//   'github'     (register an OAuth app on GitHub)
//   'microsoft'  (register an app in Azure AD)
export const authProviders = ['google'];

// Also let people create an account with an email + password (in addition to
// the providers above). Enable "Email/Password" in the Firebase console
// (Authentication → Sign-in method → Email/Password → Enable). Set to false to
// offer OAuth only.
export const authEmailPassword = true;

// Set to true only after you've pasted a real config above.
export const FIREBASE_ENABLED = Boolean(firebaseConfig.projectId);
