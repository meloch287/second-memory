import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../src/parser.mjs';
import { extractDate, extractAmount } from '../src/dates.mjs';

// Фиксированная «текущая» дата: понедельник, 6 июля 2026, 09:00.
const NOW = new Date(2026, 6, 6, 9, 0);

const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('долг: «Иванов должен 50 000 до 20 июля»', () => {
  const p = parseMessage('Иванов должен 50 000 до 20 июля', NOW);
  assert.equal(p.kind, 'entry');
  assert.equal(p.entry.type, 'debt');
  assert.equal(p.entry.amount, 50000);
  assert.equal(p.entry.counterparty, 'Иванов');
  assert.equal(p.entry.direction, 'in');
  assert.equal(day(new Date(p.entry.due)), '2026-07-20');
});

test('долг: «я должен Петрову 15к до пятницы»', () => {
  const p = parseMessage('я должен Петрову 15к до пятницы', NOW);
  assert.equal(p.entry.type, 'debt');
  assert.equal(p.entry.direction, 'out');
  assert.equal(p.entry.amount, 15000);
  assert.equal(p.entry.counterparty, 'Петрову');
  assert.equal(day(new Date(p.entry.due)), '2026-07-10'); // ближайшая пятница
});

test('долг: «Заказчик «Ромашка» должен 120 000 до конца месяца»', () => {
  const p = parseMessage('Заказчик «Ромашка» должен 120 000 до конца месяца', NOW);
  assert.equal(p.entry.type, 'debt');
  assert.equal(p.entry.counterparty, 'Ромашка');
  assert.equal(p.entry.amount, 120000);
  assert.equal(day(new Date(p.entry.due)), '2026-07-31');
});

test('встреча: «запиши встречу с Сергеем завтра в 15:00»', () => {
  const p = parseMessage('запиши встречу с Сергеем завтра в 15:00', NOW);
  assert.equal(p.entry.type, 'meeting');
  assert.equal(p.entry.title, 'Встреча с Сергеем');
  const d = new Date(p.entry.due);
  assert.equal(day(d), '2026-07-07');
  assert.equal(d.getHours(), 15);
  assert.equal(p.entry.hasTime, true);
});

test('встреча: «созвон с командой в пятницу в 10:00»', () => {
  const p = parseMessage('созвон с командой в пятницу в 10:00', NOW);
  assert.equal(p.entry.type, 'meeting');
  assert.equal(p.entry.title, 'Созвон с командой');
  const d = new Date(p.entry.due);
  assert.equal(day(d), '2026-07-10');
  assert.equal(d.getHours(), 10);
});

test('задача: «напомни оплатить хостинг через 3 дня»', () => {
  const p = parseMessage('напомни оплатить хостинг через 3 дня', NOW);
  assert.equal(p.entry.type, 'task');
  assert.equal(p.entry.title, 'Оплатить хостинг');
  assert.equal(day(new Date(p.entry.due)), '2026-07-09');
});

test('задача: «не забыть отправить акт до 15.07»', () => {
  const p = parseMessage('не забыть отправить акт до 15.07', NOW);
  assert.equal(p.entry.type, 'task');
  assert.equal(p.entry.title, 'Отправить акт');
  assert.equal(day(new Date(p.entry.due)), '2026-07-15');
});

test('заметка: «клиент Альфа просил расширить договор»', () => {
  const p = parseMessage('клиент Альфа просил расширить договор', NOW);
  assert.equal(p.entry.type, 'note');
});

test('запрос: «отгрузи все долговые обязательства заказчиков на сегодняшний день»', () => {
  const p = parseMessage('отгрузи все долговые обязательства заказчиков на сегодняшний день', NOW);
  assert.equal(p.kind, 'query');
  assert.equal(p.type, 'debt');
});

test('запрос: «сколько мне должны»', () => {
  const p = parseMessage('сколько мне должны', NOW);
  assert.equal(p.kind, 'query');
  assert.equal(p.type, 'debt');
  assert.equal(p.aggregate, true);
  assert.equal(p.direction, 'in');
});

test('запрос: «что у меня завтра» — сводка на завтра', () => {
  const p = parseMessage('что у меня завтра', NOW);
  assert.equal(p.kind, 'digest');
  assert.equal(day(new Date(p.range.from)), '2026-07-07');
});

test('запрос: «покажи встречи на неделю»', () => {
  const p = parseMessage('покажи встречи на неделю', NOW);
  assert.equal(p.kind, 'query');
  assert.equal(p.type, 'meeting');
  assert.equal(p.range.days, 7);
});

test('команды: «готово 2» и «удали 3»', () => {
  assert.deepEqual(parseMessage('готово 2', NOW), { kind: 'done', target: '2' });
  assert.deepEqual(parseMessage('удали 3', NOW), { kind: 'delete', target: '3' });
});

test('помощь', () => {
  assert.equal(parseMessage('помощь', NOW).kind, 'help');
  assert.equal(parseMessage('что ты умеешь?', NOW).kind, 'help');
});

test('extractDate: «послезавтра», «через неделю», «20.07.2026»', () => {
  assert.equal(day(extractDate('послезавтра', NOW).when), '2026-07-08');
  assert.equal(day(extractDate('через неделю', NOW).when), '2026-07-13');
  assert.equal(day(extractDate('оплатить 20.07.2026', NOW).when), '2026-07-20');
});

test('extractDate: время «в 15:00» и «в 7 вечера»', () => {
  const a = extractDate('встреча в 15:00', NOW);
  assert.equal(a.hasTime, true);
  assert.equal(a.when.getHours(), 15);
  const b = extractDate('встреча в 7 вечера', NOW);
  assert.equal(b.when.getHours(), 19);
});

