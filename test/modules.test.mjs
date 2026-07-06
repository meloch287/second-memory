import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { isDuplicateEntry } from '../src/worker.mjs';
import { morningHour, eveningHour, todayEvents } from '../src/scheduler.mjs';
import { extractDocxText } from '../src/docx.mjs';

const NOW = new Date(2026, 6, 6, 9, 0);

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'sm-mod-'));
  return new Store(join(dir, 'memory.json'));
}

test('векторный поиск: скалярное произведение ранжирует факты', () => {
  const s = freshStore();
  s.addFacts([
    { chatId: '1', text: 'про собаку', embedding: [1, 0, 0] },
    { chatId: '1', text: 'про работу', embedding: [0, 1, 0] },
    { chatId: '2', text: 'чужой чат', embedding: [1, 0, 0] },
    { chatId: '1', text: 'без вектора' },
  ]);
  assert.equal(s.hasEmbeddings('1'), true);
  const hits = s.factsByVector('1', [0.9, 0.1, 0], 5);
  assert.equal(hits[0].text, 'про собаку');
  assert.ok(!hits.some((f) => f.text === 'чужой чат'), 'изоляция чатов');
});

test('дедуп ИИ-записей: сумма или похожее название', () => {
  const existing = [{ type: 'debt', title: 'Долг: Петров', counterparty: 'Петров', amount: 30000 }];
  assert.equal(isDuplicateEntry({ type: 'debt', title: 'Долг Петрову', amount: 30000 }, existing), true);
  assert.equal(isDuplicateEntry({ type: 'debt', title: 'Долг: Петров', amount: null }, existing), true);
  assert.equal(isDuplicateEntry({ type: 'debt', title: 'Долг: Сидоров', counterparty: 'Сидоров', amount: 5000 }, existing), false);
  assert.equal(isDuplicateEntry({ type: 'task', title: 'Долг: Петров' }, existing), false, 'другой тип - не дубль');
});

test('часы пингов подстраиваются под ритм', () => {
  assert.equal(morningHour('жаворонок'), 8);
  assert.equal(morningHour('я сова'), 11);
  assert.equal(morningHour(null), 9);
  assert.equal(eveningHour('жаворонок'), 21);
  assert.equal(eveningHour('сова'), 22);
});

test('todayEvents: сегодняшние дела и просроченные долги, только свои', () => {
  const s = freshStore();
  const today = new Date(2026, 6, 6, 15, 0).toISOString();
  const past = new Date(2026, 6, 1).toISOString();
  s.add({ type: 'meeting', title: 'Созвон', due: today, hasTime: true, chatId: '42' });
  s.add({ type: 'debt', title: 'Долг: Ромашка', counterparty: 'Ромашка', amount: 120000, due: past, chatId: '42' });
  s.add({ type: 'task', title: 'Чужое дело', due: today, chatId: '99' });
  const lines = todayEvents(s, '42', NOW);
  assert.equal(lines.length, 2);
  assert.ok(lines.some((l) => l.includes('Созвон')));
  assert.ok(lines.some((l) => l.includes('просрочен') && l.includes('Ромашка')));
});

test('docx: извлекаем текст без зависимостей', () => {
  const buf = readFileSync(new URL('./fixtures/sample.docx', import.meta.url));
  const text = extractDocxText(buf);
  assert.ok(text.includes('Договор с Ромашкой'));
  assert.ok(text.includes('120 000'));
});

test('бэкап данных создаётся и ротация не падает', () => {
  const s = freshStore();
  s.add({ type: 'note', title: 'тест', text: 'тест' });
  const path = s.backup();
  assert.ok(path && path.includes('backups'));
  assert.ok(readFileSync(path, 'utf8').includes('тест'));
});
