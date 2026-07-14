// app.js — vanilla mobile SPA. Talks to the data layer (db.js); no backend.
import { createDB } from './db.js';
import { createAuth } from './auth.js';
import { enablePush, pushSupported, pushConfigured, isIOS, isStandalone } from './messaging.js';
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
let adminUnlocked = false;

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
    game = {
      id: g.id, status: g.status, dateLabel: g.dateLabel, kickoffAt: g.kickoffAt, capacity: g.capacity,
      confirmed: ranked.filter(r => r.status === 'confirmed'),
      waitlist: ranked.filter(r => r.status === 'waitlist'),
      totalIn: ranked.length,
      me: mine ? { rank: mine.rank, status: mine.status } : null,
      withdrawPenaltyNow: logic.penaltyForHours(hrs, lastRaw.config).penalty
    };
  }
  const alert = game ? statusAlert(game, playerId) : null;
  state = { config: lastRaw.config, me, roster: lastRaw.roster, game, alert };
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
function avatarColor(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 70% 62%)`; }
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

// ---- screens --------------------------------------------------------------
function renderHeader() {
  const c = state.config;
  const demo = db.mode === 'local'
    ? `<div class="demo-banner">Demo mode · single device. Add your Firebase config to share with the group — see README.</div>` : '';
  return `<header class="app">
    <div class="row">
      <svg class="ball" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#eaf5ef"/><path d="M12 6l3.5 2.6-1.3 4.1h-4.4L8.5 8.6 12 6z" fill="#0b3d2e"/></svg>
      <h1>${esc(c.clubName)}</h1>
    </div>
    <div class="sub">${esc(c.gameDay)}s · ${esc(c.kickoff)} · ${c.capacity}-a-squad · picked by loyalty, not speed</div>
  </header>${demo}`;
}

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

  const kicker = g.status === 'open' ? 'REGISTRATION OPEN' : g.status === 'locked' ? 'SQUAD LOCKED' : g.status.toUpperCase();

  return `
    ${alert}
    <div class="card">
      <div class="hero">
        <div class="kicker">${kicker}</div>
        <div class="date">${esc(g.dateLabel)}</div>
        <div class="count">${g.confirmed.length}/${g.capacity} confirmed${g.waitlist.length ? ` · ${g.waitlist.length} on the bench` : ''} · ${fmtCountdown(g.kickoffAt)}</div>
        <div class="capbar"><span style="width:${pct}%"></span></div>
      </div>
      ${mine}
      ${actionBtn()}
    </div>
    <div class="card">
      <h2>Squad &amp; reserves</h2>
      <p class="hint">Everyone can see the full list. Ranked by loyalty score — a regular who signs up late still ranks above a casual, so there's no rush to be first.</p>
      <div class="lu-head">Starting ${g.capacity} · by loyalty</div>
      ${lineup(g.confirmed, 1, 'loyalty')}
      ${g.waitlist.length ? `<div class="lu-head sub">Reserves</div>${lineup(g.waitlist, g.capacity + 1, 'reserve')}` : ''}
    </div>`;
}

// Abbreviate to Guardian lineup style: "Darren Ellis" → "D. Ellis"; single
// names stay as-is ("Faisal", "Suki").
function abbrev(name) {
  const parts = String(name).trim().split(/\s+/);
  return parts.length < 2 ? name : `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}

// Two-column "Lineups / Substitutes" style list (Guardian match-report look).
function lineup(list, startNum, badgeMode) {
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
  return `<div class="lineup"><div class="lu-col">${left}</div><div class="lu-col">${right}</div></div>`;
}

function nextGamePreview() {
  return `<div class="card">
    <h2>How selection works</h2>
    <p class="hint">When more than ${state.config.capacity} want to play, the squad is the top ${state.config.capacity} by <b>loyalty score</b> — you earn loyalty every game you play and lose it if you drop out late. It rewards regulars and removes the race to tap first.</p>
  </div>`;
}

