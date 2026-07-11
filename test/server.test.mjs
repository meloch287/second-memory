// HTTP-поверхность server.mjs: поднимаем createApp(store) на эфемерном порту,
// бьём реальным fetch. AI не задействован (без ключа детерминированный путь).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { ensureAuth } from '../src/webauth.mjs';
import { createApp } from '../src/server.mjs';

delete process.env.SM_ENCRYPTION_KEY;
delete process.env.WEB_CHAT_ID;

let srv, base;
const store = new Store(join(mkdtempSync(join(tmpdir(), 'sm-srv-')), 'm.json'));
ensureAuth(store, 'testpass');

before(async () => {
  srv = createApp(store);
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());

const post = (path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('health открыт без входа', async () => {
  const r = await fetch(base + '/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('защищённый /api/* без сессии -> 401', async () => {
  const r = await fetch(base + '/api/entries');
  assert.equal(r.status, 401);
});

test('логин: неверный пароль -> 401, верный -> 200 + кука, и она открывает /api/*', async () => {
  const bad = await post('/api/login', { password: 'nope' });
  assert.equal(bad.status, 401);

  const ok = await post('/api/login', { password: 'testpass' });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /sm_session=/);
  assert.match(cookie, /HttpOnly/);
  // localhost без x-forwarded-proto=https -> без Secure (иначе кука не долетит по http)
  assert.ok(!/Secure/.test(cookie), 'на http Secure не ставим');

  const sess = cookie.split(';')[0];
  const r = await fetch(base + '/api/entries', { headers: { cookie: sess } });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray((await r.json()).entries));
});

test('кука получает Secure при x-forwarded-proto=https', async () => {
  const ok = await post('/api/login', { password: 'testpass' }, { 'x-forwarded-proto': 'https' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /Secure/);
});

test('троттлинг логина: серия неудач -> 429 с Retry-After', async () => {
  const s2 = new Store(join(mkdtempSync(join(tmpdir(), 'sm-srv2-')), 'm.json'));
  ensureAuth(s2, 'pw');
  const app = createApp(s2);
  await new Promise((r) => app.listen(0, r));
  const b2 = `http://127.0.0.1:${app.address().port}`;
  try {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(b2 + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }) });
      assert.equal(r.status, 401, `попытка ${i + 1} ещё не блок`);
    }
    const blocked = await fetch(b2 + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
    assert.equal(blocked.status, 429, 'после 5 неудач — блок даже с верным паролем');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  } finally {
    app.close();
  }
});

test('статика: index отдаётся, traversal-выход из public -> 403', async () => {
  const idx = await fetch(base + '/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get('content-type'), /text\/html/);
  assert.match(idx.headers.get('cache-control'), /no-store/);

  const evil = await fetch(base + '/%2e%2e/%2e%2e/etc/passwd');
  assert.ok(evil.status === 403 || evil.status === 404, 'выход из public не отдаёт файл');
});

test('история чата: /api/history отдаёт последние реплики (для восстановления ленты)', async () => {
  const login = await post('/api/login', { password: 'testpass' });
  const sess = login.headers.get('set-cookie').split(';')[0];
  store.pushHistory('user', 'привет', 'web');
  store.pushHistory('assistant', 'здравствуйте', 'web');
  const r = await fetch(base + '/api/history', { headers: { cookie: sess } });
  assert.equal(r.status, 200);
  const { turns } = await r.json();
  assert.ok(turns.length >= 2);
  assert.equal(turns[turns.length - 1].role, 'assistant');
  assert.match(turns[turns.length - 1].text, /здравствуйте/);
});

test('неизвестный /api/* метод -> 404 json', async () => {
  const login = await post('/api/login', { password: 'testpass' });
  const sess = login.headers.get('set-cookie').split(';')[0];
  const r = await fetch(base + '/api/nope', { headers: { cookie: sess } });
  assert.equal(r.status, 404);
});
