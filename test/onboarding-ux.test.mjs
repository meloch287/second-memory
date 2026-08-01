// Онбординг подтверждает имя (иначе выглядит как «бот не увидел имя») и
// повторно введённое имя на шаге города не уходит в «город». Гоняем реального
// бота спай-транспортом (как tolik.e2e.holdout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { startTelegramBot } from '../src/telegram.mjs';

for (const k of ['AI_API_KEY', 'AI_AUDIO_API_KEY', 'AI_WORKER_API_KEY', 'SM_ENCRYPTION_KEY', 'WEB_CHAT_ID']) delete process.env[k];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness(store) {
  const calls = [], q = []; let uid = 1, out = 9000;
  const M = (u) => (String(u).match(/\/bot[^/]+\/([A-Za-z]+)$/) || [])[1];
  global.fetch = async (u, o = {}) => {
    const m = M(u);
    if (m === 'getUpdates') { await sleep(4); const b = q.splice(0); return { json: async () => ({ ok: true, result: b }) }; }
    let p = {}; try { p = JSON.parse(o.body); } catch {}
    calls.push({ m, text: p.text });
    if (m === 'getMe') return { json: async () => ({ ok: true, result: { id: 1, is_bot: true, username: 't' } }) };
    return { json: async () => ({ ok: true, result: { message_id: out++, chat: { id: p.chat_id } } }) };
  };
  const msg = (c, t) => q.push({ update_id: uid++, message: { message_id: uid, chat: { id: c, type: 'private' }, from: { id: c }, text: t } });
  return { calls, msg };
}
const freshStore = () => new Store(join(mkdtempSync(join(tmpdir(), 'onbux-')), 'm.json'));

test('онбординг подтверждает имя пользователя', async () => {
  const s = freshStore(); const { calls, msg } = harness(s);
  const bot = startTelegramBot(s, 'T:T', { log() {}, error() {} });
  await sleep(25); msg(777, '/start'); await sleep(45); msg(777, 'Саня'); await sleep(60);
  bot?.stop?.();
  const said = calls.filter((c) => c.m === 'sendMessage').map((c) => c.text).join('\n');
  assert.match(said, /Приятно, Саня/, 'бот должен подтвердить имя');
  assert.equal(s.getUser('777')?.name, 'Саня');
});

test('повторное имя на шаге города не становится городом', async () => {
  const s = freshStore(); s.setUser('777', { step: 'name', botName: 'Толик' });
  const { msg } = harness(s);
  const bot = startTelegramBot(s, 'T:T', { log() {}, error() {} });
  await sleep(25); msg(777, 'Саня'); await sleep(45); msg(777, 'Саня'); await sleep(60);
  bot?.stop?.();
  const u = s.getUser('777');
  assert.equal(u?.name, 'Саня');
  assert.notEqual(u?.city, 'Саня', 'имя не должно записаться в город');
});
