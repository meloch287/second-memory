// Store: дебаунс/flush записи, migrateChat (перенос при tg-link) и wipeMemory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';

delete process.env.SM_ENCRYPTION_KEY;
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'sm-store-')), 'm.json');

test('save() дебаунсит: файл не пишется сразу, flush() дописывает', () => {
  const file = tmpFile();
  const s = new Store(file);
  s.add({ type: 'note', title: 'привет', chatId: '1' });
  assert.equal(existsSync(file), false, 'сразу после мутации на диск ещё не записано');
  s.flush();
  assert.ok(existsSync(file), 'после flush файл есть');
  assert.ok(readFileSync(file, 'utf8').includes('привет'), 'данные записаны');
  // повторный flush без изменений — no-op, не падает
  s.flush();
});

test('flush(): сбой записи не роняет процесс и не теряет данные (dirty остаётся)', () => {
  const s = new Store(tmpFile());
  s.add({ type: 'note', title: 'важное', chatId: '1' });
  const realWrite = s._writeNow.bind(s);
  let calls = 0;
  s._writeNow = () => { calls++; throw new Error('EACCES симуляция'); };
  assert.doesNotThrow(() => s.flush(), 'flush не бросает наружу');
  assert.equal(s._dirty, true, 'данные остаются dirty после сбоя (не потеряны)');
  assert.ok(calls >= 1, 'попытка записи была');
  // восстановление: запись снова работает -> flush дописывает
  s._writeNow = realWrite;
  s.flush();
  assert.equal(s._dirty, false, 'после успешной записи dirty сброшен');
  const b = new Store(s.file);
  assert.equal(b.list({ chatId: '1' })[0]?.title, 'важное', 'данные дошли до диска');
  if (s._saveTimer) clearTimeout(s._saveTimer);
});

test('flush() переживает перезагрузку: данные видны новому Store', () => {
  const file = tmpFile();
  const a = new Store(file);
  a.add({ type: 'task', title: 'дело', chatId: '1' });
  a.setUser('1', { name: 'Саня' });
  a.flush();
  const b = new Store(file);
  assert.equal(b.list({ chatId: '1' }).length, 1);
  assert.equal(b.getUser('1')?.name, 'Саня');
});

test('migrateChat: переносит ВСЮ память from -> to, ничего не теряя и не дублируя', () => {
  const s = new Store(tmpFile());
  s.add({ chatId: 'web', type: 'debt', counterparty: 'Дима', amount: 5000, direction: 'in' });
  s.add({ chatId: 'web', type: 'task', title: 'зал' });
  s.add({ chatId: 'tg-other', type: 'note', title: 'чужое' }); // не должно тронуться
  s.addFacts([{ chatId: 'web', text: 'ф1' }, { chatId: 'web', text: 'ф2' }, { chatId: 'tg-other', text: 'чужой факт' }]);
  s.addRaw('web', 'сырьё');
  s.pushHistory('user', 'привет', 'web');
  s.addRecurring({ chatId: 'web', title: 'вода', kind: 'daily', hour: 9, min: 0 });
  s.setPersonas?.('web', { Дима: 'друг' });

  const n = s.migrateChat('web', '999');
  assert.equal(n, 4, 'вернул число перенесённых записей+фактов (2 записи + 2 факта)');
  assert.equal(s.list({ chatId: 'web' }).length, 0, 'в web записей не осталось');
  assert.equal(s.list({ chatId: '999' }).length, 2, 'обе записи переехали');
  assert.equal(s.data.facts.filter((f) => f.chatId === '999').length, 2);
  assert.equal(s.data.raw.filter((r) => r.chatId === '999').length, 1, 'сырьё переехало');
  assert.equal(s.recentHistory(10, '999').length, 1, 'история переехала');
  assert.equal(s.recurringFor('999').length, 1, 'повторяющееся переехало');
  // чужой чат не тронут
  assert.equal(s.list({ chatId: 'tg-other' }).length, 1);
  assert.equal(s.data.facts.filter((f) => f.chatId === 'tg-other').length, 1);
  // самоперенос — no-op
  assert.equal(s.migrateChat('999', '999'), 0);
});

test('wipeMemory: стирает память чата, профиль оставляет, чужое не трогает', () => {
  const s = new Store(tmpFile());
  s.setUser('1', { name: 'Саня' });
  s.add({ chatId: '1', type: 'task', title: 'дело' });
  s.addFacts([{ chatId: '1', text: 'ф' }, { chatId: '2', text: 'чужой' }]);
  s.addRaw('1', 'сырьё');
  s.pushHistory('user', 'хай', '1');
  s.addRecurring({ chatId: '1', title: 'вода', kind: 'daily', hour: 9, min: 0 });

  const r = s.wipeMemory('1');
  assert.deepEqual(r, { facts: 1, entries: 1 });
  assert.equal(s.list({ chatId: '1' }).length, 0);
  assert.equal(s.data.facts.filter((f) => f.chatId === '1').length, 0);
  assert.equal(s.data.raw.filter((x) => x.chatId === '1').length, 0, 'сырьё тоже стёрто (worker не пересоберёт)');
  assert.equal(s.recentHistory(10, '1').length, 0);
  assert.equal(s.recurringFor('1').length, 0);
  assert.equal(s.getUser('1')?.name, 'Саня', 'профиль пользователя сохранён');
  assert.equal(s.data.facts.filter((f) => f.chatId === '2').length, 1, 'чужой чат не тронут');
});