test('extractDate: сумма не путается со временем («долг в 5 000 руб»)', () => {
  const r = extractDate('долг в 5 000 руб', NOW);
  assert.equal(r.hasTime, false);
});

test('extractAmount: «50 000», «15к», «1,5 млн», «120 000 руб»', () => {
  assert.equal(extractAmount('должен 50 000').amount, 50000);
  assert.equal(extractAmount('верни 15к').amount, 15000);
  assert.equal(extractAmount('контракт на 1,5 млн').amount, 1500000);
  assert.equal(extractAmount('аванс 120 000 руб').amount, 120000);
});

test('extractAmount: маленькие числа без валюты игнорируются', () => {
  assert.equal(extractAmount('позвонить 2 раза').amount, null);
});

// Регрессии по итогам аудита (ветка test-optimization-test)

test('регрессия: два числа подряд не склеиваются в одно', () => {
  assert.equal(extractAmount('долг 50000 15000').amount, 50000);
});

test('регрессия: «Петров мне должен 30 тысяч» — имя не теряется', () => {
  const p = parseMessage('Петров мне должен 30 тысяч', NOW);
  assert.equal(p.entry.counterparty, 'Петров');
  assert.equal(p.entry.amount, 30000);
  assert.equal(p.entry.direction, 'in');
});

test('регрессия: «должен я Кузнецову 5000» — направление «вы должны»', () => {
  const p = parseMessage('должен я Кузнецову 5000', NOW);
  assert.equal(p.entry.direction, 'out');
  assert.equal(p.entry.counterparty, 'Кузнецову');
});

test('регрессия: «через месяц» с 31 января не перескакивает в март', () => {
  const jan31 = new Date(2026, 0, 31, 9, 0);
  assert.equal(day(extractDate('через месяц', jan31).when), '2026-02-28');
});

// --- Таймер/будильник: раньше падали в note из-за кириллицы + \b ---
test('таймер: «поставь мне таймер на 5 минут» → задача с временем', () => {
  const p = parseMessage('поставь мне таймер на 5 минут', NOW);
  assert.equal(p.kind, 'entry');
  assert.equal(p.entry.type, 'task');
  assert.equal(p.entry.hasTime, true);
});

test('будильник: «мне нужен будильник на завтра в 7 утра» → задача', () => {
  const p = parseMessage('мне нужен будильник на завтра в 7 утра', NOW);
  assert.equal(p.kind, 'entry');
  assert.equal(p.entry.type, 'task');
  assert.equal(p.entry.hasTime, true);
});

test('таймер в начале фразы всё ещё работает', () => {
  const p = parseMessage('таймер на 10 минут', NOW);
  assert.equal(p.entry.type, 'task');
});

// --- Долги «занял/одолжил»: раньше direction:in + counterparty:null ---
test('долг: «я занял у Пети 5000» → я должен (out), Петя', () => {
  const p = parseMessage('я занял у Пети 5000', NOW);
  assert.equal(p.entry.type, 'debt');
  assert.equal(p.entry.amount, 5000);
  assert.equal(p.entry.direction, 'out');
  assert.equal(p.entry.counterparty, 'Пети');
});

test('долг: «занял 3000 у Васи на неделю» (сумма перед «у») → out, Вася', () => {
  const p = parseMessage('занял 3000 у Васи на неделю', NOW);
  assert.equal(p.entry.type, 'debt');
  assert.equal(p.entry.amount, 3000);
  assert.equal(p.entry.direction, 'out');
  assert.equal(p.entry.counterparty, 'Васи');
});

test('долг: «я одолжил у Игоря 2000» → out, Игорь', () => {
  const p = parseMessage('я одолжил у Игоря 2000', NOW);
  assert.equal(p.entry.direction, 'out');
  assert.equal(p.entry.counterparty, 'Игоря');
});

test('долг: «одолжил Диме 5000» (дал в долг) → мне должны (in), Дима', () => {
  const p = parseMessage('одолжил Диме 5000', NOW);
  assert.equal(p.entry.type, 'debt');
  assert.equal(p.entry.direction, 'in');
  assert.equal(p.entry.counterparty, 'Диме');
});

test('долг: «одолжил денег другу 5000» → in, Друг', () => {
  const p = parseMessage('одолжил денег другу 5000', NOW);
  assert.equal(p.entry.direction, 'in');
  assert.equal(p.entry.counterparty, 'Другу');
});

test('регрессия: «Иванов должен 50000» по-прежнему in/Иванов', () => {
  const p = parseMessage('Иванов должен 50000', NOW);
  assert.equal(p.entry.direction, 'in');
  assert.equal(p.entry.counterparty, 'Иванов');
});

// --- Порядок слов в долгах (находка spec-ревью) ---
test('долг: «я занял 5000» без имени → всё равно out (я взял в долг)', () => {
  const p = parseMessage('я занял 5000', NOW);
  assert.equal(p.entry.type, 'debt');
  assert.equal(p.entry.direction, 'out');
  assert.equal(p.entry.counterparty, null);
});

test('долг: «Дима одолжил мне 5000» (имя ПЕРЕД глаголом) → out, Дима', () => {
  const p = parseMessage('Дима одолжил мне 5000', NOW);
  assert.equal(p.entry.direction, 'out'); // Дима дал мне → я должен Диме
  assert.equal(p.entry.counterparty, 'Дима');
});

test('долг: «Петя занял у меня 5000» → in, Петя (а не контрагент «Меня»)', () => {
  const p = parseMessage('Петя занял у меня 5000', NOW);
  assert.equal(p.entry.direction, 'in'); // Петя взял у меня → должен мне
  assert.equal(p.entry.counterparty, 'Петя');
});
