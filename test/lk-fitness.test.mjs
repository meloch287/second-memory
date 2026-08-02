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

/* ---- Питание: норма по профилю + дневной трекер ---- */

test('fit: экран Питание считает норму по профилю', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  s.setUser('1', { name: 'Саня', tzOffset: 180, step: null });
  s.setFitness('1', { weight: 72, height: 181, age: 20, sex: 'м', goal: 'масса', level: 'новичок', days: [1, 3, 5] });
  await bot.lk.onCallback('1', 'lk:fit:food', cbq('1'), s.getUser('1'));
  const r = lastRender(bot, '1');
  assert.match(r.text, /Питание на сегодня/);
  assert.match(r.text, /Норма: <b>\d{4}<\/b> ккал/);
  assert.match(r.text, /Б \d+ г · Ж \d+ г · У \d+ г/);
  assert.match(r.text, /Вода/);
  assert.ok(hasCb(r, 'lk:fit:food:w:500'));
  assert.ok(hasCb(r, 'lk:fit:food:meal'));
});

test('fit: Питание без профиля просит заполнить, цифр не выдумывает', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  s.setUser('1', { name: 'Саня', tzOffset: 180, step: null });
  await bot.lk.onCallback('1', 'lk:fit:food', cbq('1'), s.getUser('1'));
  const r = lastRender(bot, '1');
  assert.match(r.text, /нужен профиль/i);
  assert.ok(!/Норма: <b>\d/.test(r.text), 'нормы без данных нет');
});

test('fit: вода +500 копится и переживает перезаход', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  s.setUser('1', { name: 'Саня', tzOffset: 180, step: null });
  s.setFitness('1', { weight: 72, height: 181, goal: 'масса', days: [1] });
  await bot.lk.onCallback('1', 'lk:fit:food:w:500', cbq('1'), s.getUser('1'));
  await bot.lk.onCallback('1', 'lk:fit:food:w:250', cbq('1'), s.getUser('1'));
  assert.equal(s.getFitness('1').log.water, 750);
  assert.match(lastRender(bot, '1').text, /Вода: <b>0\.8<\/b>/, 'показывает 0.75 -> 0.8 л');
});

test('fit: «омлет 480» пишется в дневник калорий', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  s.setUser('1', { name: 'Саня', tzOffset: 180, step: null });
  s.setFitness('1', { weight: 72, height: 181, goal: 'масса', days: [1] });
  await bot.lk.onCallback('1', 'lk:fit:food:meal', cbq('1'), s.getUser('1'));
  assert.equal(bot.lk.pendingInput('1'), true);
  assert.equal(await bot.lk.consumeInput('1', s.getUser('1'), 'омлет с беконом 480'), true);
  const f = s.getFitness('1');
  assert.equal(f.log.kcal, 480);
  assert.equal(f.log.items.at(-1).title, 'омлет с беконом');
  assert.match(lastRender(bot, '1').text, /Съедено: <b>480<\/b>/);
});

test('fit: воду можно записать словами в том же диалоге', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  s.setUser('1', { name: 'Саня', tzOffset: 180, step: null });
  s.setFitness('1', { weight: 72, height: 181, goal: 'масса', days: [1] });
  await bot.lk.onCallback('1', 'lk:fit:food:meal', cbq('1'), s.getUser('1'));
  await bot.lk.consumeInput('1', s.getUser('1'), 'выпил стакан воды');
  assert.equal(s.getFitness('1').log.water, 250);
});

test('fit: сброс дня обнуляет трекер', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  s.setUser('1', { name: 'Саня', tzOffset: 180, step: null });
  s.setFitness('1', { weight: 72, height: 181, goal: 'масса', days: [1], log: { date: '2020-01-01', water: 1, kcal: 1, items: [] } });
  await bot.lk.onCallback('1', 'lk:fit:food:w:250', cbq('1'), s.getUser('1'));
  assert.equal(s.getFitness('1').log.water, 250, 'вчерашний лог не суммируется');
  await bot.lk.onCallback('1', 'lk:fit:food:reset', cbq('1'), s.getUser('1'));
  assert.equal(s.getFitness('1').log.water, 0);
  assert.equal(s.getFitness('1').log.kcal, 0);
});

