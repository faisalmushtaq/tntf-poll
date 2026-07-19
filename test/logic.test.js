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

// --- unavailable ("out") sign-ups are excluded -----------------------------
{
  const players = { a: { id: 'a', name: 'A', loyalty: 9 }, b: { id: 'b', name: 'B', loyalty: 1 } };
  const signups = [
    { playerId: 'a', status: 'out', outAt: '2026-01-01T09:00:00Z' },
    { playerId: 'b', status: 'in', joinedAt: '2026-01-01T10:01:00Z' }
  ];
  const ranked = logic.rankSignups(signups, players, 14);
  ok('unavailable players are not ranked (even with high loyalty)', ranked.length === 1 && ranked[0].playerId === 'b');
}

// --- time-weighted penalty tiers -------------------------------------------
{
  ok('drop 30h out (before 5pm Mon) → no penalty', logic.penaltyForHours(30).penalty === 0);
  ok('exactly 27h out (5pm Mon) → still free', logic.penaltyForHours(27).penalty === 0);
  ok('drop 20h out (after 5pm Mon) → -3', logic.penaltyForHours(20).penalty === 3);
  ok('drop 10h out (within 12h) → -5', logic.penaltyForHours(10).penalty === 5);
  ok('drop 5h out (within 6h) → -8', logic.penaltyForHours(5).penalty === 8);
  ok('drop 2h out (within 3h) → -10', logic.penaltyForHours(2).penalty === 10);
  ok('no-show (already kicked off) → -10', logic.penaltyForHours(-2).penalty === 10);
}

// --- next kickoff lands on the configured game-day --------------------------
{
  const cfg = logic.withDefaults({ gameDay: 'Tuesday', kickoff: '20:00' });
  const from = new Date('2026-07-15T09:00:00'); // a Wednesday
  const next = new Date(logic.nextKickoffISO(cfg, from));
  ok('next kickoff is a Tuesday', next.getDay() === 2);
  ok('next kickoff is in the future', next > from);
}

// --- prompt window: late sign-ups' loyalty counts half ---------------------
{
  const cfg = logic.withDefaults({ promptHours: 24, lateLoyaltyFactor: 0.5 });
  const open = '2026-07-17T10:00:00Z'; // poll opened Friday 10am
  const prompt = '2026-07-17T20:00:00Z';        // same day — within 24h
  const late = '2026-07-19T09:00:00Z';          // Sunday — past 24h
  ok('within 24h is prompt', logic.isPromptSignup(cfg, prompt, open));
  ok('past 24h is not prompt', !logic.isPromptSignup(cfg, late, open));
  ok('exactly 24h still counts', logic.isPromptSignup(cfg, '2026-07-18T10:00:00Z', open));
  ok('prompt sign-up keeps full loyalty', logic.effectiveLoyalty(20, prompt, open, cfg) === 20);
  ok('late sign-up loyalty is halved', logic.effectiveLoyalty(20, late, open, cfg) === 10);
  ok('no release time → full loyalty', logic.effectiveLoyalty(20, late, null, cfg) === 20);

  // ranking: a keen early bird (low loyalty, prompt) leapfrogs a slow regular
  const players = { reg: { name: 'Reg', loyalty: 20 }, keen: { name: 'Keen', loyalty: 12 } };
  const signups = [
    { playerId: 'reg', status: 'in', joinedAt: late },   // regular, slow → 10 effective
    { playerId: 'keen', status: 'in', joinedAt: prompt }  // keen, prompt → 12 effective
  ];
  const ranked = logic.rankSignups(signups, players, 1, { pollOpenAt: open, config: cfg });
  ok('keen prompt sign-up ranks first', ranked[0].playerId === 'keen' && ranked[0].status === 'confirmed');
  ok('slow regular drops to reserve', ranked[1].playerId === 'reg' && ranked[1].status === 'waitlist');
  ok('raw loyalty still reported', ranked[1].loyalty === 20 && ranked[1].effLoyalty === 10);
  // without the prompt window it's raw loyalty (regular wins)
  const rawRanked = logic.rankSignups(signups, players, 1);
  ok('fallback ranks by raw loyalty', rawRanked[0].playerId === 'reg');
}

