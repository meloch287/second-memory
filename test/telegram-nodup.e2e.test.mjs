// REGRESSION: no double-capture when the AI is disabled.
//
// friendFlow (src/telegram.mjs) used to store every plainly-typed debt/meeting/
// task TWICE while AI was off: once via captureEntry() at the top, and again via
// handleMessage() -> route() -> saveEntry() in the `!aiEnabled()` branch — same
// parse, two store.add() calls, duplicate ids with identical title/type/due.
//
// This drives the REAL bot end-to-end (startTelegramBot + a spy Telegram
// transport, same technique as tolik.e2e.holdout.test.mjs) with no AI key, and
// asserts each business phrase lands EXACTLY ONE entry in the store. Counting is
// gated on the bot's own outgoing reply, which is sent only after friendFlow has
// finished both saves — so a reintroduced dup can't hide behind timing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { startTelegramBot } from '../src/telegram.mjs';

delete process.env.SM_ENCRYPTION_KEY;
delete process.env.AI_API_KEY;         // <- the buggy path: AI off, route() saves
delete process.env.AI_AUDIO_API_KEY;
delete process.env.AI_WORKER_API_KEY;
delete process.env.WEB_CHAT_ID;

const CHAT_ID = 555;
const TOKEN = 'TEST:TOKEN';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function installSpy() {
  const calls = [];
  const queue = [];
  let updateId = 1;
  let inSeq = 1;
  let outSeq = 9000;
  const methodFromUrl = (url) => (String(url).match(/\/bot[^/]+\/([A-Za-z]+)$/) || [])[1] || null;
  const parseBody = (o) => { try { return JSON.parse(o?.body); } catch { return {}; } };
  const fetchSpy = async (url, opts = {}) => {
    const method = methodFromUrl(url);
    if (method === 'getUpdates') {
      await sleep(4); // real macrotask beat so the poll loop yields to timers
      return { json: async () => ({ ok: true, result: queue.splice(0, queue.length) }) };
    }
    const params = parseBody(opts);
    calls.push({ method, params });
    const result = method === 'getMe'
      ? { ok: true, result: { id: 1, is_bot: true, username: 'nodup_e2e_bot' } }
      : ['sendMessage', 'sendPhoto', 'sendDocument', 'sendVoice', 'sendSticker'].includes(method)
        ? { ok: true, result: { message_id: outSeq++, chat: { id: params.chat_id } } }
        : { ok: true, result: true };
    return { json: async () => result };
  };
  return {
    calls,
    fetchSpy,
    push(text) {
      queue.push({
        update_id: updateId++,
        message: {
          message_id: inSeq++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: CHAT_ID, type: 'private' },
          from: { id: CHAT_ID, is_bot: false, first_name: 'Тестер' },
          text,
        },
      });
    },
    sendsTo(chatId = CHAT_ID) {
      return calls.filter((c) => c.method === 'sendMessage' && String(c.params.chat_id) === String(chatId)).length;
    },
  };
}

async function waitFor(predicate, { timeout = 5000, interval = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start > timeout) return Boolean(predicate());
    await sleep(interval);
  }
}

test('AI-disabled bot stores a plainly-typed debt/meeting/task exactly once', async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'sm-nodup-')), 'm.json'));
  const spy = installSpy();
  const originalFetch = global.fetch;
  global.fetch = spy.fetchSpy;
  const log = { log() {}, error(...a) { console.error('[bot error]', ...a); } };
  const bot = startTelegramBot(store, TOKEN, log);

  try {
    // Onboarding (name -> tz -> goal) so subsequent plain text reaches friendFlow.
    spy.push('/start');
    await waitFor(() => store.getUser(String(CHAT_ID))?.step === 'name');
    spy.push('Тестер');
    await waitFor(() => store.getUser(String(CHAT_ID))?.step === 'tz');
    spy.push('+3');
    await waitFor(() => store.getUser(String(CHAT_ID))?.step === 'goal');
    spy.push('работа');
    await waitFor(() => store.getUser(String(CHAT_ID))?.step === null);

    const cases = [
      { text: 'Иванов должен 50000 до 20 июля', type: 'debt' },
      { text: 'встреча с командой завтра в 15:00', type: 'meeting' },
      { text: 'напомни через 10 минут позвонить маме', type: 'task' },
    ];

    for (const c of cases) {
      const beforeEntries = store.list({ chatId: String(CHAT_ID) }).length;
      const beforeSends = spy.sendsTo();
      spy.push(c.text);
      // The reply is sent only after friendFlow has done all of its store writes,
      // so once it appears both a correct single save and a buggy double save are settled.
      await waitFor(() => spy.sendsTo() > beforeSends);

      const delta = store.list({ chatId: String(CHAT_ID) }).length - beforeEntries;
      console.log(`[nodup] "${c.text}" -> +${delta} entr${delta === 1 ? 'y' : 'ies'}`);
      assert.equal(delta, 1, `"${c.text}" must create exactly one stored entry (got ${delta})`);

      const mine = store.list({ chatId: String(CHAT_ID), type: c.type });
      assert.ok(mine.length >= 1, `phrase stored as a ${c.type}`);
      assert.equal(mine.at(-1).type, c.type, `latest ${c.type} has the expected type`);
    }
  } finally {
    bot.stop();
    global.fetch = originalFetch;
  }
});
