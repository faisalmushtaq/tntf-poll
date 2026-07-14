// logic.js — pure selection/loyalty logic. No I/O, no framework.
// Imported by both the browser app and the Node tests, so it stays testable.

export const DEFAULT_CONFIG = {
  clubName: 'Tuesday Night Total Football',
  gameDay: 'Tuesday',
  kickoff: '20:00',        // 24h local time, used to time-weight penalties
  capacity: 14,            // 7-a-side default
  adminPin: '1234',        // change from Settings
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
