// store.js — persistence + all the fairness/loyalty logic for TNTF.
// Zero dependencies: data lives in a single JSON file so the whole app is
// `node server.js` and nothing else. Fine for a WhatsApp-group-sized crowd.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DATA_FILE = new URL('./data.json', import.meta.url);

// ---------------------------------------------------------------------------
// Defaults. Everything here is editable by the admin from the Settings screen.
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  clubName: 'Tuesday Night Total Football',
  gameDay: 'Tuesday',
  kickoff: '20:00',          // 24h local time, used to time-weight penalties
  capacity: 14,              // 7-a-side default; admin can set 16 etc. per game
  adminPin: '1234',          // change me from Settings
  scoring: {
    playedReward: 2,         // loyalty gained for actually turning up
    // Time-weighted dropout penalty. `hoursBefore` is the cutoff; the first
    // tier whose cutoff the withdrawal falls under (or equal) applies.
    // i.e. drop >=48h out -> 0, 24-48h -> 1, 3-24h -> 3, <3h / no-show -> 5.
    dropoutTiers: [
      { hoursBefore: 48, penalty: 0, label: '2+ days before (free)' },
      { hoursBefore: 24, penalty: 1, label: '1–2 days before' },
      { hoursBefore: 3,  penalty: 3, label: 'same day' },
      { hoursBefore: 0,  penalty: 5, label: 'last minute / no-show' }
    ]
  }
};

