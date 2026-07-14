// db.js — the data layer. One interface, two backends:
//   • Firestore  (shared, multi-device) when firebase-config.js is filled in
//   • localStorage (single-device demo) otherwise
// All the fairness maths lives in logic.js; this file is just storage + wiring.

import { FIREBASE_ENABLED } from './firebase-config.js';
import { getFirebaseApp, FB_VERSION } from './firebase.js';
import * as logic from './logic.js';

const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }));

function seedPlayers() {
  const players = {};
  for (const name of logic.SEED_NAMES) {
    const id = uuid();
    players[id] = { id, name, loyalty: 0, gamesPlayed: 0, dropouts: 0, createdAt: new Date().toISOString() };
  }
  return players;
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
    const fresh = { config: { ...logic.DEFAULT_CONFIG }, players: seedPlayers(), games: [], currentGameId: null };
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
    async renamePlayer(id, name) { db.players[id].name = String(name).trim(); persist(); },
    async adjustLoyalty(id, delta) { db.players[id].loyalty += Number(delta) || 0; persist(); },

    async openGame({ dateLabel, kickoffAt, capacity }) {
      const game = {
        id: uuid(), status: 'open',
        dateLabel: dateLabel || logic.nextGameLabel(db.config),
        kickoffAt: kickoffAt || logic.nextKickoffISO(db.config),
        capacity: Number(capacity) || db.config.capacity,
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
    async completeGame(id) {
      const g = db.games.find(x => x.id === id); if (!g) throw new Error('No game');
      const ranked = logic.rankSignups(g.signups, db.players, g.capacity);
      const reward = db.config.scoring.playedReward;
      for (const r of ranked) if (r.status === 'confirmed') { db.players[r.playerId].loyalty += reward; db.players[r.playerId].gamesPlayed += 1; }
      g.status = 'completed'; g.completedAt = new Date().toISOString(); g.result = logic.finalResult(ranked);
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
    async renamePlayer(id, name) { await updateDoc(doc(playersCol, id), { name: String(name).trim() }); },
    async adjustLoyalty(id, delta) { await updateDoc(doc(playersCol, id), { loyalty: increment(Number(delta) || 0) }); },

    async openGame({ dateLabel, kickoffAt, capacity }) {
      const id = uuid();
      await setDoc(gameRef(id), {
        status: 'open',
        dateLabel: dateLabel || logic.nextGameLabel(cfg()),
        kickoffAt: kickoffAt || logic.nextKickoffISO(cfg()),
        capacity: Number(capacity) || cfg().capacity,
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
    async completeGame(id) {
      const ranked = logic.rankSignups(cache.signups, cache.players, cache.game?.capacity || cfg().capacity);
      const reward = cfg().scoring.playedReward;
      const batch = writeBatch(dbf);
      for (const r of ranked) if (r.status === 'confirmed') {
        batch.update(doc(playersCol, r.playerId), { loyalty: increment(reward), gamesPlayed: increment(1) });
      }
      batch.update(gameRef(id), { status: 'completed', completedAt: new Date().toISOString(), result: logic.finalResult(ranked) });
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
