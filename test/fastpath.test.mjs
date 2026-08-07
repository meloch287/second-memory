// Кнопки и служебные команды не должны стоять в очереди за ответом ИИ.
// Живой случай: ИИ отвечал 11 секунд, а нажатия кнопок и /settings ждали
// по 8-12 секунд, хотя сами отрабатывают за 200-400мс.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { startTelegramBot } from '../src/telegram.mjs';

for (const k of ['AI_API_KEY', 'AI_AUDIO_API_KEY', 'AI_WORKER_API_KEY', 'SM_ENCRYPTION_KEY', 'WEB_CHAT_ID']) delete process.env[k];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UID = 500600700;

function boot() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'sm-fast-')), 'm.json'));
  store.setUser(String(UID), { name: 'Саня', tzOffset: 180 });
  const sent = [], queue = [];
  let uid = 1, out = 9000;
  const M = (u) => (String(u).match(/\/bot[^/]+\/([A-Za-z]+)$/) || [])[1];
  const original = global.fetch;
  let holdMs = 0;
  global.fetch = async (u, o = {}) => {
    const m = M(u);
    if (m === 'getUpdates') { await sleep(4); return { json: async () => ({ ok: true, result: queue.splice(0) }) }; }
    let p = {}; try { p = JSON.parse(o.body); } catch {}
    if (m === 'sendMessage') {
      // имитируем медленный ответ разговора: первый sendMessage «думает»
      if (holdMs) { const h = holdMs; holdMs = 0; await sleep(h); }
      sent.push({ text: p.text, ts: Date.now() });
    }
    if (m === 'getMe') return { json: async () => ({ ok: true, result: { id: 77, is_bot: true, username: 'tolik_bot' } }) };
    return { json: async () => ({ ok: true, result: { message_id: out++, chat: { id: p.chat_id } } }) };
  };
  const bot = startTelegramBot(store, 'T:T', { log() {}, error() {} });
  const msg = (text) => queue.push({
    update_id: uid++,
    message: { message_id: uid, chat: { id: UID, type: 'private' }, from: { id: UID, first_name: 'Саня' }, text },
  });
  return { store, sent, msg, hold: (ms) => { holdMs = ms; }, restore() { bot?.stop?.(); global.fetch = original; } };
}
const waitFor = async (fn, ms = 4000) => { const s = Date.now(); while (!fn() && Date.now() - s < ms) await sleep(15); return fn(); };

test('/settings не ждёт медленный разговор впереди себя', async () => {
  const h = boot();
  try {
    h.hold(1200); // «ИИ» отвечает 1.2 секунды
    h.msg('расскажи что-нибудь длинное');
    await sleep(20);
    const t0 = Date.now();
    h.msg('/settings');
    const ok = await waitFor(() => h.sent.some((s) => /Личный кабинет/i.test(s.text || '')));
    const waited = Date.now() - t0;
    assert.ok(ok, 'ЛК должен ответить');
    assert.ok(waited < 900, `ЛК ответил через ${waited}мс - значит стоял в очереди за разговором`);
  } finally { h.restore(); }
});

test('обычные сообщения по-прежнему обрабатываются строго по очереди', async () => {
  const h = boot();
  try {
    h.hold(400);
    h.msg('первое');
    await sleep(10);
    h.msg('второе');
    await waitFor(() => h.sent.length >= 2);
    assert.ok(h.sent[0].ts <= h.sent[1].ts, 'порядок разговора не должен ломаться');
  } finally { h.restore(); }
});
