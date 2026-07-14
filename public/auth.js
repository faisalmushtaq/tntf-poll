// auth.js — passwordless email magic-link sign-in (Firebase Auth).
// In demo mode (no Firebase config) this returns a disabled stub so the app
// still runs with the lightweight "pick your name" flow.
import { getFirebaseApp, FB_VERSION, FIREBASE_ENABLED } from './firebase.js';

const EMAIL_KEY = 'tntf.emailForSignIn';

export async function createAuth() {
  if (!FIREBASE_ENABLED) {
    return { enabled: false, onChange() { return () => {}; }, get user() { return null; },
      async sendLink() {}, async complete() { return null; }, async signOut() {} };
  }
  const app = await getFirebaseApp();
  const m = await import(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-auth.js`);
  const { getAuth, onAuthStateChanged, sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, signOut } = m;
  const auth = getAuth(app);

  return {
    enabled: true,
    onChange(cb) { return onAuthStateChanged(auth, cb); },
    get user() { return auth.currentUser; },

    async sendLink(email) {
      const url = location.origin + location.pathname; // come back to this page
      await sendSignInLinkToEmail(auth, email, { url, handleCodeInApp: true });
      localStorage.setItem(EMAIL_KEY, email);
    },

    // If the current URL is a completed sign-in link, finish signing in.
    async complete() {
      if (!isSignInWithEmailLink(auth, location.href)) return null;
      let email = localStorage.getItem(EMAIL_KEY);
      if (!email) email = window.prompt('Confirm the email you used to sign in');
      if (!email) return null;
      const res = await signInWithEmailLink(auth, email, location.href);
      localStorage.removeItem(EMAIL_KEY);
      history.replaceState({}, '', location.pathname); // strip the link params
      return res.user;
    },

    async signOut() { await signOut(auth); }
  };
}
