// db.js — the data layer. One interface, two backends:
//   • Firestore  (shared, multi-device) when firebase-config.js is filled in
//   • localStorage (single-device demo) otherwise
// All the fairness maths lives in logic.js; this file is just storage + wiring.

import { FIREBASE_ENABLED } from './firebase-config.js';
import { getFirebaseApp, FB_VERSION } from './firebase.js';
import { SEED } from './seed-data.js';
import * as logic from './logic.js';

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
  return SEED.games.map(g => ({ ...g, signups: [] }));
}

const dedupe = arr => [...new Set(arr)];
// Remove a player id from every reference in a game (used by deletePlayer).
function stripPlayer(g, id) {
  if (g.teams) { g.teams.bibs = (g.teams.bibs || []).filter(x => x !== id); g.teams.nonbibs = (g.teams.nonbibs || []).filter(x => x !== id); }
  if (g.result) { g.result.confirmed = (g.result.confirmed || []).filter(x => x !== id); g.result.reserves = (g.result.reserves || []).filter(x => x !== id); }
  if (g.signups) g.signups = g.signups.filter(s => s.playerId !== id);
}
// Replace all references to dropId with keepId in a game (used by mergePlayers).
function repointPlayer(g, dropId, keepId) {
  const swap = arr => dedupe((arr || []).map(x => x === dropId ? keepId : x));
  if (g.teams) { g.teams.bibs = swap(g.teams.bibs); g.teams.nonbibs = swap(g.teams.nonbibs); }
  if (g.result) { g.result.confirmed = swap(g.result.confirmed); g.result.reserves = swap(g.result.reserves); }
  if (g.signups) {
    const seen = new Set();
    g.signups = g.signups.map(s => s.playerId === dropId ? { ...s, playerId: keepId } : s)
      .filter(s => (seen.has(s.playerId) ? false : seen.add(s.playerId)));
  }
}

// Shared shape emitted to subscribers.
function assemble(config, playersById, game, signups) {
  const roster = Object.values(playersById)
    .sort((a, b) => b.loyalty - a.loyalty || a.name.localeCompare(b.name));
  return { config: logic.withDefaults(config), playersById, roster, game: game || null, signups: signups || [] };
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
    const payload = assemble(db.config, db.players, g, g ? g.signups : []);
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
      const id = uuid();
      db.players[id] = {
        id, name: String(name || 'Player').trim(), email: email || null, uid: uid || null,
        photoURL: photoURL || null, account: true,
        loyalty: 0, gamesPlayed: 0, dropouts: 0, createdAt: new Date().toISOString()
      };
      persist(); return id;
    },
    async clearAccount(id) { const p = db.players[id]; if (p) { p.account = false; persist(); } },
    async renamePlayer(id, name) { db.players[id].name = String(name).trim(); persist(); },
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
    async saveLineup(gameId, teams, finalised) {
      const g = db.games.find(x => x.id === gameId); if (!g) throw new Error('No game');
      g.teams = { bibs: teams.bibs || [], nonbibs: teams.nonbibs || [] };
      g.teamsFinalised = !!finalised; persist();
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
      db.games.push(game); db.currentGameId = game.id; persist(); return game.id;
    },
    async signup(playerId, gameId) {
      const g = db.games.find(x => x.id === gameId);
      if (!g) throw new Error('No game'); if (g.status !== 'open') throw new Error('Registration is closed');
      const s = g.signups.find(x => x.playerId === playerId);
      if (s) { if (s.status === 'withdrawn') { s.status = 'in'; s.joinedAt = new Date().toISOString(); } }
      else g.signups.push({ playerId, status: 'in', joinedAt: new Date().toISOString() });
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
    async lockGame(id) { db.games.find(g => g.id === id).status = 'locked'; persist(); },
    async reopenGame(id) { db.games.find(g => g.id === id).status = 'open'; persist(); },
    async completeGame(id, opts = {}) {
      const g = db.games.find(x => x.id === id); if (!g) throw new Error('No game');
      const ranked = logic.rankSignups(g.signups, db.players, g.capacity);
      const flat = logic.withDefaults(db.config).scoring.playedReward + (Number(opts.bonus) || 0);
      const awards = logic.lateSignupAwards(g.signups, db.players, db.config, g.kickoffAt, g.capacity);
      for (const r of ranked) if (r.status === 'confirmed') {
        db.players[r.playerId].loyalty += flat + (awards[r.playerId] || 0); db.players[r.playerId].gamesPlayed += 1;
      }
      g.status = 'completed'; g.completedAt = new Date().toISOString(); g.result = logic.finalResult(ranked);
      if (opts.scores) g.scores = opts.scores;
      if (opts.weather) g.weather = opts.weather;
      if (Number(opts.bonus) > 0) { g.weatherBonus = Number(opts.bonus); g.bonusReasons = opts.reasons || []; }
      if (db.currentGameId === id) db.currentGameId = null; persist();
    },
    async setPlayerEmail(id, email, uid) { const p = db.players[id]; if (!p) throw new Error('Unknown player'); p.email = email || null; if (uid) p.uid = uid; persist(); },
    async savePushToken(id, token) { const p = db.players[id]; if (!p) return; p.pushTokens = { ...(p.pushTokens || {}), [token]: new Date().toISOString() }; persist(); },
    async loadHistory() { return db.games.filter(g => g.status === 'completed'); },
    async updateConfig(patch) {
      db.config = { ...db.config, ...patch };
      if (patch.scoring) db.config.scoring = { ...db.config.scoring, ...patch.scoring };
      persist();
    },
    async checkPin(pin) { return String(pin) === String(logic.withDefaults(db.config).adminPin); }
  };
}

