// Minimal assertions for the selection/penalty logic. Run: npm test
import assert from 'node:assert';
import * as logic from '../public/logic.js';

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓', name); pass++; };

// --- loyalty beats sign-up order -------------------------------------------
{
  const players = {
    a: { id: 'a', name: 'Casual Early', loyalty: 0 },
    b: { id: 'b', name: 'Regular Late', loyalty: 10 },
    c: { id: 'c', name: 'Mid', loyalty: 5 }
  };
  const signups = [
    { playerId: 'a', status: 'in', joinedAt: '2026-01-01T10:00:00Z' }, // earliest
    { playerId: 'c', status: 'in', joinedAt: '2026-01-01T10:01:00Z' },
    { playerId: 'b', status: 'in', joinedAt: '2026-01-01T10:05:00Z' }  // latest, highest loyalty
  ];
  const ranked = logic.rankSignups(signups, players, 2);
  ok('highest loyalty ranks #1 despite signing up last', ranked[0].playerId === 'b');
  ok('capacity 2 → third player is waitlisted', ranked[2].status === 'waitlist');
  ok('confirmed count respects capacity', ranked.filter(r => r.status === 'confirmed').length === 2);
}

// --- tie-break by sign-up time ---------------------------------------------
{
  const players = { a: { id: 'a', name: 'A', loyalty: 3 }, b: { id: 'b', name: 'B', loyalty: 3 } };
  const signups = [
    { playerId: 'b', status: 'in', joinedAt: '2026-01-01T10:05:00Z' },
    { playerId: 'a', status: 'in', joinedAt: '2026-01-01T10:00:00Z' }
  ];
  const ranked = logic.rankSignups(signups, players, 2);
  ok('equal loyalty → earlier sign-up ranks first', ranked[0].playerId === 'a');
}

// --- withdrawn sign-ups are excluded ---------------------------------------
{
  const players = { a: { id: 'a', name: 'A', loyalty: 1 }, b: { id: 'b', name: 'B', loyalty: 1 } };
  const signups = [
    { playerId: 'a', status: 'withdrawn', joinedAt: '2026-01-01T10:00:00Z' },
    { playerId: 'b', status: 'in', joinedAt: '2026-01-01T10:01:00Z' }
  ];
  const ranked = logic.rankSignups(signups, players, 14);
  ok('withdrawn players are not ranked', ranked.length === 1 && ranked[0].playerId === 'b');
}

// --- time-weighted penalty tiers -------------------------------------------
{
  ok('drop 72h out → no penalty', logic.penaltyForHours(72).penalty === 0);
  ok('drop 36h out → -1', logic.penaltyForHours(36).penalty === 1);
  ok('drop 5h out → -3', logic.penaltyForHours(5).penalty === 3);
  ok('drop 1h out → -5', logic.penaltyForHours(1).penalty === 5);
  ok('no-show (already kicked off) → -5', logic.penaltyForHours(-2).penalty === 5);
}

// --- next kickoff lands on the configured game-day --------------------------
{
  const cfg = logic.withDefaults({ gameDay: 'Tuesday', kickoff: '20:00' });
  const from = new Date('2026-07-15T09:00:00'); // a Wednesday
  const next = new Date(logic.nextKickoffISO(cfg, from));
  ok('next kickoff is a Tuesday', next.getDay() === 2);
  ok('next kickoff is in the future', next > from);
}

// --- notification diff: who changed status because of others ---------------
{
  const prev = { a: 'confirmed', b: 'confirmed', c: 'waitlist', d: 'waitlist' };
  const curr = { a: 'confirmed', c: 'confirmed', d: 'waitlist', e: 'waitlist' };
  // b withdrew (gone), c promoted, e is brand new (self sign-up)
  const changes = logic.diffStatuses(prev, curr);
  const byId = Object.fromEntries(changes.map(c => [c.playerId, c.kind]));
  ok('promotion off the reserves is flagged', byId.c === 'promoted');
  ok('brand-new sign-up is NOT notified (self-initiated)', !('e' in byId));
  ok('players who withdrew are not flagged', !('b' in byId));
  ok('unchanged players are not flagged', !('a' in byId) && !('d' in byId));
}
{
  const changes = logic.diffStatuses({ a: 'confirmed' }, { a: 'waitlist' });
  ok('being bumped from squad to reserve is flagged', changes[0] && changes[0].kind === 'bumped');
}

