// HELD-OUT E2E acceptance test.
//
// This boots the REAL Telegram bot (startTelegramBot from src/telegram.mjs)
// and drives it exactly the way Telegram would: every step goes in through
// the bot's own long-polling loop (getUpdates -> onMessage/onCallback), and
// every assertion reads only what the bot sent back out over the wire
// (sendMessage/sendPhoto/editMessageText params). No internal handler
// (onMessage, onCallback, createLkHandler, ...) is called directly.
//
// The stand-in for the network is `global.fetch`: it captures every
// outgoing Telegram Bot API call and feeds crafted updates back through
// getUpdates, one batch per poll. The poll is paced with a real (tiny)
// setTimeout so the bot's `while (running) await api('getUpdates', ...)`
// loop yields to Node's timer phase each iteration - without that pacing
// a stub that resolves synchronously would chain into an unbroken run of
// microtasks and livelock the process (our own setTimeout-based waits
// would never get a turn to run).
//
// This is written as an independent grader against the acceptance journey
// in the task, not against whatever the app happens to do - assertions are
// not weakened to make the app look correct.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { startTelegramBot } from '../src/telegram.mjs';

delete process.env.SM_ENCRYPTION_KEY;
delete process.env.AI_API_KEY;
delete process.env.AI_AUDIO_API_KEY;
delete process.env.AI_WORKER_API_KEY;
delete process.env.WEB_CHAT_ID;

const CHAT_ID = 777;
const TOKEN = 'TEST:TOKEN';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Spy Telegram transport (stands in for global.fetch) --------------

function installFetchSpy() {
  const calls = []; // every non-getUpdates call: { method, params, order }
  const updateQueue = [];
  let updateId = 1;
  let inMsgSeq = 1;
  let outMsgSeq = 9000;
  let order = 0;
  const lastMsgId = new Map(); // chatId(string) -> most recent bot message_id in that chat

  const methodFromUrl = (url) => {
    const m = String(url).match(/\/bot[^/]+\/([A-Za-z]+)$/);
    return m ? m[1] : null;
  };
  const parseBody = (opts) => {
    if (!opts || typeof opts.body !== 'string') return {};
    try { return JSON.parse(opts.body); } catch { return {}; }
  };
  const respond = (method, params) => {
    if (['sendMessage', 'sendPhoto', 'sendDocument', 'sendVoice', 'sendSticker'].includes(method)) {
      const message_id = outMsgSeq++;
      if (params.chat_id != null) lastMsgId.set(String(params.chat_id), message_id);
      return { ok: true, result: { message_id, chat: { id: params.chat_id } } };
    }
    if (method === 'editMessageText') return { ok: true, result: { message_id: params.message_id } };
    if (method === 'getMe') return { ok: true, result: { id: 424242, is_bot: true, username: 'tolik_e2e_test_bot' } };
    return { ok: true, result: true };
  };

  const fetchSpy = async (url, opts = {}) => {
    const method = methodFromUrl(url);
    if (method === 'getUpdates') {
      // Real macrotask beat, not a synchronous resolve - see file header.
      await sleep(4);
      const batch = updateQueue.splice(0, updateQueue.length);
      return { json: async () => ({ ok: true, result: batch }) };
    }
    const params = parseBody(opts);
    calls.push({ method, params, order: order++ });
    return { json: async () => respond(method, params) };
  };

  return {
    calls,
    fetchSpy,
    pushMessage(text, { chatId = CHAT_ID } = {}) {
      updateQueue.push({
        update_id: updateId++,
        message: {
          message_id: inMsgSeq++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: 'private' },
          from: { id: chatId, is_bot: false, first_name: 'Тестер' },
          text,
        },
      });
    },
    pushCallback(data, { chatId = CHAT_ID, messageId } = {}) {
      const mid = messageId ?? lastMsgId.get(String(chatId));
      const cbId = `cbq${updateId}`;
      updateQueue.push({
        update_id: updateId++,
        callback_query: {
          id: cbId,
          from: { id: chatId, is_bot: false, first_name: 'Тестер' },
          message: { message_id: mid, chat: { id: chatId, type: 'private' } },
          data,
        },
      });
      return cbId;
    },
  };
}

