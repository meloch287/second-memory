// Аутентификация веб-панели на уровне приложения: пароль (scrypt-хэш) и
// подписанная сессионная кука. Данные и секрет живут в store.data.meta.web.
// Ноль зависимостей.

import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

const DAY = 86400;
const SESSION_TTL = 30 * DAY; // кука живёт 30 дней

function cfg(store) {
  if (!store.data.meta.web) store.data.meta.web = {};
  return store.data.meta.web;
}

// Секрет для подписи кук - создаётся один раз и хранится в meta.
function secret(store) {
  const c = cfg(store);
  if (!c.sessionSecret) {
    c.sessionSecret = randomBytes(32).toString('hex');
    store.save();
  }
  return c.sessionSecret;
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const h = scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${h}`;
}

export function verifyPassword(store, password) {
  const c = cfg(store);
  if (!c.passHash) return false;
  const [salt, h] = c.passHash.split(':');
  const want = Buffer.from(h, 'hex');
  const got = scryptSync(String(password), salt, 32);
  return want.length === got.length && timingSafeEqual(want, got);
}

// Логин/пароль по умолчанию задаём при первом старте (пароль из env или дефолт).
export function ensureAuth(store, defaultPass) {
  const c = cfg(store);
  if (!c.login) c.login = 'admin';
  if (!c.passHash) {
    c.passHash = hashPassword(defaultPass || 'change-me');
    store.save();
  }
}

export function setPassword(store, newPassword) {
  cfg(store).passHash = hashPassword(newPassword);
  store.save();
}

export function getLogin(store) {
  return cfg(store).login || 'admin';
}
export function setLogin(store, login) {
  cfg(store).login = String(login).slice(0, 40) || 'admin';
  store.save();
}

// --- Настройки веб-панели ---
const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

export function getWebSettings(store) {
  const c = cfg(store);
  return {
    name: c.assistantName || 'Вторая память',
    login: c.login || 'admin',
    voiceReplies: !!c.voiceReplies,
    voice: VOICES.includes(c.voice) ? c.voice : 'alloy',
    voices: VOICES,
    tgLinked: !!c.linkedChatId,
  };
}

// --- Связка веб-профиля с Telegram («Подключить Telegram-алерты») ---
// Одноразовый токен: веб генерит, отдаёт deep-link t.me/<bot>?start=sm-<token>,
// бот при /start sm-<token> подтверждает и привязывает свой chatId.
export function startTgLink(store, dir = 'web') {
  const c = cfg(store);
  const token = randomBytes(9).toString('base64url');
  c.linkToken = { token, exp: Date.now() + 15 * 60000, dir: dir === 'tg' ? 'tg' : 'web' };
  store.save();
  return token;
}
// Возвращает направление переноса ('web'|'tg') при успехе, иначе null.
export function consumeTgLink(store, token, chatId) {
  const c = cfg(store);
  const lt = c.linkToken;
  if (!lt || lt.token !== token || Date.now() > lt.exp) return null;
  c.linkedChatId = String(chatId);
  const dir = lt.dir || 'web';
  delete c.linkToken;
  store.save();
  return dir;
}
export function linkedChatId(store) {
  return cfg(store).linkedChatId || null;
}
export function unlinkTg(store) {
  const c = cfg(store);
  delete c.linkedChatId;
  store.save();
}

export function setWebSettings(store, patch) {
  const c = cfg(store);
  if (typeof patch.name === 'string') c.assistantName = patch.name.trim().slice(0, 40) || 'Вторая память';
  if (typeof patch.voiceReplies === 'boolean') c.voiceReplies = patch.voiceReplies;
  if (typeof patch.voice === 'string' && VOICES.includes(patch.voice)) c.voice = patch.voice;
  if (typeof patch.login === 'string' && patch.login.trim()) c.login = patch.login.trim().slice(0, 40);
  store.save();
  return getWebSettings(store);
}

// --- Сессии: подписанный токен «эпоха.время.подпись». Смена пароля или выход
// поднимают epoch, обесценивая все старые токены (серверная инвалидация). ---

function epoch(store) {
  return cfg(store).sessionEpoch || 0;
}
export function bumpEpoch(store) {
  const c = cfg(store);
  c.sessionEpoch = (c.sessionEpoch || 0) + 1;
  store.save();
}

export function makeSession(store) {
  const payload = `${epoch(store)}.${Date.now()}`;
  const sig = createHmac('sha256', secret(store)).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function validSession(store, token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const want = createHmac('sha256', secret(store)).update(payload).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const [ep, tsStr] = payload.split('.');
  if (Number(ep) !== epoch(store)) return false; // токен из старой эпохи - недействителен
  const ts = Number(tsStr);
  return Number.isFinite(ts) && Date.now() - ts < SESSION_TTL * 1000;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token) {
  return `sm_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}`;
}
export const clearCookie = () => 'sm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