// --- player stats from frozen game results ---------------------------------
{
  const games = [
    { id: 'g1', status: 'completed', dateLabel: 'Wk1', completedAt: '2026-01-06T21:00:00Z',
      result: { confirmed: ['a', 'b'], reserves: ['c'] },
      signups: [{ playerId: 'a', status: 'in' }, { playerId: 'b', status: 'in' }, { playerId: 'c', status: 'in' }] },
    { id: 'g2', status: 'completed', dateLabel: 'Wk2', completedAt: '2026-01-13T21:00:00Z',
      result: { confirmed: ['b', 'c'], reserves: [] },
      signups: [{ playerId: 'a', status: 'withdrawn' }, { playerId: 'b', status: 'in' }, { playerId: 'c', status: 'in' }] },
    { id: 'g3', status: 'open', signups: [] } // ignored
  ];
  const a = logic.playerStats('a', games);
  ok('player A played 1 of 2 invited', a.played === 1 && a.invited === 2);
  ok('player A has 1 dropout', a.dropouts === 1);
  ok('total counts all completed games', a.total === 2);
  ok('player A attendance = 50% (of all games)', a.attendancePct === 50);
  ok('history is newest-first', a.history[0].dateLabel === 'Wk2');
  const c = logic.playerStats('c', games);
  ok('player C was reserve in wk1, played wk2', c.played === 1 && c.history.some(h => h.reserve));
  // A regular involved in only some games isn't 100% — it's out of ALL games.
  const many = [
    { id: 'x1', status: 'completed', result: { confirmed: ['p'], reserves: [] }, signups: [{ playerId: 'p', status: 'in' }] },
    { id: 'x2', status: 'completed', result: { confirmed: ['q'], reserves: [] }, signups: [] },
    { id: 'x3', status: 'completed', result: { confirmed: ['q'], reserves: [] }, signups: [] }
  ];
  const p = logic.playerStats('p', many);
  ok('attendance is played/total, not played/involved (1 of 3 = 33%)', p.played === 1 && p.invited === 1 && p.total === 3 && p.attendancePct === 33);
}

// --- win/loss analytics ----------------------------------------------------
{
  const games = [
    { id: '1', status: 'completed', date: '2026-01-01', teams: { bibs: ['x', 'y'], nonbibs: ['z'] }, scores: { bibs: 3, nonbibs: 1 } }, // X win
    { id: '2', status: 'completed', date: '2026-01-08', teams: { bibs: ['z'], nonbibs: ['x'] }, scores: { bibs: 2, nonbibs: 0 } },       // X loss
    { id: '3', status: 'completed', date: '2026-01-15', teams: { bibs: ['x'], nonbibs: ['z'] }, scores: { bibs: 4, nonbibs: 4 } },       // X draw
    { id: '4', status: 'completed', date: '2026-01-22', teams: { bibs: ['x'], nonbibs: ['z'] }, scores: { bibs: 6, nonbibs: 2 } },       // X win
    { id: '5', status: 'open', teams: { bibs: ['x'], nonbibs: [] }, scores: { bibs: 0, nonbibs: 0 } } // ignored
  ];
  const a = logic.playerAnalytics('x', games);
  ok('analytics played=4', a.played === 4);
  ok('analytics W/D/L = 2/1/1', a.wins === 2 && a.draws === 1 && a.losses === 1);
  ok('analytics win% = 50', a.winPct === 50);
  ok('goals for/against aggregated', a.gf === 13 && a.ga === 9);
  ok('current streak = W1', a.currentStreak.type === 'W' && a.currentStreak.count === 1);
  ok('longest unbeaten = 2', a.longestUnbeaten === 2);
  ok('form newest-first starts W, length 4', a.form[0] === 'W' && a.form.length === 4);
  const z = logic.playerAnalytics('z', games);
  ok('opponent mirror: Z 1W/2L/1D', z.wins === 1 && z.losses === 2 && z.draws === 1);
}

// --- team balancer ----------------------------------------------------------
{
  const P = {
    a: { id: 'a', attrs: { fitness: 20, skill: 20, strength: 20, speed: 20 } }, // 80
    b: { id: 'b', attrs: { fitness: 15, skill: 15, strength: 15, speed: 15 } }, // 60
    c: { id: 'c', attrs: { fitness: 10, skill: 10, strength: 10, speed: 10 } }, // 40
    d: { id: 'd', attrs: { fitness: 5, skill: 5, strength: 5, speed: 5 } }      // 20
  };
  const { bibs, nonbibs, bibsTotal, nonbibsTotal } = logic.balanceTeams(['a', 'b', 'c', 'd'], P);
  ok('balancer splits into equal sizes', bibs.length === 2 && nonbibs.length === 2);
  ok('balancer keeps totals equal here (80+20 vs 60+40)', bibsTotal === nonbibsTotal);
  ok('everyone placed exactly once', new Set([...bibs, ...nonbibs]).size === 4);
  ok('attrOverall defaults missing attrs to 10 (=40)', logic.attrOverall({}) === 40);
  ok('attrOverall sums provided attrs', logic.attrOverall(P.a) === 80);
}

