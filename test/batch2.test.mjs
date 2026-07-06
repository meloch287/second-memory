import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { parseMessage } from '../src/parser.mjs';
import { balanceReport } from '../src/finance.mjs';
import { toCsv, toJson, toMarkdown } from '../src/export.mjs';
import { weatherLine } from '../src/weather.mjs';

function freshStore() {
  return new Store(join(mkdtempSync(join(tmpdir(), 'sm-b2-')), 'memory.json'));
}
const NOW = new Date('2026-07-06T09:00:00.000Z');

/* №2 lead-напоминания */
test('dueReminders с lead: срабатывает за N минут до срока', () => {
  const s = freshStore();
  const now = Date.parse('2026-07-06T12:00:00.000Z');
  s.add({ type: 'meeting', title: 'Созвон', chatId: '1', hasTime: true, due: '2026-07-06T12:10:00.000Z' }); // через 10 мин
  s.add({ type: 'meeting', title: 'Позже', chatId: '1', hasTime: true, due: '2026-07-06T13:00:00.000Z' }); // через час
  assert.equal(s.dueReminders('1', now, 0).length, 0, 'без lead ещё рано');
  const withLead = s.dueReminders('1', now, 15);
  assert.equal(withLead.length, 1, 'за 15 мин ловит созвон через 10 мин');
  assert.equal(withLead[0].title, 'Созвон');
});

test('parser: setlead / setcity / settings / balance / export', () => {
  assert.deepEqual(parseMessage('напоминай за 30 минут', NOW), { kind: 'setlead', minutes: 30 });
  assert.equal(parseMessage('мой город Казань', NOW).kind, 'setcity');
  assert.equal(parseMessage('мой город Казань', NOW).city, 'Казань');
  assert.equal(parseMessage('настройки', NOW).kind, 'settings');
  assert.equal(parseMessage('баланс', NOW).kind, 'balance');
  assert.equal(parseMessage('экспорт', NOW).kind, 'export');
  assert.equal(parseMessage('часовой пояс +5', NOW).kind, 'settz');
  // не ломаем обычную запись
  assert.equal(parseMessage('напомни оплатить счёт через 3 дня', NOW).kind, 'entry');
});

test('parser: команды-настройки не перехватывают дневниковые фразы', () => {
  // дневниковые предложения, начинающиеся похоже, НЕ должны стать командами
  assert.notEqual(parseMessage('баланс на работе совсем расшатался, устал', NOW).kind, 'balance');
  assert.notEqual(parseMessage('выгрузи мне идей на завтра штук пять', NOW).kind, 'export');
  assert.notEqual(parseMessage('настройки станка сбились на заводе', NOW).kind, 'settings');
  assert.notEqual(parseMessage('мой город засыпает, а я всё думаю о делах', NOW).kind, 'setcity');
  assert.notEqual(parseMessage('часовой пояс постоянно мешает созвонам на -5 часов разницы', NOW).kind, 'settz');
  // но сами команды - срабатывают
  assert.equal(parseMessage('баланс', NOW).kind, 'balance');
  assert.equal(parseMessage('покажи баланс', NOW).kind, 'balance');
  assert.equal(parseMessage('мой город Санкт-Петербург', NOW).kind, 'setcity');
  assert.equal(parseMessage('мой город Санкт-Петербург', NOW).city, 'Санкт-Петербург');
});

test('toCsv: обезвреживает формулы Excel', () => {
  const s = freshStore();
  s.add({ type: 'note', title: '=СУММ(A1:A9)', chatId: '1' });
  s.add({ type: 'note', title: '+79001234567', chatId: '1' });
  const csv = toCsv(s, '1');
  assert.ok(!/;=СУММ/.test(csv) && /'=СУММ/.test(csv), 'формула обезврежена апострофом');
  assert.ok(/'\+79001234567/.test(csv), 'плюс-номер обезврежен');
  assert.equal(toCsv(s, ''), '﻿id;тип;название', 'пустой chatId - не выгружает всех');
});

/* №6 финсводка */
test('balanceReport: считает баланс, крупнейшего должника, просрочку', () => {
  const s = freshStore();
  s.add({ type: 'debt', counterparty: 'Иванов', amount: 50000, direction: 'in', chatId: '1', due: '2026-07-01T00:00:00.000Z' });
  s.add({ type: 'debt', counterparty: 'Петров', amount: 120000, direction: 'in', chatId: '1' });
  s.add({ type: 'debt', counterparty: 'Банк', amount: 30000, direction: 'out', chatId: '1' });
  const r = balanceReport(s, '1', 180, Date.parse('2026-07-06T00:00:00.000Z'));
  assert.match(r, /Тебе должны: 170.000/);
  assert.match(r, /Ты должен: 30.000/);
  assert.match(r, /в твою пользу: \+140.000/);
  assert.match(r, /Больше всех должен: Петров/);
  assert.match(r, /Просрочено \(1\)/);
  assert.match(r, /Иванов/);
});

test('balanceReport: пусто - дружелюбно', () => {
  const s = freshStore();
  assert.match(balanceReport(s, '1'), /Долгов нет/);
});

/* №11 экспорт */
test('toCsv: BOM, заголовки, строки только свои', () => {
  const s = freshStore();
  s.add({ type: 'debt', counterparty: 'Иванов', amount: 50000, direction: 'in', chatId: '1', title: 'Долг: Иванов' });
  s.add({ type: 'note', title: 'Чужое', chatId: '2' });
  const csv = toCsv(s, '1');
  assert.ok(csv.startsWith('﻿'), 'BOM для Excel');
  assert.match(csv, /id;тип;название/);
  assert.match(csv, /Иванов;50000;должны нам/);
  assert.ok(!csv.includes('Чужое'), 'чужие строки не попадают');
});

test('toJson: срез пользователя без embeddings', () => {
  const s = freshStore();
  s.setUser('1', { name: 'Саня' });
  s.addFacts([{ chatId: '1', text: 'факт', embedding: [1, 2, 3] }]);
  const j = JSON.parse(toJson(s, '1'));
  assert.equal(j.user.name, 'Саня');
  assert.equal(j.facts.length, 1);
  assert.equal(j.facts[0].embedding, undefined, 'вектора не выгружаем');
});

test('toMarkdown: дневник по дням', () => {
  const s = freshStore();
  s.addRaw('1', 'Сегодня был тяжёлый день');
  s.add({ type: 'meeting', title: 'Созвон', chatId: '1', due: NOW.toISOString() });
  const md = toMarkdown(s, '1');
  assert.match(md, /# Моя вторая память/);
  assert.match(md, /Сегодня был тяжёлый день/);
  assert.match(md, /Созвон/);
});

/* №5 погода: форматирование строки */
test('weatherLine: температура, осадки, совет', () => {
  assert.equal(weatherLine(null), null);
  const l = weatherLine({ tmax: 18, tmin: 11, precip: 70, desc: 'дождь', advice: 'возьми зонт', city: 'Москва' });
  assert.match(l, /Москва/);
  assert.match(l, /18°/);
  assert.match(l, /дождь/);
  assert.match(l, /Возьми зонт/);
});
