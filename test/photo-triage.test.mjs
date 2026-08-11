// Один взгляд на картинку вместо трёх запросов. Разбор ответа проверяем без
// похода в сеть: раньше длинный текст со скриншота ломал JSON, и поход к модели
// пропадал впустую.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTriageAnswer } from '../src/ai-skills.mjs';

test('чек: сумма, магазин и категория', () => {
  const r = parseTriageAnswer('{"kind":"receipt","amount":1250,"merchant":"Пятёрочка","category":"еда","date":"2026-08-10"}');
  assert.equal(r.kind, 'receipt');
  assert.equal(r.amount, 1250);
  assert.equal(r.merchant, 'Пятёрочка');
});

test('еда: блюдо с калориями и БЖУ', () => {
  const r = parseTriageAnswer('{"kind":"food","title":"Боул с тофу","portion":"1 тарелка","kcal":550,"protein":35,"fat":25,"carbs":45,"sure":"medium"}');
  assert.equal(r.kind, 'food');
  assert.equal(r.kcal, 550);
  assert.equal(r.protein, 35);
  assert.equal(r.sure, 'medium');
});

test('еда без калорий - не еда (иначе в дневник уйдёт ноль)', () => {
  const r = parseTriageAnswer('{"kind":"food","title":"что-то","kcal":0}');
  assert.notEqual(r?.kind, 'food');
});

test('чек без суммы не считается чеком', () => {
  const r = parseTriageAnswer('{"kind":"receipt","amount":0,"merchant":"?"}');
  assert.notEqual(r?.kind, 'receipt');
});

test('обычная картинка приходит текстом, а не JSON', () => {
  const r = parseTriageAnswer('Скриншот переписки\nМама\nКупи хлеб\nОк, зайду');
  assert.equal(r.kind, 'other');
  assert.match(r.text, /Купи хлеб/);
  assert.match(r.text, /Скриншот переписки/);
});

test('длинный текст с кавычками и переносами не ломает разбор', () => {
  const long = 'Документ\n' + Array.from({ length: 60 }, (_, i) => `строка ${i} с "кавычками" и {скобками}`).join('\n');
  const r = parseTriageAnswer(long);
  assert.equal(r.kind, 'other');
  assert.match(r.text, /строка 59/);
});

test('битый JSON не теряется: отдаём как текст', () => {
  const r = parseTriageAnswer('{"kind":"other","text":"начало текста без закрытия');
  assert.equal(r.kind, 'other');
  assert.ok(r.text.length > 20);
});

test('markdown-обёртка снимается', () => {
  const r = parseTriageAnswer('```json\n{"kind":"food","title":"Омлет","kcal":300,"protein":20,"fat":22,"carbs":3}\n```');
  assert.equal(r.kind, 'food');
  assert.equal(r.title, 'Омлет');
});

test('пусто - значит нечего разбирать', () => {
  assert.equal(parseTriageAnswer(''), null);
  assert.equal(parseTriageAnswer(null), null);
});

test('завышенные числа обрезаются по здравому смыслу', () => {
  const r = parseTriageAnswer('{"kind":"food","title":"Тарелка","kcal":999999,"protein":9999,"fat":9999,"carbs":9999}');
  assert.equal(r.kcal, 5000);
  assert.equal(r.protein, 500);
  assert.equal(r.carbs, 800);
});
