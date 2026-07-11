// HTTP-сервер: статика (public/) + JSON API. Ноль зависимостей.
// createApp(store) собирает http.Server без побочек — для тестов; запуск как
// главный модуль (ниже) создаёт store, поднимает бота/воркер/планировщик и слушает порт.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, normalize, extname, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { handleMessage } from './brain.mjs';
import { memoryStats } from './ragmeter.mjs';
import { startTelegramBot } from './telegram.mjs';
import { startFactWorker } from './worker.mjs';
import { startScheduler } from './scheduler.mjs';
import { aiTts, aiTranscribe, audioFormatFromMime, audioEnabled } from './ai.mjs';
import {
  ensureAuth, verifyPassword, setPassword, makeSession, validSession, bumpEpoch,
  parseCookies, sessionCookie, clearCookie, getWebSettings, setWebSettings,
  startTgLink, linkedChatId, unlinkTg,
} from './webauth.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8790);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  return (await readRaw(req, 65536)).toString('utf8');
}

// Сырое тело (для аудио): возвращает Buffer, свой лимит размера.
async function readRaw(req, max) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new Error('Слишком большой запрос');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// Кука Secure только по HTTPS (за caddy — заголовок x-forwarded-proto).
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
// Ключ троттлинга — реальный сокет-адрес (за caddy это сам прокси). X-Forwarded-For
// НЕ используем: его подделывает клиент и обходит лимит / локаутит владельца.
const clientIp = (req) => String(req.socket?.remoteAddress || '?');

