// import.js — parse a stats spreadsheet (CSV/TSV, e.g. exported from Google
// Sheets) into per-game, per-player records, and resolve player names + dates
// against the roster and fixtures. Pure and framework-free so it's unit-tested.

import { STATS, ATTRS } from './logic.js';

// ---- header aliases -------------------------------------------------------
// Normalise a header cell to a lookup key: lowercase, drop anything in
// brackets, collapse non-alphanumerics to single spaces.
export function normHeader(s) {
  return String(s).toLowerCase().replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// field key -> list of accepted header spellings (normalised on use).
const ALIASES = {
  name: ['player', 'name', 'players', 'player name'],
  date: ['date', 'match', 'game', 'fixture', 'match date'],
  rating: ['rating', 'rate', 'stars', 'star rating', 'out of 5'],
  motm: ['motm', 'man of the match', 'mom', 'star man', 'motw'],
  og: ['own goals', 'own goal', 'og', 'owngoal', 'owngoals'],
  g: ['goals', 'goal', 'g', 'gls', 'scored'],
  a: ['assists', 'assist', 'a', 'ast', 'assisted'],
  sv: ['saves', 'save', 'sv', 'gk saves'],
  sh: ['shots', 'shot', 'sh'],
  sot: ['on target', 'shots on target', 'shot on target', 'sot'],
  tkl: ['tackles', 'tackle', 'tkl'],
  blk: ['blocks', 'block', 'blk'],
  pass: ['passes', 'pass'],
  passc: ['passes completed', 'completed passes', 'pass completed', 'passc', 'pass'],
  pp: ['progressive passes', 'prog passes', 'pp'],
  ppc: ['prog passes completed', 'progressive passes completed', 'ppc'],
  ww: ['woodwork', 'hit woodwork', 'ww']
};
// Build a normalised alias -> field-key index. Longer/more-specific spellings
// win (e.g. "passes completed" before "passes", "on target" before nothing).
const ALIAS_INDEX = (() => {
  const idx = {};
  for (const [key, list] of Object.entries(ALIASES)) {
    for (const spelling of list) idx[normHeader(spelling)] = key;
  }
  return idx;
})();
const STAT_KEYS = STATS.map(s => s.key);

// ---- delimited parsing ----------------------------------------------------
// Parse CSV or TSV text into a 2-D array of strings, honouring "quoted" cells
// (with "" escapes). Delimiter is auto-detected (tab wins if the header has one).
export function parseDelimited(text) {
  const src = String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!src.trim()) return [];
  const firstLine = src.slice(0, src.indexOf('\n') < 0 ? src.length : src.indexOf('\n'));
  const delim = firstLine.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows;
}

const truthy = v => /^(y|yes|1|x|true|t|motm|✓|✔|★|\*)/i.test(String(v).trim());
// A rating cell: a number 0–5, or a run of ★ characters.
function parseRating(v) {
  const s = String(v).trim();
  if (!s) return null;
  const stars = (s.match(/[★✦]/g) || []).length;
  if (stars) return Math.min(5, stars);
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.min(5, n) : null;
}

// ---- sheet -> rows --------------------------------------------------------
// Parse a stats sheet into structured rows. Returns { rows, columns, warnings }.
// Only columns whose blank cells we should NOT treat as zero are omitted from a
// row's `values`; an explicit number (including 0) is always kept.
export function parseStatsSheet(text) {
  const grid = parseDelimited(text).filter(r => r.some(c => String(c).trim() !== ''));
  if (!grid.length) return { rows: [], columns: {}, warnings: ['The sheet is empty.'] };
  const header = grid[0].map(normHeader);
  const columns = {}; // fieldKey -> column index
  header.forEach((h, i) => { const key = ALIAS_INDEX[h]; if (key && !(key in columns)) columns[key] = i; });
  const warnings = [];
  if (!('name' in columns)) warnings.push('No "Player" column found — needed to match people.');
  const statCols = STAT_KEYS.filter(k => k in columns);
  if (!statCols.length && !('rating' in columns) && !('motm' in columns) && !('og' in columns)) {
    warnings.push('No recognised stat columns (Goals, Assists, Rating, MOTM, …) found.');
  }
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const line = grid[r];
    const cell = key => (columns[key] != null ? String(line[columns[key]] ?? '').trim() : '');
    const name = cell('name');
    if (!name) continue;
    const values = {};
    for (const k of statCols) {
      const raw = cell(k);
      if (raw === '') continue;               // blank → leave that stat untouched
      const n = Number(raw);
      if (Number.isFinite(n)) values[k] = n;  // explicit number (incl. 0)
    }
    rows.push({
      name,
      date: 'date' in columns ? cell('date') : '',
      values,
      rating: 'rating' in columns ? parseRating(cell('rating')) : null,
      motm: 'motm' in columns ? truthy(cell('motm')) : false,
      og: 'og' in columns ? (Number(cell('og')) || 0) : 0
    });
  }
  return { rows, columns, warnings };
}

