// db.js — the data layer. One interface, two backends:
//   • Firestore  (shared, multi-device) when firebase-config.js is filled in
//   • localStorage (single-device demo) otherwise
// All the fairness maths lives in logic.js; this file is just storage + wiring.

import { FIREBASE_ENABLED } from './firebase-config.js';
import { getFirebaseApp, FB_VERSION } from './firebase.js';
import { SEED } from './seed-data.js';
import { PERF } from './perf-data.js';
import * as logic from './logic.js';

// Goals map { playerId: count } derived from a game's per-player stats.
const goalsFromStats = perf => Object.fromEntries(
  Object.entries(perf).filter(([, v]) => Number(v.g) > 0).map(([id, v]) => [id, Number(v.g)]));

const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }));

// Roster seeded from the parsed history (data/history.txt → seed-data.js),
// keyed by the stable historic ids so imported games line up with players.
function seedPlayers() {
  const players = {};
  for (const p of SEED.players) players[p.id] = { ...p };
  return players;
}
function seedGames() {
  return SEED.games.map(g => {
    const perf = PERF[g.id];
    const extra = perf ? { stats: perf, goals: goalsFromStats(perf) } : {};
    return { ...g, ...extra, signups: [] };
  });
}

const dedupe = arr => [...new Set(arr)];
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
const PLAYER_MAP_FIELDS = ['stats', 'goals', 'selfRatings', 'stattoRatings', 'ownGoals', 'withdrawnPenalties'];
const PLAYER_ARRAY_FIELDS = ['motm', 'withdrawnIds'];

function sumValues(a, b) { return (Number(a) || 0) + (Number(b) || 0); }
function mergeStatLines(keep = {}, drop = {}) {
  const out = { ...drop, ...keep };
  for (const key of new Set([...Object.keys(keep || {}), ...Object.keys(drop || {})])) {
    if (Number.isFinite(Number(keep[key])) && Number.isFinite(Number(drop[key]))) out[key] = sumValues(keep[key], drop[key]);
  }
  return out;
}
function mergeSignupRecords(keep = {}, drop = {}) {
  const priority = { in: 3, withdrawn: 2, out: 1 };
  const status = (priority[keep.status] || 0) >= (priority[drop.status] || 0) ? keep.status : drop.status;
  const joined = [keep.joinedAt, drop.joinedAt].filter(Boolean).sort()[0];
  return {
    ...drop, ...keep, status,
    ...(joined ? { joinedAt: joined } : {}),
    paid: !!(keep.paid || drop.paid),
    paidAt: keep.paidAt || drop.paidAt || null
  };
}
function dropMapEntry(g, field, id) {
  if (!g[field] || !hasOwn(g[field], id)) return;
  const next = { ...g[field] }; delete next[id]; g[field] = next;
}
function moveMapEntry(g, field, dropId, keepId, merge = (keep) => keep) {
  if (!g[field] || !hasOwn(g[field], dropId)) return;
  const next = { ...g[field] };
  next[keepId] = hasOwn(next, keepId) ? merge(next[keepId], next[dropId]) : next[dropId];
  delete next[dropId]; g[field] = next;
}

// Remove a player from every reference in a game (used by deletePlayer).
function stripPlayer(g, id) {
  if (g.teams) { g.teams.bibs = (g.teams.bibs || []).filter(x => x !== id); g.teams.nonbibs = (g.teams.nonbibs || []).filter(x => x !== id); }
  if (g.result) { g.result.confirmed = (g.result.confirmed || []).filter(x => x !== id); g.result.reserves = (g.result.reserves || []).filter(x => x !== id); }
  for (const field of PLAYER_MAP_FIELDS) dropMapEntry(g, field, id);
  for (const field of PLAYER_ARRAY_FIELDS) if (Array.isArray(g[field])) g[field] = g[field].filter(x => x !== id);
  if (g.signups) g.signups = g.signups.filter(s => s.playerId !== id);
}
// Replace all references to dropId with keepId in a game (used by mergePlayers).
function repointPlayer(g, dropId, keepId) {
  const swap = arr => dedupe((arr || []).map(x => x === dropId ? keepId : x));
  if (g.teams) {
    g.teams.bibs = swap(g.teams.bibs);
    g.teams.nonbibs = swap(g.teams.nonbibs).filter(id => !g.teams.bibs.includes(id));
  }
  if (g.result) {
    g.result.confirmed = swap(g.result.confirmed);
    g.result.reserves = swap(g.result.reserves).filter(id => !g.result.confirmed.includes(id));
  }
  moveMapEntry(g, 'stats', dropId, keepId, mergeStatLines);
  for (const field of ['goals', 'ownGoals', 'withdrawnPenalties']) moveMapEntry(g, field, dropId, keepId, sumValues);
  for (const field of ['selfRatings', 'stattoRatings']) moveMapEntry(g, field, dropId, keepId);
  for (const field of PLAYER_ARRAY_FIELDS) if (Array.isArray(g[field])) g[field] = swap(g[field]);
  if (g.signups) {
    const byPlayer = new Map();
    for (const signup of g.signups) {
      const mapped = signup.playerId === dropId ? { ...signup, playerId: keepId } : signup;
      byPlayer.set(mapped.playerId, byPlayer.has(mapped.playerId) ? mergeSignupRecords(byPlayer.get(mapped.playerId), mapped) : mapped);
    }
    g.signups = [...byPlayer.values()];
  }
}

function gameRecordPatch(g) {
  return {
    teams: g.teams || null, guests: g.guests || null, result: g.result || null,
    stats: g.stats || null, goals: g.goals || null,
    selfRatings: g.selfRatings || null, stattoRatings: g.stattoRatings || null,
    ownGoals: g.ownGoals || null, motm: g.motm || [],
    withdrawnIds: g.withdrawnIds || [], withdrawnPenalties: g.withdrawnPenalties || null
  };
}

function guestPlayersForGame(game) {
  return Object.fromEntries(Object.entries(game?.guests || {})
    .map(([id, guest]) => [id, { id, name: typeof guest === 'string' ? guest : guest?.name, guest: true, loyalty: 0, gamesPlayed: 0, dropouts: 0 }])
    .filter(([, guest]) => !!guest.name));
}

// Exported only for the Node test suite. The production data layer uses the
// same helpers immediately above, so fixture coverage protects both backends.
export const __testGameRefs = { stripPlayer, repointPlayer, guestPlayersForGame };

// Shared shape emitted to subscribers. Guests are available for team sheets and
// historic match display, while the roster deliberately remains registered players only.
function assemble(config, playersById, game, signups, announcement) {
  const guests = guestPlayersForGame(game);
  const roster = Object.values(playersById)
    .sort((a, b) => b.loyalty - a.loyalty || a.name.localeCompare(b.name));
  return { config: logic.withDefaults(config), playersById: { ...playersById, ...guests }, roster, game: game || null, signups: signups || [], announcement: announcement || null };
}

// Stage a line-up announcement to the players who are on the team sheet, with
// each side's names resolved for the message. Auto-sends a set time before
// kickoff. Used by both backends. `prev` (the current announcement) lets a
// re-publish keep the organiser's recipient tweaks instead of resetting them.
function buildLineupAnnouncement(game, playersById, config, prev = null, reserves = []) {
  const guests = guestPlayersForGame(game);
  const nameOf = id => (playersById[id] && playersById[id].name) || (guests[id] && guests[id].name) || 'Player';
  const teams = game.teams || { bibs: [], nonbibs: [] };
  const bibIds = teams.bibs || [], nonbibIds = teams.nonbibs || [];
  const playingIds = [...new Set([...bibIds, ...nonbibIds])];
  // A published team sheet can differ from the game capacity when the organiser
  // adds or removes players. The price must follow the people actually playing.
  const lineupSize = playingIds.length || Number(game.capacity) || 0;
  const recipients = playingIds.map(id => playersById[id]).filter(Boolean);
  const ann = logic.buildAnnouncement('lineup', {
    game: { id: game.id, dateLabel: game.dateLabel, kickoffAt: game.kickoffAt, venue: game.venue, capacity: lineupSize },
    recipients, config,
    teams: { bibs: bibIds.map(nameOf), nonbibs: nonbibIds.map(nameOf) },
    reserves
  });
  // Re-publishing refreshes the teams but keeps who the organiser deselected.
  if (prev && prev.kind === 'lineup' && prev.gameId === game.id && Array.isArray(prev.excludedIds)) {
    ann.excludedIds = prev.excludedIds.filter(id => playingIds.includes(id));
  }
  return ann;
}

