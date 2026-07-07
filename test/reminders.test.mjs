import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMessage } from '../src/parser.mjs';
import { captureEntry } from '../src/brain.mjs';
import { Store } from '../src/store.mjs';

delete process.env.SM_ENCRYPTION_KEY;
const store = () => new Store(join(mkdtempSync(join(tmpdir(), 'sm-rem-')), 'm.json'));
const NOW = new Date('2026-07-07T06:00:00Z'); // 09:00 МСК
const wallH = (iso) => new Date(new Date(iso).getTime() + 180 * 60000).getUTCHours();

test('таймеры и относительное время', () => {
  const s = store();
  const cases = [
    ['напомни через 10 минут', 10], ['напомни через 2 часа', 120], ['напомни через час', 60],
    ['напомни через полчаса', 30], ['поставь таймер на 5 минут', 5], ['таймер на 15 минут', 15],
    ['засеки 20 минут', 20], ['засеки на час', 60], ['поставь будильник на 7 утра', null],
  ];
  for (const [t, mins] of cases) {
    const e = captureEntry(s, t, NOW, '1', 180);
    assert.ok(e && e.hasTime, `${t}: время должно извлечься`);
    if (mins != null) {
      const got = Math.round((Date.parse(e.due) - NOW.getTime()) / 60000);
      assert.equal(got, mins, `${t}: смещение +${mins}мин`);
    }
  }
});

test('roll-forward: прошедшее время не в прошлом', () => {
  const s = store();
  assert.equal(wallH(captureEntry(s, 'напомни в 4 позвонить', NOW, '1', 180).due), 16, 'в 4 в 9 утра -> 16:00');
  assert.equal(wallH(captureEntry(s, 'напомни к 5 позвонить', NOW, '1', 180).due), 17);
  assert.equal(wallH(captureEntry(s, 'напомни в 11 ночи', NOW, '1', 180).due), 23);
  // ни одно напоминание не в прошлом
  for (const t of ['напомни в 4', 'напомни в 7', 'напомни в 8 утра', 'напомни в 5']) {
    const e = captureEntry(s, t, NOW, '1', 180);
    assert.ok(Date.parse(e.due) > NOW.getTime(), `${t}: не в прошлом`);
  }
});

test('дата-напоминание без времени получает полдень', () => {
  const s = store();
  const e = captureEntry(s, 'напомни завтра оплатить счёт', NOW, '1', 180);
  assert.ok(e.hasTime, 'hasTime после дефолта');
  assert.equal(wallH(e.due), 12, 'полдень');
});

test('долговые вопросы -> запрос, не запись', () => {
  const N = NOW;
  for (const q of ['кто мне должен', 'кто должен денег', 'кому я должен', 'у кого горит долг', 'кто должен']) {
    const k = parseMessage(q, N).kind;
    assert.notEqual(k, 'entry', `${q}: не должно создавать запись (kind=${k})`);
  }
});

test('трата с временем: цифры времени не в сумме', () => {
  const p = parseMessage('потратил 500 на кофе в 16:00', NOW);
  assert.equal(p.kind, 'expense');
  assert.equal(p.amount, 500);
});
