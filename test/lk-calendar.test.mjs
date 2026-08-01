// Календарь в ЛК: месячная сетка, день-вью, коннект Apple (тумблер), выгрузка,
// импорт, и добавление события по ключевому слову «календарь» с переспросом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createLkHandler } from '../src/telegram-lk.mjs';

delete process.env.SM_ENCRYPTION_KEY;
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'sm-lk-cal-')), 'm.json');

function fakeBot(store) {
  const sent = [], edits = [], ics = [];
  let msgSeq = 1000, order = 0;
  const send = async (chatId, text, extra = {}) => { const message_id = msgSeq++; sent.push({ chatId: String(chatId), text, extra, message_id, order: order++ }); return { ok: true, result: { message_id } }; };
  const sendButtons = async (chatId, text, inline_keyboard) => send(chatId, text, { reply_markup: { inline_keyboard } });
  const api = async (method, params) => {
    if (method === 'editMessageText') { edits.push({ chatId: String(params.chat_id), text: params.text, reply_markup: params.reply_markup, order: order++ }); return { ok: true, result: { message_id: params.message_id } }; }
    return { ok: true };
  };
  const sendIcs = async (chatId, events, filename) => { ics.push({ chatId: String(chatId), count: events.length, filename }); return { ok: true }; };
  const lk = createLkHandler({ store, send, sendButtons, api, botNameOf: () => 'Толик', log: { error() {}, log() {} }, sendIcs, publicUrl: 'https://cal.example.io' });
  return { lk, sent, edits, ics };
}
function lastRender(bot, chatId) {
  const all = [
    ...bot.sent.filter((s) => s.chatId === String(chatId)).map((s) => ({ text: s.text, kb: s.extra?.reply_markup?.inline_keyboard, at: s.order })),
    ...bot.edits.filter((e) => e.chatId === String(chatId)).map((e) => ({ text: e.text, kb: e.reply_markup?.inline_keyboard, at: e.order })),
  ];
  return all.sort((a, b) => a.at - b.at).at(-1);
}
const cbq = (chatId, messageId = 10) => ({ id: 'cb', message: { message_id: messageId, chat: { id: Number(chatId) } } });
const flat = (r) => (r.kb || []).flat();
const hasCb = (r, cb) => flat(r).some((b) => b.callback_data === cb);
const user = (s) => { s.setUser('1', { name: 'Макс', tzOffset: 180, step: null }); return s.getUser('1'); };

test('cal: месячная сетка - месяц, дни недели, коннект/выгрузка/загрузка', async () => {
  const s = new Store(tmpFile()); const u = user(s); const bot = fakeBot(s);
  await bot.lk.onCallback('1', 'lk:cal', cbq('1'), u);
  const r = lastRender(bot, '1');
  assert.match(r.text, /\d{4}/, 'есть год в заголовке');
  assert.ok(flat(r).some((b) => b.text === 'Пн') && flat(r).some((b) => b.text === 'Вс'), 'ряд дней недели');
  assert.ok(hasCb(r, 'lk:cal:connect'));
  assert.ok(hasCb(r, 'lk:cal:export'));
  assert.ok(hasCb(r, 'lk:cal:import'));
  assert.ok(flat(r).some((b) => /Подключить Apple/.test(b.text)), 'кнопка подключения');
});

test('cal: коннект Apple - тумблер (подключил -> ✅ + ссылка, ещё раз -> отвязал)', async () => {
  const s = new Store(tmpFile()); const u = user(s); const bot = fakeBot(s);
  await bot.lk.onCallback('1', 'lk:cal:connect', cbq('1'), s.getUser('1'));
  let f = s.getFitness; // noop
  assert.equal(s.getUser('1').calConnected, true);
  assert.ok(s.getUser('1').calToken, 'токен создан');
  assert.match(lastRender(bot, '1').text, /webcal:\/\/cal\.example\.io\/calendar\/[a-z0-9]+\.ics/i);
  // ещё раз -> отвязка
  await bot.lk.onCallback('1', 'lk:cal:connect', cbq('1'), s.getUser('1'));
  assert.equal(s.getUser('1').calConnected, false);
  assert.equal(s.getUser('1').calToken, null);
  assert.match(lastRender(bot, '1').text, /[Оо]твяз/);
});

test('cal: userByCalToken находит юзера по токену (для веб-фида)', async () => {
  const s = new Store(tmpFile()); user(s); const bot = fakeBot(s);
  await bot.lk.onCallback('1', 'lk:cal:connect', cbq('1'), s.getUser('1'));
  const token = s.getUser('1').calToken;
  const found = s.userByCalToken(token);
  assert.equal(found.chatId, '1');
});

