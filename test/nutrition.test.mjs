// Расчёт нормы питания (Миффлин-Сан Жеор) и разбор ввода еды/воды.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyNorm, todayLog, dayKey, parseMeal, parseWater, bar } from '../src/nutrition.mjs';

const PROFILE = { weight: 72, height: 181, age: 20, sex: 'м', goal: 'масса', days: [1, 3, 5] };

test('dailyNorm: считает по формуле, набор массы даёт профицит', () => {
  const n = dailyNorm(PROFILE);
  // BMR = 10*72 + 6.25*181 - 5*20 + 5 = 1756
  assert.equal(n.bmr, 1756);
  // 3 тренировки -> коэффициент 1.55
  assert.equal(n.tdee, Math.round(1756 * 1.55));
  assert.ok(n.kcal > n.tdee, 'на массе профицит');
  assert.equal(n.protein, Math.round(72 * 1.8));
  assert.equal(n.fat, Math.round(72 * 0.9));
  // калории сходятся из БЖУ (с округлением)
  assert.ok(Math.abs(n.protein * 4 + n.fat * 9 + n.carbs * 4 - n.kcal) <= 5);
});

test('dailyNorm: похудение -> дефицит, женщина -> BMR ниже', () => {
  const cut = dailyNorm({ ...PROFILE, goal: 'похудение' });
  assert.ok(cut.kcal < cut.tdee, 'на похудении дефицит');
  assert.ok(cut.protein > dailyNorm(PROFILE).protein, 'на сушке белка больше');
  const f = dailyNorm({ ...PROFILE, sex: 'ж' });
  assert.equal(f.bmr, 1756 - 5 - 161, 'женская формула');
});

test('dailyNorm: вода 32 мл/кг + 400 мл в тренировочный день', () => {
  const rest = dailyNorm(PROFILE, false);
  const train = dailyNorm(PROFILE, true);
  assert.equal(rest.water, Math.round((72 * 32) / 50) * 50);
  assert.equal(train.water - rest.water, 400);
  assert.equal(train.trainingDay, true);
});

test('dailyNorm: без веса/роста -> null (не выдумываем цифры)', () => {
  assert.equal(dailyNorm({ weight: 72 }), null);
  assert.equal(dailyNorm({}), null);
  assert.equal(dailyNorm(null), null);
});

test('dailyNorm: разбивка по приёмам суммируется в норму', () => {
  const n = dailyNorm(PROFILE);
  const sum = n.meals.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - n.kcal) <= 40, `сумма приёмов ${sum} ≈ ${n.kcal}`);
});

test('parseMeal: калории и название', () => {
  assert.deepEqual(parseMeal('омлет 350'), { kcal: 350, title: 'омлет' });
  assert.equal(parseMeal('600').kcal, 600);
  assert.equal(parseMeal('поел 480 ккал').kcal, 480);
  assert.equal(parseMeal('без цифр'), null);
});

test('parseWater: мл, литры, стаканы, бутылки', () => {
  assert.equal(parseWater('500'), 500);
  assert.equal(parseWater('стакан'), 250);
  assert.equal(parseWater('2 стакана'), 500);
  assert.equal(parseWater('бутылка'), 500);
  assert.equal(parseWater('0.5 л'), 500);
  assert.equal(parseWater('1,5 л'), 1500);
  assert.equal(parseWater('ничего'), null);
});

test('todayLog: обнуляется при смене даты (по поясу юзера)', () => {
  const today = dayKey(180);
  const fresh = todayLog({ log: { date: today, water: 500, kcal: 300, items: [{ title: 'x', kcal: 300 }] } }, 180);
  assert.equal(fresh.water, 500);
  assert.equal(fresh.kcal, 300);
  const stale = todayLog({ log: { date: '2020-01-01', water: 999, kcal: 999, items: [] } }, 180);
  assert.equal(stale.water, 0, 'вчерашний трекер сброшен');
  assert.equal(stale.kcal, 0);
  assert.equal(todayLog({}, 180).water, 0, 'без лога - нули');
});

test('bar: полоска прогресса', () => {
  assert.equal(bar(0, 100), '▱'.repeat(10));
  assert.equal(bar(100, 100), '▰'.repeat(10));
  assert.equal(bar(50, 100), '▰'.repeat(5) + '▱'.repeat(5));
  assert.equal(bar(500, 100), '▰'.repeat(10), 'перебор не ломает полоску');
  assert.equal(bar(10, 0).length, 10, 'нулевая цель не делит на ноль');
});
