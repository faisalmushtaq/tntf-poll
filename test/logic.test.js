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
  ok('player A attendance = 50%', a.attendancePct === 50);
  ok('history is newest-first', a.history[0].dateLabel === 'Wk2');
  const c = logic.playerStats('c', games);
  ok('player C was reserve in wk1, played wk2', c.played === 1 && c.history.some(h => h.reserve));
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

console.log(`\n${pass} checks passed ✅`);