// ---- name + date resolution ----------------------------------------------
export function normName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
function pad(n) { return String(n).padStart(2, '0'); }
// Normalise a date cell to 'YYYY-MM-DD', or null if unparseable.
export function normDate(s) {
  const t = String(s).trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = t.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/); // dd/mm/yyyy (UK)
  if (m) { let [, d, mo, y] = m; if (y.length === 2) y = '20' + y; return `${y}-${pad(mo)}-${pad(d)}`; }
  const ms = Date.parse(t);
  if (!Number.isNaN(ms)) return new Date(ms).toISOString().slice(0, 10);
  return null;
}

function playerIndex(players) {
  const full = {}, first = {};
  for (const p of Object.values(players || {})) {
    const n = normName(p.name);
    if (!n) continue;
    (full[n] ||= []).push(p.id);
    (first[n.split(' ')[0]] ||= []).push(p.id);
  }
  return { full, first };
}
function matchPlayer(raw, idx) {
  const n = normName(raw);
  if (idx.full[n] && idx.full[n].length === 1) return idx.full[n][0];
  if (idx.full[n] && idx.full[n].length > 1) return null; // ambiguous full name
  const f = n.split(' ')[0];
  if (idx.first[f] && idx.first[f].length === 1) return idx.first[f][0];
  return null;
}
function matchGame(raw, games) {
  const s = String(raw).trim().toLowerCase();
  const iso = normDate(raw);
  for (const g of games) {
    if (iso && g.date === iso) return g.id;
    if (g.dateLabel && String(g.dateLabel).toLowerCase() === s) return g.id;
    if (g.date && String(g.date).toLowerCase() === s) return g.id;
  }
  return null;
}

// Resolve parsed rows against the roster + fixtures into a per-game payload.
// opts: { players, games, targetGameId } — targetGameId is used for rows with
// no Date column (or when the sheet is a single game). Returns a preview:
//   { byGame, summary }
export function resolveImport(parsed, { players = {}, games = [], targetGameId = null } = {}) {
  const idx = playerIndex(players);
  const byGame = {};
  const unmatchedNames = new Set(), unmatchedDates = new Set();
  let matched = 0, needTarget = false;
  const hasDateCol = 'date' in (parsed.columns || {});

  for (const row of parsed.rows) {
    let gameId = targetGameId;
    if (hasDateCol && row.date) {
      gameId = matchGame(row.date, games);
      if (!gameId) { unmatchedDates.add(row.date); continue; }
    } else if (!targetGameId) { needTarget = true; continue; }

    const pid = matchPlayer(row.name, idx);
    if (!pid) { unmatchedNames.add(row.name); continue; }

    const gm = (byGame[gameId] ||= { stats: {}, stattoRatings: {}, ownGoals: {}, motm: [] });
    if (Object.keys(row.values).length) gm.stats[pid] = { ...(gm.stats[pid] || {}), ...row.values };
    if (row.rating != null) gm.stattoRatings[pid] = row.rating;
    if (row.og > 0) gm.ownGoals[pid] = (gm.ownGoals[pid] || 0) + row.og;
    if (row.motm && !gm.motm.includes(pid)) gm.motm.push(pid);
    matched++;
  }

  // Per-game label + counts for the preview UI.
  const gameList = Object.keys(byGame).map(id => {
    const g = games.find(x => x.id === id);
    const gm = byGame[id];
    const players = new Set([...Object.keys(gm.stats), ...Object.keys(gm.stattoRatings), ...Object.keys(gm.ownGoals), ...gm.motm]);
    return { id, label: g ? (g.dateLabel || g.date || id) : id, players: players.size, motm: gm.motm.length };
  });

  return {
    byGame,
    summary: {
      matched, rows: parsed.rows.length,
      games: gameList,
      unmatchedNames: [...unmatchedNames],
      unmatchedDates: [...unmatchedDates],
      needTarget,
      warnings: parsed.warnings || []
    }
  };
}

