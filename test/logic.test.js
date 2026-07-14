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

console.log(`\n${pass} checks passed ✅`);