export async function createDB() {
  return FIREBASE_ENABLED ? createFirestoreDB() : createLocalDB();
}

// ===========================================================================
// localStorage backend
// ===========================================================================
function createLocalDB() {
  const KEY = 'tntf.db.v2';
  const listeners = new Set();

  function read() {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
    const fresh = { config: { ...logic.DEFAULT_CONFIG }, players: seedPlayers(), games: seedGames(), currentGameId: null };
    localStorage.setItem(KEY, JSON.stringify(fresh));
    return fresh;
  }
  let db = read();
  const persist = () => { localStorage.setItem(KEY, JSON.stringify(db)); emit(); };
  function currentGame() { return db.games.find(g => g.id === db.currentGameId) || null; }
  function emit() {
    const g = currentGame();
    const payload = assemble(db.config, db.players, g, g ? g.signups : [], db.announcement);
    listeners.forEach(l => l(payload));
  }
  // cross-tab sync
  window.addEventListener('storage', e => { if (e.key === KEY) { db = read(); emit(); } });

  return {
    mode: 'local',
    subscribe(cb) { listeners.add(cb); emit(); return () => listeners.delete(cb); },

    async upsertPlayer(name) {
      const clean = String(name || '').trim();
      if (!clean) throw new Error('Name required');
      const existing = Object.values(db.players).find(p => p.name.toLowerCase() === clean.toLowerCase());
      if (existing) return existing.id;
      const id = uuid();
      db.players[id] = { id, name: clean, loyalty: 0, gamesPlayed: 0, dropouts: 0, createdAt: new Date().toISOString() };
      persist(); return id;
    },
    // Find-or-create the roster record for a signed-in account. Matches an
    // existing player by uid, then by email; otherwise creates a fresh record
    // flagged account:true so the organiser can merge it into a historic one.
    async upsertAccount({ uid, email, name, photoURL }) {
      const byUid = uid && Object.values(db.players).find(p => p.uid === uid);
      if (byUid) return byUid.id;
      const byEmail = email && Object.values(db.players).find(p => p.email && p.email.toLowerCase() === email.toLowerCase());
      if (byEmail) {
        if (uid) byEmail.uid = uid;
        if (photoURL && !byEmail.photoURL) byEmail.photoURL = photoURL;
        persist(); return byEmail.id;
      }
      const id = uid ? 'u_' + String(uid).replace(/[^A-Za-z0-9_-]/g, '') : uuid();
      db.players[id] = {
        ...(db.players[id] || {}),
        id, name: String(name || 'Player').trim(), email: email || null, uid: uid || null,
        photoURL: photoURL || null, account: db.players[id]?.account ?? true,
        loyalty: db.players[id]?.loyalty || 0, gamesPlayed: db.players[id]?.gamesPlayed || 0,
        dropouts: db.players[id]?.dropouts || 0, createdAt: db.players[id]?.createdAt || new Date().toISOString()
      };
      persist(); return id;
    },
    async clearAccount(id) { const p = db.players[id]; if (p) { p.account = false; persist(); } },
    async commitRecalc({ players = [], games = [] }) {
      for (const p of players) { const rec = db.players[p.id]; if (rec) { rec.loyalty = p.loyalty; rec.gamesPlayed = p.gamesPlayed; } }
      for (const gw of games) {
        const g = db.games.find(x => x.id === gw.id); if (!g) continue;
        if (gw.weather) g.weather = gw.weather;
        if (gw.weatherBonus != null) { g.weatherBonus = gw.weatherBonus; g.bonusReasons = gw.bonusReasons || []; }
      }
      persist();
    },
    async renamePlayer(id, name) { db.players[id].name = String(name).trim(); persist(); },
    async updatePlayerProfile(id, { name, photoData, photoHidden } = {}) {
      const p = db.players[id]; if (!p) throw new Error('Unknown player');
      if (name != null) p.name = String(name).trim();
      if (photoData === null) delete p.photoData;
      else if (photoData) p.photoData = String(photoData);
      if (photoHidden != null) p.photoHidden = !!photoHidden;
      persist();
    },
    async adjustLoyalty(id, delta) { db.players[id].loyalty += Number(delta) || 0; persist(); },
    async deletePlayer(id) {
      delete db.players[id];
      for (const g of db.games) stripPlayer(g, id);
      persist();
    },
    async setPlayerAttrs(id, attrs) {
      const p = db.players[id]; if (!p) throw new Error('Unknown player');
      p.attrs = { ...(p.attrs || {}), ...attrs }; persist();
    },
    // Standing 7-vs-8-a-side preference (7, 8, or null for no preference).
    async setFormatPref(id, pref) {
      const p = db.players[id]; if (!p) throw new Error('Unknown player');
      const v = Number(pref);
      if (v === 7 || v === 8) p.formatPref = v; else delete p.formatPref;
      persist();
    },
    async saveLineup(gameId, teams, finalised, guests = {}) {
      const g = db.games.find(x => x.id === gameId); if (!g) throw new Error('No game');
      g.teams = { bibs: teams.bibs || [], nonbibs: teams.nonbibs || [] };
      const teamIds = new Set([...(g.teams.bibs || []), ...(g.teams.nonbibs || [])]);
      g.guests = Object.fromEntries(Object.entries(guests || {}).filter(([id, name]) => teamIds.has(id) && String(name || '').trim()).map(([id, name]) => [id, String(name).trim()]));
      g.teamsFinalised = !!finalised;
      // Publishing (re)stages the line-up announcement to auto-send before kickoff.
      if (finalised) {
        const reserves = logic.lineupReserves(g.signups, db.players, g.teams, g.capacity, { pollOpenAt: g.createdAt, config: db.config });
        db.announcement = buildLineupAnnouncement(g, db.players, db.config, db.announcement, reserves);
      }
      persist();
    },
    async mergePlayers(keepId, dropId) {
      if (keepId === dropId) return;
      const keep = db.players[keepId], drop = db.players[dropId];
      if (!keep || !drop) throw new Error('Unknown player');
      keep.loyalty += drop.loyalty; keep.gamesPlayed += drop.gamesPlayed; keep.dropouts += drop.dropouts;
      if (!keep.email && drop.email) keep.email = drop.email;
      if (!keep.uid && drop.uid) keep.uid = drop.uid;
      if (drop.pushTokens) keep.pushTokens = { ...(drop.pushTokens || {}), ...(keep.pushTokens || {}) };
      for (const g of db.games) repointPlayer(g, dropId, keepId);
      delete db.players[dropId];
      persist();
    },

    async openGame({ dateLabel, kickoffAt, capacity, venue }) {
      const game = {
        id: uuid(), status: 'open',
        dateLabel: dateLabel || logic.nextGameLabel(db.config),
        kickoffAt: kickoffAt || logic.nextKickoffISO(db.config),
        capacity: Number(capacity) || db.config.capacity,
        venue: venue || db.config.venue || '',
        signups: [], createdAt: new Date().toISOString()
      };
      db.games.push(game); db.currentGameId = game.id;
      // Stage the "poll's open" announcement for organiser review (see notifier).
      db.announcement = logic.buildAnnouncement('poll-open', { game, recipients: Object.values(db.players), config: db.config });
      persist(); return game.id;
    },
    // Client-side safety net for the weekly auto-open: if the poll is due
    // (past the open time, last game settled, not already opened) open it now.
    // Mirrors the notifier's logic so the two can't both open the same week
    // (the "no open game" guard + the stored marker dedupe them).
    async autoOpenPoll() {
      const marker = db.config.autoOpenedKickoff || null;
      const plan = logic.autoOpenPlan(db.config, currentGame(), new Date(), marker);
      if (!plan) return null;
      const game = {
        id: uuid(), status: 'open', dateLabel: plan.dateLabel, kickoffAt: plan.kickoffAt,
        capacity: Number(db.config.capacity) || 14, venue: db.config.venue || '',
        signups: [], createdAt: new Date().toISOString(), autoOpened: true
      };
      db.games.push(game); db.currentGameId = game.id; db.config.autoOpenedKickoff = plan.kickoffAt;
      db.announcement = logic.buildAnnouncement('poll-open', { game, recipients: Object.values(db.players), config: db.config, sendNow: true });
      persist();
      return { id: game.id, kickoffAt: plan.kickoffAt, dateLabel: plan.dateLabel };
    },
    async updateAnnouncement(patch) {
      if (!db.announcement) return;
      db.announcement = { ...db.announcement, ...patch }; persist();
    },
    async announceLineup(id) {
      const g = db.games.find(x => x.id === id); if (!g) throw new Error('No game');
      db.announcement = buildLineupAnnouncement(g, db.players, db.config, db.announcement);
      persist();
    },
    async signup(playerId, gameId) {
      const g = db.games.find(x => x.id === gameId);
      if (!g) throw new Error('No game'); if (g.status !== 'open') throw new Error('Registration is closed');
      const s = g.signups.find(x => x.playerId === playerId);
      if (s) { if (s.status !== 'in') { s.status = 'in'; s.joinedAt = new Date().toISOString(); } }
      else g.signups.push({ playerId, status: 'in', joinedAt: new Date().toISOString() });
      persist();
    },
    // Mark a player as unavailable this week (no penalty — they never signed up),
    // or clear it back to "no response" when out=false.
    async setUnavailable(playerId, gameId, out = true) {
      const g = db.games.find(x => x.id === gameId); if (!g) throw new Error('No game');
      const s = g.signups.find(x => x.playerId === playerId);
      if (out) {
        if (s) { s.status = 'out'; s.outAt = new Date().toISOString(); }
        else g.signups.push({ playerId, status: 'out', outAt: new Date().toISOString() });
      } else {
        g.signups = g.signups.filter(x => x.playerId !== playerId);
      }
      persist();
    },
    async withdraw(playerId, gameId) {
      const g = db.games.find(x => x.id === gameId); if (!g) throw new Error('No game');
      const s = g.signups.find(x => x.playerId === playerId && x.status !== 'withdrawn');
      if (!s) throw new Error('You are not signed up');
      const tier = logic.penaltyForHours(logic.hoursUntilKickoff(g.kickoffAt), db.config);
      s.status = 'withdrawn'; s.withdrawnAt = new Date().toISOString(); s.penaltyApplied = tier.penalty;
      if (tier.penalty > 0) { db.players[playerId].loyalty -= tier.penalty; db.players[playerId].dropouts += 1; }
      persist(); return { penalty: tier.penalty, label: tier.label };
    },
    // Undo a withdrawal penalty (organiser): refund the loyalty that was docked,
    // clear the dropout, and treat it as a no-penalty "out" so it no longer
    // counts against them. They still didn't play that game.
    async reverseWithdrawal(playerId, gameId) {
      const g = db.games.find(x => x.id === gameId); if (!g) throw new Error('No game');
      const s = (g.signups || []).find(x => x.playerId === playerId && x.status === 'withdrawn');
      if (!s) throw new Error('No withdrawal to reverse');
      const refund = Number(s.penaltyApplied) || 0;
      const p = db.players[playerId];
      if (p) { p.loyalty += refund; if (refund > 0) p.dropouts = Math.max(0, (p.dropouts || 0) - 1); }
      s.status = 'out'; s.outAt = new Date().toISOString();
      delete s.withdrawnAt; s.penaltyApplied = 0; s.penaltyWaived = true;
      if (Array.isArray(g.withdrawnIds)) g.withdrawnIds = g.withdrawnIds.filter(id => id !== playerId);
      if (g.withdrawnPenalties) delete g.withdrawnPenalties[playerId];
      persist(); return { refunded: refund };
    },
    async setPaid(playerId, gameId, paid) {
      const g = db.games.find(x => x.id === gameId); if (!g) throw new Error('No game');
      let s = g.signups.find(x => x.playerId === playerId && x.status !== 'withdrawn');
      // A player the organiser added straight into the team sheet may have no
      // sign-up yet — create one so their payment can be recorded.
      if (!s) {
        if (!paid) return; // nothing to clear
        s = { playerId, status: 'in', joinedAt: new Date().toISOString() };
        g.signups.push(s);
      }
      s.paid = !!paid; s.paidAt = paid ? new Date().toISOString() : null;
      persist();
    },
    // Proof of payment (a screenshot/photo). Stored beside the game, ticks the
    // player off as paid in the same step. See logic.buildProofRecord.
    async uploadPaymentProof(playerId, gameId, proof) {
      const g = db.games.find(x => x.id === gameId); if (!g) throw new Error('No game');
      const record = logic.buildProofRecord(proof);
      let s = g.signups.find(x => x.playerId === playerId && x.status !== 'withdrawn');
      if (!s) { s = { playerId, status: 'in', joinedAt: new Date().toISOString() }; g.signups.push(s); }
      Object.assign(s, logic.proofSignupPatch(new Date(record.uploadedAt)));
      ((db.proofs ||= {})[gameId] ||= {})[playerId] = record;
      persist();
    },
    async getPaymentProof(playerId, gameId) {
      return (db.proofs && db.proofs[gameId] && db.proofs[gameId][playerId]) || null;
    },
    // Taking a proof down (the wrong picture, say) also un-ticks the payment it
    // was vouching for.
    async removePaymentProof(playerId, gameId) {
      const g = db.games.find(x => x.id === gameId); if (!g) throw new Error('No game');
      if (db.proofs && db.proofs[gameId]) delete db.proofs[gameId][playerId];
      const s = g.signups.find(x => x.playerId === playerId && x.status !== 'withdrawn');
      if (s) { s.paid = false; s.paidAt = null; s.proofAt = null; }
      persist();
    },
    async lockGame(id) { db.games.find(g => g.id === id).status = 'locked'; persist(); },
    async reopenGame(id) { db.games.find(g => g.id === id).status = 'open'; persist(); },
    async setCapacity(id, capacity) { const g = db.games.find(x => x.id === id); if (g) { g.capacity = Math.max(2, Number(capacity) || 0); g.capacityLocked = true; persist(); } },
    async setCapacityAuto(id) { const g = db.games.find(x => x.id === id); if (g) { g.capacityLocked = false; persist(); } },
    async rescheduleGame(id, { kickoffAt, dateLabel, venue }) {
      const g = db.games.find(x => x.id === id); if (!g) throw new Error('No game');
      if (kickoffAt) g.kickoffAt = kickoffAt;
      if (dateLabel != null && dateLabel !== '') g.dateLabel = dateLabel;
      if (venue != null) g.venue = venue;
      // Stage a "game moved" announcement for review before it reaches the group.
      db.announcement = logic.buildAnnouncement('reschedule', { game: g, recipients: Object.values(db.players), config: db.config });
      persist();
    },
    async cancelGame(id) {
      const g = db.games.find(x => x.id === id); if (!g) throw new Error('No game');
      // Keep it as currentGameId (marked cancelled) so the notifier can announce
      // it; buildView treats a cancelled game as "no game". Opening a fresh game
      // moves currentGameId on.
      g.status = 'cancelled'; g.cancelledAt = new Date().toISOString();
      // Stage a "no game this week" announcement for review before it goes out.
      db.announcement = logic.buildAnnouncement('cancellation', { game: g, recipients: Object.values(db.players), config: db.config });
      persist();
    },
    async completeGame(id, opts = {}) {
      const g = db.games.find(x => x.id === id); if (!g) throw new Error('No game');
      // Freeze the squad size that's in force (the live recommendation while auto).
      const capacity = logic.effectiveCapacity(g, g.signups, db.players, db.config);
      const ranked = logic.rankSignups(g.signups, db.players, capacity, { pollOpenAt: g.createdAt, config: db.config });
      const sc = logic.withDefaults(db.config).scoring;
      const flat = sc.playedReward + (Number(opts.bonus) || 0);
      // Late-cover: an explicit list from the organiser (each gets the full late
      // award), else the auto gap-aware detection.
      let awards;
      if (Array.isArray(opts.lateBonusIds)) {
        const each = (sc.playedReward || 0) * (sc.lateSignupBonusGames || 0);
        awards = {}; for (const pid of opts.lateBonusIds) awards[pid] = each;
      } else {
        awards = logic.lateSignupAwards(g.signups, db.players, db.config, g.kickoffAt, capacity, g.createdAt);
      }
      // Who actually played: the finalised team sheet if the organiser built it
      // (they may have pulled people in or taken them out), else the ranked squad.
      const teamSheet = g.teamsFinalised && g.teams && ((g.teams.bibs || []).length || (g.teams.nonbibs || []).length)
        ? logic.gamePlayers(g) : null;
      const playedIds = teamSheet || ranked.filter(r => r.status === 'confirmed').map(r => r.playerId);
      const playedSet = new Set(playedIds);
      // Prompt reserves (signed up quickly but didn't play) bank the reward + bonus.
      const promptAwards = logic.promptSignupAwards(g.signups, db.players, db.config, g.createdAt, capacity, teamSheet ? playedIds : null);
      for (const pid of playedIds) if (db.players[pid]) {
        db.players[pid].loyalty += flat + (awards[pid] || 0); db.players[pid].gamesPlayed += 1;
      }
      for (const [pid, amt] of Object.entries(promptAwards)) if (db.players[pid]) db.players[pid].loyalty += amt;
      g.status = 'completed'; g.completedAt = new Date().toISOString();
      g.capacity = capacity; g.capacityLocked = true; // freeze the size onto the record
      g.result = teamSheet
        ? { confirmed: [...playedIds], reserves: ranked.filter(r => !playedSet.has(r.playerId)).map(r => r.playerId) }
        : logic.finalResult(ranked);
      // Denormalize who withdrew so history loads don't need the signups.
      g.withdrawnIds = (g.signups || []).filter(s => s.status === 'withdrawn').map(s => s.playerId);
      g.withdrawnPenalties = Object.fromEntries((g.signups || []).filter(s => s.status === 'withdrawn').map(s => [s.playerId, Number(s.penaltyApplied) || 0]));
      if (opts.scores) g.scores = opts.scores;
      if (opts.weather) g.weather = opts.weather;
      if (Number(opts.bonus) > 0) { g.weatherBonus = Number(opts.bonus); g.bonusReasons = opts.reasons || []; }
      if (opts.highlights !== undefined) g.highlights = opts.highlights;
      if (opts.ownGoals !== undefined) g.ownGoals = opts.ownGoals;
      if (db.currentGameId === id) db.currentGameId = null; persist();
    },
    // Change a past game's conditions (weather / cold-season) bonus. Adjusts
    // everyone who played by the difference and re-stamps the game record.
    async setConditionsBonus(gameId, weatherOn, coldOn) {
      const g = db.games.find(x => x.id === gameId); if (!g) throw new Error('No game');
      const { bonus, reasons } = logic.completionBonus(db.config, { adverseWeather: !!weatherOn, coldSeason: !!coldOn });
      const delta = bonus - (Number(g.weatherBonus) || 0);
      const ids = logic.gamePlayers(g);
      if (delta !== 0) for (const pid of ids) if (db.players[pid]) db.players[pid].loyalty += delta;
      g.weatherBonus = bonus; g.bonusReasons = reasons;
      persist();
      return { bonus, delta, players: ids.length };
    },
    async setPlayerEmail(id, email, uid) { const p = db.players[id]; if (!p) throw new Error('Unknown player'); p.email = email || null; if (uid) p.uid = uid; persist(); },
    async savePushToken(id, token) { const p = db.players[id]; if (!p) return; p.pushTokens = { ...(p.pushTokens || {}), [token]: new Date().toISOString() }; persist(); },
    async loadHistory() { return db.games.filter(g => g.status === 'completed'); },
    async updateConfig(patch) {
      db.config = { ...db.config, ...patch };
      if (patch.scoring) db.config.scoring = { ...db.config.scoring, ...patch.scoring };
      persist();
    },
    async checkPin(pin) { return String(pin) === String(logic.withDefaults(db.config).adminPin); },
    async checkStattoPin(pin) { const c = logic.withDefaults(db.config); return String(pin) === String(c.stattoPin) || String(pin) === String(c.adminPin); },
    async saveGameStats(gameId, edit) {
      const g = db.games.find(x => x.id === gameId); if (!g) throw new Error('No game');
      Object.assign(g, logic.statsEditPatch(g, edit));
      persist();
    },
    // A player logging their own goals & assists for a game they played. The
    // score follows unless the organiser has set it. Returns what was written.
    async saveSelfStats(gameId, playerId, { g: goals, a: assists }) {
      const g = db.games.find(x => x.id === gameId); if (!g) throw new Error('No game');
      if (!logic.selfStatGames([g], playerId).length) throw new Error('You can only log games you played in');
      const entry = { g: logic.cleanSelfStat(goals), a: logic.cleanSelfStat(assists), at: new Date().toISOString() };
      g.selfStats = { ...(g.selfStats || {}), [playerId]: entry };
      const auto = logic.autoScorePatch(g) || {};
      Object.assign(g, auto);
      persist();
      return { selfStats: g.selfStats, ...auto };
    },
    async useAutoScore(gameId) {
      const g = db.games.find(x => x.id === gameId); if (!g) throw new Error('No game');
      Object.assign(g, logic.useAutoScorePatch(g)); persist();
    },
    async saveHighlights(gameId, highlights) {
      const g = db.games.find(x => x.id === gameId); if (!g) throw new Error('No game');
      g.highlights = highlights; persist();
    },
    // A player rating their own performance in a past game (0 clears it).
    async setSelfRating(gameId, playerId, rating) {
      const g = db.games.find(x => x.id === gameId); if (!g) throw new Error('No game');
      g.selfRatings = { ...(g.selfRatings || {}) };
      if (rating > 0) g.selfRatings[playerId] = Number(rating);
      else delete g.selfRatings[playerId];
      persist();
    },
    async importPerf() {
      let n = 0;
      for (const g of db.games) {
        const perf = PERF[g.id]; if (!perf) continue;
        g.stats = perf; g.goals = goalsFromStats(perf); n++;
      }
      persist(); return n;
    },
    // Apply a resolved spreadsheet import (see import.js). Merges per game:
    // stats shallow-merge per player (goals recomputed), ratings + own goals
    // merged, MOTM unioned. Returns { games } actually touched.
    async applyImport(byGame) {
      let games = 0;
      for (const [gid, gm] of Object.entries(byGame || {})) {
        const g = db.games.find(x => x.id === gid); if (!g) continue;
        const stats = { ...(g.stats || {}) };
        for (const [pid, vals] of Object.entries(gm.stats || {})) stats[pid] = { ...(stats[pid] || {}), ...vals };
        g.stats = stats;
        g.goals = goalsFromStats(stats);
        if (Object.keys(gm.stattoRatings || {}).length) g.stattoRatings = { ...(g.stattoRatings || {}), ...gm.stattoRatings };
        if (Object.keys(gm.ownGoals || {}).length) g.ownGoals = { ...(g.ownGoals || {}), ...gm.ownGoals };
        if ((gm.motm || []).length) g.motm = [...new Set([...(g.motm || []), ...gm.motm])];
        games++;
      }
      persist(); return { games };
    },
    // Apply imported player attribute ratings (Fitness/Skill/Strength/Speed),
    // merged onto each player's existing attrs. Returns { players } touched.
    async applyRatings(byPlayer) {
      let players = 0;
      for (const [pid, attrs] of Object.entries(byPlayer || {})) {
        const p = db.players[pid]; if (!p) continue;
        p.attrs = { ...(p.attrs || {}), ...attrs }; players++;
      }
      persist(); return { players };
    }
  };
}

