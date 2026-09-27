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
  adminPin: '07525418924', // organiser PIN; change from Settings
  stattoPin: '7869',       // stats-keeper role: edit scores + enter goalscorers
  configVersion: 4,        // bump to trigger a one-time config self-heal (see configMigrationPatch)
  pollOpenDay: 'Friday',   // the notifier auto-opens the next poll on this day…
  pollOpenTime: '10:00',   // …at this time (once last week's result is recorded)
  timeZone: 'Europe/London', // club wall-clock time for schedules, labels and automated cut-offs
  announceGraceMinutes: 60, // review window before most announcement emails auto-send
  lineupHoursBefore: 2,     // the line-up email auto-sends this many hours before kickoff
  pitchCost: 113,           // total £ to hire the pitch; split across the squad for per-player cost
  promptHours: 24,         // sign up within this long of the poll opening → full loyalty counts…
  lateLoyaltyFactor: 0.5,  // …sign up after that and your loyalty counts this fraction for a spot
  eightASideBias: 1.25,    // 7-a-side is the weekly default; only auto-switch to 8 when the loyalty behind "8" beats the loyalty behind "7" by MORE than this multiple. Biases us toward 7; reviewable.
  organiserEmail: '',      // where the auto-close squad alert is sent
  scoring: {
    playedReward: 2,       // loyalty gained for turning up
    weatherBonus: 1,       // extra loyalty when the game is cold/wet (adverse)
    coldSeasonBonus: 1,    // extra loyalty for playing in the cold-season months
    promptBonus: 1,        // extra loyalty (on top of the played reward) for a prompt sign-up who's benched — so a keen reserve earns one MORE than a player, and climbs faster
    coldMonths: [10, 11, 0, 1, 2], // Nov–Mar (0-indexed) count as cold season
    lateSignupBonusGames: 4, // stepping in late (see lateSignupHours) is worth this many games' reward
    lateSignupHours: 24,     // "last minute" = signed up within this many hours of kickoff
    // Time-weighted dropout penalty. The first tier whose `hoursBefore`
    // cutoff the withdrawal is still outside of applies. Cutoffs are hours
    // before kickoff; for the usual Tue 8pm game that reads as:
    //   >=27h (before 5pm Mon) free · <27h (after 5pm Mon) -3 ·
    //   <12h (from 8am) -5 · <6h (from 2pm) -8 · <3h (from 5pm) / no-show -10.
    dropoutTiers: [
      { hoursBefore: 27, penalty: 0,  label: 'before 5pm Monday' },
      { hoursBefore: 12, penalty: 3,  label: 'after 5pm Monday' },
      { hoursBefore: 6,  penalty: 5,  label: 'within 12 hours (from 8am)' },
      { hoursBefore: 3,  penalty: 8,  label: 'within 6 hours' },
      { hoursBefore: 0,  penalty: 10, label: 'within 3 hours / no-show' }
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
  // Version-gated one-time self-heals. Gated on the stored version (not
  // withDefaults') so each applies exactly once and never overrides a value the
  // organiser later changes in Settings.
  const v = Number(config.configVersion) || 0;
  if (v < 2) { // adopt the current organiser + Statto PINs
    patch.adminPin = DEFAULT_CONFIG.adminPin;
    patch.stattoPin = DEFAULT_CONFIG.stattoPin;
  }
  if (v < 3) { // adopt the current dropout-penalty tiers
    patch.scoring = { ...(patch.scoring || {}), dropoutTiers: DEFAULT_CONFIG.scoring.dropoutTiers };
  }
  if (v < 4) patch.timeZone = DEFAULT_CONFIG.timeZone;
  if (v < 4) patch.configVersion = 4;
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
export function lateSignupAwards(signups = [], playersById = {}, config = {}, kickoffAt, capacity = 14, pollOpenAt = null) {
  const s = withDefaults(config).scoring;
  const games = s.lateSignupBonusGames || 0;
  const perAward = s.playedReward * games;
  const out = {};
  if (!games || !perAward || !kickoffAt) return out;
  const active = signups.filter(x => x.status !== 'withdrawn');
  const nonLate = active.filter(su => !isLateSignup(config, su.joinedAt, kickoffAt)).length;
  let gaps = Math.max(0, capacity - nonLate);
  if (gaps <= 0) return out;
  for (const r of rankSignups(active, playersById, capacity, { pollOpenAt, config })) {
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

// Was a sign-up "prompt" — made within promptHours of the poll opening?
export function isPromptSignup(config = {}, joinedAt, pollOpenAt) {
  if (!pollOpenAt || !joinedAt) return true; // no release time known → treat as prompt
  const h = withDefaults(config).promptHours ?? 24;
  return (new Date(joinedAt).getTime() - new Date(pollOpenAt).getTime()) <= h * 3600000;
}

// The loyalty a sign-up carries into the ranking. Sign up promptly (within
// promptHours of the poll opening) and your full loyalty counts; sign up later
// and it counts only `lateLoyaltyFactor` of it — so a keen early sign-up can
// leapfrog a higher-loyalty regular who's slow off the mark.
export function effectiveLoyalty(rawLoyalty = 0, joinedAt, pollOpenAt, config = {}) {
  if (isPromptSignup(config, joinedAt, pollOpenAt)) return rawLoyalty;
  const f = withDefaults(config).lateLoyaltyFactor;
  return rawLoyalty * (Number.isFinite(f) ? f : 0.5);
}

// The heart of it: rank active sign-ups by their *effective* loyalty (desc),
// tie-break by the time they registered. Top `capacity` are confirmed, the rest
// waitlist. A regular who signs up in good time still ranks above a casual who
// got in early — which kills the "fastest tapper wins" problem — but a regular
// who's slow (past the prompt window) has their loyalty halved, opening the door
// to keen early birds. Pass opts.pollOpenAt (the poll's release time) + config
// to enable this; without it, ranking falls back to raw loyalty.
export function rankSignups(signups = [], playersById = {}, capacity = 14, opts = {}) {
  const { pollOpenAt = null, config = {} } = opts;
  const active = signups
    .filter(s => s.status !== 'withdrawn' && s.status !== 'out')
    .map(s => {
      const player = playersById[s.playerId];
      const eff = pollOpenAt && player ? effectiveLoyalty(player.loyalty, s.joinedAt, pollOpenAt, config) : (player ? player.loyalty : 0);
      return { ...s, player, eff, prompt: isPromptSignup(config, s.joinedAt, pollOpenAt) };
    })
    .filter(s => s.player);

  active.sort((a, b) => {
    if (b.eff !== a.eff) return b.eff - a.eff;
    return new Date(a.joinedAt) - new Date(b.joinedAt);
  });

  return active.map((s, i) => ({
    playerId: s.playerId,
    name: s.player.name,
    loyalty: s.player.loyalty,
    effLoyalty: s.eff,
    prompt: s.prompt,
    gamesPlayed: s.player.gamesPlayed || 0,
    joinedAt: s.joinedAt,
    rank: i + 1,
    status: i < capacity ? 'confirmed' : 'waitlist'
  }));
}

// The reserve list for a finalised line-up: available sign-ups (in loyalty
// rank order) who are NOT on the team sheet. So anyone the organiser placed
// into a team — even a waitlisted player promoted into the squad, or a
// last-minute add-in — drops off the reserves, and anyone taken out of the
// squad rejoins them. Keeps the announcement's reserves from duplicating
// names already in the line-up. Returns player names.
export function lineupReserves(signups = [], playersById = {}, teams = {}, capacity = 14, opts = {}) {
  const inTeam = new Set([...(teams.bibs || []), ...(teams.nonbibs || [])]);
  return rankSignups(signups, playersById, capacity, opts)
    .filter(r => !inTeam.has(r.playerId))
    .map(r => r.name);
}

// The "prompt sign-up" reward: a keen reserve who signed up promptly but didn't
// make the squad gets the played reward PLUS the prompt bonus — i.e. one more
// point than the players who actually played. This is the incentive that keeps
// new/keen players signing up (and softens the disappointment of missing out),
// so they climb and eventually get a game. Returns { [playerId]: loyaltyAmount }.
export function promptSignupAwards(signups = [], playersById = {}, config = {}, pollOpenAt = null, capacity = 14, playedIds = null) {
  const s = withDefaults(config).scoring;
  const bonus = Number(s.promptBonus) || 0;
  const out = {};
  if (!bonus) return out;
  const award = (Number(s.playedReward) || 0) + bonus;
  // "Didn't play" is the actual team sheet when the organiser finalised it
  // (they may have added/removed people); otherwise it's the ranked reserves.
  const played = playedIds ? new Set(playedIds) : null;
  for (const r of rankSignups(signups, playersById, capacity, { pollOpenAt, config })) {
    const missedOut = played ? !played.has(r.playerId) : r.status === 'waitlist';
    if (missedOut && r.prompt) out[r.playerId] = award;
  }
  return out;
}

// Decide the format — 5, 7 or 8-a-side — from turnout and preferences.
//
//  · Turnout is the number of sign-ups who are in (not out / withdrawn).
//  · 14 = a full 7-a-side, 16 = a full 8-a-side, 10 = a 5-a-side.
//  · 7-a-side is the weekly default. It only flips to 8-a-side when there are
//    enough bodies (>=16) AND the loyalty behind the "8" camp beats the loyalty
//    behind the "7" camp by MORE than the `eightASideBias` multiple (1.25). So
//    it takes an overwhelming, loyalty-weighted preference to override the
//    default — a slim majority won't do it.
//  · 11–13 is an awkward middle: too few for 7-a-side, too many for a clean
//    5-a-side, so the top 10 (by the usual loyalty ranking) play a 5-a-side —
//    but only if an alternative (smaller) pitch can be found; otherwise the
//    date/time has to change or the game is cancelled. `needsPitch` flags that.
//  · 10 or fewer → a straight 5-a-side (also needs a smaller pitch).
//
// A player's preference comes from the sign-up (`formatPref`, a per-week
// override) or the player's standing `formatPref` (7 or 8); anyone with no
// preference is happy with the default and counts for neither camp.
export function recommendedFormat(signups = [], playersById = {}, config = DEFAULT_CONFIG) {
  const c = withDefaults(config);
  const bias = Number(c.eightASideBias) > 0 ? Number(c.eightASideBias) : 1.25;
  const avail = signups.filter(s => s && s.status !== 'out' && s.status !== 'withdrawn');
  const count = avail.length;

  // Loyalty (and headcount) behind each of the 7- vs 8-a-side camps.
  let pts7 = 0, pts8 = 0, n7 = 0, n8 = 0;
  for (const s of avail) {
    const p = playersById[s.playerId];
    const pref = Number(s.formatPref) || (p && Number(p.formatPref)) || 0;
    const loyalty = p ? (Number(p.loyalty) || 0) : 0;
    if (pref === 8) { pts8 += loyalty; n8++; }
    else if (pref === 7) { pts7 += loyalty; n7++; }
  }
  const wantsEight = pts8 > pts7 * bias;
  const threshold = pts7 * bias;

  let format, capacity, needsPitch = false, note = '';
  if (count >= 16 && wantsEight) {
    format = 8; capacity = 16;
    note = `The loyalty behind 8-a-side (${pts8}) beats 7-a-side's ${pts7} × ${bias} = ${round1(threshold)}, so it flips to 8.`;
  } else if (count >= 14) {
    format = 7; capacity = 14;
    note = (n8 && count < 16)
      ? `${n8} would prefer 8-a-side, but there aren't ${16} in for it — staying 7-a-side.`
      : `7-a-side is the weekly default; the 8-camp's loyalty (${pts8}) doesn't clear ${pts7} × ${bias} = ${round1(threshold)}.`;
  } else if (count > 10) {
    format = 5; capacity = 10; needsPitch = true;
    note = `Only ${count} in — too few for 7-a-side. The top 10 play a 5-a-side, if a smaller pitch can be found; otherwise change the date/time or cancel.`;
  } else {
    format = 5; capacity = 10; needsPitch = true;
    note = `Only ${count} in — a 5-a-side, if a smaller pitch can be found.`;
  }
  return { format, capacity, count, wantsEight, pts7, pts8, n7, n8, eightBias: bias, threshold, needsPitch, note };
}

function round1(n) { return Math.round(n * 10) / 10; }

// The squad size to actually use for a game. While the organiser hasn't locked
// it (game.capacityLocked), it follows the recommended format live — so the
// squad grows/shrinks (10 → 14 → 16) as people sign up and register their 7-vs-8
// preference. Once locked (a manual size, or "finalise"), the stored capacity
// wins. Falls back to the config default when there's no game.
export function effectiveCapacity(game, signups = [], playersById = {}, config = DEFAULT_CONFIG) {
  if (!game) return withDefaults(config).capacity;
  if (game.capacityLocked) return Number(game.capacity) || withDefaults(config).capacity;
  return recommendedFormat(signups, playersById, config).capacity;
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
    // Prefer the denormalized withdrawnIds (so history loads don't need signups);
    // fall back to the per-signup status for older games / the live game object.
    const withdrew = Array.isArray(g.withdrawnIds)
      ? g.withdrawnIds.includes(playerId)
      : !!(signup && signup.status === 'withdrawn');
    const wasConfirmed = g.result.confirmed.includes(playerId);
    const wasReserve = g.result.reserves.includes(playerId);
    if (!wasConfirmed && !wasReserve && !withdrew && !signup) continue; // wasn't involved
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
    // Oldest → newest. Games completed in-app have no `date`, so fall back to
    // completedAt/kickoffAt — otherwise the chronological order (and with it the
    // form guide and current streak) breaks. Sort before mapping so the entries
    // stay clean.
    .slice()
    .sort((a, b) => new Date(a.date || a.completedAt || a.kickoffAt || 0) - new Date(b.date || b.completedAt || b.kickoffAt || 0))
    .map(g => {
      const side = (g.teams.bibs || []).includes(playerId) ? 'bibs'
        : (g.teams.nonbibs || []).includes(playerId) ? 'nonbibs' : null;
      if (!side) return null;
      const other = side === 'bibs' ? 'nonbibs' : 'bibs';
      const gf = g.scores[side], ga = g.scores[other];
      const pg = (g.stats && g.stats[playerId] && Number(g.stats[playerId].g)) || (g.goals && Number(g.goals[playerId])) || 0; // personal goals this game
      return { date: g.date, dateLabel: g.dateLabel, gf, ga, pg, outcome: gf > ga ? 'W' : gf < ga ? 'L' : 'D' };
    })
    .filter(Boolean);

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
  let n = 0, ratingSum = 0, ratingGames = 0, motm = 0, og = 0, appearances = 0;
  for (const g of games) {
    if (g.status !== 'completed') continue;
    // Games played: on the team sheet (or the result) — counts whether or not
    // any goals/stats were logged, so a player who turned out and didn't score
    // still shows a game played.
    if (gamePlayers(g).includes(playerId)) appearances++;
    const st = g.stats && g.stats[playerId];
    if (st) {
      // Full stat line. (When it's present, g.goals is derived from it, so we
      // read goals from here — never both — to avoid double-counting.)
      n++;
      for (const s of STATS) t[s.key] += Number(st[s.key]) || 0;
    } else {
      // No full line, but a goal logged via the quick scorer entry (g.goals)
      // still counts the game as recorded and the goal toward the total —
      // that's the usual weekly case where only goals get noted.
      const gq = (g.goals && Number(g.goals[playerId])) || 0;
      if (gq > 0) { n++; t.g += gq; }
    }
    const r = effectiveRating(g, playerId);
    if (r != null) { ratingSum += r; ratingGames++; }
    if (isMotm(g, playerId)) motm++;
    og += (g.ownGoals && Number(g.ownGoals[playerId])) || 0;
  }
  t.games = n;
  t.appearances = appearances;
  t.passPct = t.pass ? Math.round(t.passc / t.pass * 100) : 0;
  t.ppPct = t.pp ? Math.round(t.ppc / t.pp * 100) : 0;
  t.sotPct = t.sh ? Math.round(t.sot / t.sh * 100) : 0;
  t.ratingGames = ratingGames;
  t.rating = ratingGames ? Math.round(ratingSum / ratingGames * 10) / 10 : 0;
  t.motm = motm;
  t.og = og;
  return t;
}

// Build a per-player stats index in one pass over history, so screens don't
// recompute analytics on every render. Returns IDs only (names are resolved at
// render time). For each player: the existing analytics/performance/attendance
// (reused verbatim, so output is identical to computing them ad hoc), plus a
// teammates matrix (same-side co-appearances), an opponents matrix (faced), and
// a chronological per-game `series` for the form-over-time plots.
export function buildStatsIndex(games = [], playersById = {}) {
  // Completed games with two teams and a score, oldest first.
  const rel = games
    .filter(g => g.status === 'completed' && g.teams && g.scores)
    .slice()
    .sort((a, b) => new Date(a.date || a.completedAt || 0) - new Date(b.date || b.completedAt || 0));

  const acc = {}; // id -> { teammates:{}, opponents:{}, series:[] }
  const ensure = id => (acc[id] ||= { teammates: {}, opponents: {}, series: [] });
  const credit = (bucket, key, outcome) => {
    const m = (bucket[key] ||= { id: key, games: 0, wins: 0, draws: 0, losses: 0 });
    m.games++; if (outcome === 'W') m.wins++; else if (outcome === 'D') m.draws++; else m.losses++;
  };

  for (const g of rel) {
    const bibs = g.teams.bibs || [], nonbibs = g.teams.nonbibs || [];
    for (const side of ['bibs', 'nonbibs']) {
      const mine = side === 'bibs' ? bibs : nonbibs;
      const theirs = side === 'bibs' ? nonbibs : bibs;
      const other = side === 'bibs' ? 'nonbibs' : 'bibs';
      const gf = Number(g.scores[side]) || 0, ga = Number(g.scores[other]) || 0;
      const outcome = gf > ga ? 'W' : gf < ga ? 'L' : 'D';
      for (const id of mine) {
        const rec = ensure(id);
        for (const t of mine) if (t !== id) credit(rec.teammates, t, outcome);
        for (const o of theirs) credit(rec.opponents, o, outcome);
        const pg = (g.stats && g.stats[id] && Number(g.stats[id].g)) || (g.goals && Number(g.goals[id])) || 0;
        rec.series.push({ date: g.date, dateLabel: g.dateLabel, gf, ga, pg, outcome, rating: effectiveRating(g, id) });
      }
    }
  }

  const withPct = m => ({ ...m, winPct: m.games ? Math.round(m.wins / m.games * 100) : 0 });
  const rank = obj => Object.values(obj).map(withPct)
    .sort((a, b) => b.games - a.games || b.winPct - a.winPct || String(a.id).localeCompare(String(b.id)));

  const out = { version: rel.length, players: {} };
  const ids = new Set([...Object.keys(playersById), ...Object.keys(acc)]);
  for (const id of ids) {
    const rec = acc[id] || { teammates: {}, opponents: {}, series: [] };
    let cumPts = 0, cumGD = 0; const recent = [];
    const series = rec.series.map(s => {
      cumPts += s.outcome === 'W' ? 3 : s.outcome === 'D' ? 1 : 0;
      cumGD += s.gf - s.ga;
      recent.push(s.outcome === 'W' ? 1 : 0);
      const last = recent.slice(-5);
      const rollWin = Math.round(last.reduce((a, b) => a + b, 0) / last.length * 100);
      return { ...s, cumPts, cumGD, rollWin };
    });
    out.players[id] = {
      analytics: playerAnalytics(id, games),
      performance: playerPerformance(id, games),
      attendance: playerStats(id, games),
      teammates: rank(rec.teammates),
      opponents: rank(rec.opponents),
      series
    };
  }
  return out;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Scheduling is club-local rather than device-local. This keeps the browser,
// GitHub Actions and organisers travelling outside the UK aligned through DST.
export function clubTimeZone(config = DEFAULT_CONFIG) {
  const candidate = String(withDefaults(config).timeZone || DEFAULT_CONFIG.timeZone).trim();
  try {
    Intl.DateTimeFormat('en-GB', { timeZone: candidate }).format();
    return candidate;
  } catch {
    return DEFAULT_CONFIG.timeZone;
  }
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value;
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')), minute: Number(get('minute')), second: Number(get('second')),
    weekday: get('weekday')
  };
}

function civilDateShift({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Convert a club-wall-clock date and time into an absolute ISO time. Weekly
// evening sessions avoid ambiguous DST transition hours; a second pass still
// ensures the current offset is used after a seasonal clock change.
function zonedISO({ year, month, day, hour, minute }, timeZone) {
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetAt = instant => {
    const p = zonedParts(new Date(instant), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
  };
  let instant = wallUtc - offsetAt(wallUtc);
  instant = wallUtc - offsetAt(instant);
  return new Date(instant).toISOString();
}

function timeParts(value, fallbackHour) {
  const [rawHour, rawMinute] = String(value || '').split(':').map(Number);
  return {
    hour: Number.isInteger(rawHour) && rawHour >= 0 && rawHour <= 23 ? rawHour : fallbackHour,
    minute: Number.isInteger(rawMinute) && rawMinute >= 0 && rawMinute <= 59 ? rawMinute : 0
  };
}

// Convert a datetime-local field into an absolute instant using the club clock,
// not the organiser's browser clock. Returns null for an invalid entry.
export function clubDateTimeToISO(value, config = DEFAULT_CONFIG) {
  const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  return zonedISO({ year, month, day, hour, minute }, clubTimeZone(config));
}

// Format an absolute instant for a datetime-local field in the club timezone.
export function clubDateTimeInput(iso, config = DEFAULT_CONFIG) {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '';
  const p = zonedParts(d, clubTimeZone(config));
  const pad = n => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// The weekly auto-lock time: 17:00 on the club-calendar day before kickoff.
export function squadLockCutoffISO(kickoffAt, config = DEFAULT_CONFIG) {
  const d = new Date(kickoffAt); if (Number.isNaN(d.getTime())) return null;
  const timeZone = clubTimeZone(config);
  const local = zonedParts(d, timeZone);
  const prior = civilDateShift(local, -1);
  return zonedISO({ ...prior, hour: 17, minute: 0 }, timeZone);
}

export function nextKickoffISO(config = DEFAULT_CONFIG, now = new Date()) {
  const c = withDefaults(config), timeZone = clubTimeZone(c);
  const local = zonedParts(now, timeZone);
  const targetDow = DAYS.indexOf(c.gameDay);
  const { hour, minute } = timeParts(c.kickoff, 20);
  let add = ((targetDow < 0 ? 2 : targetDow) - DAYS.indexOf(local.weekday) + 7) % 7;
  let civil = civilDateShift(local, add);
  let result = zonedISO({ ...civil, hour, minute }, timeZone);
  if (new Date(result) <= now) {
    civil = civilDateShift(civil, 7);
    result = zonedISO({ ...civil, hour, minute }, timeZone);
  }
  return result;
}

export function nextGameLabel(config = DEFAULT_CONFIG, now = new Date()) {
  const c = withDefaults(config);
  const d = new Date(nextKickoffISO(c, now));
  return d.toLocaleDateString('en-GB', { timeZone: clubTimeZone(c), weekday: 'long', day: 'numeric', month: 'short' });
}

// The most recent occurrence of `dayName` at HH:MM in the club's timezone.
export function mostRecentWeekly(dayName, time, now = new Date(), timeZone = DEFAULT_CONFIG.timeZone) {
  const zone = clubTimeZone({ timeZone });
  const local = zonedParts(now, zone);
  const dow = DAYS.indexOf(dayName);
  const { hour, minute } = timeParts(time, 0);
  let back = (DAYS.indexOf(local.weekday) - (dow < 0 ? 5 : dow) + 7) % 7;
  let civil = civilDateShift(local, -back);
  let result = zonedISO({ ...civil, hour, minute }, zone);
  if (back === 0 && new Date(result) > now) {
    civil = civilDateShift(civil, -7);
    result = zonedISO({ ...civil, hour, minute }, zone);
  }
  return new Date(result);
}

// Decide whether the notifier should auto-open a new poll right now.
// Returns { kickoffAt, dateLabel } when it should, or null when it should not.
// Guard: never opens while last week's game is still open/locked (unresolved) —
// the organiser needs to record the result first, which banks loyalty. Once the
// previous game is completed or cancelled, opening becomes safe.
export function autoOpenPlan(config, currentGame, now = new Date(), alreadyOpenedKickoff = null) {
  const c = withDefaults(config);
  if (currentGame && currentGame.status !== 'completed' && currentGame.status !== 'cancelled') return null;
  const openMoment = mostRecentWeekly(c.pollOpenDay, c.pollOpenTime, now, clubTimeZone(c));
  const kickoffAt = nextKickoffISO(c, openMoment);
  if (alreadyOpenedKickoff === kickoffAt) return null; // already opened this week's poll
  if (new Date(kickoffAt) <= now) return null;         // kickoff already passed — nothing to open
  // Never re-open for a kickoff at or before the game we just had (e.g. don't
  // re-open the same week a game was cancelled — wait for next week's slot).
  if (currentGame && currentGame.kickoffAt && new Date(kickoffAt) <= new Date(currentGame.kickoffAt)) return null;
  return { kickoffAt, dateLabel: nextGameLabel(c, openMoment) };
}

// True once an open/locked game's kickoff time has passed — registration should
// close ("the poll closes after the game starts").
export function pastKickoff(game, now = new Date()) {
  return !!(game && game.kickoffAt && new Date(game.kickoffAt) <= now
    && game.status !== 'completed' && game.status !== 'cancelled');
}

// --- group announcements, held for organiser review -------------------------
// Broadcasts to the group (poll opening, a time/venue change, a cancellation,
// the line-up) aren't emailed straight away. We stage each as a pending
// announcement the organiser previews (message + who it's going to), trims,
// sends early, or holds. If untouched it auto-sends once the grace window
// elapses. `kind` is one of: 'poll-open' | 'reschedule' | 'cancellation' |
// 'lineup'. `teams` (line-up only) is { bibs: [names], nonbibs: [names] }.
export function buildAnnouncement(kind, { game = {}, recipients = [], config = {}, teams = null, reserves = [] } = {}, now = new Date()) {
  const c = withDefaults(config);
  // A published line-up can contain more or fewer players than the stored game
  // capacity. Price the announcement from the actual unique team-sheet size.
  const lineupSize = kind === 'lineup' && teams
    ? new Set([...(teams.bibs || []), ...(teams.nonbibs || [])]).size
    : 0;
  const capacity = lineupSize || game.capacity || null;
  const grace = Number(c.announceGraceMinutes);
  const mins = Number.isFinite(grace) && grace >= 0 ? grace : 60;
  // The line-up goes out a set time before kickoff (default 2h); everything else
  // after a short review grace window.
  let sendAfter;
  if (kind === 'lineup' && game.kickoffAt) {
    const lead = Number(c.lineupHoursBefore);
    const h = Number.isFinite(lead) && lead >= 0 ? lead : 2;
    sendAfter = new Date(new Date(game.kickoffAt).getTime() - h * 3600000).toISOString();
  } else {
    sendAfter = new Date(now.getTime() + mins * 60000).toISOString();
  }
  return {
    kind: kind || 'poll-open',
    gameId: game.id || null,
    dateLabel: game.dateLabel || '',
    kickoffAt: game.kickoffAt || null,
    venue: game.venue || '',
    teams: teams || null,
    reserves: reserves || [],
    capacity,
    pitchCost: Number(c.pitchCost) || 0,
    recipients: recipients.map(r => ({ id: r.id, name: r.name, email: r.email || null })),
    excludedIds: [],
    graceMinutes: mins,
    sendAfter,
    status: 'pending',
    createdAt: now.toISOString()
  };
}

// Per-player pitch cost for an announcement (total ÷ squad size), or 0.
export function perPlayerCost(ann = {}) {
  const cap = Number(ann.capacity) || 0;
  const total = Number(ann.pitchCost) || 0;
  return cap > 0 && total > 0 ? total / cap : 0;
}

// The message for an announcement, by kind. Returns { subject, heading,
// paragraphs } — rendered as an email by the notifier and as an in-app preview
// by the organiser, so the wording lives in exactly one place.
export function announcementContent(ann = {}, clubName = 'the club') {
  const when = ann.kickoffAt
    ? new Date(ann.kickoffAt).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    : (ann.dateLabel || 'this week');
  const label = ann.dateLabel || 'this week';
  const at = ann.venue ? ` at ${ann.venue}` : '';
  switch (ann.kind) {
    case 'reschedule':
      return { subject: `${clubName} — game moved`, heading: 'The game has moved',
        paragraphs: [`This week's game has moved to ${when}${at}.`] };
    case 'cancellation':
      return { subject: `${clubName} — no game this week`, heading: 'No game this week',
        paragraphs: [`This week's game (${label}) has been called off.`, `No game this week — we'll be back in the app for the next one.`] };
    case 'lineup': {
      const t = ann.teams || {};
      const bibs = (t.bibs || []).join(', ') || '—';
      const nonbibs = (t.nonbibs || []).join(', ') || '—';
      const paragraphs = [
        `Here's the line-up as it stands right now — kick-off ${when}${at}.`,
        `Bibs: ${bibs}`,
        `Non-bibs: ${nonbibs}`
      ];
      if ((ann.reserves || []).length) paragraphs.push(`Reserves: ${ann.reserves.join(', ')}`);
      const per = perPlayerCost(ann);
      if (per) paragraphs.push(`It's £${per.toFixed(2)} each this week — the pitch is £${Number(ann.pitchCost).toFixed(2)} split ${ann.capacity} ways.`);
      paragraphs.push(`There may be a few last-minute changes — check the app for the latest.`);
      return { subject: `${clubName} — line-up for ${label}`, heading: `Line-up`, paragraphs };
    }
    case 'poll-open':
    default:
      return { subject: `⚽ ${clubName} — poll's open for ${label}`, heading: `Poll's open — ${label}`,
        paragraphs: [`The poll for ${label} is open${at}.`, `Kick-off ${when}. Get your name in to claim a spot.`] };
  }
}

// How long until the notifier gets another turn. GitHub throttles scheduled
// workflows on repositories with no recent pushes, so the every-5-minutes cron
// in notify.yml is aspirational — in practice the gap between runs can stretch
// to hours. We therefore measure the real gaps rather than trust the schedule.
// The estimate is the worst recent gap, because that's the one that makes us miss
// a deadline — but with the single largest sample discarded once we have a few,
// so that one outage (a workflow switched off for a fortnight, say) doesn't have
// us sending every line-up half a day early for the next dozen runs. Floored at
// the nominal interval so a healthy notifier stays responsive, and capped so a
// wild sample can't push the estimate past all usefulness.
export const MAX_RUN_ESTIMATE_MINUTES = 720; // 12h
export const RUN_ESTIMATE_TRIM_FROM = 4;     // samples needed before we trim
export function nextRunEstimateMinutes(recentGaps = [], nominalMinutes = 5) {
  const nominal = Number(nominalMinutes) > 0 ? Number(nominalMinutes) : 5;
  const gaps = (Array.isArray(recentGaps) ? recentGaps : [])
    .map(Number).filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (gaps.length >= RUN_ESTIMATE_TRIM_FROM) gaps.pop();
  const worst = gaps.length ? gaps[gaps.length - 1] : 0;
  return Math.min(MAX_RUN_ESTIMATE_MINUTES, Math.max(nominal, worst));
}

// A pending announcement is due to send once its grace window has elapsed — or,
// for the line-up, once we can no longer count on getting another run in before
// kick-off (see announcementDeadlineDue).
export function announcementReady(ann, now = new Date(), opts = {}) {
  if (!ann || ann.status !== 'pending' || !ann.sendAfter) return false;
  if (new Date(ann.sendAfter).getTime() <= asTime(now)) return true;
  return announcementDeadlineDue(ann, now, opts);
}

// The line-up has a hard deadline the other announcements don't: once the game
// has kicked off it's no use to anybody. Only the notifier can actually email or
// push, so if it won't be back before kick-off, waiting for `sendAfter` means the
// line-up never goes out at all. Send it now instead — a line-up that arrives
// earlier than intended beats one that arrives after the final whistle.
//
// Pass `nextRunMinutes` (from nextRunEstimateMinutes) to enable this; without it
// the behaviour is exactly the plain grace-window rule, so callers that can't
// measure the cadence — the browser, which isn't allowed to read meta/notify —
// are unaffected.
export function announcementDeadlineDue(ann, now = new Date(), opts = {}) {
  if (!ann || ann.kind !== 'lineup' || !ann.kickoffAt) return false;
  const nextRun = Number(opts.nextRunMinutes);
  if (!Number.isFinite(nextRun) || nextRun <= 0) return false;
  const t = asTime(now);
  const kickoff = new Date(ann.kickoffAt).getTime();
  // Kick-off already gone: `sendAfter` has necessarily passed too, so the plain
  // rule in announcementReady has already decided this one.
  if (!Number.isFinite(kickoff) || kickoff <= t) return false;
  return t + nextRun * 60000 >= kickoff;
}

// Where a pending announcement stands, for the organiser's review card. The app
// can't see the notifier's bookkeeping (meta/notify is Admin-SDK only), but
// "sendAfter has passed and this is *still* pending" is proof the robot hasn't
// been round yet — worth saying out loud, because the organiser can post it to
// WhatsApp themselves in one tap instead of waiting on a late cron.
//   held    — waiting on its grace window / pre-kickoff time, as designed.
//   due     — its moment has come; the next notifier run should carry it.
//   late    — overdue by more than `overdueAfterMinutes`; the notifier is behind.
//   missed  — a line-up still sitting here after kick-off. Too late to matter.
export function announcementProgress(ann, now = new Date(), overdueAfterMinutes = 10) {
  if (!ann || ann.status !== 'pending' || !ann.sendAfter) return null;
  const t = asTime(now);
  const kickoff = ann.kickoffAt ? new Date(ann.kickoffAt).getTime() : NaN;
  const minutesToKickoff = Number.isFinite(kickoff) ? Math.round((kickoff - t) / 60000) : null;
  const overdueMinutes = Math.round((t - new Date(ann.sendAfter).getTime()) / 60000);
  let state;
  if (ann.kind === 'lineup' && Number.isFinite(kickoff) && kickoff <= t) state = 'missed';
  else if (overdueMinutes < 0) state = 'held';
  else if (overdueMinutes <= Math.max(0, Number(overdueAfterMinutes) || 0)) state = 'due';
  else state = 'late';
  return { state, overdueMinutes: Math.max(0, overdueMinutes), minutesToKickoff };
}

function asTime(now) {
  return now instanceof Date ? now.getTime() : new Date(now).getTime();
}

// Whether a staged announcement still matches the game it was for (so we don't
// send a stale one). Cancellations are valid against the cancelled game;
// everything else against the live open/locked poll.
export function announcementValid(ann, game, currentGameId) {
  if (!ann || !game || ann.gameId !== currentGameId) return false;
  if (ann.kind === 'cancellation') return game.status === 'cancelled';
  return game.status === 'open' || game.status === 'locked';
}

// The recipients an announcement will actually reach (roster minus the ones the
// organiser deselected).
export function announcementAudience(ann) {
  const ex = new Set((ann && ann.excludedIds) || []);
  return ((ann && ann.recipients) || []).filter(r => !ex.has(r.id));
}

// Seed roster from the group so the app is usable on day one.
export const SEED_NAMES = [
  'Faisal', 'Haroon Hanif', 'Haseeb', 'Shergal Rodaina', 'Tom Exon',
  'Haris Farooq', 'Suki', 'Darren Ellis', 'Matthew Eastwood', 'Ismael Nazar',
  'Lee', 'Hamad', 'James Roberts', 'Marc Coleman', 'Shakeel', 'Oli Scott',
  'Tom Clapham'
];