test('cal: «…добавь в календарь» -> переспрос Да/Нет -> Да создаёт событие', async () => {
  const s = new Store(tmpFile()); const u = user(s); const bot = fakeBot(s);
  const handled = await bot.lk.tryCalendar('1', u, 'встреча с другом завтра в 16:00 добавь в календарь');
  assert.equal(handled, true);
  const r = lastRender(bot, '1');
  assert.match(r.text, /[Вв]ерно|Добавить в календарь/);
  assert.ok(hasCb(r, 'lk:cal:add:yes') && hasCb(r, 'lk:cal:add:no'), 'кнопки Да/Нет');
  await bot.lk.onCallback('1', 'lk:cal:add:yes', cbq('1'), s.getUser('1'));
  const evs = s.calEvents('1');
  assert.equal(evs.length, 1, 'событие добавлено в календарь');
  assert.equal(evs[0].calendar, true);
  assert.ok(evs[0].due, 'со сроком');
  assert.match(lastRender(bot, '1').text, /Добавил в календарь/);
});

test('cal: подтверждение словом «да» (голос) тоже создаёт', async () => {
  const s = new Store(tmpFile()); const u = user(s); const bot = fakeBot(s);
  await bot.lk.tryCalendar('1', u, 'созвон завтра в 18:00 в календарь');
  assert.equal(bot.lk.pendingInput('1'), true);
  assert.equal(await bot.lk.consumeInput('1', s.getUser('1'), 'да'), true);
  assert.equal(s.calEvents('1').length, 1);
});

test('cal: «нет» -> переспрашивает, не создаёт', async () => {
  const s = new Store(tmpFile()); const u = user(s); const bot = fakeBot(s);
  await bot.lk.tryCalendar('1', u, 'встреча завтра в 10 в календарь');
  await bot.lk.onCallback('1', 'lk:cal:add:no', cbq('1'), s.getUser('1'));
  assert.match(lastRender(bot, '1').text, /как правильно/i);
  assert.equal(s.calEvents('1').length, 0, 'ничего не создано');
  assert.equal(bot.lk.pendingInput('1'), true, 'ждём исправление');
});

test('cal: без времени -> спрашивает «на когда», потом подтверждает', async () => {
  const s = new Store(tmpFile()); const u = user(s); const bot = fakeBot(s);
  await bot.lk.tryCalendar('1', u, 'добавь в календарь поход к врачу');
  assert.match(lastRender(bot, '1').text, /когда/i);
  assert.equal(await bot.lk.consumeInput('1', s.getUser('1'), 'завтра в 9:00'), true);
  assert.match(lastRender(bot, '1').text, /[Вв]ерно|Добавить в календарь/);
});

test('cal: без ключевого слова не перехватывает', async () => {
  const s = new Store(tmpFile()); const u = user(s); const bot = fakeBot(s);
  assert.equal(await bot.lk.tryCalendar('1', u, 'встреча с другом завтра в 16'), false, 'нет слова «календарь» - не трогаем');
  assert.equal(s.calEvents('1').length, 0);
});

test('cal: «покажи календарь» открывает сетку, а не добавляет', async () => {
  const s = new Store(tmpFile()); const u = user(s); const bot = fakeBot(s);
  const handled = await bot.lk.tryCalendar('1', u, 'покажи календарь');
  assert.equal(handled, true);
  assert.match(lastRender(bot, '1').text, /\d{4}/);
  assert.equal(s.calEvents('1').length, 0);
});

test('cal: день-вью показывает события этого дня', async () => {
  const s = new Store(tmpFile()); const u = user(s); const bot = fakeBot(s);
  // 15-е число текущего месяца, 14:00 МСК
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  const dueIso = new Date(Date.UTC(y, m - 1, 15, 11, 0, 0)).toISOString(); // 14:00 МСК
  s.add({ chatId: '1', type: 'meeting', title: 'Зубной', due: dueIso, hasTime: true, calendar: true });
  await bot.lk.onCallback('1', `lk:cal:d:${y}-${m}-15`, cbq('1'), s.getUser('1'));
  assert.match(lastRender(bot, '1').text, /Зубной/);
});

test('cal: импорт .ics складывает события в календарь', () => {
  const s = new Store(tmpFile()); user(s); const bot = fakeBot(s);
  const n = bot.lk.importCalendar('1', [{ title: 'Импорт1', due: new Date().toISOString(), hasTime: true }]);
  assert.equal(n, 1);
  assert.equal(s.calEvents('1').length, 1);
});
