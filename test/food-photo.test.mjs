// Еда по фото и учёт БЖУ. Живой запрос: «определяй еду по фото и записывай
// калории, а в еде - сколько нужно белков и сколько можно жиров».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { dailyNorm, todayLog, macroAdvice, guessMacros } from '../src/nutrition.mjs';
import { createFoodPhoto } from '../src/foodphoto.mjs';
import { createFitnessHandler } from '../src/telegram-fitness.mjs';

const PROFILE = { weight: 55, height: 155, age: 25, sex: 'ж', goal: 'похудение', days: [1, 3, 5] };

function harness() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'sm-food-')), 'm.json'));
  store.setUser('1', { name: 'Лиза', tzOffset: 180 });
  store.setFitness('1', PROFILE);
  const sent = [];
  const fitness = createFitnessHandler({
    store, send: async () => {}, api: async () => ({}), render: async () => {},
    withTyping: async (_c, f) => f(), aiFitnessProgram: async () => '', log: { error() {}, log() {} },
  });
  const food = createFoodPhoto({
    store,
    send: async (chatId, text, extra) => { sent.push({ text, extra }); },
    esc: (s) => String(s),
    log: { error() {} },
    logFoodEntry: (c, u, f) => fitness.logFoodEntry(c, u, f),
  });
  return { store, sent, food, fitness };
}

const DISH = { title: 'омлет с беконом', portion: '1 тарелка', kcal: 420, protein: 22, fat: 30, carbs: 8, sure: 'medium' };

test('карточка показывает блюдо, калории и БЖУ, но НЕ пишет в дневник сама', async () => {
  const h = harness();
  assert.equal(await h.food.card('1', DISH), true);
  assert.match(h.sent[0].text, /омлет с беконом/);
  assert.match(h.sent[0].text, /420<\/b> ккал/);
  assert.match(h.sent[0].text, /Б 22 г · Ж 30 г · У 8 г/);
  assert.match(h.sent[0].text, /оценка примерная/);
  assert.deepEqual(h.sent[0].extra.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['food:yes', 'food:no']);
  assert.equal(todayLog(h.store.getFitness('1'), 180).kcal, 0, 'до подтверждения дневник пуст');
});

test('«Записать» кладёт блюдо в дневник вместе с БЖУ', async () => {
  const h = harness();
  await h.food.card('1', DISH);
  assert.equal(await h.food.onCallback('1', 'food:yes'), true);
  const log = todayLog(h.store.getFitness('1'), 180);
  assert.equal(log.kcal, 420);
  assert.equal(log.protein, 22);
  assert.equal(log.fat, 30);
  assert.equal(log.carbs, 8);
  assert.equal(log.items.at(-1).title, 'омлет с беконом');
  assert.match(h.sent.at(-1).text, /Записал: омлет с беконом - 420 ккал \(Б22\/Ж30\/У8\)/);
});

test('«Не надо» ничего не пишет', async () => {
  const h = harness();
  await h.food.card('1', DISH);
  assert.equal(await h.food.onCallback('1', 'food:no'), true);
  assert.equal(todayLog(h.store.getFitness('1'), 180).kcal, 0);
});

test('чужие колбэки не перехватываются', async () => {
  const h = harness();
  assert.equal(await h.food.onCallback('1', 'lk:fit'), false);
});

test('без профиля честно просит завести его, а не считает вслепую', async () => {
  const h = harness();
  h.store.setFitness('1', { weight: null, height: null });
  await h.food.card('1', DISH);
  await h.food.onCallback('1', 'food:yes');
  assert.match(h.sent.at(-1).text, /нужен профиль/);
});

test('карточка не вылезает посреди онбординга', async () => {
  const h = harness();
  h.store.setUser('1', { step: 'name' });
  assert.equal(await h.food.card('1', DISH), false);
});

/* --- Нормы БЖУ и подсказки --- */

test('норма считает белки, жиры и углеводы под цель', () => {
  const n = dailyNorm(PROFILE, false);
  assert.equal(n.protein, 110); // 2.0 г/кг на похудении
  assert.equal(n.fat, 50); // ~0.9 г/кг
  assert.ok(n.carbs > 0);
});

test('подсказка говорит, чего добрать и где перебор', () => {
  const n = dailyNorm(PROFILE, false);
  const advice = macroAdvice({ protein: 30, fat: 60, carbs: 80 }, n);
  assert.match(advice[0], /Белок: добери \d+ г/);
  assert.match(advice[1], /Жиры: перебор на 10 г/);
  assert.match(advice[2], /Углеводы: добери/);
});

test('закрытая норма не читается как недобор', () => {
  const n = dailyNorm(PROFILE, false);
  const advice = macroAdvice({ protein: n.protein, fat: n.fat, carbs: n.carbs }, n);
  assert.ok(advice.every((s) => /почти норма|перебор/.test(s)), advice.join(' | '));
});

test('БЖУ по названию блюда: мясо - белковое, десерт - жиры и сахар', () => {
  const meat = guessMacros('куриная грудка', 300);
  const sweet = guessMacros('рафаэлки', 120);
  assert.ok(meat.protein > meat.fat, 'у мяса белка больше жира в граммах');
  assert.ok(sweet.carbs > sweet.protein);
  assert.equal(meat.guessed, true, 'помечено как оценка, а не измерение');
});

test('текстовая запись еды тоже получает БЖУ', () => {
  const h = harness();
  const r = h.fitness.logFoodText('1', h.store.getUser('1'), 'куриная грудка 300');
  assert.equal(r.kind, 'meal');
  assert.ok(r.added.protein > 0 && r.added.fat > 0 && r.added.carbs > 0);
  assert.equal(todayLog(h.store.getFitness('1'), 180).protein, r.added.protein);
});
