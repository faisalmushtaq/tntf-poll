// app.js — vanilla mobile SPA. Talks to the data layer (db.js); no backend.
import { createDB } from './db.js';
import { createAuth } from './auth.js';
import { enablePush, pushSupported, pushConfigured, isIOS, isStandalone } from './messaging.js';
import { fetchWeather, weatherFlags } from './weather.js';
import * as logic from './logic.js';

const $app = document.getElementById('app');

const LS = {
  get id() { return localStorage.getItem('tntf.playerId'); },
  set id(v) { v ? localStorage.setItem('tntf.playerId', v) : localStorage.removeItem('tntf.playerId'); },
  get pin() { return sessionStorage.getItem('tntf.pin') || ''; },
  set pin(v) { v ? sessionStorage.setItem('tntf.pin', v) : sessionStorage.removeItem('tntf.pin'); }
};

let db = null;
let auth = null;
let user = null;      // signed-in Firebase user (cloud mode) or null
let lastRaw = null;   // latest snapshot from the data layer
let state = null;     // derived view for rendering
let history = null;   // completed games (loaded lazily for Stats)
let tab = 'week';
let detailId = null;  // which historic game the detail view is showing
let menuOpen = false; // mobile top-nav dropdown open?
let mediaCache = {};  // dateKey -> {videos, clips, note} | null (fetched, none) | undefined (unchecked)
let mediaPending = {}; // dateKey -> true while its file is loading
let weatherCache = {}; // cacheKey -> weather summary | null (none) | undefined (unchecked)
let weatherPending = {};
let authMode = 'signup'; // email form mode on the Join screen: 'signup' | 'signin'
let pendingName = null;   // name typed on account creation, used to name the roster record
let tableSort = { key: 'loyalty', dir: 'desc' }; // League-table sort column + direction
let adminUnlocked = false;
let lineupDraft = null;        // organiser lineupDraft builder state { bibs:[], nonbibs:[] }
let lineupGameId = null;  // which game `lineupDraft` was built for

// Top-nav definition: [tab key, label]. Order is left→right on web,
// top→bottom in the mobile menu.
const NAV = [
  ['week', 'This week'],
  ['join', 'Join'],
  ['history', 'History'],
  ['table', 'Table'],
  ['you', 'You'],
  ['rules', 'Rules'],
  ['admin', 'Organiser']
];

// Resolve "me": in cloud+auth mode match the signed-in account to a roster
// entry by uid/email; in demo mode fall back to the name saved on this device.
function resolveMe() {
  if (auth?.enabled) {
    if (!user) return null;
    const p = Object.values(lastRaw.playersById).find(x => x.uid === user.uid || (x.email && user.email && x.email.toLowerCase() === user.email.toLowerCase()));
    if (p) { LS.id = p.id; return p; }
    return null; // signed in but not linked to a roster spot yet
  }
  return LS.id ? lastRaw.playersById[LS.id] || null : null;
}

// After an OAuth sign-in, make sure this account has a roster record. Matches
// an existing player by uid/email (backend-deduped); otherwise creates a fresh
// account:true record the organiser can later merge into a historic profile.
let accountPending = false;
async function ensureAccount(u) {
  if (!u || !db || accountPending) return;
  accountPending = true;
  try {
    // upsertAccount is the single source of truth: with the DB cache loaded it
    // matches an existing record by uid/email and only creates one when there's
    // genuinely none — so this is idempotent and can't spawn duplicates.
    const name = u.displayName || pendingName || (u.email || '').split('@')[0];
    pendingName = null;
    const id = await db.upsertAccount({ uid: u.uid, email: u.email, name, photoURL: u.photoURL });
    LS.id = id; // the players snapshot will re-render with the resolved record
  } catch (e) { console.error('account setup', e); toast(e.message || 'Sign-in failed', true); }
  finally { accountPending = false; }
}

// Heal any pre-existing duplicate accounts (same uid) left by the earlier race:
// collapse them into the richest record. Runs once per session when signed in.
let dedupeRan = false;
async function maybeDedupe() {
  if (dedupeRan || !db || !user || !lastRaw) return;
  const merges = logic.duplicateMerges(lastRaw.playersById);
  if (!merges.length) { dedupeRan = true; return; }
  dedupeRan = true;
  try { for (const m of merges) await db.mergePlayers(m.keep, m.drop); }
  catch (e) { console.error('dedupe', e); dedupeRan = false; }
}

// One-time config self-heal: bring an older stored config up to the current
// defaults (venue name + pitch coordinates), so weather turns on and the venue
// updates without anyone touching Settings. Runs once per session.
let configMigrated = false;
function maybeMigrateConfig() {
  if (configMigrated || !db || !state) return;
  configMigrated = true;
  const patch = logic.configMigrationPatch(state.config);
  if (Object.keys(patch).length) db.updateConfig(patch).catch(e => console.error('config self-heal', e));
}

// ---- derive the render view from a raw snapshot ---------------------------
function buildView() {
  if (!lastRaw) return;
  const me = resolveMe();
  const playerId = me ? me.id : null;

  let game = null;
  const g = lastRaw.game;
  if (g && g.status !== 'completed') {
    const ranked = logic.rankSignups(lastRaw.signups, lastRaw.playersById, g.capacity);
    const mine = playerId ? ranked.find(r => r.playerId === playerId) : null;
    const hrs = logic.hoursUntilKickoff(g.kickoffAt);
    const paidBy = {};
    for (const s of lastRaw.signups) if (s.status !== 'withdrawn') paidBy[s.playerId] = !!s.paid;
    const withPaid = r => ({ ...r, paid: !!paidBy[r.playerId] });
    game = {
      id: g.id, status: g.status, dateLabel: g.dateLabel, kickoffAt: g.kickoffAt, capacity: g.capacity,
      venue: g.venue || lastRaw.config.venue,
      teams: g.teams || null, teamsFinalised: !!g.teamsFinalised,
      confirmed: ranked.filter(r => r.status === 'confirmed').map(withPaid),
      waitlist: ranked.filter(r => r.status === 'waitlist').map(withPaid),
      totalIn: ranked.length,
      me: mine ? { rank: mine.rank, status: mine.status, paid: !!paidBy[playerId] } : null,
      withdrawPenaltyNow: logic.penaltyForHours(hrs, lastRaw.config).penalty
    };
  }
  const alert = game ? statusAlert(game, playerId) : null;
  state = { config: lastRaw.config, me, roster: lastRaw.roster, playersById: lastRaw.playersById, game, alert };
}

// Detect when my confirmed/reserve status changed since I last looked (works
// in every mode, no server needed) and surface it as an in-app banner.
function statusAlert(game, playerId) {
  if (!playerId || !game.me) return null;
  const key = 'tntf.laststatus.' + game.id + '.' + playerId;
  const prev = localStorage.getItem(key);
  const now = game.me.status;
  if (prev !== now) localStorage.setItem(key, now);
  if (!prev || prev === now) return null;
  if (now === 'confirmed') return { kind: 'in', text: "🎉 You've been promoted — you're now IN the squad!" };
  return { kind: 'wait', text: "⚠️ You've been bumped to the reserves — you'll move up if someone drops." };
}

// ---- ui helpers -----------------------------------------------------------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, isErr = false) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.className = isErr ? 'err show' : 'show';
  clearTimeout(t._t); t._t = setTimeout(() => t.className = t.className.replace('show', ''), 2600);
}
function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function avatarColor(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 20% 56%)`; }
function initials(name) { return name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase(); }
function fmtCountdown(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return 'kicked off';
  const h = Math.floor(ms / 3.6e6), d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ${h % 24}h to kickoff`;
  const m = Math.floor((ms % 3.6e6) / 6e4);
  return `${h}h ${m}m to kickoff`;
}

function playerRow(p, opts = {}) {
  const me = p.playerId === LS.id || p.id === LS.id;
  return `<div class="player ${me ? 'me' : ''}">
    ${opts.num != null ? `<div class="num">${opts.num}</div>` : ''}
    <div class="avatar" style="background:${avatarColor(p.name)}">${initials(p.name)}</div>
    <div class="info">
      <div class="name">${esc(p.name)}${me ? ' <span class="small">(you)</span>' : ''}</div>
      <div class="meta">${opts.meta ?? `${p.gamesPlayed ?? 0} games played`}</div>
    </div>
    ${opts.right ?? `<div class="loyalty">${p.loyalty}</div>`}
  </div>`;
}

// ---- top bar --------------------------------------------------------------
// Persistent full-width masthead + responsive nav. Inline links on the web,
// a hamburger dropdown on mobile. Rendered outside #app so it can span the
// full window width and stay sticky.
const BALL_SVG = `<svg class="ball" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M12 6.6l3.1 2.25-1.18 3.65H10.08L8.9 8.85 12 6.6z" fill="currentColor"/><path d="M12 6.6V3.9M15.1 8.85l2.5-.8M13.9 12.5l1.6 2.1M10.1 12.5l-1.6 2.1M8.9 8.85l-2.5-.8" stroke="currentColor" stroke-width="1" stroke-linecap="round" fill="none"/></svg>`;

function renderTopbar() {
  const c = state.config;
  let bar = document.getElementById('topbar');
  if (!bar) {
    bar = document.createElement('header');
    bar.id = 'topbar';
    document.body.insertBefore(bar, $app);
  }
  bar.className = menuOpen ? 'open' : '';
  const links = NAV.map(([k, label]) => {
    const active = tab === k || (tab === 'game' && k === 'history');
    return `<a class="navlink${active ? ' active' : ''}" role="button" tabindex="0" onclick="go('${k}')">${label}</a>`;
  }).join('');
  bar.innerHTML = `<div class="bar">
    <a class="brand" role="button" tabindex="0" onclick="go('week')">${BALL_SVG}<h1>${esc(c.clubName)}</h1></a>
    <button class="menu-btn" aria-label="Menu" aria-expanded="${menuOpen}" onclick="toggleMenu()">${menuOpen ? '✕' : '☰'}</button>
    <nav class="topnav">${links}</nav>
  </div>`;
}

function demoBanner() {
  return db.mode === 'local'
    ? `<div class="demo-banner">Demo mode · single device. Add your Firebase config to share with the group — see README.</div>` : '';
}

// ---- screens --------------------------------------------------------------