// Waits for `predicate()` to become truthy, polling instead of a fixed
// sleep - robust against the poll loop's ~4ms pacing without being slow.
async function waitFor(predicate, { timeout = 5000, interval = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start > timeout) return Boolean(predicate());
    await sleep(interval);
  }
}

// What the user would see last in `chatId`: a fresh sendMessage/sendPhoto,
// or an edit of a previous one. Mirrors the `lastRender` helper used in
// test/lk-debts.test.mjs and test/lk-wishlist.test.mjs, but reconstructed
// from the captured HTTP calls instead of an in-process fake bot.
function lastRender(spy, chatId = CHAT_ID) {
  const rel = spy.calls.filter(
    (c) => ['sendMessage', 'editMessageText', 'sendPhoto'].includes(c.method) && String(c.params.chat_id) === String(chatId)
  );
  if (!rel.length) return null;
  const last = rel.at(-1);
  const text = last.method === 'sendPhoto' ? last.params.caption : last.params.text;
  return { method: last.method, text, kb: last.params.reply_markup?.inline_keyboard, params: last.params };
}

function textsSentTo(spy, chatId = CHAT_ID) {
  return spy.calls
    .filter((c) => ['sendMessage', 'editMessageText', 'sendPhoto'].includes(c.method) && String(c.params.chat_id) === String(chatId))
    .map((c) => (c.method === 'sendPhoto' ? c.params.caption : c.params.text));
}

