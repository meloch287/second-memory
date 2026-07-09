import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relDay } from '../src/tz.mjs';

const MSK = 180;
// 9 июля 2026, 09:00 МСК (06:00Z)
const NOW = new Date('2026-07-09T06:00:00.000Z');

test('relDay: базовые относительные подписи в поясе пользователя', () => {
  assert.equal(relDay('2026-07-09T15:00:00.000Z', NOW, MSK), 'сегодня');   // тот же день
  assert.equal(relDay('2026-07-10T06:00:00.000Z', NOW, MSK), 'завтра');
  assert.equal(relDay('2026-07-11T06:00:00.000Z', NOW, MSK), 'послезавтра');
  assert.equal(relDay('2026-07-08T06:00:00.000Z', NOW, MSK), 'вчера');
  assert.equal(relDay('2026-07-07T06:00:00.000Z', NOW, MSK), 'позавчера');
});

test('relDay: главный баг — дата через 5 дней НЕ «завтра»', () => {
  assert.equal(relDay('2026-07-14T09:00:00.000Z', NOW, MSK), 'через 5 дней'); // ДР 14 июля
  assert.equal(relDay('2026-07-27T09:00:00.000Z', NOW, MSK), 'через 18 дней'); // Лизин ДР 27 июля
});

test('relDay: склонения «день/дня/дней»', () => {
  assert.equal(relDay('2026-07-12T06:00:00.000Z', NOW, MSK), 'через 3 дня');
  assert.equal(relDay('2026-07-14T06:00:00.000Z', NOW, MSK), 'через 5 дней');
  assert.equal(relDay('2026-07-30T06:00:00.000Z', NOW, MSK), 'через 21 день');
  assert.equal(relDay('2026-06-30T06:00:00.000Z', NOW, MSK), '9 дней назад');
});

test('relDay: считает по поясу пользователя, а не UTC (кроссинг полуночи)', () => {
  // 21:30Z = 00:30 10 июля по МСК → «сегодня» у юзера уже 10-е
  const lateNow = new Date('2026-07-09T21:30:00.000Z');
  assert.equal(relDay('2026-07-10T09:00:00.000Z', lateNow, MSK), 'сегодня');
  assert.equal(relDay('2026-07-11T09:00:00.000Z', lateNow, MSK), 'завтра');
  // тот же момент в UTC (off=0) дал бы другой ответ — подтверждаем, что пояс учитывается
  assert.equal(relDay('2026-07-10T09:00:00.000Z', lateNow, 0), 'завтра');
});

test('relDay: мусорная дата → пустая строка (без падения)', () => {
  assert.equal(relDay('не дата', NOW, MSK), '');
  assert.equal(relDay(null, NOW, MSK), '');
});
