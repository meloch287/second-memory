// HTTP-сервер: статика (public/) + JSON API. Ноль зависимостей.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { handleMessage } from './brain.mjs';
import { startTelegramBot } from './telegram.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/health') return json(res, 200, { ok: true });

    if (url.pathname === '/api/message' && req.method === 'POST') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'Ожидается JSON вида {"text":"..."}' });
      }
      const text = String(payload?.text ?? '').slice(0, 2000);
      return json(res, 200, handleMessage(store, text));
    }

    if (url.pathname === '/api/entries' && req.method === 'GET') {
      const type = url.searchParams.get('type') || undefined;
      const status = url.searchParams.get('status') || undefined;
      return json(res, 200, { entries: store.list({ type, status }) });
    }

    if (url.pathname === '/api/digest' && req.method === 'GET') {
      return json(res, 200, handleMessage(store, 'что у меня сегодня'));
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
      res.end('404 — не найдено');
    }
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Вторая память: http://localhost:${PORT}`);
});

startTelegramBot(store, process.env.TELEGRAM_BOT_TOKEN);