// --- prompt bonus: keen reserves accumulate --------------------------------
{
  const cfg = logic.withDefaults({ promptHours: 24, scoring: { promptBonus: 1 } });
  const open = '2026-07-17T10:00:00Z';
  const players = { a: { loyalty: 30 }, b: { loyalty: 5 }, c: { loyalty: 4 } };
  const signups = [
    { playerId: 'a', status: 'in', joinedAt: '2026-07-17T11:00:00Z' }, // plays
    { playerId: 'b', status: 'in', joinedAt: '2026-07-17T12:00:00Z' }, // prompt reserve
    { playerId: 'c', status: 'in', joinedAt: '2026-07-19T12:00:00Z' }  // late reserve
  ];
  const awards = logic.promptSignupAwards(signups, players, cfg, open, 1);
  ok('prompt reserve gets the bonus', awards.b === 1);
  ok('player who made the squad gets no prompt bonus', !('a' in awards));
  ok('late reserve gets no prompt bonus', !('c' in awards));
}

// --- auto-open: most-recent weekly moment ----------------------------------
{
  // Saturday 18 Jul 2026, 14:00 — most recent Friday 10:00 is the day before.
  const now = new Date('2026-07-18T14:00:00');
  const m = logic.mostRecentWeekly('Friday', '10:00', now);
  ok('mostRecentWeekly lands on a Friday', m.getDay() === 5);
  ok('mostRecentWeekly is at 10:00', m.getHours() === 10 && m.getMinutes() === 0);
  ok('mostRecentWeekly is in the past', m <= now);
  // Friday 09:00 — the 10:00 slot has not arrived yet, so go back a full week.
  const early = new Date('2026-07-17T09:00:00'); // a Friday
  const m2 = logic.mostRecentWeekly('Friday', '10:00', early);
  ok('before the slot on the day itself → previous week', m2 < early && m2.getDay() === 5);
  // Friday 10:00 exactly counts as now.
  const onTime = new Date('2026-07-17T10:00:00');
  const m3 = logic.mostRecentWeekly('Friday', '10:00', onTime);
  ok('exactly on the slot counts as today', m3.getTime() === onTime.getTime());
}

// --- auto-open: whether to open a new poll ---------------------------------
{
  const cfg = logic.withDefaults({ gameDay: 'Tuesday', kickoff: '20:00', pollOpenDay: 'Friday', pollOpenTime: '10:00' });
  const now = new Date('2026-07-18T14:00:00'); // Saturday, after Fri 10:00 open
  const plan = logic.autoOpenPlan(cfg, { status: 'completed' }, now, null);
  ok('opens once last game completed', plan && new Date(plan.kickoffAt).getDay() === 2);
  ok('open plan carries a date label', plan && typeof plan.dateLabel === 'string' && plan.dateLabel.length > 0);
  ok('blocks while last game still open', logic.autoOpenPlan(cfg, { status: 'open' }, now, null) === null);
  ok('blocks while last game locked', logic.autoOpenPlan(cfg, { status: 'locked' }, now, null) === null);
  ok('opens after cancelled game (older kickoff)', logic.autoOpenPlan(cfg, { status: 'cancelled', kickoffAt: '2026-07-14T19:00:00Z' }, now, null) !== null);
  // A game cancelled for THIS week has the same kickoff the poll would target — don't re-open it.
  ok('does NOT re-open the same week a game was cancelled', logic.autoOpenPlan(cfg, { status: 'cancelled', kickoffAt: plan.kickoffAt }, now, null) === null);
  ok('opens with no previous game', logic.autoOpenPlan(cfg, null, now, null) !== null);
  ok('does not re-open the same week twice', logic.autoOpenPlan(cfg, { status: 'completed' }, now, plan.kickoffAt) === null);
  // Before the Friday 10:00 slot the most-recent open moment is a week ago,
  // whose kickoff has already passed — so nothing new opens until the slot lands.
  const beforeOpen = new Date('2026-07-17T09:00:00'); // Fri 09:00, slot not reached
  ok('does not open before the poll-open slot arrives', logic.autoOpenPlan(cfg, { status: 'completed' }, beforeOpen, null) === null);
}