// Mode-aware identity prompt:
//  • demo mode → pick your name (device-local)
//  • cloud + auth, signed out → email magic-link sign-in
//  • cloud + auth, signed in but unlinked → link to a roster spot
function identityPrompt() {
  if (auth?.enabled) {
    if (!user) {
      return `<h2>Sign in to register</h2>
        <p class="hint">Enter your email — we'll send you a one-tap sign-in link. No password. This is also how you get notified when your spot changes.</p>
        <input id="emailInput" type="email" inputmode="email" autocomplete="email" placeholder="you@email.com" />
        <div class="mt"><button class="btn-primary" onclick="sendLink()">Email me a sign-in link</button></div>
        <p class="small center mt">You can still see the squad and reserves without signing in.</p>`;
    }
    // signed in, needs linking to a roster entry
    const opts = state.roster.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    return `<h2>Link your spot</h2>
      <p class="hint">Signed in as ${esc(user.email)}. Which player are you? Pick your name, or add yourself if you're new.</p>
      <label class="field">I'm on the roster as</label>
      <select id="linkSelect"><option value="">— choose your name —</option>${opts}</select>
      <button class="btn-primary mt" onclick="linkExisting()">That's me</button>
      <label class="field mt">Not on the roster? Add yourself</label>
      <input id="linkNew" placeholder="Your name" />
      <button class="btn-ghost" onclick="linkNew()">Add me & link</button>`;
  }
  return `<h2>What's your name?</h2>
    <p class="hint">Pick your name so we can track your loyalty. One tap and you're set on this phone.</p>
    <input id="nameInput" placeholder="e.g. ${esc((state.roster[0] && state.roster[0].name) || 'Your name')}" autocomplete="name" />
    <div class="mt"><button class="btn-primary" onclick="join()">Continue</button></div>
    <p class="small center mt">Already on the roster? Type your exact name to link up.</p>`;
}

function tableScreen() {
  const rows = state.roster.map((p, i) => {
    const an = history ? logic.playerAnalytics(p.id, history) : null;
    const meta = an && an.played
      ? `${an.wins}W-${an.draws}D-${an.losses}L · ${an.winPct}% ${formGuide(an.form.slice(0, 5))}`
      : `${p.gamesPlayed} games · ${p.dropouts} dropout${p.dropouts === 1 ? '' : 's'}`;
    return playerRow(p, { num: i + 1, meta, right: `<div class="loyalty">${p.loyalty}</div>` });
  }).join('');
  return `<div class="card">
    <h2>Loyalty table</h2>
    <p class="hint">Ranked by loyalty (priority when oversubscribed). Each row shows record and recent form. Tap <b>You</b> for your full profile.</p>
    ${rows || '<div class="empty">No players yet.</div>'}
  </div>`;
}

