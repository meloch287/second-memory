// REGRESSION: голос = текст, и ЛК не работает мид-онбординга.
//
// 1) Расшифровка голосового раньше шла мимо слоя ЛК (audioFlow -> handleIntent
//    напрямую): голосовое «настройки» открывало СТАРЫЙ экран настроек
//    (settingsText из telegram-intents), а голосовой ответ на ожидание ЛК
//    («добавить долг») игнорировался. Теперь и текст, и голос идут через одну
//    точку - router.routeText (онбординг -> триггеры ЛК -> ожидания ЛК ->
//    интенты -> разговор).
// 2) /settings и lk:-callback'и мид-онбординга не должны взводить pending,
//    который потом перехватил бы первое настоящее сообщение.
// 3) Deep-link «/start sm-…» для нового чата должен создать профиль с
//    дефолтами (раньше bumpRequests пре-создавал профиль и ветка была мёртвой).
//
// Реальный бот (startTelegramBot) + спай-fetch - та же техника, что в
// test/telegram-nodup.e2e.test.mjs: апдейты заходят через long polling бота,
// ассерты только по исходящим вызовам Bot API и содержимому стора.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { startTelegramBot } from '../src/telegram.mjs';
import { startTgLink } from '../src/webauth.mjs';

delete process.env.SM_ENCRYPTION_KEY;
delete process.env.AI_API_KEY; // текстовый ИИ выключен - разговор ведёт handleMessage
delete process.env.AI_WORKER_API_KEY;
delete process.env.WEB_CHAT_ID;
process.env.AI_AUDIO_API_KEY = 'test-audio-key'; // голосовые включены, расшифровка стабится

const TOKEN = 'TEST:TOKEN';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function installSpy() {
  const calls = [];
  const queue = [];
  let updateId = 1;
  let inSeq = 1;
  let outSeq = 9000;
  const lastMsgId = new Map(); // chatId -> последний message_id бота в чате
  const state = { transcript: '' }; // что «услышит» расшифровка голосового

  const methodFromUrl = (url) => (String(url).match(/\/bot[^/]+\/([A-Za-z]+)$/) || [])[1] || null;
  const parseBody = (o) => { try { return JSON.parse(o?.body); } catch { return {}; } };

  const fetchSpy = async (url, opts = {}) => {
    const u = String(url);
    // Мультимодальный аудио-провайдер (aiTranscribe): отдаём заготовленный текст
    if (u.endsWith('/chat/completions')) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: state.transcript } }] }) };
    }
    // Скачивание файла голосового с серверов Telegram
    if (u.includes('/file/bot')) {
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }
    const method = methodFromUrl(u);
    if (method === 'getUpdates') {
      await sleep(4); // макротакт, чтобы poll-цикл бота уступал таймерам
      return { json: async () => ({ ok: true, result: queue.splice(0, queue.length) }) };
    }
    const params = parseBody(opts);
    calls.push({ method, params });
    const respond = () => {
      if (['sendMessage', 'sendPhoto', 'sendDocument', 'sendVoice', 'sendSticker'].includes(method)) {
        const message_id = outSeq++;
        if (params.chat_id != null) lastMsgId.set(String(params.chat_id), message_id);
        return { ok: true, result: { message_id, chat: { id: params.chat_id } } };
      }
      if (method === 'editMessageText') return { ok: true, result: { message_id: params.message_id } };
      if (method === 'getFile') return { ok: true, result: { file_path: 'voice/1.ogg' } };
      if (method === 'getMe') return { ok: true, result: { id: 7, is_bot: true, username: 'voice_parity_bot' } };
      return { ok: true, result: true };
    };
    return { json: async () => respond() };
  };

  const baseMsg = (chatId) => ({
    message_id: inSeq++,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: 'private' },
    from: { id: chatId, is_bot: false, first_name: 'Тестер' },
  });

  return {
    calls,
    fetchSpy,
    setTranscript(t) { state.transcript = t; },
    pushText(chatId, text) {
      queue.push({ update_id: updateId++, message: { ...baseMsg(chatId), text } });
    },
    pushVoice(chatId) {
      queue.push({ update_id: updateId++, message: { ...baseMsg(chatId), voice: { file_id: `v${inSeq}`, duration: 3 } } });
    },
    pushCallback(chatId, data, messageId) {
      queue.push({
        update_id: updateId++,
        callback_query: {
          id: `cbq${updateId}`,
          from: { id: chatId, is_bot: false, first_name: 'Тестер' },
          message: { message_id: messageId ?? lastMsgId.get(String(chatId)), chat: { id: chatId, type: 'private' } },
          data,
        },
      });
    },
    textsTo(chatId) {
      return calls
        .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && String(c.params.chat_id) === String(chatId))
        .map((c) => c.params.text || '');
    },
    lastRender(chatId) {
      const rel = calls.filter(
        (c) => ['sendMessage', 'editMessageText'].includes(c.method) && String(c.params.chat_id) === String(chatId)
      );
      const last = rel.at(-1);
      return last ? { text: last.params.text, kb: last.params.reply_markup?.inline_keyboard } : null;
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

function boot() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'sm-voice-parity-')), 'm.json'));
  const spy = installSpy();
  const originalFetch = global.fetch;
  global.fetch = spy.fetchSpy;
  const log = { log() {}, error(...a) { console.error('[bot error]', ...a); } };
  const bot = startTelegramBot(store, TOKEN, log);
  return { store, spy, bot, restore() { bot.stop(); global.fetch = originalFetch; } };
}