// ---- player attribute ratings (Organiser) ---------------------------------
// A separate importer for the /20 team-balancing ratings (Fitness, Skill,
// Strength, Speed), keyed to players rather than games.
const ATTR_ALIASES = {
  name: ['player', 'name', 'players', 'player name'],
  fitness: ['fitness', 'fit', 'stamina'],
  skill: ['skill', 'skl', 'technique', 'ability'],
  strength: ['strength', 'str', 'power'],
  speed: ['speed', 'spd', 'pace']
};
const ATTR_INDEX = (() => {
  const idx = {};
  for (const [key, list] of Object.entries(ATTR_ALIASES)) for (const s of list) idx[normHeader(s)] = key;
  return idx;
})();

// Parse a ratings sheet into { rows:[{name, attrs}], columns, warnings }.
export function parseRatingsSheet(text) {
  const grid = parseDelimited(text).filter(r => r.some(c => String(c).trim() !== ''));
  if (!grid.length) return { rows: [], columns: {}, warnings: ['The sheet is empty.'] };
  const header = grid[0].map(normHeader);
  const columns = {};
  header.forEach((h, i) => { const key = ATTR_INDEX[h]; if (key && !(key in columns)) columns[key] = i; });
  const warnings = [];
  if (!('name' in columns)) warnings.push('No "Player" column found — needed to match people.');
  const attrCols = ATTRS.filter(k => k in columns);
  if (!attrCols.length) warnings.push('No rating columns (Fitness, Skill, Strength, Speed) found.');
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const line = grid[r];
    const cell = key => (columns[key] != null ? String(line[columns[key]] ?? '').trim() : '');
    const name = cell('name');
    if (!name) continue;
    const attrs = {};
    for (const k of attrCols) {
      const raw = cell(k);
      if (raw === '') continue;
      const n = Number(raw);
      if (Number.isFinite(n)) attrs[k] = Math.max(0, Math.min(20, n));
    }
    rows.push({ name, attrs });
  }
  return { rows, columns, warnings };
}

// Resolve ratings rows against the roster into { byPlayer, summary }.
export function resolveRatings(parsed, { players = {} } = {}) {
  const idx = playerIndex(players);
  const byPlayer = {};
  const unmatchedNames = new Set();
  let matched = 0;
  for (const row of parsed.rows) {
    if (!Object.keys(row.attrs).length) continue;
    const pid = matchPlayer(row.name, idx);
    if (!pid) { unmatchedNames.add(row.name); continue; }
    byPlayer[pid] = { ...(byPlayer[pid] || {}), ...row.attrs };
    matched++;
  }
  return {
    byPlayer,
    summary: {
      matched, rows: parsed.rows.length,
      players: Object.keys(byPlayer).length,
      unmatchedNames: [...unmatchedNames],
      warnings: parsed.warnings || []
    }
  };
}

// Ready-to-paste ratings template (header + example row).
export function templateRatings() {
  const cols = ['Player', ...ATTRS.map(a => a[0].toUpperCase() + a.slice(1))];
  const example = ['Faisal', '14', '15', '12', '13'];
  return cols.join('\t') + '\n' + example.join('\t');
}

// A ready-to-paste template header (+ one example row) covering everything the
// importer understands. Tab-separated so it pastes cleanly into a sheet.
export function templateText() {
  const cols = ['Date', 'Player', ...STATS.map(s => s.label), 'Rating', 'MOTM', 'Own goals'];
  const example = ['2026-07-14', 'Faisal', '2', '1', ...STATS.slice(2).map(() => ''), '4', 'yes', ''];
  return cols.join('\t') + '\n' + example.join('\t');
}

// Turn a Google Sheets share/edit URL into a CSV export URL the browser can
// fetch. Handles normal /d/<id> links, published /d/e/<id> links, and URLs that
// are already a CSV endpoint. Returns null if it doesn't look like Sheets.
export function toCsvUrl(url) {
  const u = String(url).trim();
  if (!u) return null;
  if (/output=csv|format=csv|tqx=out:csv/.test(u)) return u; // already CSV
  const pub = u.match(/\/spreadsheets\/d\/e\/([\w-]+)/);
  if (pub) return `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=csv`;
  const m = u.match(/\/spreadsheets\/d\/([\w-]+)/);
  if (!m) return null;
  const gid = (u.match(/[#&?]gid=(\d+)/) || [])[1];
  return `https://docs.google.com/spreadsheets/d/${m[1]}/gviz/tq?tqx=out:csv` + (gid ? `&gid=${gid}` : '');
}