// ===========================================================================
// Firestore backend
// ===========================================================================
async function createFirestoreDB() {
  const fs = await import(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-firestore.js`);
  const {
    getFirestore, doc, getDoc, setDoc, updateDoc, deleteField, deleteDoc,
    collection, getDocs, onSnapshot, writeBatch, increment, arrayRemove, runTransaction
  } = fs;

  const app = await getFirebaseApp();
  const dbf = getFirestore(app);
  const cfgRef = doc(dbf, 'meta', 'config');
  const announceRef = doc(dbf, 'meta', 'announcement');
  const playersCol = collection(dbf, 'players');
  const gameRef = id => doc(dbf, 'games', id);
  const signupsCol = id => collection(dbf, 'games', id, 'signups');
  const proofRef = (gameId, playerId) => doc(dbf, 'games', gameId, 'proofs', playerId);

  // First-run seed: create config + roster if they don't exist yet.
  const cfgSnap = await getDoc(cfgRef);
  if (!cfgSnap.exists()) {
    await setDoc(cfgRef, { ...logic.DEFAULT_CONFIG, currentGameId: null });
    const existing = await getDocs(playersCol);
    if (existing.empty) {
      const batch = writeBatch(dbf);
      for (const p of Object.values(seedPlayers())) batch.set(doc(playersCol, p.id), p);
      // Historic games (completed, with teams + scores) for analytics/history.
      for (const g of seedGames()) { const { signups, ...doc0 } = g; batch.set(gameRef(g.id), doc0); }
      await batch.commit();
    }
  }

  // Live cache assembled from snapshots (config, players, current game+signups,
  // the pending announcement).
  const cache = { config: {}, players: {}, game: null, signups: [], announcement: null };
  const listeners = new Set();
  const emit = () => { const p = assemble(cache.config, cache.players, cache.game, cache.signups, cache.announcement); listeners.forEach(l => l(p)); };

  let unsubGame = null, unsubSignups = null;
  function watchGame(id) {
    if (unsubGame) unsubGame(); if (unsubSignups) unsubSignups();
    unsubGame = unsubSignups = null; cache.game = null; cache.signups = [];
    if (!id) { emit(); return; }
    unsubGame = onSnapshot(gameRef(id), s => { cache.game = s.exists() ? { id: s.id, ...s.data() } : null; emit(); });
    unsubSignups = onSnapshot(signupsCol(id), qs => {
      cache.signups = qs.docs.map(d => ({ playerId: d.id, ...d.data() })); emit();
    });
  }

  // Gate startup on the first config + players snapshots so the cache is
  // authoritative before anyone (e.g. account sign-in) reads or writes it —
  // otherwise account look-ups race an empty cache and create duplicates.
  let seenConfig, seenPlayers;
  const firstConfig = new Promise(r => { seenConfig = r; });
  const firstPlayers = new Promise(r => { seenPlayers = r; });

  onSnapshot(cfgRef, s => {
    const data = s.data() || {}; cache.config = data;
    watchGame(data.currentGameId || null);
    seenConfig();
  });
  onSnapshot(playersCol, qs => {
    const m = {}; qs.docs.forEach(d => { m[d.id] = { id: d.id, ...d.data() }; }); cache.players = m; emit();
    seenPlayers();
  });
  onSnapshot(announceRef, s => { cache.announcement = s.exists() ? s.data() : null; emit(); });
  // Normally both fire in well under a second; the timeout just prevents a
  // blank app if a snapshot is unusually slow (e.g. a cold offline start).
  const timeout = new Promise(r => setTimeout(r, 12000));
  await Promise.race([Promise.all([firstConfig, firstPlayers]), timeout]);

  const cfg = () => logic.withDefaults(cache.config);

  return {
    mode: 'cloud',
    subscribe(cb) { listeners.add(cb); if (Object.keys(cache.config).length) emit(); return () => listeners.delete(cb); },

    async upsertPlayer(name) {
      const clean = String(name || '').trim(); if (!clean) throw new Error('Name required');
      const existing = Object.values(cache.players).find(p => p.name.toLowerCase() === clean.toLowerCase());
      if (existing) return existing.id;
      const id = uuid();
      await setDoc(doc(playersCol, id), { id, name: clean, loyalty: 0, gamesPlayed: 0, dropouts: 0, createdAt: new Date().toISOString() });
      return id;
    },
    async upsertAccount({ uid, email, name, photoURL }) {
      // Match an existing record first (the cache is loaded before we get here).
      const byUid = uid && Object.values(cache.players).find(p => p.uid === uid);
      if (byUid) return byUid.id;
      const byEmail = email && Object.values(cache.players).find(p => p.email && p.email.toLowerCase() === email.toLowerCase());
      if (byEmail) {
        const patch = {}; if (uid) patch.uid = uid; if (photoURL && !byEmail.photoURL) patch.photoURL = photoURL;
        if (Object.keys(patch).length) await updateDoc(doc(playersCol, byEmail.id), patch);
        return byEmail.id;
      }
      // Brand-new account. Key the doc on the uid so repeated/concurrent
      // sign-ins can never create duplicates (idempotent create).
      const id = uid ? 'u_' + String(uid).replace(/[^A-Za-z0-9_-]/g, '') : uuid();
      await setDoc(doc(playersCol, id), {
        id, name: String(name || 'Player').trim(), email: email || null, uid: uid || null,
        photoURL: photoURL || null, account: true,
        loyalty: 0, gamesPlayed: 0, dropouts: 0, createdAt: new Date().toISOString()
      }, { merge: true });
      return id;
    },
    async clearAccount(id) { await updateDoc(doc(playersCol, id), { account: false }); },
    async commitRecalc({ players = [], games = [] }) {
      const batch = writeBatch(dbf);
      for (const p of players) batch.update(doc(playersCol, p.id), { loyalty: p.loyalty, gamesPlayed: p.gamesPlayed });
      for (const gw of games) {
        const patch = {};
        if (gw.weather) patch.weather = gw.weather;
        if (gw.weatherBonus != null) { patch.weatherBonus = gw.weatherBonus; patch.bonusReasons = gw.bonusReasons || []; }
        if (Object.keys(patch).length) batch.update(gameRef(gw.id), patch);
      }
      await batch.commit();
    },
    async renamePlayer(id, name) { await updateDoc(doc(playersCol, id), { name: String(name).trim() }); },
    async updatePlayerProfile(id, { name, photoData, photoHidden } = {}) {
      const patch = {};
      if (name != null) patch.name = String(name).trim();
      if (photoData === null) patch.photoData = null;
      else if (photoData) patch.photoData = String(photoData);
      if (photoHidden != null) patch.photoHidden = !!photoHidden;
      if (Object.keys(patch).length) await updateDoc(doc(playersCol, id), patch);
    },
    async adjustLoyalty(id, delta) { await updateDoc(doc(playersCol, id), { loyalty: increment(Number(delta) || 0) }); },
    async deletePlayer(id) {
      const gs = await getDocs(collection(dbf, 'games'));
      const batch = writeBatch(dbf);
      for (const d of gs.docs) {
        const g = { id: d.id, ...d.data() }; stripPlayer(g, id);
        batch.update(gameRef(d.id), gameRecordPatch(g));
        // Sign-ups live in a subcollection, so remove this player from every
        // fixture rather than only the currently cached game.
        const signup = await getDoc(doc(signupsCol(d.id), id));
        if (signup.exists()) batch.delete(doc(signupsCol(d.id), id));
      }
      batch.delete(doc(playersCol, id));
      await batch.commit();
    },
    async setPlayerAttrs(id, attrs) { await setDoc(doc(playersCol, id), { attrs }, { merge: true }); },
    // Standing 7-vs-8-a-side preference (7, 8, or null for no preference).
    async setFormatPref(id, pref) {
      const v = Number(pref);
      await setDoc(doc(playersCol, id), { formatPref: (v === 7 || v === 8) ? v : null }, { merge: true });
    },
    async saveLineup(gameId, teams, finalised, guests = {}) {
      const t = { bibs: teams.bibs || [], nonbibs: teams.nonbibs || [] };
      const teamIds = new Set([...(t.bibs || []), ...(t.nonbibs || [])]);
      const savedGuests = Object.fromEntries(Object.entries(guests || {}).filter(([id, name]) => teamIds.has(id) && String(name || '').trim()).map(([id, name]) => [id, String(name).trim()]));
      await updateDoc(gameRef(gameId), { teams: t, guests: savedGuests, teamsFinalised: !!finalised });
      // Publishing (re)stages the line-up announcement to auto-send before kickoff.
      if (finalised) {
        const g = { ...(cache.game || {}), id: gameId, teams: t, guests: savedGuests };
        const reserves = logic.lineupReserves(cache.signups, cache.players, t, g.capacity, { pollOpenAt: g.createdAt, config: cfg() });
        await setDoc(announceRef, buildLineupAnnouncement(g, cache.players, cfg(), cache.announcement, reserves));
      }
    },
    async mergePlayers(keepId, dropId) {
      if (keepId === dropId) return;
      const keep = cache.players[keepId], drop = cache.players[dropId];
      if (!keep || !drop) throw new Error('Unknown player');
      const gs = await getDocs(collection(dbf, 'games'));
      const batch = writeBatch(dbf);
      for (const d of gs.docs) {
        const g = { id: d.id, ...d.data() }; repointPlayer(g, dropId, keepId);
        batch.update(gameRef(d.id), gameRecordPatch(g));
        // Migrate sign-ups in every fixture, including historic games that are
        // outside the current-game cache. When both records responded, retain
        // the earliest response and any payment marker.
        const [dropSignup, keepSignup] = await Promise.all([
          getDoc(doc(signupsCol(d.id), dropId)),
          getDoc(doc(signupsCol(d.id), keepId))
        ]);
        if (dropSignup.exists()) {
          const merged = mergeSignupRecords(
            keepSignup.exists() ? { playerId: keepId, ...keepSignup.data() } : {},
            { playerId: dropId, ...dropSignup.data() }
          );
          const { playerId, ...data } = merged;
          batch.set(doc(signupsCol(d.id), keepId), data);
          batch.delete(doc(signupsCol(d.id), dropId));
        }
      }
      const patch = {
        loyalty: increment(drop.loyalty || 0), gamesPlayed: increment(drop.gamesPlayed || 0), dropouts: increment(drop.dropouts || 0)
      };
      if (!keep.email && drop.email) patch.email = drop.email;
      if (!keep.uid && drop.uid) patch.uid = drop.uid;
      if (drop.pushTokens) patch.pushTokens = { ...(drop.pushTokens || {}), ...(keep.pushTokens || {}) };
      batch.update(doc(playersCol, keepId), patch);
      batch.delete(doc(playersCol, dropId));
      await batch.commit();
    },

    async openGame({ dateLabel, kickoffAt, capacity, venue }) {
      const id = uuid();
      const game = {
        id, status: 'open',
        dateLabel: dateLabel || logic.nextGameLabel(cfg()),
        kickoffAt: kickoffAt || logic.nextKickoffISO(cfg()),
        capacity: Number(capacity) || cfg().capacity,
        venue: venue || cfg().venue || '',
        createdAt: new Date().toISOString()
      };
      const { id: _omit, ...doc0 } = game;
      await setDoc(gameRef(id), doc0);
      await updateDoc(cfgRef, { currentGameId: id });
      // Stage the "poll's open" announcement for organiser review; the notifier
      // sends it once the grace window elapses (or when the organiser sends it).
      await setDoc(announceRef, logic.buildAnnouncement('poll-open', { game, recipients: Object.values(cache.players), config: cfg() }));
      return id;
    },
    // Client-side safety net for the weekly auto-open. Runs in a transaction on
    // the current-game pointer so two visitors landing at once can't both open —
    // whoever's transaction commits first wins; the other re-reads the now-open
    // game and backs out. The stored marker (meta/config.autoOpenedKickoff) and
    // the "no open game" guard also keep it from racing the server notifier.
    async autoOpenPoll() {
      const res = await runTransaction(dbf, async (tx) => {
        const cs = await tx.get(cfgRef);
        const cdata = cs.exists() ? cs.data() : {};
        let curGame = null;
        if (cdata.currentGameId) {
          const gs = await tx.get(gameRef(cdata.currentGameId));
          if (gs.exists()) curGame = { id: cdata.currentGameId, ...gs.data() };
        }
        const plan = logic.autoOpenPlan(logic.withDefaults(cdata), curGame, new Date(), cdata.autoOpenedKickoff || null);
        if (!plan) return null;
        const newRef = doc(collection(dbf, 'games'));
        tx.set(newRef, {
          status: 'open', dateLabel: plan.dateLabel, kickoffAt: plan.kickoffAt,
          capacity: Number(cdata.capacity) || 14, venue: cdata.venue || '',
          autoOpened: true, createdAt: new Date().toISOString()
        });
        tx.set(cfgRef, { currentGameId: newRef.id, autoOpenedKickoff: plan.kickoffAt }, { merge: true });
        return { id: newRef.id, kickoffAt: plan.kickoffAt, dateLabel: plan.dateLabel };
      });
      if (res) {
        const game = { id: res.id, dateLabel: res.dateLabel, kickoffAt: res.kickoffAt, capacity: Number(cfg().capacity) || 14, venue: cfg().venue || '' };
        // Opened on schedule, so the "poll's open" message isn't held for review.
        try { await setDoc(announceRef, logic.buildAnnouncement('poll-open', { game, recipients: Object.values(cache.players), config: cfg(), sendNow: true })); } catch (e) { /* announcement is best-effort */ }
      }
      return res;
    },
    async updateAnnouncement(patch) { await setDoc(announceRef, patch, { merge: true }); },
    async signup(playerId, gameId) {
      const g = cache.game;
      if (!g || g.id !== gameId) throw new Error('No game');
      if (g.status !== 'open') throw new Error('Registration is closed');
      await setDoc(doc(signupsCol(gameId), playerId), { status: 'in', joinedAt: new Date().toISOString() }, { merge: true });
    },
    // Mark unavailable this week (no penalty), or clear it back to no-response.
    async setUnavailable(playerId, gameId, out = true) {
      const ref = doc(signupsCol(gameId), playerId);
      if (out) await setDoc(ref, { status: 'out', outAt: new Date().toISOString() }, { merge: true });
      else await deleteDoc(ref);
    },
    async withdraw(playerId, gameId) {
      const g = cache.game; if (!g) throw new Error('No game');
      const s = cache.signups.find(x => x.playerId === playerId && x.status !== 'withdrawn');
      if (!s) throw new Error('You are not signed up');
      const tier = logic.penaltyForHours(logic.hoursUntilKickoff(g.kickoffAt), cfg());
      const batch = writeBatch(dbf);
      batch.update(doc(signupsCol(gameId), playerId), { status: 'withdrawn', withdrawnAt: new Date().toISOString(), penaltyApplied: tier.penalty });
      if (tier.penalty > 0) batch.update(doc(playersCol, playerId), { loyalty: increment(-tier.penalty), dropouts: increment(1) });
      await batch.commit();
      return { penalty: tier.penalty, label: tier.label };
    },
    // Undo a withdrawal penalty (organiser): refund the docked loyalty, clear
    // the dropout, and turn it into a no-penalty "out". Reads the signup doc so
    // it works on any past game without loading the whole signups subcollection.
    async reverseWithdrawal(playerId, gameId) {
      const ref = doc(signupsCol(gameId), playerId);
      const snap = await getDoc(ref);
      if (!snap.exists() || snap.data().status !== 'withdrawn') throw new Error('No withdrawal to reverse');
      const refund = Number(snap.data().penaltyApplied) || 0;
      const batch = writeBatch(dbf);
      batch.update(ref, { status: 'out', outAt: new Date().toISOString(), withdrawnAt: deleteField(), penaltyApplied: 0, penaltyWaived: true });
      const pPatch = { loyalty: increment(refund) };
      if (refund > 0) pPatch.dropouts = increment(-1);
      batch.update(doc(playersCol, playerId), pPatch);
      batch.update(gameRef(gameId), { withdrawnIds: arrayRemove(playerId), [`withdrawnPenalties.${playerId}`]: deleteField() });
      await batch.commit();
      return { refunded: refund };
    },
    async setPaid(playerId, gameId, paid) {
      const ref = doc(signupsCol(gameId), playerId);
      const patch = { paid: !!paid, paidAt: paid ? new Date().toISOString() : null };
      // A player added straight into the team sheet may have no sign-up yet —
      // seed status/joinedAt on create so the record is well-formed.
      const snap = await getDoc(ref);
      if (!snap.exists()) { patch.status = 'in'; patch.joinedAt = new Date().toISOString(); }
      await setDoc(ref, patch, { merge: true });
    },
    // Proof of payment. The image and the "paid" tick are written in one batch,
    // so if the security rules refuse the image (not signed in as this player,
    // or the rules haven't been published yet) nobody is ticked off without it.
    async uploadPaymentProof(playerId, gameId, proof) {
      const record = logic.buildProofRecord(proof);
      const ref = doc(signupsCol(gameId), playerId);
      const patch = logic.proofSignupPatch(new Date(record.uploadedAt));
      const snap = await getDoc(ref);
      if (!snap.exists()) { patch.status = 'in'; patch.joinedAt = record.uploadedAt; }
      const batch = writeBatch(dbf);
      batch.set(proofRef(gameId, playerId), record);
      batch.set(ref, patch, { merge: true });
      await batch.commit();
    },
    // Fetched on demand (not part of the live listener) — images are big.
    async getPaymentProof(playerId, gameId) {
      const snap = await getDoc(proofRef(gameId, playerId));
      return snap.exists() ? snap.data() : null;
    },
    async removePaymentProof(playerId, gameId) {
      const batch = writeBatch(dbf);
      batch.delete(proofRef(gameId, playerId));
      batch.set(doc(signupsCol(gameId), playerId), { paid: false, paidAt: null, proofAt: null }, { merge: true });
      await batch.commit();
    },
    async lockGame(id) { await updateDoc(gameRef(id), { status: 'locked' }); },
    async setCapacity(id, capacity) { await updateDoc(gameRef(id), { capacity: Math.max(2, Number(capacity) || 0), capacityLocked: true }); },
    async setCapacityAuto(id) { await updateDoc(gameRef(id), { capacityLocked: false }); },
    async rescheduleGame(id, { kickoffAt, dateLabel, venue }) {
      const patch = {};
      if (kickoffAt) patch.kickoffAt = kickoffAt;
      if (dateLabel != null && dateLabel !== '') patch.dateLabel = dateLabel;
      if (venue != null) patch.venue = venue;
      if (Object.keys(patch).length) await updateDoc(gameRef(id), patch);
      // Stage a "game moved" announcement for review before it reaches the group.
      const g = { ...(cache.game || {}), id, ...patch };
      await setDoc(announceRef, logic.buildAnnouncement('reschedule', { game: g, recipients: Object.values(cache.players), config: cfg() }));
    },
    async cancelGame(id) {
      // Leave currentGameId pointing here (marked cancelled) so the app treats a
      // cancelled game as "no game"; opening a fresh game moves the pointer on.
      await updateDoc(gameRef(id), { status: 'cancelled', cancelledAt: new Date().toISOString() });
      // Stage a "no game this week" announcement for review before it goes out.
      const g = { ...(cache.game || {}), id, status: 'cancelled' };
      await setDoc(announceRef, logic.buildAnnouncement('cancellation', { game: g, recipients: Object.values(cache.players), config: cfg() }));
    },
    async announceLineup(id) {
      const g = cache.game && cache.game.id === id ? cache.game : { ...(cache.game || {}), id };
      await setDoc(announceRef, buildLineupAnnouncement(g, cache.players, cfg(), cache.announcement));
    },
    async reopenGame(id) { await updateDoc(gameRef(id), { status: 'open' }); },
    async completeGame(id, opts = {}) {
      const pollOpenAt = cache.game?.createdAt || null;
      // Freeze the squad size that's in force (the live recommendation while auto).
      const capacity = logic.effectiveCapacity(cache.game, cache.signups, cache.players, cfg());
      const ranked = logic.rankSignups(cache.signups, cache.players, capacity, { pollOpenAt, config: cfg() });
      const sc = cfg().scoring;
      const flat = sc.playedReward + (Number(opts.bonus) || 0);
      let awards;
      if (Array.isArray(opts.lateBonusIds)) {
        const each = (sc.playedReward || 0) * (sc.lateSignupBonusGames || 0);
        awards = {}; for (const pid of opts.lateBonusIds) awards[pid] = each;
      } else {
        awards = logic.lateSignupAwards(cache.signups, cache.players, cache.config, cache.game?.kickoffAt, capacity, pollOpenAt);
      }
      // Who actually played: the finalised team sheet if the organiser built it
      // (add-ins / removals included), else the ranked squad.
      const gm = cache.game || {};
      const teamSheet = gm.teamsFinalised && gm.teams && ((gm.teams.bibs || []).length || (gm.teams.nonbibs || []).length)
        ? logic.gamePlayers(gm) : null;
      const playedIds = teamSheet || ranked.filter(r => r.status === 'confirmed').map(r => r.playerId);
      const playedSet = new Set(playedIds);
      // Prompt reserves (signed up quickly but didn't play) bank the reward + bonus.
      const promptAwards = logic.promptSignupAwards(cache.signups, cache.players, cache.config, pollOpenAt, capacity, teamSheet ? playedIds : null);
      const batch = writeBatch(dbf);
      for (const pid of playedIds) if (cache.players[pid]) {
        batch.update(doc(playersCol, pid), { loyalty: increment(flat + (awards[pid] || 0)), gamesPlayed: increment(1) });
      }
      for (const [pid, amt] of Object.entries(promptAwards)) if (cache.players[pid]) batch.update(doc(playersCol, pid), { loyalty: increment(amt) });
      const result = teamSheet
        ? { confirmed: [...playedIds], reserves: ranked.filter(r => !playedSet.has(r.playerId)).map(r => r.playerId) }
        : logic.finalResult(ranked);
      const gamePatch = { status: 'completed', completedAt: new Date().toISOString(), result, capacity, capacityLocked: true };
      // Denormalize who withdrew (and their penalty) so history loads don't need the signups subcollection.
      gamePatch.withdrawnIds = (cache.signups || []).filter(s => s.status === 'withdrawn').map(s => s.playerId);
      gamePatch.withdrawnPenalties = Object.fromEntries((cache.signups || []).filter(s => s.status === 'withdrawn').map(s => [s.playerId, Number(s.penaltyApplied) || 0]));
      if (opts.scores) gamePatch.scores = opts.scores;
      if (opts.weather) gamePatch.weather = opts.weather;
      if (Number(opts.bonus) > 0) { gamePatch.weatherBonus = Number(opts.bonus); gamePatch.bonusReasons = opts.reasons || []; }
      if (opts.highlights !== undefined) gamePatch.highlights = opts.highlights;
      if (opts.ownGoals !== undefined) gamePatch.ownGoals = opts.ownGoals;
      batch.update(gameRef(id), gamePatch);
      batch.update(cfgRef, { currentGameId: null });
      await batch.commit();
    },
    // Change a past game's conditions (weather / cold-season) bonus. Adjusts
    // everyone who played by the difference and re-stamps the game record.
    async setConditionsBonus(gameId, weatherOn, coldOn) {
      const snap = await getDoc(gameRef(gameId));
      if (!snap.exists()) throw new Error('No game');
      const g = { id: gameId, ...snap.data() };
      const { bonus, reasons } = logic.completionBonus(cfg(), { adverseWeather: !!weatherOn, coldSeason: !!coldOn });
      const delta = bonus - (Number(g.weatherBonus) || 0);
      const ids = logic.gamePlayers(g);
      const batch = writeBatch(dbf);
      batch.update(gameRef(gameId), { weatherBonus: bonus, bonusReasons: reasons });
      if (delta !== 0) for (const pid of ids) if (cache.players[pid]) batch.update(doc(playersCol, pid), { loyalty: increment(delta) });
      await batch.commit();
      return { bonus, delta, players: ids.length };
    },
    async setPlayerEmail(id, email, uid) {
      const patch = { email: email || null }; if (uid) patch.uid = uid;
      await updateDoc(doc(playersCol, id), patch);
    },
    async savePushToken(id, token) {
      // store under a sanitised field key so one player can have several devices
      await setDoc(doc(playersCol, id), { pushTokens: { [token.slice(-24)]: token } }, { merge: true });
    },
    async loadHistory() {
      // Single collection read — no per-game signups fan-out. Everything history
      // needs is frozen on the game doc (result, teams, scores, stats, ratings,
      // and withdrawnIds); signups are only for the live game.
      const gs = await getDocs(collection(dbf, 'games'));
      const out = [];
      for (const d of gs.docs) {
        const data = d.data();
        if (data.status !== 'completed') continue;
        out.push({ id: d.id, ...data });
      }
      return out;
    },
    async updateConfig(patch) {
      const flat = { ...patch };
      if (patch.scoring) flat.scoring = { ...cfg().scoring, ...patch.scoring };
      await setDoc(cfgRef, flat, { merge: true });
    },
    async checkPin(pin) { return String(pin) === String(cfg().adminPin); },
    async checkStattoPin(pin) { const c = cfg(); return String(pin) === String(c.stattoPin) || String(pin) === String(c.adminPin); },
    async saveGameStats(gameId, edit) {
      await runTransaction(dbf, async (tx) => {
        const snap = await tx.get(gameRef(gameId)); if (!snap.exists()) throw new Error('No game');
        const patch = logic.statsEditPatch(snap.data(), edit);
        if (Object.keys(patch).length) tx.update(gameRef(gameId), patch);
      });
    },
    // A player logging their own goals & assists for a game they played. Run as
    // a transaction: the automatic score is rebuilt from everyone's entries, so
    // two players saving at once must not overwrite each other's goals.
    async saveSelfStats(gameId, playerId, { g: goals, a: assists }) {
      return runTransaction(dbf, async (tx) => {
        const snap = await tx.get(gameRef(gameId)); if (!snap.exists()) throw new Error('No game');
        const g = { id: gameId, ...snap.data() };
        if (!logic.selfStatGames([g], playerId).length) throw new Error('You can only log games you played in');
        const entry = { g: logic.cleanSelfStat(goals), a: logic.cleanSelfStat(assists), at: new Date().toISOString() };
        const selfStats = { ...(g.selfStats || {}), [playerId]: entry };
        const auto = logic.autoScorePatch({ ...g, selfStats }) || {};
        tx.update(gameRef(gameId), { [`selfStats.${playerId}`]: entry, ...auto });
        return { selfStats, ...auto };
      });
    },
    async useAutoScore(gameId) {
      await runTransaction(dbf, async (tx) => {
        const snap = await tx.get(gameRef(gameId)); if (!snap.exists()) throw new Error('No game');
        const patch = logic.useAutoScorePatch(snap.data());
        if (Object.keys(patch).length) tx.update(gameRef(gameId), patch);
      });
    },
    async saveHighlights(gameId, highlights) {
      await updateDoc(gameRef(gameId), { highlights });
    },
    // A player rating their own performance in a past game (0 clears it).
    async setSelfRating(gameId, playerId, rating) {
      await updateDoc(gameRef(gameId), { [`selfRatings.${playerId}`]: rating > 0 ? Number(rating) : deleteField() });
    },
    async importPerf() {
      const batch = writeBatch(dbf); let n = 0;
      for (const [gid, perf] of Object.entries(PERF)) {
        batch.update(gameRef(gid), { stats: perf, goals: goalsFromStats(perf) }); n++;
      }
      await batch.commit(); return n;
    },
    // Apply a resolved spreadsheet import (see import.js). Reads each game to
    // merge onto, then writes back stats (goals recomputed), ratings, own goals
    // and unioned MOTM. Returns { games } actually touched.
    async applyImport(byGame) {
      const batch = writeBatch(dbf); let games = 0;
      for (const [gid, gm] of Object.entries(byGame || {})) {
        const snap = await getDoc(gameRef(gid)); if (!snap.exists()) continue;
        const data = snap.data();
        const stats = { ...(data.stats || {}) };
        for (const [pid, vals] of Object.entries(gm.stats || {})) stats[pid] = { ...(stats[pid] || {}), ...vals };
        const patch = { stats, goals: goalsFromStats(stats) };
        if (Object.keys(gm.stattoRatings || {}).length) patch.stattoRatings = { ...(data.stattoRatings || {}), ...gm.stattoRatings };
        if (Object.keys(gm.ownGoals || {}).length) patch.ownGoals = { ...(data.ownGoals || {}), ...gm.ownGoals };
        if ((gm.motm || []).length) patch.motm = [...new Set([...(data.motm || []), ...gm.motm])];
        batch.update(gameRef(gid), patch); games++;
      }
      await batch.commit(); return { games };
    },
    // Apply imported player attribute ratings, merged via dotted field paths so
    // existing attrs are preserved without a read. Returns { players } touched.
    async applyRatings(byPlayer) {
      const batch = writeBatch(dbf); let players = 0;
      for (const [pid, attrs] of Object.entries(byPlayer || {})) {
        const patch = {};
        for (const [k, v] of Object.entries(attrs)) patch[`attrs.${k}`] = v;
        if (Object.keys(patch).length) { batch.update(doc(playersCol, pid), patch); players++; }
      }
      await batch.commit(); return { players };
    }
  };
}