// ===========================================================================
// Firestore backend
// ===========================================================================
async function createFirestoreDB() {
  const fs = await import(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-firestore.js`);
  const {
    getFirestore, doc, getDoc, setDoc, updateDoc, deleteField,
    collection, getDocs, onSnapshot, writeBatch, increment
  } = fs;

  const app = await getFirebaseApp();
  const dbf = getFirestore(app);
  const cfgRef = doc(dbf, 'meta', 'config');
  const playersCol = collection(dbf, 'players');
  const gameRef = id => doc(dbf, 'games', id);
  const signupsCol = id => collection(dbf, 'games', id, 'signups');

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

  // Live cache assembled from three snapshots (config, players, current game+signups).
  const cache = { config: {}, players: {}, game: null, signups: [] };
  const listeners = new Set();
  const emit = () => { const p = assemble(cache.config, cache.players, cache.game, cache.signups); listeners.forEach(l => l(p)); };

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

  onSnapshot(cfgRef, s => {
    const data = s.data() || {}; cache.config = data;
    watchGame(data.currentGameId || null);
  });
  onSnapshot(playersCol, qs => {
    const m = {}; qs.docs.forEach(d => { m[d.id] = { id: d.id, ...d.data() }; }); cache.players = m; emit();
  });

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
      const byUid = uid && Object.values(cache.players).find(p => p.uid === uid);
      if (byUid) return byUid.id;
      const byEmail = email && Object.values(cache.players).find(p => p.email && p.email.toLowerCase() === email.toLowerCase());
      if (byEmail) {
        const patch = {}; if (uid) patch.uid = uid; if (photoURL && !byEmail.photoURL) patch.photoURL = photoURL;
        if (Object.keys(patch).length) await updateDoc(doc(playersCol, byEmail.id), patch);
        return byEmail.id;
      }
      const id = uuid();
      await setDoc(doc(playersCol, id), {
        id, name: String(name || 'Player').trim(), email: email || null, uid: uid || null,
        photoURL: photoURL || null, account: true,
        loyalty: 0, gamesPlayed: 0, dropouts: 0, createdAt: new Date().toISOString()
      });
      return id;
    },
    async clearAccount(id) { await updateDoc(doc(playersCol, id), { account: false }); },
    async renamePlayer(id, name) { await updateDoc(doc(playersCol, id), { name: String(name).trim() }); },
    async adjustLoyalty(id, delta) { await updateDoc(doc(playersCol, id), { loyalty: increment(Number(delta) || 0) }); },
    async deletePlayer(id) {
      const gs = await getDocs(collection(dbf, 'games'));
      const batch = writeBatch(dbf);
      for (const d of gs.docs) {
        const g = { id: d.id, ...d.data() }; stripPlayer(g, id);
        batch.update(gameRef(d.id), { teams: g.teams || null, result: g.result || null });
      }
      batch.delete(doc(playersCol, id));
      await batch.commit();
    },
    async setPlayerAttrs(id, attrs) { await setDoc(doc(playersCol, id), { attrs }, { merge: true }); },
    async saveLineup(gameId, teams, finalised) {
      await updateDoc(gameRef(gameId), { teams: { bibs: teams.bibs || [], nonbibs: teams.nonbibs || [] }, teamsFinalised: !!finalised });
    },
    async mergePlayers(keepId, dropId) {
      if (keepId === dropId) return;
      const keep = cache.players[keepId], drop = cache.players[dropId];
      if (!keep || !drop) throw new Error('Unknown player');
      const gs = await getDocs(collection(dbf, 'games'));
      const batch = writeBatch(dbf);
      for (const d of gs.docs) {
        const g = { id: d.id, ...d.data() }; repointPlayer(g, dropId, keepId);
        batch.update(gameRef(d.id), { teams: g.teams || null, result: g.result || null });
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
      await setDoc(gameRef(id), {
        status: 'open',
        dateLabel: dateLabel || logic.nextGameLabel(cfg()),
        kickoffAt: kickoffAt || logic.nextKickoffISO(cfg()),
        capacity: Number(capacity) || cfg().capacity,
        venue: venue || cfg().venue || '',
        createdAt: new Date().toISOString()
      });
      await updateDoc(cfgRef, { currentGameId: id });
      return id;
    },
    async signup(playerId, gameId) {
      const g = cache.game;
      if (!g || g.id !== gameId) throw new Error('No game');
      if (g.status !== 'open') throw new Error('Registration is closed');
      await setDoc(doc(signupsCol(gameId), playerId), { status: 'in', joinedAt: new Date().toISOString() }, { merge: true });
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
    async lockGame(id) { await updateDoc(gameRef(id), { status: 'locked' }); },
    async reopenGame(id) { await updateDoc(gameRef(id), { status: 'open' }); },
    async completeGame(id, opts = {}) {
      const capacity = cache.game?.capacity || cfg().capacity;
      const ranked = logic.rankSignups(cache.signups, cache.players, capacity);
      const flat = cfg().scoring.playedReward + (Number(opts.bonus) || 0);
      const awards = logic.lateSignupAwards(cache.signups, cache.players, cache.config, cache.game?.kickoffAt, capacity);
      const batch = writeBatch(dbf);
      for (const r of ranked) if (r.status === 'confirmed') {
        batch.update(doc(playersCol, r.playerId), { loyalty: increment(flat + (awards[r.playerId] || 0)), gamesPlayed: increment(1) });
      }
      const gamePatch = { status: 'completed', completedAt: new Date().toISOString(), result: logic.finalResult(ranked) };
      if (opts.scores) gamePatch.scores = opts.scores;
      if (opts.weather) gamePatch.weather = opts.weather;
      if (Number(opts.bonus) > 0) { gamePatch.weatherBonus = Number(opts.bonus); gamePatch.bonusReasons = opts.reasons || []; }
      batch.update(gameRef(id), gamePatch);
      batch.update(cfgRef, { currentGameId: null });
      await batch.commit();
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
      const gs = await getDocs(collection(dbf, 'games'));
      const out = [];
      for (const d of gs.docs) {
        const data = d.data();
        if (data.status !== 'completed') continue;
        const sus = await getDocs(signupsCol(d.id));
        out.push({ id: d.id, ...data, signups: sus.docs.map(s => ({ playerId: s.id, ...s.data() })) });
      }
      return out;
    },
    async updateConfig(patch) {
      const flat = { ...patch };
      if (patch.scoring) flat.scoring = { ...cfg().scoring, ...patch.scoring };
      await setDoc(cfgRef, flat, { merge: true });
    },
    async checkPin(pin) { return String(pin) === String(cfg().adminPin); }
  };
}
