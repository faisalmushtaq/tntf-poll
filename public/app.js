// app.js — vanilla mobile SPA for TNTF. No build step, no framework.
const $app = document.getElementById('app');

const LS = {
  get id() { return localStorage.getItem('tntf.playerId'); },
  set id(v) { v ? localStorage.setItem('tntf.playerId', v) : localStorage.removeItem('tntf.playerId'); },
  get pin() { return sessionStorage.getItem('tntf.pin') || ''; },
  set pin(v) { v ? sessionStorage.setItem('tntf.pin', v) : sessionStorage.removeItem('tntf.pin'); }
};

let state = null;
let tab = 'week';

// ---- api helpers ----------------------------------------------------------
async function api(path, body, method = 'POST') {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-pin': LS.pin },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
async function loadState() {
  const q = LS.id ? `?playerId=${encodeURIComponent(LS.id)}` : '';
  state = await (await fetch('/api/state' + q)).json();
}

// ---- ui helpers -----------------------------------------------------------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, isErr = false) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.className = isErr ? 'err show' : 'show';
  clearTimeout(t._t); t._t = setTimeout(() => t.className = t.className.replace('show', ''), 2600);
}
function avatarColor(name) {
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 62%)`;
}
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
  const pid = p.playerId || p.id;
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
  return `<header class="app">
    <div class="row">
      <svg class="ball" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#eaf5ef"/><path d="M12 6l3.5 2.6-1.3 4.1h-4.4L8.5 8.6 12 6z" fill="#0b3d2e"/></svg>
      <h1>${esc(c.clubName)}</h1>
    </div>
    <div class="sub">${esc(c.gameDay)}s · ${esc(c.kickoff)} · ${c.capacity}-a-squad · picked by loyalty, not speed</div>
  </header>`;
}

function weekScreen() {
  const g = state.game;
  if (!g) {
    return `<div class="card center">
      <h2>No game open yet ⚽</h2>
      <p class="hint">The next poll opens after this week's game. When it's live, you'll register here — and your place is decided by loyalty, so there's no rush to be first.</p>
      ${LS.id ? '' : joinPrompt()}
    </div>${nextGamePreview()}`;
  }

  const pct = Math.min(100, Math.round(g.confirmed.length / g.capacity * 100));
  const filled = g.confirmed.length;
  let mine = '';
  if (!LS.id) {
    mine = `<div class="card">${joinPrompt()}</div>`;
  } else if (g.me) {
    if (g.me.status === 'confirmed') {
      mine = `<div class="mine-banner in">✅ You're IN — squad place #${g.me.rank}</div>`;
    } else {
      mine = `<div class="mine-banner wait">⏳ You're on the waitlist — #${g.me.rank - g.capacity} in line. You'll move up if a regular drops.</div>`;
    }
  } else {
    mine = `<div class="mine-banner out">You haven't registered for this game yet.</div>`;
  }

  const actionBtn = () => {
    if (!LS.id) return '';
    if (g.status !== 'open') return `<button class="btn-ghost" disabled>Registration ${esc(g.status)}</button>`;
    if (g.me) {
      const pen = g.withdrawPenaltyNow;
      const warn = pen > 0
        ? `Withdrawing now costs <b>-${pen} loyalty</b> (${fmtCountdown(g.kickoffAt).replace(' to kickoff','')} out).`
        : `Free to withdraw now — more than 48h to kickoff.`;
      return `<p class="small mt center">${warn}</p>
        <button class="btn-danger" onclick="withdraw()">Withdraw from this game</button>`;
    }
    return `<button class="btn-primary" onclick="signup()">✋ I'm in for ${esc(g.dateLabel)}</button>`;
  };

  const rows = g.confirmed.map((p, i) => playerRow(p, {
    num: i + 1,
    meta: `${p.loyalty} loyalty · ${p.gamesPlayed} games`,
    right: `<span class="pill in">IN</span>`
  })).join('') || `<div class="empty">No one's in yet — be the first.</div>`;

  const waitRows = g.waitlist.length
    ? `<div class="divider-wait">Waitlist · promoted if someone drops</div>` +
      g.waitlist.map((p, i) => playerRow(p, {
        num: g.capacity + i + 1,
        meta: `${p.loyalty} loyalty · ${p.gamesPlayed} games`,
        right: `<span class="pill wait">#${i + 1}</span>`
      })).join('')
    : '';

  return `
    <div class="card">
      <div class="hero">
        <div class="date">${esc(g.dateLabel)}</div>
        <div class="count">${filled}/${g.capacity} confirmed${g.waitlist.length ? ` · ${g.waitlist.length} waiting` : ''} · ${fmtCountdown(g.kickoffAt)}</div>
        <div class="capbar"><span style="width:${pct}%"></span></div>
      </div>
      ${mine}
      ${actionBtn()}
    </div>
    <div class="card">
      <h2>Squad</h2>
      <p class="hint">Top ${g.capacity} by loyalty score. Sign up late? A regular still ranks above a casual — no need to hover over the poll.</p>
      ${rows}
      ${waitRows}
    </div>`;
}