function weekScreen() {
  const g = state.game;
  const alert = state.alert ? `<div class="mine-banner ${state.alert.kind}">${state.alert.text}</div>` : '';
  if (!g) {
    return `${alert}<div class="card center">
      <h2>No game open yet ⚽</h2>
      <p class="hint">The next poll opens after this week's game. When it's live you'll register here — your place is decided by loyalty, so there's no rush to be first.</p>
      ${state.me ? '' : identityPrompt()}
    </div>${nextGamePreview()}`;
  }

  const pct = Math.min(100, Math.round(g.confirmed.length / g.capacity * 100));
  let mine = '';
  if (!state.me) mine = `<div class="card">${identityPrompt()}</div>`;
  else if (g.me) mine = g.me.status === 'confirmed'
    ? `<div class="mine-banner in">✅ You're IN — squad place #${g.me.rank} of ${g.capacity}</div>`
    : `<div class="mine-banner wait">⏳ You're ${ordinal(g.me.rank - g.capacity)} reserve. You'll move up if someone in the squad drops.</div>`;
  else mine = `<div class="mine-banner out">You haven't registered for this game yet.</div>`;

  const actionBtn = () => {
    if (!state.me) return '';
    if (g.status !== 'open') return `<button class="btn-ghost" disabled>Registration ${esc(g.status)}</button>`;
    if (g.me) {
      const pen = g.withdrawPenaltyNow;
      const warn = pen > 0
        ? `Withdrawing now costs <b>-${pen} loyalty</b> (${fmtCountdown(g.kickoffAt).replace(' to kickoff', '')} out).`
        : `Free to withdraw now — more than 48h to kickoff.`;
      return `<p class="small mt center">${warn}</p><button class="btn-danger" onclick="withdraw()">Withdraw from this game</button>`;
    }
    return `<button class="btn-primary" onclick="signup()">I'm in for ${esc(g.dateLabel)} &nbsp;→</button>`;
  };

  const kicker = g.status === 'open' ? 'Registration open' : g.status === 'locked' ? 'Squad locked' : g.status;
  const k = new Date(g.kickoffAt);
  const dateLine = k.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const timeLine = k.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  return `
    ${alert}
    <div class="card">
      <div class="hero">
        <div class="kicker">${kicker}</div>
        <div class="date">${esc(dateLine)}</div>
        <div class="fixture">⏰ ${timeLine}${g.venue ? ` · 📍 ${esc(g.venue)}` : ''}</div>
        ${weatherBlock(g)}
        <div class="count">${g.confirmed.length}/${g.capacity} confirmed${g.waitlist.length ? ` · ${g.waitlist.length} on the bench` : ''} · ${fmtCountdown(g.kickoffAt)}</div>
        <div class="capbar"><span style="width:${pct}%"></span></div>
      </div>
      ${mine}
      ${actionBtn()}
      ${paymentControl(g)}
    </div>
    ${teamsCard(g)}
    <div class="card">
      <h2>Squad &amp; reserves</h2>
      <p class="hint">Everyone can see the full list. Ranked by loyalty score — a regular who signs up late still ranks above a casual, so there's no rush to be first.</p>
      <div class="lu-head">Starting ${g.capacity} · by loyalty</div>
      ${renderLineup(g.confirmed, 1, 'loyalty')}
      ${g.waitlist.length ? `<div class="lu-head sub">Reserves</div>${renderLineup(g.waitlist, g.capacity + 1, 'reserve')}` : ''}
    </div>`;
}

// Player's own "have you paid?" toggle — appears once you're in the squad.
function paymentControl(g) {
  if (!state.me || !g.me) return '';
  if (g.me.status !== 'confirmed' && !g.me.paid) return ''; // only once you're actually in
  const paid = g.me.paid;
  return `<div class="pay-row${paid ? ' paid' : ''}">
    <span class="pay-label">${paid ? '✅ Payment confirmed — thanks!' : '💸 Have you paid the match fee?'}</span>
    <button class="btn-ghost pay-btn" onclick="markPaid('${g.id}', ${paid ? 'false' : 'true'})">${paid ? 'Mark unpaid' : "Yes, I've paid"}</button>
  </div>`;
}

// Organiser payment tracker for the current squad.
function paymentsAdmin(g) {
  const paidCount = g.confirmed.filter(r => r.paid).length;
  const rows = g.confirmed.map(r => `<div class="pay-line">
      <span class="pay-name">${esc(r.name)}</span>
      <button class="pay-toggle${r.paid ? ' ok' : ''}" onclick="togglePaid('${r.playerId}','${g.id}',${r.paid ? 'false' : 'true'})">${r.paid ? '✅ paid' : 'mark paid'}</button>
    </div>`).join('');
  return `<div class="section-title">Payments · ${paidCount}/${g.confirmed.length} paid</div>
    <p class="hint" style="margin-top:-2px">Players tick themselves off — tap here to record cash on the night.</p>
    <div class="pay-list">${rows || '<div class="empty">No one confirmed yet.</div>'}</div>`;
}

// Published teams (bibs vs non-bibs) shown once the organiser finalises them.
function teamsCard(g) {
  if (!g.teamsFinalised || !g.teams) return '';
  const col = (ids, label, cls) => `<div class="team-col">
      <div class="team-head ${cls}">${label} <span>${ids.length}</span></div>
      ${ids.map((id, i) => {
        const p = state.playersById[id];
        const me = id === state.me?.id;
        return `<div class="lu-row${me ? ' me' : ''}"><span class="lu-num">${i + 1}</span><span class="lu-name">${esc(p ? abbrev(p.name) : '—')}${me ? ' <span class="you">you</span>' : ''}</span></div>`;
      }).join('')}
    </div>`;
  return `<div class="card">
    <h2>Teams — ${esc(g.dateLabel)}</h2>
    <p class="hint">The teams for this week. These can still change before kickoff.</p>
    <div class="teams-grid">${col(g.teams.bibs || [], 'Bibs', 'bibs')}${col(g.teams.nonbibs || [], 'Non-bibs', 'nonbibs')}</div>
  </div>`;
}

// Abbreviate to Guardian lineupDraft style: "Darren Ellis" → "D. Ellis"; single
// names stay as-is ("Faisal", "Suki").
function abbrev(name) {
  const parts = String(name).trim().split(/\s+/);
  return parts.length < 2 ? name : `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}

// Two-column "Lineups / Substitutes" style list (Guardian match-report look).
function renderLineup(list, startNum, badgeMode) {
  if (!list.length) return '<div class="empty">No one yet — be the first.</div>';
  const half = Math.ceil(list.length / 2);
  const row = (p, n, idx) => {
    const meCls = p.playerId === state.me?.id ? ' me' : '';
    const badge = badgeMode === 'reserve'
      ? `<span class="lu-badge amber">${ordinal(idx + 1)}</span>`
      : `<span class="lu-badge" title="loyalty">${p.loyalty}</span>`;
    const you = p.playerId === state.me?.id ? ' <span class="you">you</span>' : '';
    return `<div class="lu-row${meCls}"><span class="lu-num">${n}</span><span class="lu-name">${esc(abbrev(p.name))}${you}</span>${badge}</div>`;
  };
  const left = list.slice(0, half).map((p, i) => row(p, startNum + i, i)).join('');
  const right = list.slice(half).map((p, i) => row(p, startNum + half + i, half + i)).join('');
  return `<div class="lineupDraft"><div class="lu-col">${left}</div><div class="lu-col">${right}</div></div>`;
}

function nextGamePreview() {
  return `<div class="card">
    <h2>How selection works</h2>
    <p class="hint">When more than ${state.config.capacity} want to play, the squad is the top ${state.config.capacity} by <b>loyalty score</b> — you earn loyalty every game you play and lose it if you drop out late. It rewards regulars and removes the race to tap first.</p>
  </div>`;
}

// Mode-aware identity prompt:
//  • demo mode → pick your name (device-local)
//  • cloud + auth, signed out → OAuth provider buttons (Google etc.)
//  • cloud + auth, signed in → account is being set up (transient)
function identityPrompt() {
  if (auth?.enabled) {
    if (!user) {
      const btns = (auth.providers || []).map(p =>
        `<button class="btn-ghost provider mt" onclick="signIn('${p.name}')">${providerIcon(p.name)}<span>${esc(p.label)}</span></button>`).join('');
      const hasOAuth = (auth.providers || []).length > 0;
      const divider = hasOAuth && auth.emailPassword ? `<div class="or-divider">or</div>` : '';
      return `<h2>Sign in to register</h2>
        <p class="hint">Create an account or sign in — this is also how you're notified when your spot changes.</p>
        ${btns}
        ${auth.emailPassword ? divider + emailAuthForm() : ''}
        ${!hasOAuth && !auth.emailPassword ? '<p class="small">No sign-in methods configured yet — see README.</p>' : ''}
        <p class="small center mt">You can still see the squad and reserves without signing in.</p>`;
    }
    // Signed in, roster record still being created — resolves within a moment.
    return `<h2>Finishing sign-in…</h2>
      <p class="hint">Setting up your profile for ${esc(user.displayName || user.email || 'your account')}. One sec.</p>`;
  }
  return `<h2>What's your name?</h2>
    <p class="hint">Pick your name so we can track your loyalty. One tap and you're set on this phone.</p>
    <input id="nameInput" placeholder="e.g. ${esc((state.roster[0] && state.roster[0].name) || 'Your name')}" autocomplete="name" />
    <div class="mt"><button class="btn-primary" onclick="join()">Continue</button></div>
    <p class="small center mt">Already on the roster? Type your exact name to link up.</p>`;
}

// Small monochrome provider glyphs (inline so there are no external requests).
function providerIcon(name) {
  const wrap = inner => `<svg class="pv-icon" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
  if (name === 'google') return wrap('<path fill="currentColor" d="M21.35 11.1H12v3.2h5.35c-.25 1.36-1.02 2.5-2.17 3.27v2.7h3.5c2.05-1.9 3.22-4.68 3.22-8 0-.72-.07-1.42-.2-2.09z"/><path fill="currentColor" d="M12 22c2.7 0 4.96-.9 6.62-2.43l-3.5-2.7c-.97.65-2.22 1.03-3.12 1.03-2.4 0-4.43-1.62-5.16-3.8H3.2v2.38A10 10 0 0 0 12 22z"/><path fill="currentColor" d="M6.84 14.1a5.99 5.99 0 0 1 0-3.82V7.9H3.2a10 10 0 0 0 0 8.98l3.64-2.78z"/><path fill="currentColor" d="M12 6.5c1.47 0 2.79.5 3.83 1.5l2.86-2.86A9.6 9.6 0 0 0 12 2 10 10 0 0 0 3.2 7.9l3.64 2.38C7.57 8.12 9.6 6.5 12 6.5z"/>');
  if (name === 'github') return wrap('<path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.36 1.09 2.94.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z"/>');
  if (name === 'microsoft') return wrap('<path fill="currentColor" d="M3 3h8.5v8.5H3zM12.5 3H21v8.5h-8.5zM3 12.5h8.5V21H3zM12.5 12.5H21V21h-8.5z"/>');
  return '';
}

