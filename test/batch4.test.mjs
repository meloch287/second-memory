import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { parseMessage, parsePoll } from '../src/parser.mjs';
import { monthCategorySpent, budgetsReport } from '../src/finance.mjs';

delete process.env.SM_ENCRYPTION_KEY;
const NOW = new Date('2026-07-07T09:00:00.000Z');
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'sm-b4-')), 'memory.json');

/* №4 Опросы */
test('parsePoll: вопрос и варианты', () => {
  const p1 = parseMessage('устрой опрос: пицца или суши', NOW);
  assert.equal(p1.kind, 'poll');
  assert.deepEqual(p1.options, ['пицца', 'суши']);

  const p2 = parseMessage('опрос: куда едем? Сочи, Питер, Казань', NOW);
  assert.equal(p2.kind, 'poll');
  assert.equal(p2.question, 'куда едем?');
  assert.deepEqual(p2.options, ['Сочи', 'Питер', 'Казань']);

  assert.equal(parseMessage('опрос без вариантов', NOW).kind === 'poll', false, 'один вариант - не опрос');
  // «или» внутри слова не режет
  const p3 = parsePoll('опрос: Илиада или Одиссея', 'опрос: илиада или одиссея');
  assert.deepEqual(p3.options, ['Илиада', 'Одиссея']);
});

/* №2 Сплит */
test('parser: сплит-вопросы уходят в split', () => {
  assert.equal(parseMessage('кто сколько скинул на подарок?', NOW).kind, 'split');
  assert.equal(parseMessage('кто не сдал на подарок', NOW).kind, 'split');
  assert.equal(parseMessage('раздели 6000 на троих', NOW).kind, 'split');
  // обычные фразы не попадают
  assert.notEqual(parseMessage('я скинул документы на почту', NOW).kind, 'split');
});

/* №8 Бюджеты */
test('parser: бюджет на категорию', () => {
  const b = parseMessage('бюджет на кофе 5000', NOW);
  assert.equal(b.kind, 'setbudget');
  assert.equal(b.category, 'Кофе');
  assert.equal(b.amount, 5000);
  assert.equal(parseMessage('лимит на такси 3 000 в месяц', NOW).amount, 3000);
  assert.equal(parseMessage('бюджеты', NOW).kind, 'budgets');
});

test('monthCategorySpent и budgetsReport', () => {
  const s = new Store(tmpFile());
  const now = Date.parse('2026-07-15T12:00:00Z');
  s.setUser('1', { budgets: { Кофе: 1000 } });
  s.add({ type: 'expense', category: 'Кофе', amount: 300, chatId: '1', createdAt: '2026-07-05T10:00:00Z', status: 'done' });
  s.add({ type: 'expense', category: 'кофе', amount: 550, chatId: '1', createdAt: '2026-07-10T10:00:00Z', status: 'done' });
  s.add({ type: 'expense', category: 'Кофе', amount: 999, chatId: '1', createdAt: '2026-06-01T10:00:00Z', status: 'done' }); // прошлый месяц
  s.add({ type: 'expense', category: 'Кофе', amount: 5000, chatId: '2', createdAt: '2026-07-05T10:00:00Z', status: 'done' }); // чужой
  assert.equal(monthCategorySpent(s, '1', 'Кофе', 180, now), 850, 'регистр и месяц учтены, чужое нет');
  const rep = budgetsReport(s, '1', 180, now);
  assert.match(rep, /🟡/, '85% - жёлтая зона');
  assert.match(rep, /850/);
  assert.match(budgetsReport(s, '2', 180, now), /Бюджетов пока нет/);
});