function nextGamePreview() {
  return `<div class="card">
    <h2>How selection works</h2>
    <p class="hint">When more than ${state.config.capacity} want to play, the squad is the top ${state.config.capacity} by <b>loyalty score</b> — you earn loyalty every game you play, and lose it if you drop out late. It rewards regulars and removes the race to tap first.</p>
  </div>`;
}

function joinPrompt() {
  return `<h2>What's your name?</h2>
    <p class="hint">Pick your name so we can track your loyalty. One tap and you're set on this phone.</p>
    <input id="nameInput" placeholder="e.g. ${esc((state.roster[0] && state.roster[0].name) || 'Your name')}" autocomplete="name" />
    <div class="mt"><button class="btn-primary" onclick="join()">Continue</button></div>
    <p class="small center mt">Already on the roster? Type your exact name to link up.</p>`;
}

function tableScreen() {
  const rows = state.roster.map((p, i) => playerRow(p, {
    num: i + 1,
    meta: `${p.gamesPlayed} games · ${p.dropouts} dropout${p.dropouts === 1 ? '' : 's'}`,
    right: `<div class="loyalty">${p.loyalty}</div>`
  })).join('');
  return `<div class="card">
    <h2>Loyalty table</h2>
    <p class="hint">Everyone's standing. Higher loyalty = higher priority when a game is oversubscribed. +${state.config.scoring.playedReward} for every game played; late dropouts cost points.</p>
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

// ---- admin ----------------------------------------------------------------
function adminScreen() {
  if (!LS.pin) {
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
        ? `<button class="btn-warn" onclick="admin('lock',{gameId:'${g.id}'},'Squad locked')">Lock squad (stop registration)</button>`
        : `<button class="btn-ghost" onclick="admin('reopen',{gameId:'${g.id}'},'Reopened')">Reopen registration</button>`}
      <div class="mt"><button class="btn-primary" onclick="completeGame('${g.id}')">Mark as played → bank loyalty</button></div>
    </div>` : `
    <div class="card">
      <h2>No game open</h2>
      <p class="hint">Open this week's game — defaults to the next ${esc(state.config.gameDay)} at ${esc(state.config.kickoff)}.</p>
      <label class="field">Label</label>
      <input id="gLabel" value="${esc(state.config.gameDay)} game" />
      <label class="field">Capacity (squad size)</label>
      <input id="gCap" type="number" value="${state.config.capacity}" />
      <label class="field">Kickoff</label>
      <input id="gKick" type="datetime-local" />
      <button class="btn-primary mt" onclick="openGame()">Open the game</button>
    </div>`;

  const roster = state.roster.map(p => `<div class="player">
      <div class="avatar" style="background:${avatarColor(p.name)}">${initials(p.name)}</div>
      <div class="info"><div class="name">${esc(p.name)}</div><div class="meta">${p.loyalty} loyalty · ${p.gamesPlayed} games · ${p.dropouts} dropouts</div></div>
      <button style="width:auto;padding:8px 10px" class="btn-ghost" onclick="adjust('${p.id}',1)">＋</button>
      <button style="width:auto;padding:8px 10px;margin-left:6px" class="btn-ghost" onclick="adjust('${p.id}',-1)">－</button>
    </div>`).join('');

  return `${gameCard}
    <div class="card">
      <h2>Roster & loyalty</h2>
      <p class="hint">Nudge loyalty by hand if needed (e.g. someone played as a ringer).</p>
      ${roster}
      <label class="field mt">Add a player</label>
      <input id="newPlayer" placeholder="Name" />
      <button class="btn-ghost" onclick="addPlayer()">Add to roster</button>
    </div>
    <div class="card">
      <h2>Settings</h2>
      <label class="field">Club name</label>
      <input id="cName" value="${esc(state.config.clubName)}" />
      <label class="field">Game day</label>
      <select id="cDay">${['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(d => `<option ${d === state.config.gameDay ? 'selected' : ''}>${d}</option>`).join('')}</select>
      <label class="field">Kickoff (HH:MM)</label>
      <input id="cKick" value="${esc(state.config.kickoff)}" />
      <label class="field">Default squad size</label>
      <input id="cCap" type="number" value="${state.config.capacity}" />
      <label class="field">Loyalty per game played</label>
      <input id="cReward" type="number" value="${state.config.scoring.playedReward}" />
      <label class="field">New admin PIN (leave blank to keep)</label>
      <input id="cPin" type="password" inputmode="numeric" placeholder="••••" />
      <button class="btn-primary mt" onclick="saveConfig()">Save settings</button>
      <button class="btn-ghost mt" onclick="adminLogout()">Log out of organiser</button>
    </div>`;
}

