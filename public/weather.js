// weather.js — match weather via Open-Meteo (free, no API key, CORS-friendly).
// Forecast for upcoming games, historical archive for past ones. Returns a
// small normalised summary the UI renders, or null if unavailable.

// WMO weather-interpretation codes → label + emoji.
// https://open-meteo.com/en/docs (WMO Weather interpretation codes)
const WMO = {
  0: ['Clear', '☀️'],
  1: ['Mainly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌦️'],
  56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
  80: ['Light showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Heavy showers', '🌧️'],
  85: ['Snow showers', '🌨️'], 86: ['Snow showers', '🌨️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm', '⛈️'], 99: ['Thunderstorm', '⛈️']
};
export function describeWeather(code) {
  const w = WMO[code]; return { label: w ? w[0] : 'Unknown', emoji: w ? w[1] : '🌡️' };
}

// Flags for the (future) weather loyalty weighting: was it cold / wet enough
// to deserve extra credit for turning up? Exposed now so the UI can hint at it.
export function weatherFlags(w) {
  if (!w) return { cold: false, wet: false, rough: false };
  const cold = (w.apparentC ?? w.tempC) <= 4;
  const wet = (w.precipMm ?? 0) >= 0.5 || (w.rainProb ?? 0) >= 60 || [61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(w.code);
  return { cold, wet, rough: cold || wet };
}

const cache = new Map();
const dayKey = iso => String(iso).slice(0, 10);
const hourOf = iso => { const d = new Date(iso); return d.getHours(); };

// Pull the hour nearest kickoff out of Open-Meteo's hourly arrays.
function pickHour(hourly, iso) {
  if (!hourly || !hourly.time || !hourly.time.length) return null;
  const target = `${dayKey(iso)}T${String(hourOf(iso)).padStart(2, '0')}:00`;
  let idx = hourly.time.indexOf(target);
  if (idx < 0) { // fall back to the closest available hour that day
    const day = dayKey(iso);
    const sameDay = hourly.time.map((t, i) => ({ t, i })).filter(x => x.t.startsWith(day));
    if (!sameDay.length) return null;
    const th = hourOf(iso);
    idx = sameDay.reduce((best, x) => Math.abs(Number(x.t.slice(11, 13)) - th) < Math.abs(Number(sameDay[best].t.slice(11, 13)) - th) ? x.i : best, sameDay[0].i);
  }
  const num = (arr) => (arr && arr[idx] != null ? arr[idx] : null);
  const code = num(hourly.weathercode);
  const d = describeWeather(code);
  return {
    tempC: num(hourly.temperature_2m),
    apparentC: num(hourly.apparent_temperature),
    precipMm: num(hourly.precipitation),
    rainProb: num(hourly.precipitation_probability),
    windKph: num(hourly.wind_speed_10m),
    code, label: d.label, emoji: d.emoji
  };
}

// Fetch the conditions at kickoff for a given venue + ISO datetime.
// Chooses the forecast endpoint for upcoming/recent dates and the historical
// archive for older ones. Cached per venue+datetime.
export async function fetchWeather(lat, lon, iso) {
  if (lat == null || lon == null || !iso) return null;
  const key = `${lat},${lon},${iso}`;
  if (cache.has(key)) return cache.get(key);

  const day = dayKey(iso);
  const ageDays = (Date.now() - new Date(day + 'T12:00').getTime()) / 86400000;
  const hourlyVars = 'temperature_2m,apparent_temperature,precipitation,precipitation_probability,weathercode,wind_speed_10m';
  // Archive reanalysis lags ~5 days; use the forecast endpoint (which also
  // carries recent past days) for anything newer, archive for older.
  const base = ageDays > 6
    ? 'https://archive-api.open-meteo.com/v1/archive'
    : 'https://api.open-meteo.com/v1/forecast';
  const url = `${base}?latitude=${lat}&longitude=${lon}&hourly=${hourlyVars}` +
    `&wind_speed_unit=kmh&timezone=auto&start_date=${day}&end_date=${day}`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('weather ' + r.status);
    const data = await r.json();
    const out = pickHour(data.hourly, iso);
    cache.set(key, out);
    return out;
  } catch (e) {
    console.error('weather', e);
    cache.set(key, null); // don't hammer a failing endpoint
    return null;
  }
}
