// Погода без ключей через Open-Meteo (geocoding + forecast).
// Для утренних напоминаний: температура, дождь, совет «возьми зонт».

const UA = { 'user-agent': 'second-memory-bot/1.0' };

const WMO = {
  0: 'ясно', 1: 'малооблачно', 2: 'облачно', 3: 'пасмурно',
  45: 'туман', 48: 'изморозь',
  51: 'морось', 53: 'морось', 55: 'морось',
  61: 'дождь', 63: 'дождь', 65: 'сильный дождь',
  66: 'ледяной дождь', 67: 'ледяной дождь',
  71: 'снег', 73: 'снег', 75: 'сильный снег', 77: 'снежная крупа',
  80: 'ливень', 81: 'ливень', 82: 'сильный ливень',
  85: 'снегопад', 86: 'снегопад',
  95: 'гроза', 96: 'гроза с градом', 99: 'гроза с градом',
};

async function fetchJson(url, timeoutMs = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: c.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function geocode(city) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ru&format=json`;
  const data = await fetchJson(url);
  const r = data?.results?.[0];
  return r ? { lat: r.latitude, lon: r.longitude, name: r.name } : null;
}

// Прогноз на сегодня. Возвращает { tmax, tmin, precip, desc, advice } или null.
export async function todayWeather(city) {
  try {
    const geo = await geocode(city);
    if (!geo) return null;
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=1`;
    const data = await fetchJson(url);
    const d = data?.daily;
    if (!d) return null;
    const tmax = Math.round(d.temperature_2m_max?.[0]);
    const tmin = Math.round(d.temperature_2m_min?.[0]);
    const precip = d.precipitation_probability_max?.[0] ?? 0;
    const code = d.weather_code?.[0];
    const desc = WMO[code] || 'без осадков';

    const tips = [];
    if (precip >= 50 || [61, 63, 65, 80, 81, 82, 95, 96, 99].includes(code)) tips.push('возьми зонт');
    if ([71, 73, 75, 77, 85, 86].includes(code)) tips.push('на улице снег, одевайся теплее');
    if (tmax <= 3) tips.push('holodно, оденься потеплее'.replace('holod', 'хол'));
    if (tmax >= 28) tips.push('жарко, не забудь воду');
    const advice = tips.join(', ');

    return { tmax, tmin, precip, desc, advice, city: geo.name };
  } catch {
    return null;
  }
}

// Строка для утреннего сообщения.
export function weatherLine(w) {
  if (!w) return null;
  const base = `Погода в ${w.city}: ${w.tmax}°${w.tmin != null ? ` (ночью ${w.tmin}°)` : ''}, ${w.desc}${w.precip ? `, осадки ${w.precip}%` : ''}`;
  return w.advice ? `${base}. ${w.advice[0].toUpperCase()}${w.advice.slice(1)}.` : base + '.';
}
