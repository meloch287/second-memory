// HTTP-сервер: статика (public/) + JSON API. Ноль зависимостей.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { handleMessage } from './brain.mjs';
import { memoryStats } from './ragmeter.mjs';
import { startTelegramBot } from './telegram.mjs';
import { startFactWorker } from './worker.mjs';
import { startScheduler } from './scheduler.mjs';
import { aiTts, audioEnabled } from './ai.mjs';
import {
  ensureAuth, verifyPassword, setPassword, makeSession, validSession,
  parseCookies, sessionCookie, clearCookie, getWebSettings, setWebSettings,
} from './webauth.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// .env (если есть): AI_API_KEY, TELEGRAM_BOT_TOKEN и т.д. Уже заданные
// переменные окружения имеют приоритет.
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8790);

const store = new Store(process.env.SM_DATA || join(ROOT, 'data', 'memory.json'));

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
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 65536) throw new Error('Слишком большой запрос');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Пароль веб-панели: из env при первом старте, иначе дефолт (сменить в UI).
ensureAuth(store, process.env.WEB_PASSWORD);

const authed = (req) => validSession(store, parseCookies(req.headers.cookie).sm_session);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });

    // Вход: пароль -> сессионная кука
    if (url.pathname === '/api/login' && req.method === 'POST') {
      let p;
      try { p = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      if (!verifyPassword(store, p?.password || '')) return json(res, 401, { error: 'Неверный пароль' });
      res.setHeader('set-cookie', sessionCookie(makeSession(store)));
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      res.setHeader('set-cookie', clearCookie());
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
      if (!verifyPassword(store, p?.current || '')) return json(res, 403, { error: 'Текущий пароль неверный' });
      if (typeof p?.next !== 'string' || p.next.length < 6) return json(res, 400, { error: 'Новый пароль - минимум 6 символов' });
      setPassword(store, p.next);
      if (typeof p.login === 'string' && p.login.trim()) setWebSettings(store, { login: p.login });
      res.setHeader('set-cookie', sessionCookie(makeSession(store))); // обновляем сессию
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
      return json(res, 200, await handleMessage(store, payload.text.slice(0, 2000)));
    }

    if (url.pathname === '/api/memory-stats' && req.method === 'GET') {
      return json(res, 200, memoryStats(store));
    }

    if (url.pathname === '/api/history/clear' && req.method === 'POST') {
      store.clearHistory();
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/entries' && req.method === 'GET') {
      const type = url.searchParams.get('type') || undefined;
      const status = url.searchParams.get('status') || undefined;
      return json(res, 200, { entries: store.list({ type, status }) });
    }

    if (url.pathname === '/api/digest' && req.method === 'GET') {
      return json(res, 200, await handleMessage(store, 'что у меня сегодня'));
    }

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Нет такого метода' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Метод не поддерживается' });

    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = normalize(join(PUBLIC, path));
    if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'Запрещено' });

    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 - не найдено');
    }
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

// WEB_DISABLED=1: работает только бот со своей обвязкой, HTTP не поднимается
if (process.env.WEB_DISABLED === '1') {
  console.log('Веб-интерфейс выключен (WEB_DISABLED=1), работает только бот');
} else {
  server.listen(PORT, () => {
    console.log(`Вторая память: http://localhost:${PORT}`);
  });
}

const bot = startTelegramBot(store, process.env.TELEGRAM_BOT_TOKEN);
startFactWorker(store);
startScheduler(store, bot);