function seed() {
  // Roster pulled from the group so it's usable on day one. Edit freely in-app.
  const names = [
    'Faisal', 'Haroon Hanif', 'Haseeb', 'Shergal Rodaina', 'Tom Exon',
    'Haris Farooq', 'Suki', 'Darren Ellis', 'Matthew Eastwood', 'Ismael Nazar',
    'Lee', 'Hamad', 'James Roberts', 'Marc Coleman', 'Shakeel', 'Oli Scott',
    'Tom Clapham'
  ];
  const players = {};
  for (const name of names) {
    const id = randomUUID();
    players[id] = {
      id, name,
      loyalty: 0,
      gamesPlayed: 0,
      dropouts: 0,
      createdAt: new Date().toISOString()
    };
  }
  return {
    config: structuredClone(DEFAULT_CONFIG),
    players,
    games: [],       // history, newest last
    currentGameId: null
  };
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------
let db = null;

export function load() {
  if (db) return db;
  if (existsSync(DATA_FILE)) {
    db = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    // Forward-fill any config keys added after the file was first written.
    db.config = { ...structuredClone(DEFAULT_CONFIG), ...db.config };
    db.config.scoring = { ...DEFAULT_CONFIG.scoring, ...db.config.scoring };
  } else {
    db = seed();
    save();
  }
  return db;
}

export function save() {
  writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function currentGame() {
  const d = load();
  if (!d.currentGameId) return null;
  return d.games.find(g => g.id === d.currentGameId) || null;
}

function player(id) {
  return load().players[id] || null;
}

// Hours between now and a game's kickoff datetime (negative once kicked off).
function hoursUntilKickoff(game, now = Date.now()) {
  return (new Date(game.kickoffAt).getTime() - now) / 3_600_000;
}

// Which penalty applies to a withdrawal `hours` before kickoff.
export function penaltyForHours(hours) {
  const tiers = load().config.scoring.dropoutTiers;
  // tiers are sorted high->low cutoff; pick the first the withdrawal is inside.
  for (const t of tiers) {
    if (hours >= t.hoursBefore) return t;
  }
  return tiers[tiers.length - 1];
}

// The heart of it: rank active sign-ups by loyalty (desc), tie-break by the
// time they registered. Top `capacity` are confirmed, the rest are waitlist.
// This is what kills the "fastest tapper wins" problem — a regular who signs
// up late still ranks above a casual who got in early.
export function rankSignups(game) {
  const d = load();
  const active = game.signups
    .filter(s => s.status !== 'withdrawn')
    .map(s => ({ ...s, player: d.players[s.playerId] }))
    .filter(s => s.player);

  active.sort((a, b) => {
    if (b.player.loyalty !== a.player.loyalty) return b.player.loyalty - a.player.loyalty;
    return new Date(a.joinedAt) - new Date(b.joinedAt); // earlier sign-up wins ties
  });

  return active.map((s, i) => ({
    playerId: s.playerId,
    name: s.player.name,
    loyalty: s.player.loyalty,
    gamesPlayed: s.player.gamesPlayed,
    joinedAt: s.joinedAt,
    rank: i + 1,
    status: i < game.capacity ? 'confirmed' : 'waitlist'
  }));
}

// ---------------------------------------------------------------------------
// Public state (what the frontend renders)
// ---------------------------------------------------------------------------
export function getState(playerId) {
  const d = load();
  const game = currentGame();
  const me = playerId ? player(playerId) : null;

  const roster = Object.values(d.players)
    .sort((a, b) => b.loyalty - a.loyalty || a.name.localeCompare(b.name))
    .map(p => ({ id: p.id, name: p.name, loyalty: p.loyalty, gamesPlayed: p.gamesPlayed, dropouts: p.dropouts }));

  let gameView = null;
  if (game) {
    const ranked = rankSignups(game);
    const mine = playerId ? ranked.find(r => r.playerId === playerId) : null;
    gameView = {
      id: game.id,
      status: game.status,               // open | locked | completed
      dateLabel: game.dateLabel,
      kickoffAt: game.kickoffAt,
      capacity: game.capacity,
      confirmed: ranked.filter(r => r.status === 'confirmed'),
      waitlist: ranked.filter(r => r.status === 'waitlist'),
      totalIn: ranked.length,
      hoursUntilKickoff: hoursUntilKickoff(game),
      me: mine ? { rank: mine.rank, status: mine.status } : null,
      // what it'd cost *me* to pull out right now — shown before confirming
      withdrawPenaltyNow: penaltyForHours(hoursUntilKickoff(game)).penalty
    };
  }

  return {
    config: {
      clubName: d.config.clubName,
      gameDay: d.config.gameDay,
      kickoff: d.config.kickoff,
      capacity: d.config.capacity,
      scoring: d.config.scoring
    },
    me,
    game: gameView,
    roster
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------
export function upsertPlayer(name) {
  const d = load();
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Name required');
  const existing = Object.values(d.players)
    .find(p => p.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const id = randomUUID();
  d.players[id] = { id, name: clean, loyalty: 0, gamesPlayed: 0, dropouts: 0, createdAt: new Date().toISOString() };
  save();
  return d.players[id];
}

export function openGame({ dateLabel, kickoffAt, capacity }) {
  const d = load();
  const game = {
    id: randomUUID(),
    status: 'open',
    dateLabel: dateLabel || nextGameLabel(),
    kickoffAt: kickoffAt || nextKickoffISO(),
    capacity: Number(capacity) || d.config.capacity,
    signups: [],
    createdAt: new Date().toISOString()
  };
  d.games.push(game);
  d.currentGameId = game.id;
  save();
  return game;
}

export function signup(playerId, gameId) {
  const d = load();
  const game = d.games.find(g => g.id === gameId);
  if (!game) throw new Error('No game');
  if (game.status !== 'open') throw new Error('Registration is closed for this game');
  if (!d.players[playerId]) throw new Error('Unknown player');
  const existing = game.signups.find(s => s.playerId === playerId);
  if (existing) {
    if (existing.status === 'withdrawn') {
      // re-joining after a withdrawal: back of the queue (new timestamp)
      existing.status = 'in';
      existing.joinedAt = new Date().toISOString();
    }
  } else {
    game.signups.push({ playerId, status: 'in', joinedAt: new Date().toISOString() });
  }
  save();
  return getState(playerId);
}

export function withdraw(playerId, gameId) {
  const d = load();
  const game = d.games.find(g => g.id === gameId);
  if (!game) throw new Error('No game');
  const s = game.signups.find(x => x.playerId === playerId && x.status !== 'withdrawn');
  if (!s) throw new Error('You are not signed up');
  const p = d.players[playerId];

  const hours = hoursUntilKickoff(game);
  const tier = penaltyForHours(hours);
  s.status = 'withdrawn';
  s.withdrawnAt = new Date().toISOString();
  s.penaltyApplied = tier.penalty;
  s.penaltyLabel = tier.label;

  if (tier.penalty > 0) {
    p.loyalty -= tier.penalty;
    p.dropouts += 1;
  }
  save();
  return { state: getState(playerId), penalty: tier.penalty, label: tier.label };
}

export function lockGame(gameId) {
  const d = load();
  const game = d.games.find(g => g.id === gameId);
  if (!game) throw new Error('No game');
  game.status = 'locked';
  save();
  return getState(null);
}

export function reopenGame(gameId) {
  const d = load();
  const game = d.games.find(g => g.id === gameId);
  if (!game) throw new Error('No game');
  game.status = 'open';
  save();
  return getState(null);
}

// Mark the game played: everyone in the confirmed squad who didn't withdraw
// banks their loyalty reward. Then the game is archived.
export function completeGame(gameId) {
  const d = load();
  const game = d.games.find(g => g.id === gameId);
  if (!game) throw new Error('No game');
  const ranked = rankSignups(game);
  const reward = d.config.scoring.playedReward;
  for (const r of ranked) {
    if (r.status === 'confirmed') {
      const p = d.players[r.playerId];
      p.loyalty += reward;
      p.gamesPlayed += 1;
    }
  }
  game.status = 'completed';
  game.completedAt = new Date().toISOString();
  if (d.currentGameId === gameId) d.currentGameId = null;
  save();
  return getState(null);
}

export function updateConfig(patch) {
  const d = load();
  d.config = { ...d.config, ...patch };
  if (patch.scoring) d.config.scoring = { ...d.config.scoring, ...patch.scoring };
  save();
  return getState(null);
}

export function renamePlayer(id, name) {
  const d = load();
  if (!d.players[id]) throw new Error('Unknown player');
  d.players[id].name = String(name).trim();
  save();
  return getState(null);
}

export function adjustLoyalty(id, delta) {
  const d = load();
  if (!d.players[id]) throw new Error('Unknown player');
  d.players[id].loyalty += Number(delta) || 0;
  save();
  return getState(null);
}

export function checkPin(pin) {
  return String(pin) === String(load().config.adminPin);
}

// ---------------------------------------------------------------------------
// Date helpers — default the next game to the configured game-day + kickoff.
// ---------------------------------------------------------------------------
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function nextKickoffISO() {
  const d = load();
  const targetDow = DAYS.indexOf(d.config.gameDay);
  const [hh, mm] = String(d.config.kickoff).split(':').map(Number);
  const now = new Date();
  const result = new Date(now);
  result.setHours(hh || 20, mm || 0, 0, 0);
  let add = (targetDow - now.getDay() + 7) % 7;
  if (add === 0 && result <= now) add = 7; // already past today's kickoff
  result.setDate(result.getDate() + add);
  return result.toISOString();
}

function nextGameLabel() {
  const iso = nextKickoffISO();
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
}

export { nextKickoffISO, nextGameLabel };
