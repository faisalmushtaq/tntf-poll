// auth.js — robust OAuth sign-in (Firebase Auth): Google and friends.
// In demo mode (no Firebase config) this returns a disabled stub so the app
// still runs with the lightweight "pick your name" flow.
import { getFirebaseApp, FB_VERSION, FIREBASE_ENABLED } from './firebase.js';
import { authProviders, authEmailPassword } from './firebase-config.js';

// Label per OAuth provider. Add a new key here to support more.
const PROVIDER_META = {
  google:    { label: 'Continue with Google' },
  microsoft: { label: 'Continue with Microsoft' },
  github:    { label: 'Continue with GitHub' }
};

const DISABLED = {
  enabled: false, providers: [], emailPassword: false,
  onChange() { return () => {}; }, get user() { return null; },
  async signIn() {}, async signUpEmail() {}, async signInEmail() {},
  async resetPassword() {}, async complete() { return null; }, async signOut() {}
};

export async function createAuth() {
  if (!FIREBASE_ENABLED) return DISABLED;

  const app = await getFirebaseApp();
  const m = await import(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-auth.js`);
  const {
    getAuth, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult,
    GoogleAuthProvider, GithubAuthProvider, OAuthProvider, signOut,
    createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, updateProfile
  } = m;
  const auth = getAuth(app);

  const makeProvider = (name) => {
    switch (name) {
      case 'google': return new GoogleAuthProvider();
      case 'github': return new GithubAuthProvider();
      case 'microsoft': return new OAuthProvider('microsoft.com');
      default: throw new Error(`Unknown sign-in provider: ${name}`);
    }
  };

  const providers = (authProviders?.length ? authProviders : ['google'])
    .filter(n => PROVIDER_META[n])
    .map(n => ({ name: n, label: PROVIDER_META[n].label }));

  // Fall back to a full-page redirect only when a popup genuinely can't open
  // (blocked, or unsupported in this WebView). A user-cancelled popup is not
  // an error worth retrying.
  const REDIRECT_CODES = new Set(['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment']);
  const CANCEL_CODES = new Set(['auth/cancelled-popup-request', 'auth/popup-closed-by-user', 'auth/user-cancelled']);

  return {
    enabled: true,
    providers,
    emailPassword: authEmailPassword !== false,
    onChange(cb) { return onAuthStateChanged(auth, cb); },
    get user() { return auth.currentUser; },

    async signIn(name) {
      const provider = makeProvider(name);
      try {
        await signInWithPopup(auth, provider);
      } catch (e) {
        if (CANCEL_CODES.has(e.code)) return; // user backed out — no-op
        if (REDIRECT_CODES.has(e.code)) { await signInWithRedirect(auth, provider); return; }
        throw e;
      }
    },

    // Email + password: create a new account (optionally naming it), sign in,
    // or send a reset link.
    async signUpEmail(email, password, name) {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      if (name) { try { await updateProfile(cred.user, { displayName: name }); } catch {} }
      return cred.user;
    },
    async signInEmail(email, password) {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      return cred.user;
    },
    async resetPassword(email) { await sendPasswordResetEmail(auth, email); },

    // Finish a redirect-based sign-in if we came back from one.
    async complete() {
      try { const res = await getRedirectResult(auth); return res?.user || null; }
      catch (e) { console.error('redirect sign-in', e); return null; }
    },

    async signOut() { await signOut(auth); }
  };
}
