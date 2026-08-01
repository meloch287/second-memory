// Личный тренер (кнопка «Фитнес» в ЛК): профиль (вес/рост/возраст/пол/цель/
// уровень) кнопками+текстом, дни-тумблеры, генерация плана (AI замокан) и
// галерея по дням. Тот же спай-бот, что в lk-wishlist/lk-debts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createLkHandler } from '../src/telegram-lk.mjs';

delete process.env.SM_ENCRYPTION_KEY;
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'sm-lk-fit-')), 'm.json');

// AI-план: строго формат «@@ДЕНЬ: <name>@@» на каждый переданный день.
const fakeAiPlan = async (_profile, dayNames) =>
  dayNames.map((n, i) => `@@ДЕНЬ: ${n}@@\nФокус дня ${i + 1}\n- Разминка 5 мин\n- Присед — 4x8\n- Жим — 4x10`).join('\n');

function fakeBot(store, { aiFitnessProgram = fakeAiPlan } = {}) {
  const sent = [], edits = [], photos = [];
  let msgSeq = 1000, order = 0;
  const send = async (chatId, text, extra = {}) => { const message_id = msgSeq++; sent.push({ chatId: String(chatId), text, extra, message_id, order: order++ }); return { ok: true, result: { message_id } }; };
  const sendButtons = async (chatId, text, inline_keyboard) => send(chatId, text, { reply_markup: { inline_keyboard } });
  const api = async (method, params) => {
    if (method === 'editMessageText') { edits.push({ chatId: String(params.chat_id), messageId: params.message_id, text: params.text, reply_markup: params.reply_markup, order: order++ }); return { ok: true, result: { message_id: params.message_id } }; }
    if (method === 'sendPhoto') { const message_id = msgSeq++; photos.push({ chatId: String(params.chat_id), caption: params.caption, order: order++ }); return { ok: true, result: { message_id } }; }
    return { ok: true };
  };
  const withTyping = (_chatId, fn) => fn();
  const lk = createLkHandler({ store, send, sendButtons, api, botNameOf: () => 'Толик', log: { error() {}, log() {} }, withTyping, aiFitnessProgram });
  return { lk, sent, edits, photos };
}

function lastRender(bot, chatId) {
  const all = [
    ...bot.sent.filter((s) => s.chatId === String(chatId)).map((s) => ({ text: s.text, kb: s.extra?.reply_markup?.inline_keyboard, at: s.order })),
    ...bot.edits.filter((e) => e.chatId === String(chatId)).map((e) => ({ text: e.text, kb: e.reply_markup?.inline_keyboard, at: e.order })),
    ...bot.photos.filter((p) => p.chatId === String(chatId)).map((p) => ({ text: p.caption, kb: undefined, at: p.at ?? p.order })),
  ];
  return all.sort((a, b) => a.at - b.at).at(-1);
}
const cbq = (chatId, messageId, id = 'cb1') => ({ id, message: { message_id: messageId, chat: { id: Number(chatId) } } });
const flat = (r) => (r.kb || []).flat();
const hasCb = (r, cb) => flat(r).some((b) => b.callback_data === cb);

test('fit: главная тренера - профиль не заполнен, кнопки Профиль/Дни', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  await bot.lk.onCallback('1', 'lk:fit', cbq('1', 10), s.getUser('1'));
  const r = lastRender(bot, '1');
  assert.match(r.text, /Личный тренер/);
  assert.match(r.text, /не заполнен/i);
  assert.ok(hasCb(r, 'lk:fit:prof'));
  assert.ok(hasCb(r, 'lk:fit:days'));
  assert.ok(!hasCb(r, 'lk:fit:gen'), 'кнопки Составить нет без профиля/дней');
});

test('fit: профиль вес/рост/возраст через текст, пол/цель/уровень кнопками', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  // вес
  await bot.lk.onCallback('1', 'lk:fit:set:weight', cbq('1', 10), s.getUser('1'));
  assert.equal(bot.lk.pendingInput('1'), true, 'ждём ввод веса');
  assert.equal(await bot.lk.consumeInput('1', s.getUser('1'), '80'), true);
  assert.equal(s.getFitness('1').weight, 80);
  // рост, возраст
  await bot.lk.onCallback('1', 'lk:fit:set:height', cbq('1', 10), s.getUser('1'));
  await bot.lk.consumeInput('1', s.getUser('1'), 'рост 180 см');
  assert.equal(s.getFitness('1').height, 180);
  await bot.lk.onCallback('1', 'lk:fit:set:age', cbq('1', 10), s.getUser('1'));
  await bot.lk.consumeInput('1', s.getUser('1'), '30');
  assert.equal(s.getFitness('1').age, 30);
  // пол/цель/уровень кнопками
  await bot.lk.onCallback('1', 'lk:fit:sex:м', cbq('1', 10), s.getUser('1'));
  await bot.lk.onCallback('1', 'lk:fit:goal:масса', cbq('1', 10), s.getUser('1'));
  await bot.lk.onCallback('1', 'lk:fit:level:средний', cbq('1', 10), s.getUser('1'));
  const f = s.getFitness('1');
  assert.equal(f.sex, 'м'); assert.equal(f.goal, 'масса'); assert.equal(f.level, 'средний');
  const r = lastRender(bot, '1');
  assert.match(r.text, /Набор массы/);
});