// Email + password form for the Join screen. Two modes: create an account
// (with a name) or sign in to an existing one.
function emailAuthForm() {
  if (authMode === 'signin') {
    return `<label class="field">Email</label>
      <input id="authEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@email.com" />
      <label class="field">Password</label>
      <input id="authPassword" type="password" autocomplete="current-password" placeholder="Your password" />
      <button class="btn-primary mt" onclick="emailSignIn()">Sign in</button>
      <p class="small center mt"><a role="button" tabindex="0" class="inline-link" onclick="resetPw()">Forgot password?</a> · New here? <a role="button" tabindex="0" class="inline-link" onclick="setAuthMode('signup')">Create an account</a></p>`;
  }
  return `<label class="field">Your name</label>
    <input id="authName" autocomplete="name" placeholder="e.g. ${esc((state.roster[0] && state.roster[0].name) || 'Your name')}" />
    <label class="field">Email</label>
    <input id="authEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@email.com" />
    <label class="field">Password</label>
    <input id="authPassword" type="password" autocomplete="new-password" placeholder="At least 6 characters" />
    <button class="btn-primary mt" onclick="emailSignUp()">Create account</button>
    <p class="small center mt">Already have an account? <a role="button" tabindex="0" class="inline-link" onclick="setAuthMode('signin')">Sign in</a></p>`;
}

// The number behind each sortable column (0 when a player has no games yet).
function tableValue(e, key) {
  const an = e.an;
  const has = an && an.played;
  switch (key) {
    case 'played': return has ? an.played : (e.p.gamesPlayed || 0);
    case 'gf': return has ? an.gf : 0;
    case 'winPct': return has ? an.winPct : 0;
    case 'loyalty': return e.p.loyalty || 0;
    default: return 0;
  }
}
// Canonical order: loyalty desc, then lowest win %, fewest goals, then name.
function canonicalOrder(a, b) {
  return (b.p.loyalty - a.p.loyalty)
    || (tableValue(a, 'winPct') - tableValue(b, 'winPct'))
    || (tableValue(a, 'gf') - tableValue(b, 'gf'))
    || a.p.name.localeCompare(b.p.name);
}

function tableScreen() {
  const { key, dir } = tableSort;
  const entries = state.roster.map(p => ({ p, an: history ? logic.playerAnalytics(p.id, history) : null }));
  entries.sort((a, b) => {
    if (key === 'loyalty') { const c = canonicalOrder(a, b); return dir === 'desc' ? c : -c; }
    let cmp = key === 'name' ? a.p.name.localeCompare(b.p.name) : tableValue(a, key) - tableValue(b, key);
    cmp = dir === 'asc' ? cmp : -cmp;
    return cmp || canonicalOrder(a, b); // stable tie-break
  });
  const rows = entries.map(({ p, an }, i) => {
    const me = p.id === state.me?.id;
    const played = an && an.played ? an.played : p.gamesPlayed;
    const goals = an && an.played ? an.gf : '—';
    const win = an && an.played ? an.winPct + '%' : '—';
    const form = an && an.played ? formGuide(an.form.slice(0, 6)) : '<span class="tdash">—</span>';
    return `<tr class="${me ? 'me' : ''}">
      <td class="c-pos">${i + 1}</td>
      <td class="c-player"><span class="tp-name">${esc(p.name)}</span>${me ? ' <span class="small">(you)</span>' : ''}</td>
      <td class="c-num">${played}</td>
      <td class="c-num">${goals}</td>
      <td class="c-num">${win}</td>
      <td class="c-form">${form}</td>
      <td class="c-pts">${p.loyalty}</td>
    </tr>`;
  }).join('');
  const arrow = k => key === k ? `<span class="sort-arrow">${dir === 'asc' ? '↑' : '↓'}</span>` : '';
  const th = (k, label, cls, attrs = '') => `<th class="${cls} sortable${key === k ? ' active' : ''}" ${attrs} onclick="sortTable('${k}')">${label}${arrow(k)}</th>`;
  return `<div class="card">
    <h2>League table</h2>
    <p class="hint">Ranked by loyalty points — turn up each week to climb. <b>Tap a heading to sort; tap again to reverse.</b> Swipe sideways to see every column; tap <b>You</b> for your profile.</p>
    <div class="table-scroll">
      <table class="stats-table">
        <thead><tr>
          <th class="c-pos">#</th>
          ${th('name', 'Player', 'c-player')}
          ${th('played', 'GP', 'c-num', 'title="Games played"')}
          ${th('gf', 'Goals', 'c-num', 'title="Team goals scored"')}
          ${th('winPct', 'Win%', 'c-num')}
          <th class="c-form">Form</th>
          ${th('loyalty', 'Pts', 'c-pts')}
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="empty">No players yet.</td></tr>'}</tbody>
      </table>
    </div>
  </div>`;
}