// --- cold season + adverse-weather loyalty bonus ---------------------------
{
  const cfg = logic.withDefaults({}); // defaults: weatherBonus 1, coldSeasonBonus 1, coldMonths Nov–Mar
  ok('January counts as cold season', logic.isColdSeason('2026-01-13T20:00:00', cfg));
  ok('July is not cold season', !logic.isColdSeason('2026-07-14T20:00:00', cfg));
  const both = logic.completionBonus(cfg, { adverseWeather: true, coldSeason: true });
  ok('adverse + cold stacks to +2', both.bonus === 2 && both.reasons.length === 2);
  const wxOnly = logic.completionBonus(cfg, { adverseWeather: true, coldSeason: false });
  ok('adverse weather alone is +1', wxOnly.bonus === 1);
  const none = logic.completionBonus(cfg, { adverseWeather: false, coldSeason: false });
  ok('fine summer game gets no bonus', none.bonus === 0 && none.reasons.length === 0);
  const custom = logic.completionBonus(logic.withDefaults({ scoring: { weatherBonus: 3, coldSeasonBonus: 0 } }), { adverseWeather: true, coldSeason: true });
  ok('bonuses honour custom config (weather 3, cold 0)', custom.bonus === 3);
}

// --- last-minute "stepping in" detection -----------------------------------
{
  const cfg = logic.withDefaults({}); // lateSignupHours 24
  const kick = '2026-01-13T20:00:00Z';
  ok('sign up 11h before is late', logic.isLateSignup(cfg, '2026-01-13T09:00:00Z', kick));
  ok('sign up 3 days before is not late', !logic.isLateSignup(cfg, '2026-01-10T09:00:00Z', kick));
  ok('exactly 24h before counts as late', logic.isLateSignup(cfg, '2026-01-12T20:00:00Z', kick));
  const custom = logic.withDefaults({ scoring: { lateSignupHours: 12 } });
  ok('honours custom window (11h ≤ 12h)', logic.isLateSignup(custom, '2026-01-13T09:00:00Z', kick));
  ok('outside custom 12h window', !logic.isLateSignup(custom, '2026-01-13T05:00:00Z', kick));
}

// --- gap-aware late-signup bonus -------------------------------------------
{
  const kick = '2026-01-13T20:00:00Z';
  const early = '2026-01-10T10:00:00Z';   // in good time
  const late = '2026-01-13T12:00:00Z';    // 8h before → last minute
  const players = {};
  for (let i = 1; i <= 6; i++) players['p' + i] = { id: 'p' + i, name: 'P' + i, loyalty: 10 - i };
  const cfg = logic.withDefaults({}); // playedReward 2, lateSignupBonusGames 4 → +8

  // Under-subscribed: capacity 4, only 3 in good time + 1 late → the late one fills a gap.
  const short = [
    { playerId: 'p1', status: 'in', joinedAt: early },
    { playerId: 'p2', status: 'in', joinedAt: early },
    { playerId: 'p3', status: 'in', joinedAt: early },
    { playerId: 'p4', status: 'in', joinedAt: late }
  ];
  const a1 = logic.lateSignupAwards(short, players, cfg, kick, 4);
  ok('late sign-up that fills a gap is rewarded +8', a1.p4 === 8 && Object.keys(a1).length === 1);

  // Over-subscribed: capacity 3, 4 in good time + 1 late → nobody needed the late one.
  const full = [
    { playerId: 'p1', status: 'in', joinedAt: early },
    { playerId: 'p2', status: 'in', joinedAt: early },
    { playerId: 'p3', status: 'in', joinedAt: early },
    { playerId: 'p4', status: 'in', joinedAt: early },
    { playerId: 'p5', status: 'in', joinedAt: late }
  ];
  ok('late sign-up gets nothing when squad was already full', Object.keys(logic.lateSignupAwards(full, players, cfg, kick, 3)).length === 0);

  // Two gaps, three late sign-ups → only two bonuses (capped at gaps), highest loyalty first.
  const twoGaps = [
    { playerId: 'p1', status: 'in', joinedAt: early },
    { playerId: 'p2', status: 'in', joinedAt: early },
    { playerId: 'p3', status: 'in', joinedAt: late }, // loyalty 7
    { playerId: 'p4', status: 'in', joinedAt: late }, // loyalty 6
    { playerId: 'p5', status: 'in', joinedAt: late }  // loyalty 5
  ];
  const a3 = logic.lateSignupAwards(twoGaps, players, cfg, kick, 4);
  ok('bonuses capped at the number of gaps (2)', Object.keys(a3).length === 2);
  ok('gap bonuses go to the highest-ranked late sign-ups', a3.p3 === 8 && a3.p4 === 8 && !a3.p5);
}