test('fit: некорректный вес - просит число, pending держится', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  await bot.lk.onCallback('1', 'lk:fit:set:weight', cbq('1', 10), s.getUser('1'));
  assert.equal(await bot.lk.consumeInput('1', s.getUser('1'), 'ну килограмм 5'), true);
  assert.match(lastRender(bot, '1').text, /Не понял вес/);
  assert.equal(bot.lk.pendingInput('1'), true, 'pending остаётся');
  assert.equal(s.getFitness('1'), null, 'мусор не записан');
});

test('fit: дни-тумблеры включаются и выключаются', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  await bot.lk.onCallback('1', 'lk:fit:day:1', cbq('1', 10), s.getUser('1'));
  await bot.lk.onCallback('1', 'lk:fit:day:3', cbq('1', 10), s.getUser('1'));
  await bot.lk.onCallback('1', 'lk:fit:day:5', cbq('1', 10), s.getUser('1'));
  assert.deepEqual(s.getFitness('1').days, [1, 3, 5]);
  await bot.lk.onCallback('1', 'lk:fit:day:3', cbq('1', 10), s.getUser('1')); // выключаем среду
  assert.deepEqual(s.getFitness('1').days, [1, 5]);
  const r = lastRender(bot, '1');
  assert.ok(flat(r).some((b) => /✅.*Пн|Пн/.test(b.text)));
});

test('fit: генерация плана -> план по дням + галерея с навигацией', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  s.setFitness('1', { weight: 80, height: 180, goal: 'масса', level: 'средний', sex: 'м', days: [1, 3, 5] });
  await bot.lk.onCallback('1', 'lk:fit:gen', cbq('1', 10), s.getUser('1'));
  const f = s.getFitness('1');
  assert.deepEqual(Object.keys(f.plan).map(Number).sort((a, b) => a - b), [1, 3, 5], 'план на 3 дня');
  assert.match(f.plan[1], /Присед/);
  // после генерации показывается первый день
  let r = lastRender(bot, '1');
  assert.match(r.text, /1\/3 — Понедельник/);
  assert.match(r.text, /Присед/);
  // навигация к следующему дню
  await bot.lk.onCallback('1', 'lk:fit:plan:1', cbq('1', 10), s.getUser('1'));
  r = lastRender(bot, '1');
  assert.match(r.text, /2\/3 — Среда/);
  assert.ok(hasCb(r, 'lk:fit:plan:2'));
});

test('fit: составить без профиля -> просит заполнить профиль', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  s.setFitness('1', { days: [1, 3] }); // дни есть, профиля нет
  await bot.lk.onCallback('1', 'lk:fit:gen', cbq('1', 10), s.getUser('1'));
  assert.match(lastRender(bot, '1').text, /профиль/i);
  assert.equal(s.getFitness('1').plan, undefined, 'план не создан без профиля');
});

test('fit: главная показывает Составить и Мой план, когда всё готово', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  s.setFitness('1', { weight: 80, height: 180, goal: 'масса', days: [1], plan: { 1: 'Присед 4x8' } });
  await bot.lk.onCallback('1', 'lk:fit', cbq('1', 10), s.getUser('1'));
  const r = lastRender(bot, '1');
  assert.ok(hasCb(r, 'lk:fit:gen'));
  assert.ok(hasCb(r, 'lk:fit:plan:0'));
  assert.match(r.text, /готов на 1 дн/);
});

test('fit: clearChatData стирает фитнес, чужой чат не трогает', () => {
  const s = new Store(tmpFile());
  s.setFitness('1', { weight: 80, days: [1] });
  s.setFitness('2', { weight: 70, days: [2] });
  s.clearChatData('1');
  assert.equal(s.getFitness('1'), null);
  assert.equal(s.getFitness('2').weight, 70);
});

test('fit: не-фитнес ввод не перехватывается (обычные долги работают)', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  // нет активного fit-pending -> consumeInput не должен возвращать true из-за фитнеса
  assert.equal(await bot.lk.consumeInput('1', s.getUser('1'), 'просто текст'), false);
});