function rulesScreen() {
  const tiers = state.config.scoring.dropoutTiers;
  return `<div class="card">
    <h2>The system</h2>
    <p class="hint">Built from the group's suggestions — rewards regulars, kills the tap-race, and only penalises dropouts fairly.</p>
    <div class="section-title" style="margin-top:6px">1 · Consistent timing</div>
    <p class="small">The poll opens at a set time each week, so nobody misses out for being on the pitch or driving home.</p>
    <div class="section-title">2 · Loyalty, not speed</div>
    <p class="small">When more than ${state.config.capacity} sign up, the squad is the top ${state.config.capacity} by loyalty (games played, minus dropout penalties). Signing up first doesn't jump the queue.</p>
    <div class="section-title">3 · Time-weighted dropout penalty</div>
    <p class="small">Pulling out early is free — pulling out last-minute costs you. As Tom put it: a day or two's notice is fine, last minute isn't.</p>
    <ul class="penalty-scale">
      ${tiers.map(t => `<li><span>${esc(t.label)}</span><span class="pts ${t.penalty === 0 ? 'free' : ''}">${t.penalty === 0 ? 'no penalty' : '-' + t.penalty}</span></li>`).join('')}
    </ul>
  </div>`;
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
      ${stats.history.length ? `<div class="section-title">History</div>${stats.history.map(h =>
        `<div class="histrow"><span>${esc(h.dateLabel || 'Game')}</span><span class="pill ${h.played ? 'in' : h.withdrew ? 'out' : 'wait'}">${h.played ? 'played' : h.withdrew ? 'dropped out' : 'reserve'}</span></div>`).join('')}`
        : '<p class="hint">No completed games yet — your history builds up from here.</p>'}
    </div>` : `<div class="card"><h2>Your record</h2><p class="hint">Loading your history…</p></div>`;

  // Notifications card
  let notif = '';
  if (auth?.enabled) {
    const emailLine = me.email
      ? `<div class="notif-row"><span>📧 Email alerts</span><span class="pill in">on</span></div><p class="small">Sent to ${esc(me.email)} when your spot changes.</p>`
      : `<p class="small">Sign in with email to get email alerts.</p>`;
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

  const account = auth?.enabled
    ? `<div class="card"><h2>Account</h2><p class="hint">Signed in as ${esc(user.email)} · linked to ${esc(me.name)}.</p><button class="btn-ghost" onclick="signOutUser()">Sign out</button></div>`
    : `<div class="card"><h2>You</h2><p class="hint">Playing as ${esc(me.name)} on this device.</p><button class="btn-ghost" onclick="forgetMe()">Not you? Switch name</button></div>`;

  return `<div class="card center hero-you">
      <div class="avatar big" style="background:${avatarColor(me.name)}">${initials(me.name)}</div>
      <h2 style="margin-top:8px">${esc(me.name)}</h2>
      <p class="small">${me.loyalty} loyalty · ${me.gamesPlayed} games</p>
    </div>${analyticsCard}${statsCard}${notif}${account}`;
}

// Guardian-style form guide: coloured W/D/L chips, newest first.
function formGuide(form) {
  if (!form || !form.length) return '<p class="small">No games yet.</p>';
  return `<div class="form-guide">${form.map(o => `<span class="fchip ${o.toLowerCase()}">${o}</span>`).join('')}</div>`;
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
      <div class="mt"><button class="btn-primary" onclick="completeGame('${g.id}')">Mark as played → bank loyalty</button></div>
    </div>` : `
    <div class="card">
      <h2>No game open</h2>
      <p class="hint">Open this week's game — defaults to the next ${esc(state.config.gameDay)} at ${esc(state.config.kickoff)}.</p>
      <label class="field">Label</label><input id="gLabel" value="${esc(state.config.gameDay)} game" />
      <label class="field">Capacity (squad size)</label><input id="gCap" type="number" value="${state.config.capacity}" />
      <label class="field">Kickoff</label><input id="gKick" type="datetime-local" />
      <button class="btn-primary mt" onclick="openGame()">Open the game</button>
    </div>`;

  const linkTag = p => auth?.enabled
    ? (p.email ? `<span class="link-tag ok">✓ ${esc(p.email)}</span>` : `<span class="link-tag no">not linked</span>`)
    : '';
  const roster = state.roster.map(p => `<div class="player">
      <div class="avatar" style="background:${avatarColor(p.name)}">${initials(p.name)}</div>
      <div class="info"><div class="name">${esc(p.name)}</div><div class="meta">${p.loyalty} loyalty · ${p.gamesPlayed} games · ${p.dropouts} dropouts ${linkTag(p)}</div></div>
      <button style="width:auto;padding:8px 10px" class="btn-ghost" onclick="adjust('${p.id}',1)">＋</button>
      <button style="width:auto;padding:8px 10px;margin-left:6px" class="btn-ghost" onclick="adjust('${p.id}',-1)">－</button>
    </div>`).join('');

  return `${gameCard}
    <div class="card">
      <h2>Roster & loyalty</h2>
      <p class="hint">Nudge loyalty by hand if needed (e.g. someone played as a ringer).</p>
      ${roster}
      <label class="field mt">Add a player</label><input id="newPlayer" placeholder="Name" />
      <button class="btn-ghost" onclick="addPlayer()">Add to roster</button>
    </div>
    <div class="card">
      <h2>Settings</h2>
      <label class="field">Club name</label><input id="cName" value="${esc(state.config.clubName)}" />
      <label class="field">Game day</label>
      <select id="cDay">${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(d => `<option ${d === state.config.gameDay ? 'selected' : ''}>${d}</option>`).join('')}</select>
      <label class="field">Kickoff (HH:MM)</label><input id="cKick" value="${esc(state.config.kickoff)}" />
      <label class="field">Default squad size</label><input id="cCap" type="number" value="${state.config.capacity}" />
      <label class="field">Loyalty per game played</label><input id="cReward" type="number" value="${state.config.scoring.playedReward}" />
      <label class="field">New admin PIN (leave blank to keep)</label><input id="cPin" type="password" inputmode="numeric" placeholder="••••" />
      <button class="btn-primary mt" onclick="saveConfig()">Save settings</button>
      <button class="btn-ghost mt" onclick="adminLogout()">Log out of organiser</button>
    </div>`;
}