// ---- render ---------------------------------------------------------------
function render() {
  const screens = { week: weekScreen, table: tableScreen, rules: rulesScreen, admin: adminScreen };
  const icon = {
    week: '<path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 3l4 3-1.5 4.7h-5L8 8l4-3z" fill="currentColor"/>',
    table: '<path d="M4 5h16M4 12h16M4 19h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    rules: '<path d="M6 3h9l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 12h7M9 16h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    admin: '<circle cx="12" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 20c0-3.5 3.1-6 7-6s7 2.5 7 6" fill="none" stroke="currentColor" stroke-width="2"/>'
  };
  const label = { week: 'This week', table: 'Table', rules: 'Rules', admin: 'Organiser' };
  $app.innerHTML = renderHeader() + `<main>${screens[tab]()}</main>`;
  let nav = document.querySelector('nav.tabs');
  if (!nav) { nav = document.createElement('nav'); nav.className = 'tabs'; document.body.appendChild(nav); }
  nav.innerHTML = Object.keys(screens).map(k =>
    `<button class="${tab === k ? 'active' : ''}" onclick="go('${k}')">
       <svg viewBox="0 0 24 24">${icon[k]}</svg>${label[k]}
     </button>`).join('');
}

// ---- actions --------------------------------------------------------------
window.go = t => { tab = t; render(); };

window.join = async () => {
  const name = document.getElementById('nameInput').value.trim();
  if (!name) return toast('Enter your name', true);
  try { const r = await api('/api/player', { name }); LS.id = r.player.id; await refresh(); toast(`Welcome, ${r.player.name}`); }
  catch (e) { toast(e.message, true); }
};
window.signup = async () => {
  try { state = await api('/api/signup', { playerId: LS.id, gameId: state.game.id }); render();
    toast(state.game.me?.status === 'confirmed' ? "You're in ✅" : "Added — you're on the waitlist"); }
  catch (e) { toast(e.message, true); }
};
window.withdraw = async () => {
  const pen = state.game.withdrawPenaltyNow;
  if (!confirm(pen > 0 ? `Withdraw now for -${pen} loyalty?` : 'Withdraw from this game?')) return;
  try { const r = await api('/api/withdraw', { playerId: LS.id, gameId: state.game.id });
    state = r.state; render();
    toast(r.penalty > 0 ? `Withdrawn · -${r.penalty} loyalty (${r.label})` : 'Withdrawn · no penalty'); }
  catch (e) { toast(e.message, true); }
};

window.adminLogin = async () => {
  const pin = document.getElementById('pinInput').value;
  try { const r = await api('/api/admin/check', { pin }); if (!r.ok) return toast('Wrong PIN', true);
    LS.pin = pin; render(); toast('Unlocked'); }
  catch (e) { toast(e.message, true); }
};
window.adminLogout = () => { LS.pin = ''; render(); toast('Logged out'); };
window.admin = async (action, body, ok) => {
  try { state = await api('/api/admin/' + action, body); render(); toast(ok || 'Done'); }
  catch (e) { toast(e.message, true); }
};
window.openGame = async () => {
  const label = document.getElementById('gLabel').value.trim();
  const capacity = Number(document.getElementById('gCap').value);
  const kick = document.getElementById('gKick').value;
  const body = { dateLabel: label, capacity };
  if (kick) body.kickoffAt = new Date(kick).toISOString();
  try { const r = await api('/api/admin/open', body); state = r.state; tab = 'week'; render(); toast('Game opened ⚽'); }
  catch (e) { toast(e.message, true); }
};
window.completeGame = async (id) => {
  if (!confirm('Mark as played? Confirmed squad each get their loyalty reward, then this game is archived.')) return;
  await admin('complete', { gameId: id }, 'Loyalty banked · game archived');
};
window.adjust = (id, delta) => admin('adjust', { id, delta }, 'Updated');
window.addPlayer = async () => {
  const name = document.getElementById('newPlayer').value.trim();
  if (!name) return toast('Enter a name', true);
  await admin('add-player', { name }, 'Player added');
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
  try { state = await api('/api/admin/config', patch); if (pin) LS.pin = pin; render(); toast('Settings saved'); }
  catch (e) { toast(e.message, true); }
};

async function refresh() { await loadState(); render(); }

// ---- boot -----------------------------------------------------------------
(async () => {
  try { await loadState(); render(); }
  catch { $app.innerHTML = '<div class="loading">Could not reach the server.</div>'; }
  // keep countdown / rankings fresh
  setInterval(async () => { if (document.visibilityState === 'visible') { try { await loadState(); if (tab === 'week' || tab === 'table') render(); } catch {} } }, 20000);
})();