// --- announcement: staged, reviewable, auto-sends after grace --------------
{
  const cfg = logic.withDefaults({ announceGraceMinutes: 60 });
  const now = new Date('2026-07-17T10:00:00');
  const game = { id: 'g9', dateLabel: 'Tuesday 21 Jul', kickoffAt: '2026-07-21T19:00:00Z', venue: 'Pitch 10' };
  const roster = [{ id: 'a', name: 'Al', email: 'al@x.com' }, { id: 'b', name: 'Bo', email: null }, { id: 'c', name: 'Cy', email: 'cy@x.com' }];
  const ann = logic.buildAnnouncement('poll-open', { game, recipients: roster, config: cfg }, now);
  ok('announcement targets the game', ann.gameId === 'g9' && ann.dateLabel === 'Tuesday 21 Jul');
  ok('announcement carries its kind', ann.kind === 'poll-open');
  ok('announcement snapshots recipients', ann.recipients.length === 3 && ann.recipients[1].email === null);
  ok('announcement starts pending', ann.status === 'pending' && ann.excludedIds.length === 0);
  ok('sendAfter is now + grace', new Date(ann.sendAfter).getTime() === now.getTime() + 60 * 60000);
  ok('not ready during the grace window', !logic.announcementReady(ann, now));
  ok('ready once the window elapses', logic.announcementReady(ann, new Date(now.getTime() + 61 * 60000)));
  ok('cancelled announcements never send', !logic.announcementReady({ ...ann, status: 'cancelled' }, new Date(now.getTime() + 999 * 60000)));
  ok('audience is everyone by default', logic.announcementAudience(ann).length === 3);
  ok('deselected recipients are dropped', logic.announcementAudience({ ...ann, excludedIds: ['b'] }).map(r => r.id).join() === 'a,c');
  // zero grace = send on the next check
  const now0 = logic.buildAnnouncement('poll-open', { game, recipients: roster, config: logic.withDefaults({ announceGraceMinutes: 0 }) }, now);
  ok('zero grace is immediately ready', logic.announcementReady(now0, now));

  // --- content per kind + staleness ---
  const openGame = { id: 'g9', status: 'open' };
  const cancelGame = { id: 'g9', status: 'cancelled' };
  ok('poll-open valid vs open game', logic.announcementValid(ann, openGame, 'g9'));
  ok('poll-open invalid vs cancelled game', !logic.announcementValid(ann, cancelGame, 'g9'));
  ok('poll-open invalid vs a different game', !logic.announcementValid(ann, openGame, 'other'));

  const resc = logic.buildAnnouncement('reschedule', { game, recipients: roster, config: cfg }, now);
  const rc = logic.announcementContent(resc, 'TNTF');
  ok('reschedule content reads as moved', rc.heading === 'The game has moved' && /moved to/.test(rc.paragraphs[0]));

  const canc = logic.buildAnnouncement('cancellation', { game: cancelGame, recipients: roster, config: cfg }, now);
  ok('cancellation valid vs cancelled game', logic.announcementValid(canc, cancelGame, 'g9'));
  ok('cancellation invalid vs open game', !logic.announcementValid(canc, openGame, 'g9'));
  const cc = logic.announcementContent(canc, 'TNTF');
  ok('cancellation content reads as no game', cc.heading === 'No game this week' && /called off/.test(cc.paragraphs[0]));

  const line = logic.buildAnnouncement('lineup', { game, recipients: roster, config: cfg, teams: { bibs: ['Al', 'Bo'], nonbibs: ['Cy'] } }, now);
  const lc = logic.announcementContent(line, 'TNTF');
  ok('lineup content lists both sides', /Bibs: Al, Bo/.test(lc.paragraphs[1]) && /Non-bibs: Cy/.test(lc.paragraphs[2]));
  ok('lineup subject names the date', /line-up for Tuesday 21 Jul/.test(lc.subject));
  ok('lineup says "as it stands right now"', /as it stands right now/i.test(lc.paragraphs[0]));
  ok('lineup forewarns of late changes', lc.paragraphs.some(p => /last-minute changes/i.test(p) && /check the app/i.test(p)));
  // line-up auto-sends 2h (default) before kickoff, not after a grace window
  ok('lineup sends 2h before kickoff', new Date(line.sendAfter).getTime() === new Date(game.kickoffAt).getTime() - 2 * 3600000);
  const line1 = logic.buildAnnouncement('lineup', { game, recipients: roster, config: logic.withDefaults({ lineupHoursBefore: 1 }) }, now);
  ok('lineup lead time is configurable', new Date(line1.sendAfter).getTime() === new Date(game.kickoffAt).getTime() - 1 * 3600000);
  ok('lineup heading is just "Line-up"', lc.heading === 'Line-up');

  // reserves + per-player pitch cost
  const gameCap = { id: 'g9', dateLabel: 'Tue 21', kickoffAt: '2026-07-21T19:00:00Z', venue: 'Pitch 10', capacity: 14 };
  const withCost = logic.buildAnnouncement('lineup', {
    game: gameCap, recipients: roster, config: logic.withDefaults({ pitchCost: 113 }),
    teams: { bibs: ['Al'], nonbibs: ['Bo'] }, reserves: ['Cy', 'Di']
  }, now);
  ok('per-player cost is total / squad size', Math.abs(logic.perPlayerCost(withCost) - 113 / 14) < 1e-9);
  const wc = logic.announcementContent(withCost, 'TNTF');
  ok('lineup lists reserves in order', wc.paragraphs.some(p => /Reserves: Cy, Di/.test(p)));
  ok('lineup states the per-player cost', wc.paragraphs.some(p => /£8\.07 each/.test(p) && /£113\.00 split 14 ways/.test(p)));
  ok('no cost line when pitch cost is zero', !logic.announcementContent(logic.buildAnnouncement('lineup', { game: gameCap, config: logic.withDefaults({ pitchCost: 0 }) }, now), 'TNTF').paragraphs.some(p => /each this week/.test(p)));
}