test('голосовое «настройки» открывает ЛК (как текст), а не старый экран настроек', async () => {
  const CHAT = 701;
  const { store, spy, restore } = boot();
  try {
    store.setUser(String(CHAT), { name: 'Тестер', botName: 'Толик', tzOffset: 180, step: null });

    spy.setTranscript('настройки');
    spy.pushVoice(CHAT);
    await waitFor(() => /Личный кабинет/.test(spy.lastRender(CHAT)?.text || ''));

    const r = spy.lastRender(CHAT);
    assert.match(r.text, /Личный кабинет/, 'голос попал в ЛК');
    assert.deepEqual(r.kb.flat().map((b) => b.callback_data), ['lk:fit', 'lk:debts', 'lk:wish', 'lk:cal']);
    assert.ok(
      !spy.textsTo(CHAT).some((t) => /Твои настройки/.test(t)),
      'старый settingsText (интент settings) не отправлялся'
    );
  } finally {
    restore();
  }
});

test('голосовой ответ на ожидание ЛК «добавить долг» сохраняет долг и снимает pending', async () => {
  const CHAT = 702;
  const { store, spy, restore } = boot();
  try {
    store.setUser(String(CHAT), { name: 'Тестер', botName: 'Толик', tzOffset: 180, step: null });

    spy.pushText(CHAT, 'настройки');
    await waitFor(() => /Личный кабинет/.test(spy.lastRender(CHAT)?.text || ''));
    spy.pushCallback(CHAT, 'lk:debts');
    await waitFor(() => /Долгов нет/.test(spy.lastRender(CHAT)?.text || ''));
    spy.pushCallback(CHAT, 'lk:debt:add');
    await waitFor(() => /Опиши долг/.test(spy.lastRender(CHAT)?.text || ''));

    // Ответ ГОЛОСОМ - раньше audioFlow шёл мимо lk.consumeInput и запись терялась
    spy.setTranscript('Иванов должен 50000 до 20 июля');
    spy.pushVoice(CHAT);
    await waitFor(() => store.list({ type: 'debt', chatId: String(CHAT) }).length > 0);

    const debts = store.list({ type: 'debt', chatId: String(CHAT) });
    assert.equal(debts.length, 1, 'ровно один долг (сценарий ЛК, без дублей)');
    assert.equal(debts[0].counterparty, 'Иванов');
    assert.equal(debts[0].amount, 50000);
    assert.ok(spy.textsTo(CHAT).some((t) => /Записал долг/.test(t)), 'подтверждение сценария ЛК');
    await waitFor(() => /Иванов должен вам/.test(spy.lastRender(CHAT)?.text || ''));

    // pending снят: следующее сообщение НЕ проглатывается сценарием
    const before = spy.textsTo(CHAT).length;
    spy.pushText(CHAT, 'ку как дела');
    await waitFor(() => spy.textsTo(CHAT).length > before);
    assert.ok(!/Не понял, это долг/.test(spy.lastRender(CHAT)?.text || ''), 'сценарий добавления долга завершён');
    assert.equal(store.list({ type: 'debt', chatId: String(CHAT) }).length, 1, 'новых долгов не появилось');
  } finally {
    restore();
  }
});