// createApp(store): собирает сервер вокруг переданного store, без побочных эффектов.
export function createApp(store) {
  const webChat = () => linkedChatId(store) || process.env.WEB_CHAT_ID || 'web';
  const authed = (req) => validSession(store, parseCookies(req.headers.cookie).sm_session);

  // Троттлинг входа: N неудач с одного IP -> экспоненциальный бэкофф. В памяти, на инстанс.
  const loginFails = new Map();
  const loginBlockedFor = (ip) => {
    const r = loginFails.get(ip);
    return r && r.until > Date.now() ? Math.ceil((r.until - Date.now()) / 1000) : 0;
  };
  const noteLoginFail = (ip) => {
    const r = loginFails.get(ip) || { n: 0, until: 0 };
    r.n += 1;
    if (r.n >= 5) r.until = Date.now() + Math.min(30000 * 2 ** (r.n - 5), 15 * 60000); // 30с→…→15мин
    loginFails.set(ip, r);
    // подчистка, чтобы Map не рос бесконечно (истёкшие записи)
    if (loginFails.size > 500) for (const [k, v] of loginFails) if (v.until < Date.now()) loginFails.delete(k);
  };
  const clearLoginFails = (ip) => loginFails.delete(ip);

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });

      // Вход: пароль -> сессионная кука
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const ip = clientIp(req);
        const wait = loginBlockedFor(ip);
        if (wait) {
          res.setHeader('retry-after', String(wait));
          return json(res, 429, { error: `Слишком много попыток. Повторите через ${wait} с.` });
        }
        let p;
        try { p = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
        if (!(await verifyPassword(store, p?.password || ''))) {
          noteLoginFail(ip);
          return json(res, 401, { error: 'Неверный пароль' });
        }
        clearLoginFails(ip);
        res.setHeader('set-cookie', sessionCookie(makeSession(store), isHttps(req)));
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/logout' && req.method === 'POST') {
        bumpEpoch(store); // обесцениваем старый токен на сервере, не только в куке
        res.setHeader('set-cookie', clearCookie(isHttps(req)));
        return json(res, 200, { ok: true });
      }

      // Все прочие /api/* требуют валидной сессии
      if (url.pathname.startsWith('/api/') && !authed(req)) {
        return json(res, 401, { error: 'Нужен вход' });
      }

      if (url.pathname === '/api/settings' && req.method === 'GET') {
        return json(res, 200, { ...getWebSettings(store), audio: audioEnabled() });
      }
      if (url.pathname === '/api/settings' && req.method === 'POST') {
        let p;
        try { p = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
        return json(res, 200, setWebSettings(store, p || {}));
      }
      if (url.pathname === '/api/password' && req.method === 'POST') {
        let p;
        try { p = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
        if (!(await verifyPassword(store, p?.current || ''))) return json(res, 403, { error: 'Текущий пароль неверный' });
        if (typeof p?.next !== 'string' || p.next.length < 6) return json(res, 400, { error: 'Новый пароль - минимум 6 символов' });
        setPassword(store, p.next);
        if (typeof p.login === 'string' && p.login.trim()) setWebSettings(store, { login: p.login });
        bumpEpoch(store); // старые сессии с других устройств недействительны
        res.setHeader('set-cookie', sessionCookie(makeSession(store), isHttps(req))); // новая сессия для текущего устройства
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/tts' && req.method === 'POST') {
        if (!audioEnabled()) return json(res, 503, { error: 'Озвучка недоступна' });
        let p;
        try { p = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
        if (typeof p?.text !== 'string' || !p.text.trim()) return json(res, 400, { error: 'нет текста' });
        try {
          const voice = getWebSettings(store).voice;
          const ogg = await aiTts(p.text.slice(0, 1500), voice);
          res.writeHead(200, { 'content-type': 'audio/ogg' });
          return res.end(ogg);
        } catch (e) {
          return json(res, 502, { error: 'Не удалось озвучить' });
        }
      }

      if (url.pathname === '/api/message' && req.method === 'POST') {
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { error: 'Ожидается JSON вида {"text":"..."}' });
        }
        if (typeof payload?.text !== 'string') {
          return json(res, 400, { error: 'Поле text должно быть строкой' });
        }
        return json(res, 200, await handleMessage(store, payload.text.slice(0, 2000), new Date(), webChat()));
      }

      if (url.pathname === '/api/memory-stats' && req.method === 'GET') {
        return json(res, 200, memoryStats(store, webChat()));
      }

      if (url.pathname === '/api/history/clear' && req.method === 'POST') {
        store.clearHistory(webChat());
        return json(res, 200, { ok: true });
      }

      // Восстановление ленты чата при загрузке страницы (раньше рефреш стирал диалог).
      if (url.pathname === '/api/history' && req.method === 'GET') {
        const turns = store.recentHistory(40, webChat()).map((h) => ({ role: h.role, text: h.text }));
        return json(res, 200, { turns });
      }

      // Серверное распознавание речи: фолбэк, когда браузерный SpeechRecognition
      // недоступен (не-Chromium) или вернул пусто. Клиент шлёт сам аудио-блоб.
      if (url.pathname === '/api/transcribe' && req.method === 'POST') {
        if (!audioEnabled()) return json(res, 503, { error: 'Распознавание недоступно' });
        let buf;
        try { buf = await readRaw(req, 8 * 1024 * 1024); } catch { return json(res, 413, { error: 'Аудио слишком большое' }); }
        if (!buf.length) return json(res, 400, { error: 'нет аудио' });
        const fmt = audioFormatFromMime(req.headers['content-type'] || '');
        try {
          const text = await aiTranscribe(buf.toString('base64'), fmt);
          return json(res, 200, { text: (text || '').trim() });
        } catch { return json(res, 502, { error: 'Не удалось распознать' }); }
      }

      if (url.pathname === '/api/entries' && req.method === 'GET') {
        const type = url.searchParams.get('type') || undefined;
        const status = url.searchParams.get('status') || undefined;
        return json(res, 200, { entries: store.list({ type, status, chatId: webChat() }) });
      }

      if (url.pathname === '/api/digest' && req.method === 'GET') {
        return json(res, 200, await handleMessage(store, 'что у меня сегодня', new Date(), webChat()));
      }

      // «Подключить Telegram»: выдаём одноразовый deep-link на бота.
      // dir: 'web' - перенести память из веба в TG; 'tg' - показать память из TG в вебе.
      if (url.pathname === '/api/tg-link' && req.method === 'POST') {
        const bot = store.data.meta.botUsername;
        if (!bot) return json(res, 503, { error: 'Бот пока не подключён к серверу' });
        let dir = 'web';
        try { dir = (JSON.parse(await readBody(req))?.dir === 'tg') ? 'tg' : 'web'; } catch {}
        const token = startTgLink(store, dir);
        return json(res, 200, { url: `https://t.me/${bot}?start=sm-${token}`, bot });
      }

      // «Отключить Telegram»: разрываем связку, веб возвращается в своё 'web'.
      if (url.pathname === '/api/tg-unlink' && req.method === 'POST') {
        unlinkTg(store);
        return json(res, 200, { ok: true });
      }

      // Веб-напоминания: дела со временем, которым пришёл срок и которые ещё не
      // показывались в вебе. Клиент опрашивает и показывает всплывашку.
      if (url.pathname === '/api/reminders/due' && req.method === 'GET') {
        const cid = webChat();
        const now = Date.now();
        const due = store.list({ status: 'open', chatId: cid })
          .filter((e) => e.hasTime && e.due && !e.webShown && Date.parse(e.due) <= now && Date.parse(e.due) > now - 86400000);
        for (const e of due) store.patch(e.id, { webShown: true });
        return json(res, 200, {
          reminders: due.map((e) => ({ id: e.id, title: e.title || e.counterparty || 'дело', due: e.due, type: e.type })),
        });
      }

      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Нет такого метода' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Метод не поддерживается' });

      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = normalize(join(PUBLIC, path));
      // Граница по разделителю: '/public-evil' не должен пройти как префикс '/public'.
      if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) return json(res, 403, { error: 'Запрещено' });

      try {
        const data = await readFile(file);
        const ext = extname(file);
        // html/js/css НЕ кэшируем - иначе после деплоя браузер показывает старый
        // интерфейс из кэша (заголовков кэша раньше не было = эвристический кэш).
        const noStore = ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json';
        res.writeHead(200, {
          'content-type': MIME[ext] || 'application/octet-stream',
          'cache-control': noStore ? 'no-store, must-revalidate' : 'public, max-age=86400',
        });
        res.end(data);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('404 - не найдено');
      }
    } catch (e) {
      // Текст исключения наружу не отдаём (утечка внутренностей) — только в лог.
      console.error('[server]', e?.stack || e?.message || e);
      json(res, 500, { error: 'внутренняя ошибка' });
    }
  });
}

