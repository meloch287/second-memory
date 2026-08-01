// Личный кабинет (U3a-ui): статистика + CRUD долгов через текст и инлайн-кнопки.
// Гоняем createLkHandler напрямую с фейковым ботом (в духе спай-бота из
// notifications.e2e.test.mjs / group.test.mjs) - никакого voice, только
// текст+callback, как договорено (голос - бонус-путь, не проверяем тут).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createLkHandler } from '../src/telegram-lk.mjs';

delete process.env.SM_ENCRYPTION_KEY;

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'sm-lk-')), 'm.json');

// Фейковый бот: send/sendButtons копят исходящие сообщения, api() ловит
// editMessageText (правка текущего сообщения) и answerCallbackQuery. Порядок
// рендеров (для lastRender) - отдельный монотонный счётчик `order`, а НЕ
// message_id (тестовые cbq дают его вручную, он не отражает хронологию).
function fakeBot(store) {
  const sent = []; // { chatId, text, extra, order }
  const edits = []; // { chatId, messageId, text, reply_markup, order }
  let msgSeq = 1000;
  let order = 0;

  const send = async (chatId, text, extra = {}) => {
    const message_id = msgSeq++;
    sent.push({ chatId: String(chatId), text, extra, message_id, order: order++ });
    return { ok: true, result: { message_id } };
  };
  const sendButtons = async (chatId, text, inline_keyboard) => send(chatId, text, { reply_markup: { inline_keyboard } });
  const api = async (method, params) => {
    if (method === 'editMessageText') {
      edits.push({ chatId: String(params.chat_id), messageId: params.message_id, text: params.text, reply_markup: params.reply_markup, order: order++ });
      return { ok: true, result: { message_id: params.message_id } };
    }
    if (method === 'answerCallbackQuery') return { ok: true };
    return { ok: true };
  };

  const lk = createLkHandler({ store, send, sendButtons, api, botNameOf: () => 'Толик', log: { error() {}, log() {} } });
  return { lk, sent, edits };
}

// Последний рендер (правка ИЛИ новое сообщение) для чата - что реально видит юзер.
function lastRender(bot, chatId) {
  const all = [
    ...bot.sent.filter((s) => s.chatId === String(chatId)).map((s) => ({ text: s.text, kb: s.extra?.reply_markup?.inline_keyboard, at: s.order })),
    ...bot.edits.filter((e) => e.chatId === String(chatId)).map((e) => ({ text: e.text, kb: e.reply_markup?.inline_keyboard, at: e.order })),
  ];
  return all.sort((a, b) => a.at - b.at).at(-1);
}

const cbq = (chatId, messageId, id = 'cb1') => ({ id, message: { message_id: messageId, chat: { id: Number(chatId) } } });

test('openSettings: показывает статистику и 3 кнопки (Фитнес / Долги / Вишлист)', async () => {
  const s = new Store(tmpFile());
  s.setUser('1', { name: 'Саша', step: null });
  s.bumpRequests('1');
  s.bumpRequests('1');
  s.addFacts([{ chatId: '1', text: 'факт' }]);
  s.add({ chatId: '1', type: 'debt', counterparty: 'Дима', amount: 100, direction: 'in' });
  s.add({ chatId: '1', type: 'task', title: 'дело' });
  s.add({ chatId: '1', type: 'meeting', title: 'встреча' });

  const bot = fakeBot(s);
  await bot.lk.openSettings('1', s.getUser('1'));

  const r = lastRender(bot, '1');
  assert.match(r.text, /Личный кабинет/);
  assert.match(r.text, /Запросов Толику: 2/);
  assert.match(r.text, /Фактов помню: 1/);
  assert.match(r.text, /Открытых долгов: 1/);
  assert.match(r.text, /Задач: 1/);
  assert.match(r.text, /Встреч: 1/);
  assert.match(r.text, /Вишлист: 0/);
  assert.match(r.text, /Со мной дней: \d/);

  const flat = r.kb.flat().map((b) => b.callback_data);
  assert.deepEqual(flat, ['lk:fit', 'lk:debts', 'lk:wish'], 'ровно 3 кнопки, в двух рядах');
  assert.equal(r.kb.length, 2, 'Фитнес отдельным рядом, Долги+Вишлист вторым');
});

test('lk:fit -> заглушка "в разработке", без логики фитнеса', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  await bot.lk.onCallback('1', 'lk:fit', cbq('1', 10), s.getUser('1'));
  const r = lastRender(bot, '1');
  assert.match(r.text, /в разработке/);
  assert.match(r.text, /Фитнес|тренер/i);
});

