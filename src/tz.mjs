// Часовой пояс пользователя. Смещение в минутах к востоку от UTC.
// Внутри всё считаем в UTC-epoch; «настенное» время пользователя получаем
// сдвигом и читаем через getUTC*-поля. Сервер может стоять где угодно.

import { extractDate } from './dates.mjs';

const CITY_OFFSETS = {
  калининград: 120,
  москв: 180,
  питер: 180,
  спб: 180,
  петербург: 180,
  минск: 180,
  краснодар: 180,
  сочи: 180,
  самар: 240,
  ижевск: 240,
  екатеринбург: 300,
  екб: 300,
  челябинск: 300,
  уфа: 300,
  пермь: 300,
  омск: 360,
  новосибирск: 420,
  новосиб: 420,
  красноярск: 420,
  барнаул: 420,
  иркутск: 480,
  улан: 480,
  якутск: 540,
  чита: 540,
  владивосток: 600,
  влад: 600,
  хабаровск: 600,
  магадан: 660,
  камчатк: 720,
  киев: 120,
  алматы: 300,
  ташкент: 300,
  тбилиси: 240,
  ереван: 240,
  баку: 240,
  астан: 300,
  дубай: 240,
};

export const DEFAULT_OFFSET = 180; // Москва

// Разбор часового пояса из текста: «+3», «мск+2», «utc-5», название города.
export function parseTz(text) {
  const t = String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .trim();

  const m = t.match(/(?:utc|мск|gmt|мсk)?\s*([+\-−])\s*(\d{1,2})/);
  if (m) {
    const base = /мск|msk/.test(t) ? DEFAULT_OFFSET : 0;
    const sign = m[1] === '-' || m[1] === '−' ? -1 : 1;
    const off = base + sign * Number(m[2]) * 60;
    if (off >= -720 && off <= 840) return off;
  }
  for (const [city, off] of Object.entries(CITY_OFFSETS)) {
    // граница слова слева: «омск» не должен ловиться внутри «томск(а)»
    // (\b с кириллицей в JS не работает - lookbehind, как в dates.mjs)
    if (new RegExp(`(?<![а-яa-z])${city}`).test(t)) return off;
  }
  if (/москв|как у теб|по москв|по дефолту|не знаю|всеравно|все равно/.test(t)) return DEFAULT_OFFSET;
  return null;
}

export function userOffset(user) {
  return Number.isFinite(user?.tzOffset) ? user.tzOffset : DEFAULT_OFFSET;
}

// «Настенный» момент пользователя. Читать через getUTCHours/getUTCDate и т.д.
export function wall(user, now = new Date()) {
  return new Date(now.getTime() + userOffset(user) * 60000);
}

// Границы суток пользователя в реальном UTC-epoch.
export function userDayBounds(user, now = new Date()) {
  const w = wall(user, now);
  const wallMidnight = Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate());
  const start = wallMidnight - userOffset(user) * 60000;
  return { start, end: start + 86400000 };
}

// Локальные Y/M/D/H/M (интерпретированные в tz пользователя) -> реальный ISO.
export function wallFieldsToIso(offsetMin, y, mo, d, hh = 0, mm = 0) {
  return new Date(Date.UTC(y, mo, d, hh, mm) - offsetMin * 60000).toISOString();
}

// Разбор срока из фразы в часовом поясе пользователя -> реальный UTC ISO.
// Корректно при любой таймзоне сервера: строим base так, чтобы его
// СЕРВЕР-ЛОКАЛЬНЫЕ поля равнялись настенным полям пользователя, затем
// собираем эпоху из результата через userOffset.
export function resolveWallDate(offsetMin, text, now = new Date()) {
  const w = new Date(now.getTime() + offsetMin * 60000); // getUTC* = настенное время юзера
  const base = new Date(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes());
  const dt = extractDate(text, base);
  if (!dt.when) return { due: null, hasTime: false };
  const d = dt.when;
  const iso = new Date(
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()) - offsetMin * 60000
  ).toISOString();
  return { due: iso, hasTime: dt.hasTime };
}

// День из dayIso + время из timeIso, оба в поясе пользователя -> UTC ISO.
// Нужно для «перенеси на 16:00» без указания дня: день сохраняем.
export function combineDayTime(offsetMin, dayIso, timeIso) {
  const day = new Date(new Date(dayIso).getTime() + offsetMin * 60000);
  const tm = new Date(new Date(timeIso).getTime() + offsetMin * 60000);
  return new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), tm.getUTCHours(), tm.getUTCMinutes()) - offsetMin * 60000
  ).toISOString();
}

// Формат даты в tz пользователя.
export function fmtUser(iso, offsetMin = DEFAULT_OFFSET, withTime = false) {
  const d = new Date(new Date(iso).getTime() + offsetMin * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  return withTime ? `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day;
}
