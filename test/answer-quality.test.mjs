// Гарды качества ответов, выросшие из разбора реальных диалогов Толика.
// Каждый тест защищает конкретный живой промах, а не гипотезу.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripRepeatVocative, stripSerialQuestion } from '../src/lessons.mjs';
import { parseWater, parseMeal } from '../src/nutrition.mjs';

test('второе подряд обращение по имени срезается', () => {
  // в живых диалогах ответ открывался именем 47 раз из ~110
  const prev = [{ role: 'assistant', text: 'Ань, привет как дела' }];
  assert.equal(stripRepeatVocative('Ань, да норм всё', 'Аня', prev), 'Да норм всё');
  assert.equal(stripRepeatVocative('Аня, держи план', 'Аня', prev), 'Держи план');
});

test('первое обращение по имени остаётся', () => {
  const prev = [{ role: 'assistant', text: 'Да норм всё' }];
  assert.equal(stripRepeatVocative('Ань, смотри что нашёл', 'Аня', prev), 'Ань, смотри что нашёл');
});

test('слово, начинающееся как имя, не режется', () => {
  const prev = [{ role: 'assistant', text: 'Ань, привет' }];
  assert.equal(stripRepeatVocative('Анекдот такой был', 'Аня', prev), 'Анекдот такой был');
});

test('без истории и без имени гард молчит', () => {
  assert.equal(stripRepeatVocative('Ань, привет', 'Аня', []), 'Ань, привет');
  assert.equal(stripRepeatVocative('Привет', '', [{ role: 'assistant', text: 'Ань, ку' }]), 'Привет');
});

test('второй вопрос-хвост подряд срезается, содержание остаётся', () => {
  const prev = [{ role: 'assistant', text: 'сделал, а тебе как?' }];
  const out = stripSerialQuestion('готово, план на завтра составил. будешь смотреть?', prev);
  assert.match(out, /план на завтра составил/);
  assert.ok(!out.trim().endsWith('?'), out);
});

test('одиночный вопрос не трогаем', () => {
  const prev = [{ role: 'assistant', text: 'готово' }];
  const s = 'а во сколько встреча?';
  assert.equal(stripSerialQuestion(s, prev), s);
});

test('ответ, состоящий только из вопроса, не выпотрошим в пустоту', () => {
  const prev = [{ role: 'assistant', text: 'ну как?' }];
  assert.equal(stripSerialQuestion('а ты как?', prev), 'а ты как?');
});

/* --- Питание: «записал» должно быть правдой --- */

test('литр воды словами теперь распознаётся', () => {
  // parseWater('1 литр') возвращал null - ломался даже честный путь через ЛК
  assert.equal(parseWater('1 литр'), 1000);
  assert.equal(parseWater('выпил литр воды'), 1000);
  assert.equal(parseWater('пол литра'), 500);
  assert.equal(parseWater('2 стакана'), 500);
  assert.equal(parseWater('0.5 л'), 500);
});

test('еда с калориями разбирается на название и число', () => {
  assert.deepEqual(parseMeal('рафаэлки 120 ккал'), { kcal: 120, title: 'рафаэлки' });
  assert.deepEqual(parseMeal('омлет 350'), { kcal: 350, title: 'омлет' });
  assert.equal(parseMeal('просто поел'), null, 'без числа записывать нечего');
});

/* --- Погода: бот её не знает, спрашивает сервис --- */

test('вопрос о погоде отличается от «погоди» и «погодных условий»', () => {
  const RE = /погод(?:а|ы|у|е|ой|ке|ку)(?![а-яё])|(?:дожд[ьяи]|снег|гроза)\s+(?:будет|сегодня|завтра)/i;
  for (const s of ['какая завтра погода?', 'погода', 'что там с погодой', 'посмотри погоду', 'дождь будет?']) {
    assert.equal(RE.test(s), true, s);
  }
  for (const s of ['погоди секунду', 'погодные условия в отчёте', 'я подожду']) {
    assert.equal(RE.test(s), false, s);
  }
});