test('мид-онбординга /settings и lk:-callback не открывают ЛК и не взводят pending', async () => {
  const CHAT = 703;
  const { store, spy, restore } = boot();
  try {
    spy.pushText(CHAT, '/start');
    await waitFor(() => store.getUser(String(CHAT))?.step === 'name');

    // /settings мид-онбординга: не ЛК, а объяснение текущего шага
    const beforeSettings = spy.textsTo(CHAT).length;
    spy.pushText(CHAT, '/settings');
    await waitFor(() => spy.textsTo(CHAT).length > beforeSettings);
    assert.ok(!spy.textsTo(CHAT).some((t) => /Личный кабинет/.test(t)), 'ЛК не открылся до конца знакомства');

    // lk:-callback мид-онбординга молча гасится - pending не взводится
    spy.pushCallback(CHAT, 'lk:debt:add', 1);
    await sleep(120);
    assert.ok(!spy.textsTo(CHAT).some((t) => /Опиши долг/.test(t)), 'сценарий «добавить долг» не запустился');

    // Доводим знакомство до конца
    spy.pushText(CHAT, 'Тестер');
    await waitFor(() => store.getUser(String(CHAT))?.step === 'tz');
    spy.pushText(CHAT, '+3');
    await waitFor(() => store.getUser(String(CHAT))?.step === 'goal');
    spy.pushText(CHAT, 'работа');
    await waitFor(() => store.getUser(String(CHAT))?.step === null);

    // Первое настоящее сообщение не перехвачено уцелевшим pending'ом ЛК
    const before = spy.textsTo(CHAT).length;
    spy.pushText(CHAT, 'ку как дела');
    await waitFor(() => spy.textsTo(CHAT).length > before);
    assert.ok(!/Не понял, это долг/.test(spy.lastRender(CHAT)?.text || ''), 'pending не пережил онбординг');
    assert.equal(store.list({ type: 'debt', chatId: String(CHAT) }).length, 0, 'долгов не появилось');
  } finally {
    restore();
  }
});

test('deep-link /start sm-… для нового чата создаёт профиль с дефолтами (ветка больше не мёртвая)', async () => {
  const CHAT = 704;
  const { store, spy, restore } = boot();
  try {
    const token = startTgLink(store, 'tg');
    assert.ok(!store.getUser(String(CHAT)), 'профиля ещё нет');

    spy.pushText(CHAT, `/start sm-${token}`);
    await waitFor(() => Boolean(store.getUser(String(CHAT))));
    await waitFor(() => spy.textsTo(CHAT).length > 0);

    const u = store.getUser(String(CHAT));
    assert.equal(u.botName, 'Помощник', 'дефолты из ветки deep-link применились');
    assert.equal(u.step, null, 'онбординг не запускается при подключении из веба');
    assert.match(spy.textsTo(CHAT).at(-1), /Подключил/, 'ответ о подключении отправлен');
  } finally {
    restore();
  }
});
