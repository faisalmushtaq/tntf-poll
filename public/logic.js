// logic.js — pure selection/loyalty logic. No I/O, no framework.
// Imported by both the browser app and the Node tests, so it stays testable.

export const DEFAULT_CONFIG = {
  clubName: 'Tuesday Night Total Football',
  gameDay: 'Tuesday',
  kickoff: '20:00',        // 24h local time; default next Tuesday 8pm
  venue: 'Pitch 10 - Nou Camp', // default venue; editable per game / in settings
  lat: null,               // venue latitude  (set in Settings → turns on weather)
  lon: null,               // venue longitude (Open-Meteo, no API key needed)
  capacity: 14,            // 7-a-side default
  adminPin: '1234',        // change from Settings
  organiserEmail: '',      // where the auto-close squad alert is sent
  scoring: {
    playedReward: 2,       // loyalty gained for turning up
    // Time-weighted dropout penalty. The first tier whose `hoursBefore`
    // cutoff the withdrawal is still outside of applies.
    // Drop >=48h out -> 0, 24-48h -> 1, 3-24h -> 3, <3h / no-show -> 5.
    dropoutTiers: [
      { hoursBefore: 48, penalty: 0, label: '2+ days before (free)' },
      { hoursBefore: 24, penalty: 1, label: '1–2 days before' },
      { hoursBefore: 3,  penalty: 3, label: 'same day' },
      { hoursBefore: 0,  penalty: 5, label: 'last minute / no-show' }
    ]
  }
};

// Merge a stored config over the defaults so new keys always exist.
export function withDefaults(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    scoring: { ...DEFAULT_CONFIG.scoring, ...(config.scoring || {}) }
  };
}

export function hoursUntilKickoff(kickoffAt, now = Date.now()) {
  return (new Date(kickoffAt).getTime() - now) / 3_600_000;
}

// Which penalty applies to a withdrawal `hours` before kickoff.
export function penaltyForHours(hours, config = DEFAULT_CONFIG) {
  const tiers = withDefaults(config).scoring.dropoutTiers;
  for (const t of tiers) if (hours >= t.hoursBefore) return t;
  return tiers[tiers.length - 1];
}

// The heart of it: rank active sign-ups by loyalty (desc), tie-break by the
// time they registered. Top `capacity` are confirmed, the rest waitlist.
// A regular who signs up late still ranks above a casual who got in early —
// which is what kills the "fastest tapper wins" problem.
export function rankSignups(signups = [], playersById = {}, capacity = 14) {
  const active = signups
    .filter(s => s.status !== 'withdrawn')
    .map(s => ({ ...s, player: playersById[s.playerId] }))
    .filter(s => s.player);

  active.sort((a, b) => {
    if (b.player.loyalty !== a.player.loyalty) return b.player.loyalty - a.player.loyalty;
    return new Date(a.joinedAt) - new Date(b.joinedAt);
  });

  return active.map((s, i) => ({
    playerId: s.playerId,
    name: s.player.name,
    loyalty: s.player.loyalty,
    gamesPlayed: s.player.gamesPlayed || 0,
    joinedAt: s.joinedAt,
    rank: i + 1,
    status: i < capacity ? 'confirmed' : 'waitlist'
  }));
}

// Map a ranked list to { playerId: 'confirmed' | 'waitlist' } for diffing.
export function statusMap(ranked = []) {
  const m = {};
  for (const r of ranked) m[r.playerId] = r.status;
  return m;
}

// Compare two status maps and return the transitions worth notifying about.
// We only care about players who moved between confirmed and waitlist while
// still signed up — that's a promotion or a bump caused by someone else.
// Brand-new sign-ups (no previous status) are self-initiated, so we skip them.
export function diffStatuses(prev = {}, curr = {}) {
  const changes = [];
  for (const [playerId, to] of Object.entries(curr)) {
    const from = prev[playerId];
    if (!from || from === to) continue;
    if (from === 'waitlist' && to === 'confirmed') changes.push({ playerId, from, to, kind: 'promoted' });
    else if (from === 'confirmed' && to === 'waitlist') changes.push({ playerId, from, to, kind: 'bumped' });
  }
  return changes;
}

// Freeze the outcome of a game at completion time so history stays accurate
// (it doesn't depend on today's loyalty). Returns { confirmed, reserves }.
export function finalResult(ranked = []) {
  return {
    confirmed: ranked.filter(r => r.status === 'confirmed').map(r => r.playerId),
    reserves: ranked.filter(r => r.status === 'waitlist').map(r => r.playerId)
  };
}

// Per-player attendance stats from the archived completed games, using the
// frozen result recorded on each game (see finalResult / completeGame).
export function playerStats(playerId, games = []) {
  let played = 0, invited = 0, dropouts = 0;
  const history = [];
  for (const g of games) {
    if (g.status !== 'completed' || !g.result) continue;
    const signup = (g.signups || []).find(s => s.playerId === playerId);
    const withdrew = signup && signup.status === 'withdrawn';
    const wasConfirmed = g.result.confirmed.includes(playerId);
    const wasReserve = g.result.reserves.includes(playerId);
    if (!signup && !wasConfirmed && !wasReserve) continue; // wasn't involved
    invited += 1;
    if (wasConfirmed) played += 1;
    if (withdrew) dropouts += 1;
    history.push({ gameId: g.id, dateLabel: g.dateLabel, completedAt: g.completedAt, played: wasConfirmed, reserve: wasReserve && !wasConfirmed, withdrew });
  }
  history.sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
  return { played, invited, dropouts, attendancePct: invited ? Math.round(played / invited * 100) : 0, history };
}