// --- Запуск как главный модуль ---
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // .env (если есть): AI_API_KEY, TELEGRAM_BOT_TOKEN и т.д. Уже заданные переменные имеют приоритет.
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {}

  const store = new Store(process.env.SM_DATA || join(ROOT, 'data', 'memory.json'));

  // Пароль веб-панели: из env при первом старте. Если env пуст — генерируем
  // случайный и печатаем один раз (статического дефолта больше нет).
  const _auth = ensureAuth(store, process.env.WEB_PASSWORD);
  if (_auth.generated) {
    console.log(`[webauth] WEB_PASSWORD не задан — сгенерирован временный пароль веб-панели: ${_auth.password}`);
    console.log('[webauth] Смените его в настройках или задайте WEB_PASSWORD в окружении.');
  }

  const server = createApp(store);
  // WEB_DISABLED=1: работает только бот со своей обвязкой, HTTP не поднимается
  if (process.env.WEB_DISABLED === '1') {
    console.log('Веб-интерфейс выключен (WEB_DISABLED=1), работает только бот');
  } else {
    server.listen(PORT, () => console.log(`Вторая память: http://localhost:${PORT}`));
  }

  const bot = startTelegramBot(store, process.env.TELEGRAM_BOT_TOKEN);
  startFactWorker(store);
  startScheduler(store, bot);
}
