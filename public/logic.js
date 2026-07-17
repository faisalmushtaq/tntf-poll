// logic.js — pure selection/loyalty logic. No I/O, no framework.
// Imported by both the browser app and the Node tests, so it stays testable.

export const DEFAULT_CONFIG = {
  clubName: 'Tuesday Night Total Football',
  gameDay: 'Tuesday',
  kickoff: '20:00',        // 24h local time; default next Tuesday 8pm
  venue: 'Pitch 10 - Nou Camp', // default venue; editable per game / in settings
  lat: 53.81928,           // venue latitude  (Pitch 10 - Nou Camp); editable in Settings
  lon: -1.74367,           // venue longitude (Open-Meteo, no API key needed)
  capacity: 14,            // 7-a-side default
  adminPin: '1234',        // change from Settings
  stattoPin: '2468',       // stats-keeper role: edit scores + enter goalscorers
  organiserEmail: '',      // where the auto-close squad alert is sent
  scoring: {
    playedReward: 2,       // loyalty gained for turning up
    weatherBonus: 1,       // extra loyalty when the game is cold/wet (adverse)
    coldSeasonBonus: 1,    // extra loyalty for playing in the cold-season months
    coldMonths: [10, 11, 0, 1, 2], // Nov–Mar (0-indexed) count as cold season
    lateSignupBonusGames: 4, // stepping in late (see lateSignupHours) is worth this many games' reward
    lateSignupHours: 24,     // "last minute" = signed up within this many hours of kickoff
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
// One-time config self-heal: brings a stored config up to the current defaults
// for the venue name and pitch coordinates (which older seeds saved as the old
// placeholder / null). Returns the patch to apply, or {} if already current.
export function configMigrationPatch(config = {}) {
  const c = withDefaults(config);
  const patch = {};
  if (c.venue === 'Pitch 10') patch.venue = DEFAULT_CONFIG.venue; // the old placeholder default
  if (c.lat == null) patch.lat = DEFAULT_CONFIG.lat;
  if (c.lon == null) patch.lon = DEFAULT_CONFIG.lon;
  return patch;
}

// Find duplicate player records that are provably the same person (they share
// a Firebase uid) and return the merges to collapse them: [{ keep, drop }].
// Keeps the richest record — most games, then a real profile over a bare
// account, then higher loyalty, then the oldest — and folds the rest into it.
export function duplicateMerges(playersById = {}) {
  const groups = {};
  for (const p of Object.values(playersById)) {
    if (!p.uid) continue;
    (groups[p.uid] ||= []).push(p);
  }
  const merges = [];
  for (const group of Object.values(groups)) {
    if (group.length < 2) continue;
    group.sort((a, b) =>
      (b.gamesPlayed || 0) - (a.gamesPlayed || 0) ||
      ((a.account ? 1 : 0) - (b.account ? 1 : 0)) ||
      (b.loyalty || 0) - (a.loyalty || 0) ||
      String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    const keep = group[0];
    for (const drop of group.slice(1)) merges.push({ keep: keep.id, drop: drop.id });
  }
  return merges;
}

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

// The players who took part in a game (both teams; falls back to the result).
export function gamePlayers(g) {
  if (g.teams) return [...new Set([...(g.teams.bibs || []), ...(g.teams.nonbibs || [])])];
  if (g.result) return [...new Set(g.result.confirmed || [])];
  return [];
}

// Recompute every player's loyalty purely from the completed match history,
// applying the played reward plus the weather (adverse) and cold-season bonuses.
// `adverseByGameId` says which games were cold/wet (the caller fetches weather).
// Returns { [playerId]: { loyalty, gamesPlayed } }.
export function recomputeLoyalty(games = [], config = {}, adverseByGameId = {}) {
  const s = withDefaults(config).scoring;
  const totals = {};
  for (const g of games) {
    if (g.status !== 'completed') continue;
    const cold = isColdSeason(g.date || g.completedAt || g.kickoffAt || 0, config);
    const per = s.playedReward + (adverseByGameId[g.id] ? (s.weatherBonus || 0) : 0) + (cold ? (s.coldSeasonBonus || 0) : 0);
    for (const id of gamePlayers(g)) {
      (totals[id] ||= { loyalty: 0, gamesPlayed: 0 });
      totals[id].loyalty += per;
      totals[id].gamesPlayed += 1;
    }
  }
  return totals;
}

// Is this date in the configured cold-season months?
export function isColdSeason(date, config = {}) {
  const months = withDefaults(config).scoring.coldMonths || [];
  return months.includes(new Date(date).getMonth());
}

// Did this sign-up happen inside the "last minute" window before kickoff?
export function isLateSignup(config = {}, joinedAt, kickoffAt) {
  if (!joinedAt || !kickoffAt) return false;
  const s = withDefaults(config).scoring;
  return hoursUntilKickoff(kickoffAt, new Date(joinedAt).getTime()) <= (s.lateSignupHours ?? 24);
}

// Which confirmed players earn the last-minute "stepping in" bonus, and how
// much each. Only rewards genuine gap-filling: if the players who signed up in
// good time already fill the squad, nobody needed to step in, so no bonus. The
// number of bonuses is capped at the number of gaps (capacity minus the count
// of non-late active sign-ups), handed to the highest-ranked late sign-ups.
// Returns { [playerId]: loyaltyAmount }.
export function lateSignupAwards(signups = [], playersById = {}, config = {}, kickoffAt, capacity = 14) {
  const s = withDefaults(config).scoring;
  const games = s.lateSignupBonusGames || 0;
  const perAward = s.playedReward * games;
  const out = {};
  if (!games || !perAward || !kickoffAt) return out;
  const active = signups.filter(x => x.status !== 'withdrawn');
  const nonLate = active.filter(su => !isLateSignup(config, su.joinedAt, kickoffAt)).length;
  let gaps = Math.max(0, capacity - nonLate);
  if (gaps <= 0) return out;
  for (const r of rankSignups(active, playersById, capacity)) {
    if (r.status !== 'confirmed' || gaps <= 0) break;
    if (isLateSignup(config, r.joinedAt, kickoffAt)) { out[r.playerId] = perAward; gaps--; }
  }
  return out;
}

// Bonus loyalty for playing a game in tough conditions. Adverse weather
// (cold/wet) and the cold season stack. Returns the total and human reasons.
export function completionBonus(config = {}, { adverseWeather = false, coldSeason = false } = {}) {
  const s = withDefaults(config).scoring;
  let bonus = 0; const reasons = [];
  if (adverseWeather && s.weatherBonus) { bonus += s.weatherBonus; reasons.push(`adverse weather +${s.weatherBonus}`); }
  if (coldSeason && s.coldSeasonBonus) { bonus += s.coldSeasonBonus; reasons.push(`cold season +${s.coldSeasonBonus}`); }
  return { bonus, reasons };
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
  let played = 0, invited = 0, dropouts = 0, total = 0;
  const history = [];
  for (const g of games) {
    if (g.status !== 'completed' || !g.result) continue;
    total += 1; // every completed game the club has played
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
  // Attendance is turnout across ALL the club's games, not just those you were in.
  return { played, invited, dropouts, total, attendancePct: total ? Math.round(played / total * 100) : 0, history };
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
      const pg = (g.stats && g.stats[playerId] && Number(g.stats[playerId].g)) || (g.goals && Number(g.goals[playerId])) || 0; // personal goals this game
      return { date: g.date, dateLabel: g.dateLabel, gf, ga, pg, outcome: gf > ga ? 'W' : gf < ga ? 'L' : 'D' };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const played = rel.length;
  const wins = rel.filter(r => r.outcome === 'W').length;
  const draws = rel.filter(r => r.outcome === 'D').length;
  const losses = rel.filter(r => r.outcome === 'L').length;
  const gf = rel.reduce((s, r) => s + r.gf, 0);
  const ga = rel.reduce((s, r) => s + r.ga, 0);
  const pg = rel.reduce((s, r) => s + r.pg, 0); // total personal goals

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
    gf, ga, gd: gf - ga, pg,
    currentStreak: current, longestWin, longestUnbeaten,
    form: rel.slice(-6).reverse().map(r => r.outcome),   // newest first
    log: rel.slice().reverse()
  };
}

// Per-player match performance stats, in priority order (goals first). Stored
// per game as game.stats[playerId] = { g, a, sv, ... }. Realistically only the
// early ones (goals, assists) get filled in each week; the rest when we have it.
export const STATS = [
  { key: 'g', label: 'Goals', short: 'G' },
  { key: 'a', label: 'Assists', short: 'A' },
  { key: 'sv', label: 'Saves', short: 'Sv' },
  { key: 'sh', label: 'Shots', short: 'Sh' },
  { key: 'sot', label: 'On target', short: 'SoT' },
  { key: 'tkl', label: 'Tackles', short: 'Tkl' },
  { key: 'blk', label: 'Blocks', short: 'Blk' },
  { key: 'pass', label: 'Passes', short: 'Pass' },
  { key: 'passc', label: 'Passes completed', short: 'Pass✓' },
  { key: 'pp', label: 'Progressive passes', short: 'PP' },
  { key: 'ppc', label: 'Prog. passes completed', short: 'PP✓' },
  { key: 'ww', label: 'Hit woodwork', short: 'WW' }
];

// A player's rating for one game: the average of their self-rating and the
// Statto's rating when both exist, otherwise whichever one is present (1–5),
// or null when neither has been given.
export function effectiveRating(g, playerId) {
  if (!g) return null;
  const self = g.selfRatings && Number(g.selfRatings[playerId]);
  const statto = g.stattoRatings && Number(g.stattoRatings[playerId]);
  const vals = [self, statto].filter(v => Number.isFinite(v) && v > 0);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// Was this player named man of the match in this game?
export function isMotm(g, playerId) {
  return Array.isArray(g && g.motm) && g.motm.includes(playerId);
}

// Sum a player's stats across all games that have them recorded, plus the
// season-long extras: average rating, man-of-the-match count and own goals.
export function playerPerformance(playerId, games = []) {
  const t = {}; for (const s of STATS) t[s.key] = 0;
  let n = 0, ratingSum = 0, ratingGames = 0, motm = 0, og = 0;
  for (const g of games) {
    if (g.status !== 'completed') continue;
    if (g.stats && g.stats[playerId]) {
      n++; const st = g.stats[playerId];
      for (const s of STATS) t[s.key] += Number(st[s.key]) || 0;
    }
    const r = effectiveRating(g, playerId);
    if (r != null) { ratingSum += r; ratingGames++; }
    if (isMotm(g, playerId)) motm++;
    og += (g.ownGoals && Number(g.ownGoals[playerId])) || 0;
  }
  t.games = n;
  t.passPct = t.pass ? Math.round(t.passc / t.pass * 100) : 0;
  t.ppPct = t.pp ? Math.round(t.ppc / t.pp * 100) : 0;
  t.sotPct = t.sh ? Math.round(t.sot / t.sh * 100) : 0;
  t.ratingGames = ratingGames;
  t.rating = ratingGames ? Math.round(ratingSum / ratingGames * 10) / 10 : 0;
  t.motm = motm;
  t.og = og;
  return t;
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