// --- past kickoff: registration closes after the game starts ---------------
{
  const now = new Date('2026-07-21T21:00:00'); // an hour into a Tue 20:00 kickoff
  ok('open game past kickoff → close', logic.pastKickoff({ status: 'open', kickoffAt: '2026-07-21T19:00:00Z' }, now));
  ok('locked game past kickoff → close', logic.pastKickoff({ status: 'locked', kickoffAt: '2026-07-21T19:00:00Z' }, now));
  ok('future kickoff → leave open', !logic.pastKickoff({ status: 'open', kickoffAt: '2026-07-28T19:00:00Z' }, now));
  ok('completed game → not reclosed', !logic.pastKickoff({ status: 'completed', kickoffAt: '2026-07-21T19:00:00Z' }, now));
  ok('game with no kickoff → ignored', !logic.pastKickoff({ status: 'open' }, now));
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
  const done = logic.configMigrationPatch({ venue: 'Pitch 10 - Nou Camp', lat: 53.81928, lon: -1.74367, configVersion: 3 });
  ok('already-current config needs no patch', Object.keys(done).length === 0);
  const custom = logic.configMigrationPatch({ venue: 'Powerleague', lat: 51.5, lon: -0.1, configVersion: 3 });
  ok('a custom venue is left untouched', !('venue' in custom) && !('lat' in custom));
  const absent = logic.configMigrationPatch({ venue: 'Pitch 10 - Nou Camp', configVersion: 3 }); // no lat/lon keys → defaults apply
  ok('absent coords already resolve to defaults (no patch)', Object.keys(absent).length === 0);
  // v2 one-time PIN reset + v3 tier reset for a pre-versioned config
  const pins = logic.configMigrationPatch({ venue: 'Pitch 10 - Nou Camp', lat: 1, lon: 1, adminPin: '1234', stattoPin: '2468' });
  ok('pre-v2 config adopts the new organiser PIN', pins.adminPin === '07525418924');
  ok('pre-v2 config adopts the new Statto PIN', pins.stattoPin === '7869');
  ok('migration stamps configVersion 3', pins.configVersion === 3);
  ok('pre-v3 config adopts the new penalty tiers', pins.scoring.dropoutTiers.some(t => t.penalty === 10));
  const kept = logic.configMigrationPatch({ venue: 'Pitch 10 - Nou Camp', lat: 1, lon: 1, adminPin: '9999', configVersion: 3 });
  ok('a current config keeps its organiser PIN (no re-reset)', !('adminPin' in kept));
  // a v2 config (PINs done) still gets the v3 tier bump, but not the PINs again
  const v2 = logic.configMigrationPatch({ venue: 'Pitch 10 - Nou Camp', lat: 1, lon: 1, adminPin: '9999', configVersion: 2 });
  ok('v2 config gets tiers but not PINs', !('adminPin' in v2) && !!v2.scoring && v2.configVersion === 3);
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

// --- player performance (stats) --------------------------------------------
{
  const games = [
    { id: '1', status: 'completed', date: '2026-01-01', teams: { bibs: ['x'], nonbibs: ['z'] },
      stats: { x: { g: 2, a: 1, sv: 3, sh: 5, sot: 3 }, z: { g: 1 } } },
    { id: '2', status: 'completed', date: '2026-01-08', teams: { bibs: ['x'], nonbibs: ['z'] },
      stats: { x: { g: 1, sh: 3, sot: 1 } } },
    { id: '3', status: 'open', teams: { bibs: ['x'], nonbibs: ['z'] }, stats: { x: { g: 9 } } } // open → ignored
  ];
  const x = logic.playerPerformance('x', games);
  ok('performance sums goals across completed games (2+1=3)', x.g === 3);
  ok('performance sums assists (1)', x.a === 1);
  ok('performance counts only games with stats recorded', x.games === 2);
  ok('open games are not counted in performance', x.g === 3); // the g:9 open game excluded
  ok('shots-on-target % derived (4/8=50)', x.sotPct === 50);
  ok('missing stat keys default to 0', x.tkl === 0 && x.blk === 0);
  const none = logic.playerPerformance('nobody', games);
  ok('a player with no recorded stats has 0 games', none.games === 0 && none.g === 0);
  ok('STATS lists goals first (priority order)', logic.STATS[0].key === 'g' && logic.STATS[1].key === 'a');
}

// --- personal goals prefer stats over the legacy goals map -----------------
{
  const games = [
    { id: '1', status: 'completed', date: '2026-02-01', teams: { bibs: ['x'], nonbibs: ['z'] },
      scores: { bibs: 2, nonbibs: 0 }, goals: { x: 5 }, stats: { x: { g: 2 } } } // stats win over goals
  ];
  ok('playerAnalytics reads personal goals from stats when present', logic.playerAnalytics('x', games).pg === 2);
}

// --- ratings, MOTM and own goals -------------------------------------------
{
  const games = [
    { id: '1', status: 'completed', date: '2026-03-01', teams: { bibs: ['x'], nonbibs: ['z'] },
      stats: { x: { g: 1 } }, selfRatings: { x: 4 }, stattoRatings: { x: 2 }, motm: ['x'], ownGoals: { z: 1 } },
    { id: '2', status: 'completed', date: '2026-03-08', teams: { bibs: ['x'], nonbibs: ['z'] },
      selfRatings: { x: 5 }, motm: ['x', 'z'] } // no stats entry, self-rating only
  ];
  ok('effectiveRating averages self+statto (4,2 → 3)', logic.effectiveRating(games[0], 'x') === 3);
  ok('effectiveRating uses the lone value when only one side rated', logic.effectiveRating(games[1], 'x') === 5);
  ok('effectiveRating is null when unrated', logic.effectiveRating(games[0], 'z') === null);
  ok('isMotm reads the motm array', logic.isMotm(games[0], 'x') && !logic.isMotm(games[0], 'z'));
  ok('multiple MOTM per game allowed', logic.isMotm(games[1], 'x') && logic.isMotm(games[1], 'z'));
  const x = logic.playerPerformance('x', games);
  ok('performance avg rating over rated games ((3+5)/2 = 4)', x.rating === 4 && x.ratingGames === 2);
  ok('MOTM count across games', x.motm === 2);
  ok('rating games counted even without a stats entry', x.games === 1 && x.ratingGames === 2);
  const z = logic.playerPerformance('z', games);
  ok('own goals summed per player', z.og === 1);
  ok('own goals are not personal goals', z.g === 0);
  ok('one MOTM award for z', z.motm === 1);
  ok('unrated player has 0 rating and 0 rating games', z.rating === 0 && z.ratingGames === 0);
}

// --- spreadsheet import (import.js) ----------------------------------------
{
  const sheet = await import('../public/import.js');
  const players = {
    p1: { id: 'p1', name: 'Faisal' },
    p2: { id: 'p2', name: 'Haris Farooq' },
    p3: { id: 'p3', name: 'Tom Exon' }
  };
  const games = [
    { id: 'g_2026-07-14', date: '2026-07-14', dateLabel: 'Tue 14 Jul', status: 'completed', stats: { p3: { g: 1, sv: 2 } } },
    { id: 'g_2026-07-07', date: '2026-07-07', dateLabel: 'Tue 7 Jul', status: 'completed' }
  ];

  // CSV, single game via target, name matching (full + first name)
  const csv = 'Player,Goals,Assists,Rating,MOTM,Own goals\nFaisal,2,1,4,yes,\nHaris,0,1,,,1\nGhost,3,0,,,';
  const parsed = sheet.parseStatsSheet(csv);
  ok('parses header into columns', parsed.columns.g === 1 && parsed.columns.name === 0 && parsed.columns.motm === 4);
  const r1 = sheet.resolveImport(parsed, { players, games, targetGameId: 'g_2026-07-14' });
  ok('matches full and first names', r1.summary.matched === 2);
  ok('unmatched names are reported', r1.summary.unmatchedNames.length === 1 && r1.summary.unmatchedNames[0] === 'Ghost');
  ok('goals mapped to the target game', r1.byGame['g_2026-07-14'].stats.p1.g === 2);
  ok('rating captured', r1.byGame['g_2026-07-14'].stattoRatings.p1 === 4);
  ok('MOTM captured from truthy cell', r1.byGame['g_2026-07-14'].motm.includes('p1'));
  ok('own goal captured', r1.byGame['g_2026-07-14'].ownGoals.p2 === 1);
  ok('blank stat cells are omitted (not zeroed)', !('sv' in r1.byGame['g_2026-07-14'].stats.p1));

  // TSV, multi-game via Date column, header-alias flexibility
  const tsv = 'Date\tName\tG\tSv\n2026-07-14\tFaisal\t1\t3\n2026-07-07\tTom Exon\t2\t0';
  const p2 = sheet.parseStatsSheet(tsv);
  const r2 = sheet.resolveImport(p2, { players, games });
  ok('date column routes rows to different games', !!r2.byGame['g_2026-07-14'] && !!r2.byGame['g_2026-07-07']);
  ok('alias "Sv" maps to saves', r2.byGame['g_2026-07-14'].stats.p1.sv === 3);
  ok('date label match works alongside ISO', r2.summary.games.length === 2);

  // needTarget when no date column and no target
  const r3 = sheet.resolveImport(sheet.parseStatsSheet('Player,Goals\nFaisal,1'), { players, games });
  ok('flags needTarget when no date + no target game', r3.summary.needTarget && r3.summary.matched === 0);

  // date + url helpers
  ok('normDate handles UK dd/mm/yyyy', sheet.normDate('14/07/2026') === '2026-07-14');
  ok('normDate handles ISO', sheet.normDate('2026-7-7') === '2026-07-07');
  ok('toCsvUrl builds gviz csv from an edit link',
    sheet.toCsvUrl('https://docs.google.com/spreadsheets/d/ABC123/edit#gid=42') === 'https://docs.google.com/spreadsheets/d/ABC123/gviz/tq?tqx=out:csv&gid=42');
  ok('toCsvUrl passes through a published csv link',
    sheet.toCsvUrl('https://docs.google.com/spreadsheets/d/e/XYZ/pub?output=csv').includes('output=csv'));
  ok('toCsvUrl rejects non-sheets urls', sheet.toCsvUrl('https://example.com') === null);

  // player attribute ratings import
  const rp = sheet.parseRatingsSheet('Player,Fitness,Skill,Strength,Speed\nFaisal,14,15,12,13\nHaris,,18,,\nGhost,10,10,10,10');
  ok('ratings header parsed', rp.columns.fitness === 1 && rp.columns.speed === 4);
  const rr = sheet.resolveRatings(rp, { players });
  ok('ratings matched to players', rr.summary.players === 2);
  ok('full attrs captured', rr.byPlayer.p1.fitness === 14 && rr.byPlayer.p1.speed === 13);
  ok('blank rating cells omitted', rr.byPlayer.p2 && !('fitness' in rr.byPlayer.p2) && rr.byPlayer.p2.skill === 18);
  ok('unknown rated player reported', rr.summary.unmatchedNames.includes('Ghost'));
  ok('ratings clamp to 0–20', sheet.parseRatingsSheet('Player,Skill\nFaisal,99').rows[0].attrs.skill === 20);
  ok('alias Fit/Str/Spd/Skl map', (() => { const c = sheet.parseRatingsSheet('Player,Fit,Skl,Str,Spd\nX,1,2,3,4').columns; return c.fitness === 1 && c.skill === 2 && c.strength === 3 && c.speed === 4; })());
}

console.log(`\n${pass} checks passed ✅`);