function rulesScreen() {
  const s = state.config.scoring;
  const tiers = s.dropoutTiers;
  const reward = s.playedReward;
  const cap = state.config.capacity;
  const late = reward * (s.lateSignupBonusGames || 0);
  const coldMax = reward + (s.weatherBonus || 0) + (s.coldSeasonBonus || 0);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const coldMonths = (s.coldMonths || []).map(m => months[m]);
  const coldLabel = coldMonths.length ? `${coldMonths[0]}–${coldMonths[coldMonths.length - 1]}` : 'the winter';
  return `<div class="card">
    <h2>The system</h2>
    <p class="hint">Built from the group's suggestions — rewards regulars, kills the tap-race, and only penalises dropouts fairly.</p>
    <div class="section-title" style="margin-top:6px">1 · Consistent timing</div>
    <p class="small">The poll opens at a set time each week, so nobody misses out for being on the pitch or driving home. It auto-closes once we've got enough by ${esc(prevDay(state.config.gameDay))} 5pm, and the squad is set.</p>
    <div class="section-title">2 · Loyalty, not speed</div>
    <p class="small">When more than ${cap} sign up, the squad is the top ${cap} by loyalty score. Signing up first doesn't jump the queue — a regular who signs up late still ranks above a casual. Everyone else goes on the reserves, in loyalty order, and moves up automatically if someone drops out.</p>
    <div class="section-title">3 · Time-weighted dropout penalty</div>
    <p class="small">Pulling out early is free — pulling out last-minute costs you, because it's harder to find a replacement. As Tom put it: a day or two's notice is fine, last minute isn't.</p>
    <ul class="penalty-scale">
      ${tiers.map(t => `<li><span>${esc(t.label)}</span><span class="pts ${t.penalty === 0 ? 'free' : ''}">${t.penalty === 0 ? 'no penalty' : '-' + t.penalty}</span></li>`).join('')}
    </ul>
  </div>
  <div class="card">
    <h2>How loyalty is earned</h2>
    <p class="hint">Your loyalty score decides your priority when a game is oversubscribed. Here's exactly how it moves:</p>
    <ul class="penalty-scale">
      <li><span>Play a game (in the confirmed squad)</span><span class="pts free">+${reward}</span></li>
      ${s.weatherBonus ? `<li><span>…in adverse weather (cold or wet at kickoff)</span><span class="pts free">+${s.weatherBonus}</span></li>` : ''}
      ${s.coldSeasonBonus ? `<li><span>…during the cold season (${coldLabel})</span><span class="pts free">+${s.coldSeasonBonus}</span></li>` : ''}
      ${s.lateSignupBonusGames ? `<li><span>Step in to fill a gap (sign up within ${s.lateSignupHours ?? 24}h when the squad's short) &amp; play</span><span class="pts free">+${late}</span></li>` : ''}
      <li><span>Drop out 2+ days before kickoff</span><span class="pts free">0</span></li>
      <li><span>Drop out the day before</span><span class="pts">-1</span></li>
      <li><span>Drop out same day</span><span class="pts">-3</span></li>
      <li><span>Last minute / no-show</span><span class="pts">-5</span></li>
    </ul>
    <p class="small mt">Turning up week after week steadily builds your priority; late dropouts chip it away. Miss a week without signing up and there's no penalty — you just don't earn the +${reward}. The organiser can also nudge scores by hand (e.g. a one-off ringer).</p>
  </div>
  ${(s.weatherBonus || s.coldSeasonBonus) ? `<div class="card">
    <h2>Bad-weather bonus</h2>
    <p class="hint">Turning out when it's grim deserves credit — so the reward scales with the conditions.</p>
    ${s.weatherBonus ? `<p class="small"><b>Adverse weather (+${s.weatherBonus}).</b> If it's cold or wet at kickoff — rain, or feels-like around 4°C or below — everyone who plays gets a bonus. The forecast shows on This week; the actual weather is frozen onto each result in History.</p>` : ''}
    ${s.coldSeasonBonus ? `<p class="small"><b>Cold season (+${s.coldSeasonBonus}).</b> Games in the depths of the year (${coldLabel}) get a bonus regardless of the day's weather.</p>` : ''}
    <p class="small">They stack, so a cold, wet ${coldMonths.length ? coldMonths[Math.floor(coldMonths.length / 2)] : 'winter'} night is worth <b>+${coldMax}</b> — ${Math.round(coldMax / reward * 10) / 10}× a normal game.</p>
  </div>` : ''}
  ${s.lateSignupBonusGames ? `<div class="card">
    <h2>Stepping in late</h2>
    <p class="small">If the squad's short and you sign up in the last ${s.lateSignupHours ?? 24} hours to fill a gap — then actually play — you earn <b>+${late}</b> (worth ${s.lateSignupBonusGames} games). It rewards bailing the game out, not just signing up late: if there were already enough players who signed up in good time, there's no bonus, and it only ever covers the number of empty spots.</p>
  </div>` : ''}
  <div class="card">
    <h2>The table</h2>
    <p class="small">The league table is ranked by <b>loyalty points</b>. When players are level, the tie is broken by <b>lowest win %</b>, then <b>fewest goals</b>, then alphabetically — so it's not just the same faces on top. Games played, team goals, win % and recent form all come from the match history.</p>
  </div>`;
}

// Day before the game day, for the "closes X 5pm" copy.
function prevDay(day) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const i = days.indexOf(day);
  return i < 0 ? 'the day before' : days[(i + 6) % 7];
}

// ---- join -----------------------------------------------------------------
function joinScreen() {
  if (state.me) {
    return `<div class="card">
      <h2>You're all set</h2>
      <p class="hint">You're registered as <b>${esc(state.me.name)}</b> — ${state.me.loyalty} loyalty, ${state.me.gamesPlayed} games. Head to This week to sign up for the next game.</p>
      <div class="btn-row">
        <button class="btn-primary" onclick="go('week')">Go to This week</button>
        <button class="btn-ghost" onclick="go('you')">Your profile</button>
      </div>
    </div>`;
  }
  return `<div class="card">
      <h2>Join the club</h2>
      <p class="hint">Tuesday Night Total Football — 7-a-side, every week. Register once, then sign up each week. When a game's oversubscribed the squad is picked by loyalty (turning up regularly), not who taps first.</p>
      ${identityPrompt()}
    </div>
    <div class="card">
      <h2>How it works</h2>
      <ol class="how-list">
        <li>Register with your name${auth?.enabled ? ' and email' : ''} — takes a second.</li>
        <li>When the poll's open, tap <b>I'm in</b> on This week.</li>
        <li>The squad is the top ${state.config.capacity} by loyalty, so there's no rush to be first.</li>
        <li>Play to earn loyalty; last-minute drop-outs cost you. See <a role="button" tabindex="0" class="inline-link" onclick="go('rules')">Rules</a>.</li>
      </ol>
    </div>`;
}

// ---- history: results list + match detail ---------------------------------
// Sort key for a game (ISO date, newest first).
function gameDateKey(g) {
  return g.date || (g.completedAt || g.kickoffAt || '').slice(0, 10) || '';
}

function historyScreen() {
  if (history === null) { ensureHistory(); }
  if (!history || !history.length) {
    return `<div class="card">
      <h2>Match history</h2>
      <p class="hint">${history === null ? 'Loading past results…' : 'No completed games logged yet — results appear here after each game is marked as played.'}</p>
    </div>`;
  }
  const games = [...history].sort((a, b) => gameDateKey(b).localeCompare(gameDateKey(a)));
  return `<div class="card">
    <h2>Match history</h2>
    <p class="hint">Every game we've logged — tap a result for the line-ups, the score and highlights.</p>
    <div class="hist-list">${games.map(historyRow).join('')}</div>
  </div>`;
}

function historyRow(g) {
  const b = g.scores?.bibs, n = g.scores?.nonbibs;
  const hasScore = Number.isFinite(b) && Number.isFinite(n);
  const res = !hasScore ? '' : b > n ? 'Bibs win' : n > b ? 'Non-bibs win' : 'Draw';
  const size = Math.max(g.teams?.bibs?.length || 0, g.teams?.nonbibs?.length || 0);
  const m = mediaCache[gameDateKey(g)];
  const hasVid = m && (m.videos?.length || m.clips?.length);
  return `<a class="hist-row" role="button" tabindex="0" onclick="viewGame('${g.id}')">
    <div class="hist-main">
      <div class="hist-date">${esc(g.dateLabel || gameDateKey(g))}</div>
      <div class="hist-sub">${size ? `${size}-a-side` : ''}${hasVid ? ' · ▶ highlights' : ''}</div>
    </div>
    <div class="hist-score">${hasScore ? `${b}<span>–</span>${n}` : '<span class="tdash">—</span>'}</div>
    <div class="hist-res">${res}</div>
  </a>`;
}

function gameDetailScreen() {
  if (history === null) { ensureHistory(); return `<div class="card"><p class="hint">Loading…</p></div>`; }
  const g = history.find(x => x.id === detailId);
  if (!g) {
    return `<div class="card">
      <button class="back-link" onclick="go('history')">← All results</button>
      <h2>Result not found</h2>
      <p class="hint">That game isn't in the history.</p>
    </div>`;
  }
  const b = g.scores?.bibs, n = g.scores?.nonbibs;
  const hasScore = Number.isFinite(b) && Number.isFinite(n);
  const res = !hasScore ? '' : b > n ? 'Bibs win' : n > b ? 'Non-bibs win' : 'Draw';
  const size = Math.max(g.teams?.bibs?.length || 0, g.teams?.nonbibs?.length || 0);

  const teamCol = (ids, label, cls) => `<div class="team-col">
      <div class="team-head ${cls}">${label}${hasScore ? ` <span class="tscore">${cls === 'bibs' ? b : n}</span>` : ''}</div>
      ${(ids || []).map((id, i) => {
        const p = state.playersById[id];
        const me = id === state.me?.id;
        return `<div class="lu-row${me ? ' me' : ''}"><span class="lu-num">${i + 1}</span><span class="lu-name">${esc(p ? p.name : '—')}${me ? ' <span class="you">you</span>' : ''}</span></div>`;
      }).join('') || '<div class="empty">No line-up recorded.</div>'}
    </div>`;

  const scoreline = hasScore
    ? `<div class="scoreline"><span class="sl-side">Bibs</span><span class="sl-num">${b}</span><span class="sl-dash">–</span><span class="sl-num">${n}</span><span class="sl-side">Non-bibs</span></div>
       <p class="hint center" style="margin-top:6px">${res}${size ? ` · ${size}-a-side` : ''}</p>`
    : `<p class="hint center">Score not recorded${size ? ` · ${size}-a-side` : ''}.</p>`;

  // Prefer the weather frozen at completion; otherwise fetch it on demand.
  if (g.weather) weatherCache['h-' + g.id] = g.weather;
  else ensureWeather('h-' + g.id, gameISO(g));
  const bonusNote = g.weatherBonus > 0
    ? `<p class="hint center wx-bonus">🏅 Tough conditions — everyone who played earned +${g.weatherBonus} bonus loyalty.</p>` : '';

  return `<div class="card">
      <button class="back-link" onclick="go('history')">← All results</button>
      <h2>${esc(g.dateLabel || gameDateKey(g))}</h2>
      ${scoreline}
      <div class="wx-center">${weatherLine('h-' + g.id)}</div>
      ${bonusNote}
      <div class="teams-grid detail mt">${teamCol(g.teams?.bibs, 'Bibs', 'bibs')}${teamCol(g.teams?.nonbibs, 'Non-bibs', 'nonbibs')}</div>
    </div>
    ${mediaCard(g)}`;
}

// Highlights card for a game, driven by content/games/<date>.md.
function mediaCard(g) {
  const key = gameDateKey(g);
  const m = mediaCache[key];
  if (m === undefined) { loadGameMedia(key); return `<div class="card"><h2>Highlights</h2><p class="hint">Loading…</p></div>`; }
  if (!m || (!m.videos?.length && !m.clips?.length && !m.note)) {
    return `<div class="card"><h2>Highlights</h2><p class="hint">No highlights uploaded for this game yet.</p></div>`;
  }
  let out = '';
  if (m.videos?.length) {
    out += m.videos.map((url, i) => ytEmbed(url, m.videos.length > 1 ? `Highlights · part ${i + 1}` : 'Highlights')).join('');
  }
  if (m.clips?.length) {
    out += `<div class="section-title">Clips</div>` + m.clips.map(c => ytEmbed(c.url, c.label || 'Clip')).join('');
  }
  const note = m.note ? `<div class="md-note">${mdBlock(m.note)}</div>` : '';
  return `<div class="card"><h2>Highlights</h2>${note}${out || '<p class="hint">No video links yet.</p>'}</div>`;
}

// ---- weather (Open-Meteo) --------------------------------------------------
// The kickoff datetime for a game: live games carry kickoffAt; historic ones
// only have a date, so pair it with the configured kickoff time.
function gameISO(g) {
  if (g.kickoffAt) return g.kickoffAt;
  const day = g.date || gameDateKey(g);
  return day ? `${day}T${(state.config.kickoff || '20:00')}:00` : null;
}
// Lazily fetch the weather for one game and cache it; re-renders when it lands.
function ensureWeather(key, iso) {
  const { lat, lon } = state.config;
  if (lat == null || lon == null || !iso) return;
  if (key in weatherCache || weatherPending[key]) return;
  weatherPending[key] = true;
  fetchWeather(lat, lon, iso).then(w => { weatherCache[key] = w || null; })
    .catch(() => { weatherCache[key] = null; })
    .finally(() => { weatherPending[key] = false; render(); });
}
// This week's forecast block: shows the kickoff-time forecast once it loads,
// or a brief "checking" hint while it fetches. Empty if no pitch coords.
function weatherBlock(g) {
  const { lat, lon } = state.config;
  if (lat == null || lon == null) return '';
  const key = 'g-' + g.id;
  ensureWeather(key, gameISO(g));
  const line = weatherLine(key, 'Forecast');
  if (line) return line;
  return (weatherPending[key] || weatherCache[key] === undefined) ? `<div class="wx">🌦️ Checking the forecast…</div>` : '';
}

// One-line weather summary chip. Empty until coords are set and data arrives.
function weatherLine(key, prefix) {
  const w = weatherCache[key];
  if (!w) return '';
  const t = w.tempC != null ? `${Math.round(w.tempC)}°C` : '';
  const flags = weatherFlags(w);
  const bits = [w.emoji + ' ' + w.label, t].filter(Boolean);
  if (w.rainProb != null && w.rainProb >= 20) bits.push(`${w.rainProb}% rain`);
  else if (w.precipMm != null && w.precipMm >= 0.2) bits.push(`${w.precipMm.toFixed(1)}mm`);
  if (w.windKph != null && w.windKph >= 30) bits.push(`${Math.round(w.windKph)} km/h wind`);
  const tag = flags.rough ? ` <span class="wx-tag">${flags.cold && flags.wet ? 'cold & wet' : flags.cold ? 'cold' : 'wet'}</span>` : '';
  const lead = prefix ? `<span class="wx-lead">${esc(prefix)}</span> ` : '';
  return `<div class="wx">${lead}${bits.join(' · ')}${tag}</div>`;
}

// Pull the 11-char YouTube id out of the common URL shapes.
function ytId(url) {
  const m = String(url).match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : null;
}
function ytEmbed(url, label) {
  const id = ytId(url);
  if (!id) return '';
  return `<figure class="video">
    <div class="video-frame"><iframe src="https://www.youtube-nocookie.com/embed/${id}" title="${esc(label || 'Highlights')}" loading="lazy" frameborder="0" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>
    ${label ? `<figcaption>${esc(label)}</figcaption>` : ''}
  </figure>`;
}

// Lazily fetch + parse one game's media file. No build step and no manifest —
// drop a content/games/<date>.md file, push, and it renders. One request per
// result the moment it's opened; a 404 just means "no highlights yet".
async function loadGameMedia(key) {
  if (!key || key in mediaCache || mediaPending[key]) return;
  mediaPending[key] = true;
  try {
    const r = await fetch(`./content/games/${key}.md`, { cache: 'no-cache' });
    mediaCache[key] = r.ok ? parseGameMedia(await r.text()) : null;
  } catch { mediaCache[key] = null; }
  delete mediaPending[key];
  if (tab === 'game' || tab === 'history') render();
}
// Parse a single game's media file: video:/clip:/note: lines, everything else
// treated as note (markdown). Lines starting with # or <!-- are ignored.
function parseGameMedia(text) {
  const out = { videos: [], clips: [], note: '' };
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (/^(#|<!--)/.test(t)) continue;
    if (!t) { if (out.note) out.note += '\n'; continue; }
    let mm;
    if ((mm = t.match(/^video:\s*(\S+)/i))) out.videos.push(mm[1]);
    else if ((mm = t.match(/^clip:\s*(.+)/i))) { const parts = mm[1].split('|'); out.clips.push({ url: parts[0].trim(), label: parts.slice(1).join('|').trim() }); }
    else if ((mm = t.match(/^note:\s*(.*)/i))) out.note += (out.note ? '\n' : '') + mm[1];
    else out.note += (out.note ? '\n' : '') + t;
  }
  return out;
}
// Tiny, safe markdown → HTML for match notes (links, bold, italic, paragraphs).
function mdInline(s) {
  return esc(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
}
function mdBlock(text) {
  return String(text).trim().split(/\n{2,}/).filter(Boolean)
    .map(p => `<p>${mdInline(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
}

// ---- you: stats, notifications, account -----------------------------------
function youScreen() {
  if (!state.me) {
    return `<div class="card">${identityPrompt()}</div>`;
  }
  const me = state.me;
  const stats = history ? logic.playerStats(me.id, history) : null;

  const statsCard = stats ? `
    <div class="card">
      <h2>Your record</h2>
      <div class="statgrid">
        <div class="stat"><div class="statnum">${stats.played}</div><div class="statlbl">games played</div></div>
        <div class="stat"><div class="statnum">${stats.attendancePct}%</div><div class="statlbl">attendance</div></div>
        <div class="stat"><div class="statnum">${me.loyalty}</div><div class="statlbl">loyalty</div></div>
        <div class="stat"><div class="statnum">${stats.dropouts}</div><div class="statlbl">dropouts</div></div>
      </div>
      ${stats.history.length ? `<div class="section-title">History</div><p class="hint" style="margin:-2px 0 2px">Tap a game for the line-ups, score and highlights.</p>${stats.history.map(h =>
        `<a class="histrow" role="button" tabindex="0" onclick="viewGame('${h.gameId}')"><span>${esc(h.dateLabel || 'Game')}</span><span class="hr-right"><span class="pill ${h.played ? 'in' : h.withdrew ? 'out' : 'wait'}">${h.played ? 'played' : h.withdrew ? 'dropped out' : 'reserve'}</span><span class="hr-chev">›</span></span></a>`).join('')}`
        : '<p class="hint">No completed games yet — your history builds up from here.</p>'}
    </div>` : `<div class="card"><h2>Your record</h2><p class="hint">Loading your history…</p></div>`;

  // Notifications card
  let notif = '';
  if (auth?.enabled) {
    const emailLine = me.email
      ? `<div class="notif-row"><span>📧 Email alerts</span><span class="pill in">on</span></div><p class="small">Sent to ${esc(me.email)} when your spot changes.</p>`
      : `<p class="small">Your account has no email, so email alerts are off.</p>`;
    let pushLine;
    if (!pushConfigured()) pushLine = `<p class="small">Push notifications aren't set up yet (organiser: add a messaging key — see README).</p>`;
    else if (localStorage.getItem('tntf.pushOn')) pushLine = `<div class="notif-row"><span>🔔 Push notifications</span><span class="pill in">on</span></div>`;
    else if (isIOS() && !isStandalone()) pushLine = `<div class="ios-hint"><b>To get push on iPhone:</b> tap the Share icon in Safari → <b>Add to Home Screen</b>, then open TNTF from your home screen and turn on push here.</div>`;
    else pushLine = `<button class="btn-primary" onclick="enablePushNow()">🔔 Turn on push notifications</button>`;
    notif = `<div class="card"><h2>Notifications</h2>${emailLine}${pushLine}</div>`;
  } else {
    notif = `<div class="card"><h2>Notifications</h2><p class="hint">Email & push alerts activate once the organiser connects Firebase (see README). For now this device shows in-app alerts when your status changes.</p></div>`;
  }

  // Win/loss analytics from the historic results.
  const an = history ? logic.playerAnalytics(me.id, history) : null;
  const cs = an?.currentStreak;
  const streakText = cs && cs.type
    ? (cs.type === 'W' ? `${cs.count}-game win streak 🔥` : cs.type === 'L' ? `${cs.count}-game losing run` : `${cs.count} draws in a row`)
    : '—';
  const analyticsCard = an && an.played ? `
    <div class="card">
      <h2>Form &amp; record</h2>
      <p class="hint">From ${an.played} games with a recorded result. ${an.wins}W · ${an.draws}D · ${an.losses}L.</p>
      <div class="statgrid">
        <div class="stat"><div class="statnum">${an.winPct}%</div><div class="statlbl">win rate</div></div>
        <div class="stat"><div class="statnum">${an.gd > 0 ? '+' : ''}${an.gd}</div><div class="statlbl">goal diff (${an.gf}-${an.ga})</div></div>
        <div class="stat"><div class="statnum">${an.longestWin}</div><div class="statlbl">best win streak</div></div>
        <div class="stat"><div class="statnum">${an.longestUnbeaten}</div><div class="statlbl">longest unbeaten</div></div>
      </div>
      <div class="section-title">Current run</div>
      <p style="margin:0 0 10px;font-weight:700">${streakText}</p>
      <div class="section-title">Form (recent first)</div>
      ${formGuide(an.form)}
    </div>` : (history ? '' : '');

  const unmerged = me.account && me.gamesPlayed === 0
    ? `<p class="small mt">New account — the organiser will link this to your match history so your games and loyalty show up here.</p>` : '';
  const account = auth?.enabled
    ? `<div class="card"><h2>Account</h2><p class="hint">Signed in${user?.email ? ` as ${esc(user.email)}` : ''} · you're <b>${esc(me.name)}</b>.</p>${unmerged}<button class="btn-ghost mt" onclick="signOutUser()">Sign out</button></div>`
    : `<div class="card"><h2>You</h2><p class="hint">Playing as ${esc(me.name)} on this device.</p><button class="btn-ghost" onclick="forgetMe()">Not you? Switch name</button></div>`;

  return `<div class="card hero-you">
      <div class="you-name">${esc(me.name)}</div>
      <p class="small">${me.loyalty} loyalty · ${me.gamesPlayed} games</p>
    </div>${analyticsCard}${statsCard}${notif}${account}`;
}

// Guardian-style form guide: coloured W/D/L chips, newest first.
function formGuide(form) {
  if (!form || !form.length) return '<p class="small">No games yet.</p>';
  return `<div class="form-guide">${form.map(o => `<span class="fchip ${o.toLowerCase()}">${o}</span>`).join('')}</div>`;
}

// ---- organiser: link new sign-ins to historic records ----------------------
function accountsCard() {
  const pending = state.roster.filter(p => p.account);
  const targets = state.roster.filter(p => !p.account)
    .sort((a, b) => a.name.localeCompare(b.name));
  const targetOpts = targets.map(p => `<option value="${p.id}">${esc(p.name)} · ${p.gamesPlayed} games</option>`).join('');
  const rows = pending.map(p => `<div class="acct-row">
      <div class="acct-info">
        <div class="name">${esc(p.name)}</div>
        <div class="meta">${p.email ? esc(p.email) : 'signed in'} · new sign-in</div>
      </div>
      <select id="acct-${p.id}"><option value="">— this person is —</option>${targetOpts}</select>
      <div class="btn-row">
        <button class="btn-primary" onclick="linkAccount('${p.id}')">Link to history</button>
        <button class="btn-ghost" onclick="keepAsNew('${p.id}')">New player</button>
      </div>
    </div>`).join('');
  return `<div class="card">
    <h2>Sign-ins to link ${pending.length ? `<span class="link-tag no">${pending.length}</span>` : ''}</h2>
    <p class="hint">When someone signs in with Google they appear here as a new account. Pick who they are on the roster to merge their sign-in into that record — their history and loyalty stay put, and that record becomes their account. Or mark them a brand-new player.</p>
    ${rows || '<div class="empty">No new sign-ins waiting.</div>'}
  </div>`;
}

// ---- organiser: ratings (private) ------------------------------------------
function ratingsCard() {
  const rows = state.roster.map(p => {
    const a = p.attrs || {};
    const cell = k => `<input class="attr-in" id="attr-${p.id}-${k}" type="number" min="0" max="20" value="${Number.isFinite(a[k]) ? a[k] : ''}" placeholder="10" />`;
    return `<div class="rate-row">
      <div class="rate-name">${esc(p.name)}</div>
      ${logic.ATTRS.map(cell).join('')}
      <div class="rate-ov">${logic.attrOverall(p)}</div>
    </div>`;
  }).join('');
  return `<div class="card">
    <h2>Player ratings 🔒</h2>
    <p class="hint">Only you (the organiser) see these. Rate each player /20 for Fitness, Skill, Strength, Speed — used to auto-balance the teams. Blank counts as 10.</p>
    <div class="rate-head"><div class="rate-name">Player</div><div>Fit</div><div>Skl</div><div>Str</div><div>Spd</div><div class="rate-ov">Ovr</div></div>
    ${rows}
    <button class="btn-primary mt" onclick="saveRatings()">Save ratings</button>
  </div>`;
}

// ---- organiser: lineupDraft builder ---------------------------------------------
function initLineup(g) {
  const confirmedIds = g.confirmed.map(r => r.playerId);
  if (lineupDraft && lineupGameId === g.id) {
    // keep only still-confirmed players; drop anyone who withdrew
    lineupDraft.bibs = lineupDraft.bibs.filter(id => confirmedIds.includes(id));
    lineupDraft.nonbibs = lineupDraft.nonbibs.filter(id => confirmedIds.includes(id));
    const placed = new Set([...lineupDraft.bibs, ...lineupDraft.nonbibs]);
    for (const id of confirmedIds) if (!placed.has(id)) (lineupDraft.bibs.length <= lineupDraft.nonbibs.length ? lineupDraft.bibs : lineupDraft.nonbibs).push(id);
    return;
  }
  lineupGameId = g.id;
  if (g.teams && (g.teams.bibs?.length || g.teams.nonbibs?.length)) {
    lineupDraft = { bibs: [...(g.teams.bibs || [])], nonbibs: [...(g.teams.nonbibs || [])] };
    initLineup(g); // reconcile with current confirmed
  } else {
    const b = logic.balanceTeams(confirmedIds, state.playersById);
    lineupDraft = { bibs: b.bibs, nonbibs: b.nonbibs };
  }
}

function lineupBuilderCard(g) {
  initLineup(g);
  const total = ids => ids.reduce((s, id) => s + logic.attrOverall(state.playersById[id]), 0);
  const chip = (id, side) => {
    const p = state.playersById[id];
    return `<div class="pchip" draggable="true" ondragstart="lineupDragStart(event,'${id}')" onclick="flipSide('${id}')" title="Tap to switch sides">
      <span class="pchip-name">${esc(p ? p.name : '—')}</span><span class="pchip-ov">${logic.attrOverall(p)}</span></div>`;
  };
  const column = (side, label, cls) => `<div class="build-col ${cls}" ondragover="event.preventDefault()" ondrop="lineupDrop(event,'${side}')">
      <div class="team-head ${cls}">${label} <span>${lineupDraft[side].length} · ${total(lineupDraft[side])}</span></div>
      ${lineupDraft[side].map(id => chip(id, side)).join('') || '<div class="build-empty">drop players here</div>'}
    </div>`;
  const diff = Math.abs(total(lineupDraft.bibs) - total(lineupDraft.nonbibs));
  const finalisedTag = g.teamsFinalised ? '<span class="link-tag ok">published</span>' : '<span class="link-tag no">draft</span>';
  return `<div class="card">
    <h2>Team builder ${finalisedTag}</h2>
    <p class="hint">Auto-balance by rating, then tap a player (or drag on a computer) to switch sides. Rating gap: <b>${diff}</b>. Publish to show the teams on This Week — you can keep tweaking after.</p>
    <button class="btn-ghost" onclick="autoBalance()">⚖️ Auto-balance</button>
    <div class="teams-grid build mt">${column('bibs', 'Bibs', 'bibs')}${column('nonbibs', 'Non-bibs', 'nonbibs')}</div>
    <div class="btn-row mt">
      <button class="btn-ghost" onclick="saveLineup(false)">Save draft</button>
      <button class="btn-primary" onclick="saveLineup(true)">Publish to This Week</button>
    </div>
  </div>`;
}

// ---- admin ----------------------------------------------------------------
function adminScreen() {
  if (!adminUnlocked) {
    return `<div class="card">
      <h2>Organiser area 🔒</h2>
      <p class="hint">Open the weekly game, lock the squad, mark it played, and manage the roster.</p>
      <input id="pinInput" type="password" inputmode="numeric" placeholder="Admin PIN" />
      <button class="btn-primary" onclick="adminLogin()">Unlock</button>
      <p class="small center mt">Default PIN is 1234 — change it below once in.</p>
    </div>`;
  }
  const g = state.game;
  const gameCard = g ? `
    <div class="card">
      <h2>${esc(g.dateLabel)} — ${esc(g.status)}</h2>
      <p class="hint">${g.confirmed.length}/${g.capacity} confirmed · ${g.waitlist.length} waiting</p>
      ${g.status === 'open'
        ? `<button class="btn-warn" onclick="admin('lockGame','${g.id}','Squad locked')">Lock squad (stop registration)</button>`
        : `<button class="btn-ghost" onclick="admin('reopenGame','${g.id}','Reopened')">Reopen registration</button>`}
      ${paymentsAdmin(g)}
      <div class="section-title">Enter the result</div>
      <p class="hint" style="margin-top:-2px">Type the final score, then bank loyalty. You can tweak the score and teams (Team builder) right up until you confirm.</p>
      <div class="btn-row">
        <div><label class="field">Bibs</label><input id="scoreBibs" type="number" inputmode="numeric" value="${g.scores && Number.isFinite(g.scores.bibs) ? g.scores.bibs : ''}" placeholder="0" /></div>
        <div><label class="field">Non-bibs</label><input id="scoreNonbibs" type="number" inputmode="numeric" value="${g.scores && Number.isFinite(g.scores.nonbibs) ? g.scores.nonbibs : ''}" placeholder="0" /></div>
      </div>
      <button class="btn-primary mt" onclick="completeGame('${g.id}')">Confirm result → bank loyalty</button>
    </div>` : `
    <div class="card">
      <h2>No game open</h2>
      <p class="hint">Open this week's game — defaults to the next ${esc(state.config.gameDay)} at ${esc(state.config.kickoff)} at ${esc(state.config.venue || 'the usual venue')}. Change the kickoff/venue only if it differs this week.</p>
      <label class="field">Label</label><input id="gLabel" value="${esc(state.config.gameDay)} game" />
      <label class="field">Capacity (squad size)</label><input id="gCap" type="number" value="${state.config.capacity}" />
      <label class="field">Venue</label><input id="gVenue" value="${esc(state.config.venue || '')}" />
      <label class="field">Kickoff (blank = next ${esc(state.config.gameDay)} ${esc(state.config.kickoff)})</label><input id="gKick" type="datetime-local" />
      <button class="btn-primary mt" onclick="openGame()">Open the game</button>
    </div>`;

  const linkTag = p => auth?.enabled
    ? (p.email ? `<span class="link-tag ok">✓ ${esc(p.email)}</span>` : `<span class="link-tag no">not linked</span>`)
    : '';
  const roster = state.roster.map(p => `<div class="player">
      <div class="info"><div class="name">${esc(p.name)}</div><div class="meta">${p.loyalty} loyalty · ${p.gamesPlayed} games · ${p.dropouts} dropouts ${linkTag(p)}</div></div>
      <button class="icon-btn" title="Edit name" onclick="editPlayer('${p.id}')">✎</button>
      <button class="icon-btn" title="+1 loyalty" onclick="adjust('${p.id}',1)">＋</button>
      <button class="icon-btn" title="-1 loyalty" onclick="adjust('${p.id}',-1)">－</button>
      <button class="icon-btn danger" title="Delete" onclick="removePlayer('${p.id}','${esc(p.name).replace(/'/g, "\\'")}')">🗑</button>
    </div>`).join('');

  const mergeOptions = state.roster.map(p => `<option value="${p.id}">${esc(p.name)} (${p.gamesPlayed})</option>`).join('');

  return `${gameCard}
    ${g ? lineupBuilderCard(g) : ''}
    ${accountsCard()}
    <div class="card">
      <h2>Recalculate loyalty</h2>
      <p class="hint">Rebuild everyone's loyalty from the full match history, applying the played reward plus the weather (cold/wet) and cold-season bonuses to every past game. It fetches the weather for each game and freezes it onto the record. Use this after importing history or changing the bonus values. Replaces current loyalty totals.</p>
      <button class="btn-primary" id="recalcBtn" onclick="recalcLoyalty()">Recalculate loyalty from history</button>
    </div>
    ${ratingsCard()}
    <div class="card">
      <h2>Roster</h2>
      <p class="hint">Edit a name (✎), nudge loyalty (＋/－), or remove a player (🗑). Deleting also removes them from past game records.</p>
      ${roster}
      <label class="field mt">Add a player</label><input id="newPlayer" placeholder="Name" />
      <button class="btn-ghost" onclick="addPlayer()">Add to roster</button>
    </div>
    <div class="card">
      <h2>Merge duplicates</h2>
      <p class="hint">Two entries for the same person (e.g. a name-only history record + their sign-in)? Merge them: all history and loyalty move onto the one you keep, the other is removed.</p>
      <label class="field">Keep this player</label>
      <select id="mergeKeep"><option value="">— keep —</option>${mergeOptions}</select>
      <label class="field">Merge & remove this one</label>
      <select id="mergeDrop"><option value="">— remove —</option>${mergeOptions}</select>
      <button class="btn-warn mt" onclick="mergePlayers()">Merge profiles</button>
    </div>
    <div class="card">
      <h2>Settings</h2>
      <label class="field">Club name</label><input id="cName" value="${esc(state.config.clubName)}" />
      <label class="field">Default venue</label><input id="cVenue" value="${esc(state.config.venue && state.config.venue !== 'Pitch 10' ? state.config.venue : 'Pitch 10 - Nou Camp')}" />
      <label class="field">Pitch location for weather (latitude, longitude)</label>
      <div class="btn-row">
        <input id="cLat" type="number" step="any" value="${state.config.lat ?? ''}" placeholder="e.g. 53.4808" />
        <input id="cLon" type="number" step="any" value="${state.config.lon ?? ''}" placeholder="e.g. -2.2426" />
      </div>
      <p class="small">Find the pitch on Google Maps, right-click it → the numbers at the top are latitude, longitude. Leave blank to hide weather. Free, no API key (Open-Meteo).</p>
      <label class="field">Game day</label>
      <select id="cDay">${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(d => `<option ${d === state.config.gameDay ? 'selected' : ''}>${d}</option>`).join('')}</select>
      <label class="field">Kickoff (HH:MM)</label><input id="cKick" value="${esc(state.config.kickoff)}" />
      <label class="field">Default squad size</label><input id="cCap" type="number" value="${state.config.capacity}" />
      <label class="field">Loyalty per game played</label><input id="cReward" type="number" value="${state.config.scoring.playedReward}" />
      <label class="field">Bonus for adverse weather (cold/wet)</label><input id="cWx" type="number" value="${state.config.scoring.weatherBonus ?? 1}" />
      <label class="field">Bonus for the cold season</label><input id="cCold" type="number" value="${state.config.scoring.coldSeasonBonus ?? 1}" />
      <label class="field">Last-minute sign-up bonus (× games' reward)</label><input id="cLate" type="number" value="${state.config.scoring.lateSignupBonusGames ?? 4}" />
      <label class="field">Your email (for the auto-close squad alert)</label><input id="cOrg" type="email" value="${esc(state.config.organiserEmail || '')}" placeholder="you@email.com" />
      <label class="field">New admin PIN (leave blank to keep)</label><input id="cPin" type="password" inputmode="numeric" placeholder="••••" />
      <button class="btn-primary mt" onclick="saveConfig()">Save settings</button>
      <button class="btn-ghost mt" onclick="adminLogout()">Log out of organiser</button>
    </div>`;
}

// ---- render ---------------------------------------------------------------
const SCREENS = {
  week: weekScreen, join: joinScreen, history: historyScreen, game: gameDetailScreen,
  table: tableScreen, you: youScreen, rules: rulesScreen, admin: adminScreen
};
function render() {
  if (!state) return;
  renderTopbar();
  const screen = SCREENS[tab] || weekScreen;
  $app.innerHTML = demoBanner() + `<main>${screen()}</main>`;
}

// Load completed-game history once — used by Table (form) and You (analytics).
async function ensureHistory() {
  if (history !== null) return;
  history = [];
  try { history = await db.loadHistory(); render(); } catch (e) { console.error(e); }
}

// ---- actions --------------------------------------------------------------
window.go = t => { tab = t; menuOpen = false; if (t !== 'game') detailId = null; render(); window.scrollTo(0, 0); };
// Tap a table heading to sort by it; tap the same one again to reverse.
window.sortTable = (key) => {
  if (tableSort.key === key) tableSort.dir = tableSort.dir === 'asc' ? 'desc' : 'asc';
  else tableSort = { key, dir: key === 'name' ? 'asc' : 'desc' };
  render();
};
window.toggleMenu = () => { menuOpen = !menuOpen; render(); };
window.viewGame = id => {
  detailId = id; tab = 'game'; menuOpen = false;
  const g = history && history.find(x => x.id === id);
  if (g) loadGameMedia(gameDateKey(g));
  render(); window.scrollTo(0, 0);
};

// demo-mode name pick
window.join = async () => {
  const name = document.getElementById('nameInput').value.trim();
  if (!name) return toast('Enter your name', true);
  try { LS.id = await db.upsertPlayer(name); buildView(); render(); toast(`Welcome, ${name}`); }
  catch (e) { toast(e.message, true); }
};
// cloud-mode: OAuth sign-in (Google etc.)
window.signIn = async (provider) => {
  try { await auth.signIn(provider); /* onChange handles the rest */ }
  catch (e) { toast(e.message || 'Sign-in failed', true); }
};
window.setAuthMode = (mode) => { authMode = mode; render(); };

// Friendly messages for the common Firebase Auth error codes.
function authErrorMessage(e) {
  switch (e.code) {
    case 'auth/email-already-in-use': return 'That email already has an account — try signing in.';
    case 'auth/invalid-email': return 'Enter a valid email address.';
    case 'auth/missing-password': return 'Enter a password.';
    case 'auth/weak-password': return 'Password should be at least 6 characters.';
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-credential': return 'Wrong email or password.';
    case 'auth/too-many-requests': return 'Too many attempts — try again in a bit.';
    default: return e.message || 'Something went wrong.';
  }
}
window.emailSignUp = async () => {
  const name = document.getElementById('authName')?.value.trim();
  const email = document.getElementById('authEmail')?.value.trim();
  const password = document.getElementById('authPassword')?.value || '';
  if (!name) return toast('Enter your name', true);
  if (!email) return toast('Enter your email', true);
  if (password.length < 6) return toast('Password should be at least 6 characters', true);
  pendingName = name;
  try { await auth.signUpEmail(email, password, name); /* onChange handles the rest */ }
  catch (e) {
    pendingName = null;
    if (e.code === 'auth/email-already-in-use') { authMode = 'signin'; render(); }
    toast(authErrorMessage(e), true);
  }
};
window.emailSignIn = async () => {
  const email = document.getElementById('authEmail')?.value.trim();
  const password = document.getElementById('authPassword')?.value || '';
  if (!email) return toast('Enter your email', true);
  if (!password) return toast('Enter your password', true);
  try { await auth.signInEmail(email, password); }
  catch (e) { toast(authErrorMessage(e), true); }
};
window.resetPw = async () => {
  const email = document.getElementById('authEmail')?.value.trim();
  if (!email) return toast('Enter your email first, then tap reset', true);
  try { await auth.resetPassword(email); toast('Password reset link sent — check your inbox 📧'); }
  catch (e) { toast(authErrorMessage(e), true); }
};
window.signOutUser = async () => { try { await auth.signOut(); LS.id = ''; toast('Signed out'); } catch (e) { toast(e.message, true); } };
window.forgetMe = () => { LS.id = ''; buildView(); render(); };

window.enablePushNow = async () => {
  try {
    const token = await enablePush();
    await db.savePushToken(state.me.id, token);
    localStorage.setItem('tntf.pushOn', '1');
    render(); toast('Push notifications on 🔔');
  } catch (e) { toast(e.message, true); }
};

window.signup = async () => {
  try { await db.signup(state.me.id, state.game.id); buildView(); render();
    toast(state.game?.me?.status === 'waitlist' ? "Added — you're on the waitlist" : "You're in ✅"); }
  catch (e) { toast(e.message, true); }
};
window.withdraw = async () => {
  const pen = state.game.withdrawPenaltyNow;
  if (!confirm(pen > 0 ? `Withdraw now for -${pen} loyalty?` : 'Withdraw from this game?')) return;
  try { const r = await db.withdraw(state.me.id, state.game.id);
    toast(r.penalty > 0 ? `Withdrawn · -${r.penalty} loyalty (${r.label})` : 'Withdrawn · no penalty'); }
  catch (e) { toast(e.message, true); }
};

window.adminLogin = async () => {
  const pin = document.getElementById('pinInput').value;
  try { if (!(await db.checkPin(pin))) return toast('Wrong PIN', true);
    adminUnlocked = true; render(); toast('Unlocked'); }
  catch (e) { toast(e.message, true); }
};
window.adminLogout = () => { adminUnlocked = false; render(); toast('Logged out'); };
window.admin = async (method, id, ok) => {
  try { await db[method](id); toast(ok || 'Done'); }
  catch (e) { toast(e.message, true); }
};
window.openGame = async () => {
  const dateLabel = document.getElementById('gLabel').value.trim();
  const capacity = Number(document.getElementById('gCap').value);
  const venue = document.getElementById('gVenue').value.trim();
  const kick = document.getElementById('gKick').value;
  const body = { dateLabel, capacity, venue };
  if (kick) body.kickoffAt = new Date(kick).toISOString();
  try { await db.openGame(body); tab = 'week'; render(); toast('Game opened ⚽'); }
  catch (e) { toast(e.message, true); }
};
window.completeGame = async (id) => {
  const g = state.game && state.game.id === id ? state.game : null;
  const iso = g ? gameISO(g) : new Date().toISOString();
  // Work out the adverse-conditions bonus: fetch the game's weather (if the
  // pitch coords are set) and check the cold season.
  let weather = null;
  const { lat, lon } = state.config;
  if (lat != null && lon != null) { try { weather = await fetchWeather(lat, lon, iso); } catch {} }
  const adverse = weather ? weatherFlags(weather).rough : false;
  const cold = logic.isColdSeason(iso, state.config);
  const { bonus, reasons } = logic.completionBonus(state.config, { adverseWeather: adverse, coldSeason: cold });
  const base = logic.withDefaults(state.config).scoring.playedReward;
  // Gap-aware last-minute bonus: only the sign-ups that genuinely filled a gap.
  const awards = g ? logic.lateSignupAwards(lastRaw.signups, lastRaw.playersById, state.config, g.kickoffAt, g.capacity) : {};
  const lateCount = Object.keys(awards).length;
  const lateEach = lateCount ? Object.values(awards)[0] : 0;
  const lateNote = lateCount > 0 ? ` ${lateCount} player${lateCount === 1 ? '' : 's'} who stepped in late get +${lateEach} each.` : '';
  // Read the entered score (optional but recommended).
  const bibsRaw = document.getElementById('scoreBibs')?.value.trim();
  const nonbibsRaw = document.getElementById('scoreNonbibs')?.value.trim();
  const hasScore = bibsRaw !== '' && bibsRaw != null && nonbibsRaw !== '' && nonbibsRaw != null;
  const scores = hasScore ? { bibs: Number(bibsRaw), nonbibs: Number(nonbibsRaw) } : null;
  const scoreNote = scores ? `Final score Bibs ${scores.bibs}–${scores.nonbibs} Non-bibs. ` : 'No score entered (you can add it later). ';
  const msg = scoreNote + (bonus > 0
    ? `Everyone in the squad gets +${base + bonus} (+${base} for playing, +${bonus} for ${reasons.map(r => r.replace(/ \+\d+$/, '')).join(' & ')}).`
    : `The confirmed squad each get +${base}.`) + lateNote + ' Confirm and archive?';
  if (!confirm(msg)) return;
  try {
    await db.completeGame(id, { bonus, weather, reasons, scores });
    toast('Result saved · loyalty banked · archived');
  } catch (e) { toast(e.message, true); }
};
window.adjust = async (id, delta) => { try { await db.adjustLoyalty(id, delta); } catch (e) { toast(e.message, true); } };
const asBool = v => v === true || v === 'true';
window.markPaid = async (gameId, paid) => {
  try { await db.setPaid(state.me.id, gameId, asBool(paid)); toast(asBool(paid) ? 'Payment confirmed 💸' : 'Marked unpaid'); }
  catch (e) { toast(e.message, true); }
};
window.togglePaid = async (playerId, gameId, paid) => {
  try { await db.setPaid(playerId, gameId, asBool(paid)); }
  catch (e) { toast(e.message, true); }
};
// Recompute everyone's loyalty from the whole match history, fetching the
// weather for each past game so the adverse-weather + cold-season bonuses count.
window.recalcLoyalty = async () => {
  if (!confirm('Recalculate everyone\'s loyalty from the full match history — applying the played reward plus the weather and cold-season bonuses to every past game?\n\nThis replaces current loyalty values (including any manual +/- tweaks), and fetches the weather for each game (may take a few seconds).')) return;
  const btn = document.getElementById('recalcBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Recalculating…'; }
  try {
    const games = (history && history.length ? history : await db.loadHistory()).filter(g => g.status === 'completed');
    const { lat, lon } = state.config;
    const s = logic.withDefaults(state.config).scoring;
    const adverse = {}; const gamesWeather = []; let wxCount = 0, coldCount = 0;
    for (const g of games) {
      let w = g.weather || null;
      if (!w && lat != null && lon != null) { try { w = await fetchWeather(lat, lon, gameISO(g)); } catch {} }
      const isAdv = w ? weatherFlags(w).rough : false;
      const cold = logic.isColdSeason(g.date || g.completedAt || g.kickoffAt, state.config);
      adverse[g.id] = isAdv;
      if (isAdv) wxCount++; if (cold) coldCount++;
      const reasons = []; if (isAdv) reasons.push('adverse weather'); if (cold) reasons.push('cold season');
      const bonus = (isAdv ? (s.weatherBonus || 0) : 0) + (cold ? (s.coldSeasonBonus || 0) : 0);
      gamesWeather.push({ id: g.id, weather: w || undefined, weatherBonus: bonus, bonusReasons: reasons });
    }
    const totals = logic.recomputeLoyalty(games, state.config, adverse);
    const players = Object.entries(totals).map(([id, t]) => ({ id, loyalty: t.loyalty, gamesPlayed: t.gamesPlayed }));
    await db.commitRecalc({ players, games: gamesWeather });
    history = null; ensureHistory();
    toast(`Recalculated ${players.length} players · ${wxCount} wet/cold + ${coldCount} cold-season games`);
  } catch (e) { toast(e.message, true); }
  finally { const b = document.getElementById('recalcBtn'); if (b) { b.disabled = false; b.textContent = 'Recalculate loyalty from history'; } }
};
window.editPlayer = async (id) => {
  const cur = state.roster.find(p => p.id === id);
  const name = prompt('Edit name', cur ? cur.name : '');
  if (name == null || !name.trim()) return;
  try { await db.renamePlayer(id, name.trim()); toast('Name updated'); } catch (e) { toast(e.message, true); }
};
window.removePlayer = async (id, name) => {
  if (!confirm(`Remove ${name} from the roster and all game records? This can't be undone.`)) return;
  try { await db.deletePlayer(id); history = null; ensureHistory(); toast('Player removed'); } catch (e) { toast(e.message, true); }
};
window.mergePlayers = async () => {
  const keep = document.getElementById('mergeKeep').value;
  const drop = document.getElementById('mergeDrop').value;
  if (!keep || !drop) return toast('Pick both players', true);
  if (keep === drop) return toast('Pick two different players', true);
  const kn = state.roster.find(p => p.id === keep)?.name, dn = state.roster.find(p => p.id === drop)?.name;
  if (!confirm(`Merge "${dn}" into "${kn}"? All of ${dn}'s history and loyalty move onto ${kn}, and ${dn} is removed.`)) return;
  try { await db.mergePlayers(keep, drop); history = null; ensureHistory(); toast('Profiles merged'); } catch (e) { toast(e.message, true); }
};
// Link a new Google sign-in to a historic record: keep the historic profile,
// merge the fresh account into it (transfers the account's uid/email across).
window.linkAccount = async (accountId) => {
  const target = document.getElementById(`acct-${accountId}`)?.value;
  if (!target) return toast('Pick who they are', true);
  if (target === accountId) return toast('Pick a different record', true);
  const an = state.roster.find(p => p.id === accountId)?.name;
  const tn = state.roster.find(p => p.id === target)?.name;
  if (!confirm(`Link ${an}'s sign-in to ${tn}? ${tn}'s history and loyalty stay, and that record becomes their account. The "${an}" entry is removed.`)) return;
  try { await db.mergePlayers(target, accountId); history = null; ensureHistory(); toast(`Linked to ${tn} ✅`); }
  catch (e) { toast(e.message, true); }
};
window.keepAsNew = async (id) => {
  const nm = state.roster.find(p => p.id === id)?.name;
  if (!confirm(`Keep ${nm} as a brand-new player (no past history to link)?`)) return;
  try { await db.clearAccount(id); toast('Marked as a new player'); }
  catch (e) { toast(e.message, true); }
};
window.addPlayer = async () => {
  const name = document.getElementById('newPlayer').value.trim();
  if (!name) return toast('Enter a name', true);
  try { await db.upsertPlayer(name); toast('Player added'); } catch (e) { toast(e.message, true); }
};
window.saveRatings = async () => {
  let saved = 0;
  try {
    for (const p of state.roster) {
      const attrs = {}; let any = false;
      for (const k of logic.ATTRS) {
        const el = document.getElementById(`attr-${p.id}-${k}`);
        const raw = el ? el.value.trim() : '';
        if (raw !== '') { any = true; attrs[k] = Math.max(0, Math.min(20, Number(raw) || 0)); }
        else attrs[k] = (p.attrs && Number.isFinite(p.attrs[k])) ? p.attrs[k] : 10;
      }
      if (any && JSON.stringify(attrs) !== JSON.stringify(p.attrs || {})) { await db.setPlayerAttrs(p.id, attrs); saved++; }
    }
    toast(saved ? `Saved ratings for ${saved} player${saved === 1 ? '' : 's'}` : 'No changes');
  } catch (e) { toast(e.message, true); }
};
window.autoBalance = () => {
  const g = state.game; if (!g) return;
  const b = logic.balanceTeams(g.confirmed.map(r => r.playerId), state.playersById);
  lineupDraft = { bibs: b.bibs, nonbibs: b.nonbibs }; lineupGameId = g.id; render();
};
window.flipSide = (id) => {
  if (!lineupDraft) return;
  if (lineupDraft.bibs.includes(id)) { lineupDraft.bibs = lineupDraft.bibs.filter(x => x !== id); lineupDraft.nonbibs.push(id); }
  else { lineupDraft.nonbibs = lineupDraft.nonbibs.filter(x => x !== id); lineupDraft.bibs.push(id); }
  render();
};
window.lineupDragStart = (ev, id) => { ev.dataTransfer.setData('text/plain', id); ev.dataTransfer.effectAllowed = 'move'; };
window.lineupDrop = (ev, side) => {
  ev.preventDefault();
  const id = ev.dataTransfer.getData('text/plain'); if (!id || !lineupDraft) return;
  lineupDraft.bibs = lineupDraft.bibs.filter(x => x !== id); lineupDraft.nonbibs = lineupDraft.nonbibs.filter(x => x !== id);
  lineupDraft[side].push(id); render();
};
window.saveLineup = async (finalised) => {
  const g = state.game; if (!g || !lineupDraft) return;
  try { await db.saveLineup(g.id, lineupDraft, finalised); toast(finalised ? 'Teams published to This Week ✅' : 'Draft saved'); }
  catch (e) { toast(e.message, true); }
};
window.saveConfig = async () => {
  const latRaw = document.getElementById('cLat').value.trim();
  const lonRaw = document.getElementById('cLon').value.trim();
  const patch = {
    clubName: document.getElementById('cName').value.trim(),
    venue: document.getElementById('cVenue').value.trim(),
    lat: latRaw === '' ? null : Number(latRaw),
    lon: lonRaw === '' ? null : Number(lonRaw),
    gameDay: document.getElementById('cDay').value,
    kickoff: document.getElementById('cKick').value.trim(),
    capacity: Number(document.getElementById('cCap').value),
    organiserEmail: document.getElementById('cOrg').value.trim(),
    scoring: {
      playedReward: Number(document.getElementById('cReward').value),
      weatherBonus: Number(document.getElementById('cWx').value),
      coldSeasonBonus: Number(document.getElementById('cCold').value),
      lateSignupBonusGames: Number(document.getElementById('cLate').value)
    }
  };
  const pin = document.getElementById('cPin').value.trim();
  if (pin) patch.adminPin = pin;
  try { weatherCache = {}; await db.updateConfig(patch); render(); toast('Settings saved'); }
  catch (e) { toast(e.message, true); }
};

// foreground push → in-app toast
window.addEventListener('tntf-push', e => {
  const n = e.detail?.notification || e.detail?.data || {};
  toast(n.title ? `${n.title}${n.body ? ' — ' + n.body : ''}` : 'Update');
});

// ---- boot -----------------------------------------------------------------
(async () => {
  try {
    db = await createDB();
    auth = await createAuth();
    if (auth.enabled) {
      await auth.complete().catch(err => console.error('sign-in redirect', err));
      auth.onChange(u => { user = u; history = null; if (u) ensureAccount(u); buildView(); render(); ensureHistory(); });
    }
    db.subscribe(raw => { lastRaw = raw; buildView(); render(); maybeMigrateConfig(); maybeDedupe(); });
    ensureHistory(); // load past results for form/analytics on Table & You
  } catch (e) {
    console.error(e);
    $app.innerHTML = `<div class="loading">Couldn't start: ${esc(e.message || e)}.<br>If you just added Firebase config, check firestore.rules are published.</div>`;
  }
  // keep countdown / penalty text fresh
  setInterval(() => { if (document.visibilityState === 'visible' && lastRaw) { buildView(); if (tab === 'week' || tab === 'table') render(); } }, 20000);
})();