test('Tolik e2e (held-out): real bot driven end-to-end via spy Telegram transport', async (t) => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'sm-tolik-e2e-')), 'm.json'));
  const spy = installFetchSpy();
  const originalFetch = global.fetch;
  global.fetch = spy.fetchSpy;
  const log = { log() {}, error(...a) { console.error('[bot error]', ...a); } };
  const bot = startTelegramBot(store, TOKEN, log);

  try {
    // ---- 1) Fresh /start: greeting mentions Толик, asks the USER's name ----
    await t.test('1) fresh /start greets as Толик and asks the user\'s name', async () => {
      spy.pushMessage('/start');
      await waitFor(() => /зовут/i.test(lastRender(spy)?.text || ''));
      const r = lastRender(spy);
      console.log('[step1] sendMessage:', JSON.stringify({ text: r.text }));
      assert.equal(r.method, 'sendMessage');
      assert.match(r.text, /Толик/, 'greeting introduces itself as Толик');
      assert.match(r.text, /как.*зовут/i, 'asks for the USER\'s name');
      assert.doesNotMatch(r.text, /как меня назвать/i, 'must not ask what to call the BOT');
      assert.equal(store.getUser(String(CHAT_ID))?.step, 'name');
    });

    // ---- Complete onboarding (name -> tz -> goal) so `настройки` is reachable ----
    await t.test('1b) answering name proceeds onboarding to the tz question', async () => {
      spy.pushMessage('Тестер');
      await waitFor(() => store.getUser(String(CHAT_ID))?.step === 'tz');
      const r = lastRender(spy);
      console.log('[step1b] sendMessage:', JSON.stringify({ text: r.text }));
      assert.match(r.text, /геолокац/i, 'asks for location/timezone next');
      assert.equal(store.getUser(String(CHAT_ID))?.name, 'Тестер');
    });

    await t.test('1c) answering tz (+3, MSK) proceeds to the goal question', async () => {
      spy.pushMessage('+3');
      await waitFor(() => store.getUser(String(CHAT_ID))?.step === 'goal');
      assert.equal(store.getUser(String(CHAT_ID))?.tzOffset, 180, 'MSK offset recorded');
    });

    await t.test('1d) answering goal finishes onboarding (step -> null)', async () => {
      spy.pushMessage('работа');
      await waitFor(() => store.getUser(String(CHAT_ID))?.step === null);
      assert.equal(store.getUser(String(CHAT_ID)).step, null);
    });

    // ---- 2) «настройки» -> stats + Фитнес/Долги/Вишлист; Фитнес -> "в разработке" ----
    await t.test('2) «настройки» shows stats lines and Фитнес/Долги/Вишлист buttons', async () => {
      spy.pushMessage('настройки');
      await waitFor(() => /Личный кабинет/.test(lastRender(spy)?.text || ''));
      const r = lastRender(spy);
      console.log('[step2] sendMessage:', JSON.stringify({ text: r.text, kb: r.kb }));
      assert.equal(r.method, 'sendMessage');
      assert.match(r.text, /Запросов Толику/);
      assert.match(r.text, /Фактов помню/);
      assert.match(r.text, /Открытых долгов/);
      assert.match(r.text, /Задач/);
      assert.match(r.text, /Встреч/);
      assert.match(r.text, /Вишлист/);
      const flatData = r.kb.flat().map((b) => b.callback_data);
      const flatText = r.kb.flat().map((b) => b.text);
      assert.deepEqual(flatData, ['lk:fit', 'lk:debts', 'lk:wish']);
      assert.ok(flatText.some((x) => /Фитнес/.test(x)));
      assert.ok(flatText.some((x) => /Долги/.test(x)));
      assert.ok(flatText.some((x) => /Вишлист/.test(x)));
    });

    await t.test('2b) Фитнес callback -> "в разработке" stub', async () => {
      spy.pushCallback('lk:fit');
      await waitFor(() => /в разработке/.test(lastRender(spy)?.text || ''));
      const r = lastRender(spy);
      console.log('[step2b] editMessageText:', JSON.stringify({ text: r.text }));
      assert.equal(r.method, 'editMessageText');
      assert.match(r.text, /в разработке/);
    });

    // ---- 3) Долги: add via text flow, persists, appears in the list, delete it ----
    let debtId;
    await t.test('3) Долги: opening the section shows "Долгов нет" for a fresh user', async () => {
      spy.pushCallback('lk:debts');
      await waitFor(() => /Долгов нет|💸 Долги/.test(lastRender(spy)?.text || ''));
      const r = lastRender(spy);
      assert.match(r.text, /Долгов нет/);
      assert.ok(r.kb.flat().some((b) => b.callback_data === 'lk:debt:add'));
    });

    await t.test('3b) add-flow: «Иванов должен 50000 до 20 июля» persists as a debt and appears in the list', async () => {
      spy.pushCallback('lk:debt:add');
      await waitFor(() => /Опиши долг/.test(lastRender(spy)?.text || ''));

      spy.pushMessage('Иванов должен 50000 до 20 июля');
      await waitFor(() => store.list({ type: 'debt', status: 'open', chatId: String(CHAT_ID) }).length > 0);

      const debts = store.list({ type: 'debt', status: 'open', chatId: String(CHAT_ID) });
      assert.equal(debts.length, 1, 'exactly one debt persisted');
      debtId = debts[0].id;
      assert.equal(debts[0].counterparty, 'Иванов');
      assert.equal(debts[0].amount, 50000);
      assert.equal(debts[0].direction, 'in');
      assert.ok(debts[0].due, 'due date recognized');

      await waitFor(() => /Иванов должен вам/.test(lastRender(spy)?.text || ''));
      const r = lastRender(spy);
      console.log('[step3b] refreshed list sendMessage:', JSON.stringify({ text: r.text }));
      assert.match(r.text, new RegExp(`№${debtId} — Иванов должен вам 50\\s000\\s₽, срок 20\\.07\\.\\d{4}`));

      const confirm = spy.calls.filter((c) => c.method === 'sendMessage' && String(c.params.chat_id) === String(CHAT_ID) && /Записал долг/.test(c.params.text || ''));
      assert.ok(confirm.length >= 1, 'a "Записал долг" confirmation was sent');
    });

    await t.test('3c) delete the debt -> gone from store and from the list', async () => {
      spy.pushCallback(`lk:debt:del:${debtId}`);
      await waitFor(() => /Удалить долг/.test(lastRender(spy)?.text || ''));
      assert.match(lastRender(spy).text, new RegExp(`Удалить долг №${debtId}`));

      spy.pushCallback(`lk:debt:delyes:${debtId}`);
      await waitFor(() => store.byId(debtId) === null);
      assert.equal(store.byId(debtId), null, 'removed from the store');
      assert.match(lastRender(spy).text, /Долгов нет/, 'list no longer shows it');
    });

    // ---- 4) Вишлист: manual add, gallery caption + nav ----
    await t.test('4) Вишлист: back to home, open empty wishlist', async () => {
      spy.pushCallback('lk:home');
      await waitFor(() => /Личный кабинет/.test(lastRender(spy)?.text || ''));
      spy.pushCallback('lk:wish');
      await waitFor(() => /Вишлист пуст|Вишлист \(\d+\)/.test(lastRender(spy)?.text || ''));
      assert.match(lastRender(spy).text, /Вишлист пуст/);
    });

    async function addWishManually(title) {
      spy.pushCallback('lk:wish:add');
      await waitFor(() => /ссылке или вручную/i.test(lastRender(spy)?.text || ''));
      spy.pushCallback('lk:wish:add:manual');
      await waitFor(() => /называется товар/i.test(lastRender(spy)?.text || ''));
      const before = store.listWish(String(CHAT_ID)).length;
      spy.pushMessage(title);
      await waitFor(() => /описание/i.test(lastRender(spy)?.text || ''));
      spy.pushMessage('-');
      await waitFor(() => /ссылку/i.test(lastRender(spy)?.text || ''));
      spy.pushMessage('-');
      await waitFor(() => store.listWish(String(CHAT_ID)).length > before);
    }

    await t.test('4b) manual add «водный пистолет» -> in store.listWish and in the rendered list', async () => {
      await addWishManually('водный пистолет');
      const items = store.listWish(String(CHAT_ID));
      assert.ok(items.some((w) => w.title === 'водный пистолет'), 'present in store.listWish');

      await waitFor(() => /водный пистолет/.test(lastRender(spy)?.text || ''));
      const r = lastRender(spy);
      console.log('[step4b] refreshed wishlist sendMessage:', JSON.stringify({ text: r.text }));
      assert.match(r.text, /водный пистолет/, 'shows up in the on-screen list too');

      const confirm = spy.calls.filter((c) => c.method === 'sendMessage' && String(c.params.chat_id) === String(CHAT_ID) && /Добавил в вишлист/.test(c.params.text || ''));
      assert.ok(confirm.some((c) => /водный пистолет/.test(c.params.text)));
    });

    await t.test('4c) add a second item («кепка») so gallery navigation has something to move to', async () => {
      await addWishManually('кепка');
      assert.equal(store.listWish(String(CHAT_ID)).length, 2);
    });

    await t.test('4d) gallery view:0 caption "1/2 — водный пистолет", nav to view:1 -> "2/2 — кепка"', async () => {
      const items = store.listWish(String(CHAT_ID));
      const idxOf = (title) => items.findIndex((w) => w.title === title);
      const pistolIdx = idxOf('водный пистолет');
      const capIdx = idxOf('кепка');

      spy.pushCallback(`lk:wish:view:${pistolIdx}`);
      await waitFor(() => new RegExp(`^${pistolIdx + 1}/2 — водный пистолет`).test(lastRender(spy)?.text || ''));
      const first = lastRender(spy);
      console.log('[step4d] gallery frame 1:', JSON.stringify({ method: first.method, text: first.text }));
      assert.match(first.text, new RegExp(`^${pistolIdx + 1}/2 — водный пистолет`));
      assert.ok(first.kb.flat().some((b) => b.callback_data === `lk:wish:view:${capIdx}`), 'nav button toward the other item is present');

      spy.pushCallback(`lk:wish:view:${capIdx}`);
      await waitFor(() => new RegExp(`^${capIdx + 1}/2 — кепка`).test(lastRender(spy)?.text || ''));
      const second = lastRender(spy);
      console.log('[step4d] gallery frame 2:', JSON.stringify({ method: second.method, text: second.text }));
      assert.match(second.text, new RegExp(`^${capIdx + 1}/2 — кепка`));
    });

    // ---- 5) Reminders: correct classification (task, not debt), correct due ----
    await t.test('5a) «напомни через 10 минут позвонить маме» -> a task (not a debt) with hasTime', async () => {
      const before = Date.now();
      spy.pushMessage('напомни через 10 минут позвонить маме');
      await waitFor(() => store.list({ chatId: String(CHAT_ID) }).some((e) => /маме/i.test(e.title || '')));

      const matches = store.list({ chatId: String(CHAT_ID) }).filter((e) => /маме/i.test(e.title || ''));
      console.log('[step5a] matching entries:', JSON.stringify(matches.map((e) => ({ id: e.id, type: e.type, title: e.title, due: e.due, hasTime: e.hasTime }))));
      assert.ok(matches.length >= 1, 'at least one entry was created for this reminder');
      assert.ok(matches.every((e) => e.type === 'task'), 'classified as task, never as debt/other');
      assert.ok(!matches.some((e) => e.type === 'debt'), 'not misclassified as a debt');
      assert.ok(matches.every((e) => e.hasTime === true), 'has an exact time, not just a date');
      for (const e of matches) {
        const deltaMin = (Date.parse(e.due) - before) / 60000;
        assert.ok(deltaMin > 8 && deltaMin < 13, `due ~10 minutes from now (got ${deltaMin.toFixed(2)} min)`);
      }
    });

    await t.test('5b) «напомни 29 июля что должно прийти 95к по зп» -> a task due 29 July, NOT a debt', async () => {
      spy.pushMessage('напомни 29 июля что должно прийти 95к по зп');
      await waitFor(() => store.list({ chatId: String(CHAT_ID) }).some((e) => /зп|прийти/i.test(e.title || '')));

      const matches = store.list({ chatId: String(CHAT_ID) }).filter((e) => /зп|прийти/i.test(e.title || ''));
      console.log('[step5b] matching entries:', JSON.stringify(matches.map((e) => ({ id: e.id, type: e.type, title: e.title, due: e.due }))));
      assert.ok(matches.length >= 1, 'at least one entry was created for this reminder');
      assert.ok(matches.every((e) => e.type === 'task'), 'classified as task');
      assert.ok(!matches.some((e) => e.type === 'debt'), 'NOT classified as a debt (this was the reported bug)');
      for (const e of matches) {
        const d = new Date(e.due);
        assert.equal(d.getUTCDate(), 29, 'due day is the 29th');
        assert.equal(d.getUTCMonth(), 6, 'due month is July (0-indexed 6)');
      }
    });

    // ---- 6) Summary removed: «итог» is a plain reply, not a special AI-summary ----
    await t.test('6) «итог» does not trigger the removed AI-summary special-case', async () => {
      const before = spy.calls.length;
      spy.pushMessage('итог');
      await waitFor(() => spy.calls.length > before && lastRender(spy)?.text !== undefined);
      // Give any (incorrect) follow-up async work a moment to surface before asserting.
      await sleep(30);
      const r = lastRender(spy);
      console.log('[step6] sendMessage:', JSON.stringify({ text: r.text, kb: r.kb }));
      assert.equal(r.method, 'sendMessage');
      assert.doesNotMatch(r.text, /саммари/i, 'no "саммари" special-case wording');
      assert.equal(r.kb, undefined, 'no "Расскажи подробнее"/"Что завтра?" summary buttons attached');
      const summaryButtons = spy.calls.some((c) =>
        (c.params.reply_markup?.inline_keyboard || []).flat().some((b) => b.callback_data === 'more' || b.callback_data === 'tomorrow')
      );
      assert.equal(summaryButtons, false, 'the removed summary follow-up buttons never appeared anywhere in the session');
    });
  } finally {
    bot.stop();
    global.fetch = originalFetch;
  }
});