// --- config self-heal patch ------------------------------------------------
{
  const old = logic.configMigrationPatch({ venue: 'Pitch 10', lat: null, lon: null });
  ok('old placeholder venue is migrated', old.venue === 'Pitch 10 - Nou Camp');
  ok('null coords are filled from defaults', typeof old.lat === 'number' && typeof old.lon === 'number');
  const done = logic.configMigrationPatch({ venue: 'Pitch 10 - Nou Camp', lat: 53.81928, lon: -1.74367 });
  ok('already-current config needs no patch', Object.keys(done).length === 0);
  const custom = logic.configMigrationPatch({ venue: 'Powerleague', lat: 51.5, lon: -0.1 });
  ok('a custom venue is left untouched', !('venue' in custom) && !('lat' in custom));
  const absent = logic.configMigrationPatch({ venue: 'Pitch 10 - Nou Camp' }); // no lat/lon keys → defaults apply
  ok('absent coords already resolve to defaults (no patch)', Object.keys(absent).length === 0);
}

// --- duplicate account detection (same uid) --------------------------------
{
  const players = {
    hist: { id: 'hist', name: 'Faisal', uid: 'g1', gamesPlayed: 16, loyalty: 32 },
    a: { id: 'a', name: 'Faisal Mushtaq', uid: 'g1', account: true, gamesPlayed: 0, loyalty: 0, createdAt: '2026-07-01' },
    b: { id: 'b', name: 'Faisal Mushtaq', uid: 'g1', account: true, gamesPlayed: 0, loyalty: 0, createdAt: '2026-07-02' },
    other: { id: 'other', name: 'Suki', uid: 'g2', gamesPlayed: 5 },
    nouid: { id: 'nouid', name: 'History Only' }
  };
  const merges = logic.duplicateMerges(players);
  ok('two dup accounts → two merges, kept on the historic record', merges.length === 2 && merges.every(m => m.keep === 'hist'));
  ok('a lone uid is not merged', !merges.some(m => m.drop === 'other' || m.keep === 'other'));
  ok('records without a uid are ignored', !merges.some(m => m.drop === 'nouid' || m.keep === 'nouid'));
  ok('clean roster needs no merges', logic.duplicateMerges({ x: { id: 'x', uid: 'z' }, y: { id: 'y', uid: 'w' } }).length === 0);
}

// --- recompute loyalty from history (incl. weather) ------------------------
{
  const games = [
    { id: 'g1', status: 'completed', date: '2026-01-13', teams: { bibs: ['a', 'b'], nonbibs: ['c'] } }, // cold season (Jan)
    { id: 'g2', status: 'completed', date: '2026-07-14', teams: { bibs: ['a'], nonbibs: ['c'] } },       // summer
    { id: 'g3', status: 'open', teams: { bibs: ['a'], nonbibs: [] } }                                    // ignored
  ];
  const cfg = logic.withDefaults({}); // played 2, weather 1, cold 1
  ok('gamePlayers reads both teams', logic.gamePlayers(games[0]).sort().join() === 'a,b,c');
  // no weather data → only base + cold-season bonuses
  const base = logic.recomputeLoyalty(games, cfg, {});
  ok('cold-season game gives +3, summer +2 → a = 5', base.a.loyalty === 5 && base.a.gamesPlayed === 2);
  ok('player only in the Jan game gets +3', base.b.loyalty === 3 && base.b.gamesPlayed === 1);
  // mark the summer game adverse → that game becomes +3 for its players
  const wx = logic.recomputeLoyalty(games, cfg, { g2: true });
  ok('adverse flag adds the weather bonus (a = 3 + 3 = 6)', wx.a.loyalty === 6);
  ok('open games never count', !('open' in base) && base.a.gamesPlayed === 2);
}

// --- personal goals (from goalscorers) -------------------------------------
{
  const games = [
    { id: '1', status: 'completed', date: '2026-01-01', teams: { bibs: ['x'], nonbibs: ['z'] }, scores: { bibs: 3, nonbibs: 1 }, goals: { x: 2, z: 1 } },
    { id: '2', status: 'completed', date: '2026-01-08', teams: { bibs: ['x'], nonbibs: ['z'] }, scores: { bibs: 1, nonbibs: 0 }, goals: { x: 1 } },
    { id: '3', status: 'completed', date: '2026-01-15', teams: { bibs: ['x'], nonbibs: ['z'] }, scores: { bibs: 0, nonbibs: 0 } } // no goals logged
  ];
  const x = logic.playerAnalytics('x', games);
  ok('personal goals sum across games (2+1=3)', x.pg === 3);
  ok('team goals still separate from personal', x.gf === 4);
  const z = logic.playerAnalytics('z', games);
  ok('opponent personal goals counted (1)', z.pg === 1);
  ok('no personal goals when none logged', logic.playerAnalytics('nobody', games).pg === 0);
}

console.log(`\n${pass} checks passed ✅`);