test('lk:debts: список открытых долгов юзера, "Долгов нет" для пустого', async () => {
  const s = new Store(tmpFile());
  s.setUser('1', { name: 'Саша', step: null, tzOffset: 180 });
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', 'lk:debts', cbq('1', 11), s.getUser('1'));
  assert.match(lastRender(bot, '1').text, /Долгов нет/);

  s.add({ chatId: '1', type: 'debt', counterparty: 'Иванов', amount: 50000, direction: 'in', due: '2026-07-20T09:00:00.000Z' });
  s.add({ chatId: '1', type: 'debt', counterparty: 'Пете', amount: 5000, direction: 'out' });
  s.add({ chatId: '2', type: 'debt', counterparty: 'Чужой', amount: 999, direction: 'in' }); // не должен утечь
  s.add({ chatId: '1', type: 'debt', counterparty: 'Закрытый', amount: 1, direction: 'in', status: 'done' }); // закрыт, не в списке

  await bot.lk.onCallback('1', 'lk:debts', cbq('1', 12), s.getUser('1'));
  const r = lastRender(bot, '1');
  assert.match(r.text, /№\d+ — Иванов должен вам 50\s000\s₽, срок 20\.07\.2026/);
  assert.match(r.text, /№\d+ — Вы должны Пете 5\s000\s₽/);
  assert.doesNotMatch(r.text, /Чужой/);
  assert.doesNotMatch(r.text, /Закрытый/);

  // на каждый долг - ряд [✏️ №id][🗑 №id], плюс "Добавить долг" и "Назад"
  const editButtons = r.kb.flat().filter((b) => b.callback_data.startsWith('lk:debt:edit:'));
  const delButtons = r.kb.flat().filter((b) => b.callback_data.startsWith('lk:debt:del:'));
  assert.equal(editButtons.length, 2);
  assert.equal(delButtons.length, 2);
  assert.ok(r.kb.flat().some((b) => b.callback_data === 'lk:debt:add'));
  assert.ok(r.kb.flat().some((b) => b.callback_data === 'lk:home'));
});

test('lk:debt:add -> pending -> следующее сообщение сохраняет долг (persists), список обновляется', async () => {
  const file = tmpFile();
  const s = new Store(file);
  s.setUser('1', { name: 'Саша', step: null, tzOffset: 180 });
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', 'lk:debts', cbq('1', 20), s.getUser('1'));
  assert.equal(bot.lk.pendingInput('1'), false);

  await bot.lk.onCallback('1', 'lk:debt:add', cbq('1', 21), s.getUser('1'));
  assert.match(lastRender(bot, '1').text, /Опиши долг/);
  assert.equal(bot.lk.pendingInput('1'), true, 'взведён режим ожидания ввода');

  const handled = await bot.lk.consumeInput('1', s.getUser('1'), 'Иванов должен 50000 до 20 июля');
  assert.equal(handled, true);
  assert.equal(bot.lk.pendingInput('1'), false, 'флаг снят после ввода');

  const debts = s.list({ type: 'debt', status: 'open', chatId: '1' });
  assert.equal(debts.length, 1);
  assert.equal(debts[0].counterparty, 'Иванов');
  assert.equal(debts[0].amount, 50000);
  assert.equal(debts[0].direction, 'in', '«Иванов должен» - должен вам');
  assert.ok(debts[0].due, 'срок распознан и сохранён');

  const confirmMsg = bot.sent.filter((m) => m.chatId === '1').at(-2); // предпоследнее: подтверждение (последнее - обновлённый список)
  assert.match(confirmMsg.text, /Записал долг/);
  assert.match(lastRender(bot, '1').text, /Иванов должен вам 50\s000/, 'список долгов сразу отражает добавленное (без перезапуска)');

  // Persistence (U4): переживает перезагрузку из файла
  s.flush();
  const reloaded = new Store(file);
  const reDebts = reloaded.list({ type: 'debt', status: 'open', chatId: '1' });
  assert.equal(reDebts.length, 1, 'долг пережил flush+перезагрузку');
  assert.equal(reDebts[0].counterparty, 'Иванов');
});

test('lk:debt:add -> нераспознанный текст не сбрасывает режим, можно повторить', async () => {
  const s = new Store(tmpFile());
  s.setUser('1', { name: 'Саша', step: null, tzOffset: 180 });
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', 'lk:debt:add', cbq('1', 30), s.getUser('1'));
  const handled = await bot.lk.consumeInput('1', s.getUser('1'), 'ку как дела вообще жиза');
  assert.equal(handled, true, 'сообщение перехвачено ЛК (даже если не распознано)');
  assert.equal(bot.lk.pendingInput('1'), true, 'режим ожидания остаётся - можно попробовать снова');
  assert.equal(s.list({ type: 'debt', chatId: '1' }).length, 0, 'ничего не записано как долг');
});

test('удаление долга: подтверждение, persists, список обновляется', async () => {
  const file = tmpFile();
  const s = new Store(file);
  s.setUser('1', { name: 'Саша', step: null });
  const e = s.add({ chatId: '1', type: 'debt', counterparty: 'Коля', amount: 3000, direction: 'out' });
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', `lk:debt:del:${e.id}`, cbq('1', 40), s.getUser('1'));
  const confirmR = lastRender(bot, '1');
  assert.match(confirmR.text, /Удалить долг/);
  assert.match(confirmR.text, /Коля/);
  const yes = confirmR.kb.flat().find((b) => b.callback_data === `lk:debt:delyes:${e.id}`);
  const no = confirmR.kb.flat().find((b) => b.callback_data === `lk:debt:delno:${e.id}`);
  assert.ok(yes && no, 'кнопки Да/Отмена присутствуют');

  await bot.lk.onCallback('1', `lk:debt:delyes:${e.id}`, cbq('1', 41), s.getUser('1'));
  assert.equal(s.byId(e.id), null, 'запись удалена из стора');
  assert.match(lastRender(bot, '1').text, /Долгов нет/);

  s.flush();
  const reloaded = new Store(file);
  assert.equal(reloaded.byId(e.id), null, 'удаление пережило перезагрузку (не воскрес)');
});