// Organiser-only player attributes, each rated /20. Missing → treated as 10.
export const ATTRS = ['fitness', 'skill', 'strength', 'speed'];
export function attrOverall(player) {
  const a = (player && player.attrs) || {};
  return ATTRS.reduce((s, k) => s + (Number.isFinite(a[k]) ? a[k] : 10), 0);
}

// Split a set of players into two balanced sides (bibs / nonbibs) by overall
// rating. Greedy: strongest first, each goes to the smaller side, or — when
// sides are level — to the one with the lower running total. Keeps sizes
// within one of each other and totals close.
export function balanceTeams(playerIds = [], playersById = {}) {
  const players = playerIds
    .map(id => ({ id, o: attrOverall(playersById[id]) }))
    .sort((a, b) => b.o - a.o || String(a.id).localeCompare(String(b.id)));
  const bibs = [], nonbibs = []; let bt = 0, nt = 0;
  for (const p of players) {
    if (bibs.length < nonbibs.length) { bibs.push(p.id); bt += p.o; }
    else if (nonbibs.length < bibs.length) { nonbibs.push(p.id); nt += p.o; }
    else if (bt <= nt) { bibs.push(p.id); bt += p.o; }
    else { nonbibs.push(p.id); nt += p.o; }
  }
  return { bibs, nonbibs, bibsTotal: bt, nonbibsTotal: nt };
}

// Win/loss analytics from games that recorded two teams + a score.
// Each such game has teams:{bibs:[ids],nonbibs:[ids]} and scores:{bibs,nonbibs}.
export function playerAnalytics(playerId, games = []) {
  const rel = games
    .filter(g => g.status === 'completed' && g.teams && g.scores)
    .map(g => {
      const side = (g.teams.bibs || []).includes(playerId) ? 'bibs'
        : (g.teams.nonbibs || []).includes(playerId) ? 'nonbibs' : null;
      if (!side) return null;
      const other = side === 'bibs' ? 'nonbibs' : 'bibs';
      const gf = g.scores[side], ga = g.scores[other];
      return { date: g.date, dateLabel: g.dateLabel, gf, ga, outcome: gf > ga ? 'W' : gf < ga ? 'L' : 'D' };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const played = rel.length;
  const wins = rel.filter(r => r.outcome === 'W').length;
  const draws = rel.filter(r => r.outcome === 'D').length;
  const losses = rel.filter(r => r.outcome === 'L').length;
  const gf = rel.reduce((s, r) => s + r.gf, 0);
  const ga = rel.reduce((s, r) => s + r.ga, 0);

  let longestWin = 0, longestUnbeaten = 0, w = 0, u = 0;
  for (const r of rel) {
    w = r.outcome === 'W' ? w + 1 : 0; longestWin = Math.max(longestWin, w);
    u = r.outcome !== 'L' ? u + 1 : 0; longestUnbeaten = Math.max(longestUnbeaten, u);
  }
  let current = { type: null, count: 0 };
  for (let i = rel.length - 1; i >= 0; i--) {
    if (current.type === null) current = { type: rel[i].outcome, count: 1 };
    else if (rel[i].outcome === current.type) current.count++;
    else break;
  }
  return {
    played, wins, draws, losses,
    winPct: played ? Math.round(wins / played * 100) : 0,
    gf, ga, gd: gf - ga,
    currentStreak: current, longestWin, longestUnbeaten,
    form: rel.slice(-6).reverse().map(r => r.outcome),   // newest first
    log: rel.slice().reverse()
  };
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function nextKickoffISO(config = DEFAULT_CONFIG, now = new Date()) {
  const c = withDefaults(config);
  const targetDow = DAYS.indexOf(c.gameDay);
  const [hh, mm] = String(c.kickoff).split(':').map(Number);
  const result = new Date(now);
  result.setHours(hh || 20, mm || 0, 0, 0);
  let add = (targetDow - now.getDay() + 7) % 7;
  if (add === 0 && result <= now) add = 7;
  result.setDate(result.getDate() + add);
  return result.toISOString();
}

export function nextGameLabel(config = DEFAULT_CONFIG, now = new Date()) {
  const d = new Date(nextKickoffISO(config, now));
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
}

// Seed roster from the group so the app is usable on day one.
export const SEED_NAMES = [
  'Faisal', 'Haroon Hanif', 'Haseeb', 'Shergal Rodaina', 'Tom Exon',
  'Haris Farooq', 'Suki', 'Darren Ellis', 'Matthew Eastwood', 'Ismael Nazar',
  'Lee', 'Hamad', 'James Roberts', 'Marc Coleman', 'Shakeel', 'Oli Scott',
  'Tom Clapham'
];