// ---- render ---------------------------------------------------------------
function render() {
  if (!state) return;
  const screens = { week: weekScreen, table: tableScreen, you: youScreen, rules: rulesScreen, admin: adminScreen };
  const icon = {
    week: '<path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 3l4 3-1.5 4.7h-5L8 8l4-3z" fill="currentColor"/>',
    table: '<path d="M4 5h16M4 12h16M4 19h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    you: '<circle cx="12" cy="8" r="3.4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 20c0-3.6 3.1-6.2 7-6.2s7 2.6 7 6.2" fill="none" stroke="currentColor" stroke-width="2"/>',
    rules: '<path d="M6 3h9l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 12h7M9 16h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    admin: '<path d="M12 2l7 3v6c0 4.5-3 8.5-7 9-4-.5-7-4.5-7-9V5l7-3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
  };
  const label = { week: 'This week', table: 'Table', you: 'You', rules: 'Rules', admin: 'Organiser' };
  $app.innerHTML = renderHeader() + `<main>${screens[tab]()}</main>`;
  let nav = document.querySelector('nav.tabs');
  if (!nav) { nav = document.createElement('nav'); nav.className = 'tabs'; document.body.appendChild(nav); }
  nav.innerHTML = Object.keys(screens).map(k =>
    `<button class="${tab === k ? 'active' : ''}" onclick="go('${k}')"><svg viewBox="0 0 24 24">${icon[k]}</svg>${label[k]}</button>`).join('');
}

// Load completed-game history once — used by Table (form) and You (analytics).
async function ensureHistory() {
  if (history !== null) return;
  history = [];
  try { history = await db.loadHistory(); render(); } catch (e) { console.error(e); }
}

// ---- actions --------------------------------------------------------------
window.go = t => { tab = t; render(); };

// demo-mode name pick
window.join = async () => {
  const name = document.getElementById('nameInput').value.trim();
  if (!name) return toast('Enter your name', true);
  try { LS.id = await db.upsertPlayer(name); buildView(); render(); toast(`Welcome, ${name}`); }
  catch (e) { toast(e.message, true); }
};
// cloud-mode: email magic-link
window.sendLink = async () => {
  const email = document.getElementById('emailInput').value.trim();
  if (!email) return toast('Enter your email', true);
  try { await auth.sendLink(email); toast('Check your inbox for the sign-in link 📧'); }
  catch (e) { toast(e.message, true); }
};
window.linkExisting = async () => {
  const id = document.getElementById('linkSelect').value;
  if (!id) return toast('Pick your name', true);
  try { await db.setPlayerEmail(id, user.email, user.uid); LS.id = id; toast('Linked ✅'); }
  catch (e) { toast(e.message, true); }
};
window.linkNew = async () => {
  const name = document.getElementById('linkNew').value.trim();
  if (!name) return toast('Enter your name', true);
  try { const id = await db.upsertPlayer(name); await db.setPlayerEmail(id, user.email, user.uid); LS.id = id; toast(`Welcome, ${name}`); }
  catch (e) { toast(e.message, true); }
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
  const kick = document.getElementById('gKick').value;
  const body = { dateLabel, capacity };
  if (kick) body.kickoffAt = new Date(kick).toISOString();
  try { await db.openGame(body); tab = 'week'; render(); toast('Game opened ⚽'); }
  catch (e) { toast(e.message, true); }
};
window.completeGame = async (id) => {
  if (!confirm('Mark as played? The confirmed squad each get their loyalty reward, then this game is archived.')) return;
  try { await db.completeGame(id); toast('Loyalty banked · game archived'); }
  catch (e) { toast(e.message, true); }
};
window.adjust = async (id, delta) => { try { await db.adjustLoyalty(id, delta); } catch (e) { toast(e.message, true); } };
window.addPlayer = async () => {
  const name = document.getElementById('newPlayer').value.trim();
  if (!name) return toast('Enter a name', true);
  try { await db.upsertPlayer(name); toast('Player added'); } catch (e) { toast(e.message, true); }
};
window.saveConfig = async () => {
  const patch = {
    clubName: document.getElementById('cName').value.trim(),
    gameDay: document.getElementById('cDay').value,
    kickoff: document.getElementById('cKick').value.trim(),
    capacity: Number(document.getElementById('cCap').value),
    scoring: { playedReward: Number(document.getElementById('cReward').value) }
  };
  const pin = document.getElementById('cPin').value.trim();
  if (pin) patch.adminPin = pin;
  try { await db.updateConfig(patch); render(); toast('Settings saved'); }
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
      await auth.complete().catch(err => console.error('sign-in link', err));
      auth.onChange(u => { user = u; history = null; buildView(); render(); ensureHistory(); });
    }
    db.subscribe(raw => { lastRaw = raw; buildView(); render(); });
    ensureHistory(); // load past results for form/analytics on Table & You
  } catch (e) {
    console.error(e);
    $app.innerHTML = `<div class="loading">Couldn't start: ${esc(e.message || e)}.<br>If you just added Firebase config, check firestore.rules are published.</div>`;
  }
  // keep countdown / penalty text fresh
  setInterval(() => { if (document.visibilityState === 'visible' && lastRaw) { buildView(); if (tab === 'week' || tab === 'table') render(); } }, 20000);
})();
