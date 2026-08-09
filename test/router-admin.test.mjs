// Гейт команды /admin на уровне роутера: панель видит только владелец,
// всем остальным команды как будто нет. Плюс проверка, что журнал
// пишется ДО групповой ветки (иначе групповые сообщения проходили бы мимо).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { setAdminLog, adminLogList, useAdminDb } from '../src/adminlog.mjs';

const OWNER = '1057399602';
const STRANGER = '777000';

async function harness() {
  process.env.OWNER_CHAT_ID = OWNER;
  const { createMessageRouter } = await import('../src/telegram-router.mjs?admin=' + Math.random());
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'sm-adm-')), 'memory.json'));
  useAdminDb(join(mkdtempSync(join(tmpdir(), 'sm-admdb-')), 'admin-log.jsonl'));
  const sent = [];
  const group = [];
  const router = createMessageRouter({
    api: async () => ({}),
    send: async (chatId, text, extra) => { sent.push({ chatId: String(chatId), text, extra }); },
    store,
    log: { error() {}, info() {} },
    activeThread: new Map(),
    isGroupChat: (msg) => msg.chat.type === 'group' || msg.chat.type === 'supergroup',
    groupFlow: async (msg) => { group.push(msg); },
    lk: { openSettings: async () => {}, consumeInput: async () => false, tryCalendar: async () => false, clearPending() {} },
    startOnboarding: async () => {},
    friendFlow: async () => {},
    handleIntent: async () => false,
    onboardingStep: async () => {},
  });
  return { router, store, sent, group };
}

const textMsg = (from, text, chat = { id: from, type: 'private' }) => ({
  chat, from: { id: from, username: 'u' + from, first_name: 'Кто-то' }, text,
});

test('/admin: владелец получает панель с кнопками', async () => {
  const { router, sent } = await harness();
  await router.onMessage(textMsg(OWNER, '/admin'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Админ-режим/);
  assert.match(sent[0].text, /Запись выключена/);
  const kb = sent[0].extra.reply_markup.inline_keyboard;
  assert.equal(kb[0][0].callback_data, 'adm:toggle');
  assert.deepEqual(kb[1].map((b) => b.callback_data), ['adm:last']);
  assert.deepEqual(kb[2].map((b) => b.callback_data), ['adm:dump', 'adm:zip'], 'JSON и архив с медиа');
});

test('/admin: чужому - тишина, ни ответа, ни падения', async () => {
  const { router, sent } = await harness();
  await router.onMessage(textMsg(STRANGER, '/admin'));
  assert.equal(sent.length, 0);
});

test('/admin@botname в группе тоже ловится и не уходит в групповой поток', async () => {
  const { router, sent, group } = await harness();
  const chat = { id: '-100500', type: 'supergroup', title: 'Банда' };
  await router.onMessage(textMsg(OWNER, '/admin@tolik_bot', chat));
  assert.equal(group.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Банда/);
});

test('в режиме записи бот молчит: пишет в журнал и не отвечает', async () => {
  const { router, store, sent, group } = await harness();
  const chat = { id: '-100500', type: 'supergroup', title: 'Банда' };
  setAdminLog(store, chat.id, true);
  await router.onMessage(textMsg(STRANGER, 'привет банда', chat));
  assert.equal(sent.length, 0, 'ни одного ответа');
  assert.equal(group.length, 0, 'в разговор сообщение не идёт вовсе');
  const rows = adminLogList(store, { chatId: chat.id, limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'text');
  assert.equal(rows[0].text, 'привет банда');
  assert.equal(String(rows[0].userId), STRANGER);
  assert.equal(rows[0].username, 'u' + STRANGER);
  assert.equal(rows[0].chatTitle, 'Банда');
  assert.ok(Number.isFinite(Date.parse(rows[0].ts)), 'время записи - разбираемая ISO-строка');
});

test('журнал выключен - ничего не пишем', async () => {
  const { router, store } = await harness();
  const chat = { id: '-100501', type: 'supergroup', title: 'Тихо' };
  await router.onMessage(textMsg(STRANGER, 'привет', chat));
  assert.equal(adminLogList(store, { chatId: chat.id, limit: 10 }).length, 0);
});

test('пачка пересланных: 20 записей и НИ ОДНОГО ответа', async () => {
  const { router, store, sent, group } = await harness();
  const chat = { id: '-100777', type: 'supergroup', title: 'Банда' };
  setAdminLog(store, chat.id, true);
  for (let i = 1; i <= 20; i++) {
    await router.onMessage({
      chat,
      from: { id: STRANGER, username: 'anya', first_name: 'Аня' },
      text: 'переслано ' + i,
      forward_origin: { type: 'user', date: 1754500000, sender_user: { id: 999, first_name: 'Кто-то' } },
    });
  }
  assert.equal(sent.length, 0, 'бот не должен отвечать на пересылки');
  assert.equal(group.length, 0);
  const rows = adminLogList(store, { chatId: chat.id, limit: 50 });
  assert.equal(rows.length, 20);
  assert.equal(rows[19].text, 'переслано 20');
  assert.equal(rows[0].forward.name, 'Кто-то', 'автор оригинала сохранён');
});

test('владелец может выключить запись командой, пока режим включён', async () => {
  const { router, store, sent } = await harness();
  const chat = { id: OWNER, type: 'private' };
  setAdminLog(store, chat.id, true);
  await router.onMessage(textMsg(OWNER, '/admin', chat));
  assert.equal(sent.length, 1, 'панель должна открыться даже в режиме молчания');
  assert.match(sent[0].text, /Запись ВКЛЮЧЕНА/);
  assert.match(sent[0].text, /молчу/);
});

test('журнал не хранится в основной базе бота', async () => {
  const { router, store } = await harness();
  const chat = { id: '-100888', type: 'supergroup', title: 'Банда' };
  setAdminLog(store, chat.id, true);
  await router.onMessage(textMsg(STRANGER, 'секрет', chat));
  assert.equal(adminLogList(store, { chatId: chat.id }).length, 1);
  assert.ok(!Array.isArray(store.data.adminLog) || store.data.adminLog.length === 0, 'memory.json чист');
});