test('удаление долга: чужой чат не может удалить (владение проверяется)', async () => {
  const s = new Store(tmpFile());
  const e = s.add({ chatId: '1', type: 'debt', counterparty: 'Коля', amount: 3000, direction: 'out' });
  const bot = fakeBot(s);

  await bot.lk.onCallback('2', `lk:debt:delyes:${e.id}`, cbq('2', 50), s.getUser('2'));
  assert.ok(s.byId(e.id), 'чужой долг не удалён');
});

test('«Погашен» закрывает долг без удаления, список долгов больше его не показывает', async () => {
  const s = new Store(tmpFile());
  s.setUser('1', { name: 'Саша', step: null });
  const e = s.add({ chatId: '1', type: 'debt', counterparty: 'Петров', amount: 1000, direction: 'in' });
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', `lk:debt:edit:${e.id}`, cbq('1', 60), s.getUser('1'));
  const editR = lastRender(bot, '1');
  assert.match(editR.text, /Петров/);
  const doneBtn = editR.kb.flat().find((b) => b.callback_data === `lk:debt:done:${e.id}`);
  assert.ok(doneBtn, 'кнопка «Погашен» есть');

  await bot.lk.onCallback('1', `lk:debt:done:${e.id}`, cbq('1', 61), s.getUser('1'));
  assert.equal(s.byId(e.id).status, 'done', 'запись помечена done, не удалена');
  assert.match(lastRender(bot, '1').text, /Долгов нет/, 'закрытый долг ушёл из списка открытых');
});

test('изменить сумму/срок: pending -> текст патчит существующий долг', async () => {
  const s = new Store(tmpFile());
  s.setUser('1', { name: 'Саша', step: null, tzOffset: 180 });
  const e = s.add({ chatId: '1', type: 'debt', counterparty: 'Ольга', amount: 1000, direction: 'in' });
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', `lk:debt:amount:${e.id}`, cbq('1', 70), s.getUser('1'));
  assert.equal(bot.lk.pendingInput('1'), true);

  await bot.lk.consumeInput('1', s.getUser('1'), '70000 до 25 июля');
  const updated = s.byId(e.id);
  assert.equal(updated.amount, 70000);
  assert.ok(updated.due, 'срок пересчитан');
  assert.match(lastRender(bot, '1').text, /70\s000/, 'обновлённая сумма видна в списке');
});

test('изменить сумму: только число, без даты - срок не трогаем', async () => {
  const s = new Store(tmpFile());
  s.setUser('1', { name: 'Саша', step: null });
  const e = s.add({ chatId: '1', type: 'debt', counterparty: 'Ольга', amount: 1000, direction: 'in', due: '2026-07-20T09:00:00.000Z' });
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', `lk:debt:amount:${e.id}`, cbq('1', 80), s.getUser('1'));
  await bot.lk.consumeInput('1', s.getUser('1'), '80000');
  const updated = s.byId(e.id);
  assert.equal(updated.amount, 80000);
  assert.equal(updated.due, '2026-07-20T09:00:00.000Z', 'срок остался прежним');
});

test('lk:wish -> заглушка (раздел ещё не готов), не ломает клавиатуру', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  await bot.lk.onCallback('1', 'lk:wish', cbq('1', 90), s.getUser('1'));
  const r = lastRender(bot, '1');
  assert.match(r.text, /[Вв]ишлист/);
  assert.ok(r.kb.flat().some((b) => b.callback_data === 'lk:home'));
});

test('lk:home возвращает в главное меню ЛК и снимает pending', async () => {
  const s = new Store(tmpFile());
  s.setUser('1', { name: 'Саша', step: null });
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', 'lk:debt:add', cbq('1', 100), s.getUser('1'));
  assert.equal(bot.lk.pendingInput('1'), true);

  await bot.lk.onCallback('1', 'lk:home', cbq('1', 101), s.getUser('1'));
  assert.equal(bot.lk.pendingInput('1'), false, '«Назад» отменяет незавершённый ввод');
  assert.match(lastRender(bot, '1').text, /Личный кабинет/);
});

test('onCallback игнорирует callback_data без префикса lk: (возвращает false)', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  const handled = await bot.lk.onCallback('1', 'reset_yes', cbq('1', 110), s.getUser('1'));
  assert.equal(handled, false);
  assert.equal(bot.edits.length + bot.sent.length, 0, 'ничего не отправлено - не наша забота');
});
