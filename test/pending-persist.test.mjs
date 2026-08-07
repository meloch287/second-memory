// Незавершённый сценарий ЛК должен пережить рестарт бота.
// Живой случай: человек нажал «Добавить в вишлист», бот попросил ссылку, в этот
// момент прошёл деплой - и присланная ссылка ушла в болтовню, потому что
// pending жил в памяти процесса.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { persistentPending } from '../src/pending.mjs';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'sm-pend-')), 'm.json');

test('сценарий читается новым процессом из того же файла', () => {
  const f = tmpFile();
  const a = new Store(f);
  persistentPending(a, 'lk').set('750201677', { mode: 'wish_add_url' });
  a.flush();

  const b = new Store(f); // «рестарт»
  assert.deepEqual(persistentPending(b, 'lk').get('750201677'), { mode: 'wish_add_url' });
  assert.equal(persistentPending(b, 'lk').has('750201677'), true);
});

test('пространства имён не пересекаются', () => {
  const s = new Store(tmpFile());
  persistentPending(s, 'lk').set('1', { mode: 'add' });
  persistentPending(s, 'fitness').set('1', { mode: 'fit_weight' });
  assert.deepEqual(persistentPending(s, 'lk').get('1'), { mode: 'add' });
  assert.deepEqual(persistentPending(s, 'fitness').get('1'), { mode: 'fit_weight' });
  assert.equal(persistentPending(s, 'calendar').get('1'), undefined);
});

test('delete убирает сценарий и сообщает, был ли он', () => {
  const s = new Store(tmpFile());
  const p = persistentPending(s, 'lk');
  p.set('5', { mode: 'edit', id: 3 });
  assert.equal(p.delete('5'), true);
  assert.equal(p.delete('5'), false);
  assert.equal(p.has('5'), false);
});

test('брошенный сутки назад сценарий не оживает', () => {
  const s = new Store(tmpFile());
  const p = persistentPending(s, 'lk');
  p.set('9', { mode: 'add' });
  // руками состариваем запись
  s.data.meta.pending.lk['9'].ts = Date.now() - 25 * 60 * 60 * 1000;
  assert.equal(p.get('9'), undefined);
  assert.equal('9' in s.data.meta.pending.lk, false, 'протухшее чистится сразу');
});

test('числовой и строковый chatId - один и тот же чат', () => {
  const s = new Store(tmpFile());
  const p = persistentPending(s, 'lk');
  p.set(750201677, { mode: 'add' });
  assert.deepEqual(p.get('750201677'), { mode: 'add' });
});

test('битые данные в meta не роняют бота', () => {
  const s = new Store(tmpFile());
  s.data.meta.pending = 'мусор';
  const p = persistentPending(s, 'lk');
  assert.equal(p.get('1'), undefined);
  p.set('1', { mode: 'add' });
  assert.deepEqual(p.get('1'), { mode: 'add' });
});