test('fit: разбивка по приёмам', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  s.setUser('1', { name: 'Саня', tzOffset: 180, step: null });
  s.setFitness('1', { weight: 72, height: 181, goal: 'масса', days: [1] });
  await bot.lk.onCallback('1', 'lk:fit:food:split', cbq('1'), s.getUser('1'));
  const r = lastRender(bot, '1');
  assert.match(r.text, /Завтрак: <b>\d+<\/b> ккал/);
  assert.match(r.text, /Перекус/);
});

test('fit: главная тренера - премиум-иконки на кнопках, Питание всегда есть', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  await bot.lk.onCallback('1', 'lk:fit', cbq('1'), s.getUser('1'));
  const r = lastRender(bot, '1');
  assert.match(r.text, /Личный тренер/);
  assert.match(r.text, /<tg-emoji emoji-id="\d+">/, 'премиум-эмодзи в тексте');
  const btns = flat(r);
  assert.ok(btns.every((b) => b.callback_data === 'lk:home' || b.icon_custom_emoji_id), 'у разделов премиум-иконки');
  assert.ok(hasCb(r, 'lk:fit:food'));
});

/* ---- Пересоставление плана ---- */

test('fit: план уже есть -> спрашивает, не перетирает молча', async () => {
  const s = new Store(tmpFile());
  let called = 0;
  const bot = fakeBot(s, { aiFitnessProgram: async (...a) => { called++; return fakeAiPlan(...a); } });
  s.setFitness('1', { weight: 80, height: 180, goal: 'масса', days: [1, 3], plan: { 1: 'Фокус: Грудь\n- Жим лёжа — 4x8', 3: 'Фокус: Спина\n- Тяга — 4x10' } });
  await bot.lk.onCallback('1', 'lk:fit:gen', cbq('1'), s.getUser('1'));
  const r = lastRender(bot, '1');
  assert.match(r.text, /План уже есть/);
  assert.match(r.text, /Пересоставить/);
  assert.ok(hasCb(r, 'lk:fit:gen:yes'), 'кнопка подтверждения');
  assert.ok(hasCb(r, 'lk:fit:plan:0'), 'кнопка оставить текущий');
  assert.equal(called, 0, 'ИИ не дёргали, план не тронут');
  assert.match(s.getFitness('1').plan[1], /Жим лёжа/, 'старый план на месте');
});

test('fit: подтверждение -> пересоставляет и передаёт прошлые упражнения+фокус', async () => {
  const s = new Store(tmpFile());
  let passed = null;
  const bot = fakeBot(s, {
    aiFitnessProgram: async (profile, dayNames, opts) => { passed = opts; return fakeAiPlan(profile, dayNames); },
  });
  s.setFitness('1', {
    weight: 80, height: 180, goal: 'масса', days: [1, 3],
    plan: { 1: 'Фокус: Грудь, Трицепс\n- Жим лёжа — 4x8\n- Отжимания на брусьях — 3x10', 3: 'Фокус: Спина\n- Подтягивания — 4x8' },
  });
  await bot.lk.onCallback('1', 'lk:fit:gen:yes', cbq('1'), s.getUser('1'));
  assert.ok(passed?.previous?.length === 2, 'прошлый план передан в генератор');
  assert.equal(passed.previous[0].day, 'Понедельник');
  assert.match(passed.previous[0].focus, /Грудь, Трицепс/, 'группа мышц сохраняется');
  assert.ok(passed.previous[0].exercises.includes('Жим лёжа'), 'упражнения переданы, чтобы не повторялись');
  assert.ok(passed.previous[0].exercises.includes('Отжимания на брусьях'));
  assert.match(lastRender(bot, '1').text, /Пересоставил|1\/2/, 'показал новый план');
});

test('fit: первый план (плана нет) генерится сразу, без переспроса', async () => {
  const s = new Store(tmpFile());
  let passed = 'нет вызова';
  const bot = fakeBot(s, { aiFitnessProgram: async (p, d, opts) => { passed = opts; return fakeAiPlan(p, d); } });
  s.setFitness('1', { weight: 80, height: 180, goal: 'масса', days: [1, 3] });
  await bot.lk.onCallback('1', 'lk:fit:gen', cbq('1'), s.getUser('1'));
  assert.deepEqual(passed?.previous, [], 'для нового плана прошлого нет');
  assert.equal(Object.keys(s.getFitness('1').plan).length, 2);
});
