// ICS: сборка фида (buildIcs) и разбор импорта (parseIcs), включая roundtrip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs, parseIcs } from '../src/ics.mjs';

test('buildIcs: валидный VCALENDAR с событиями', () => {
  const ics = buildIcs([{ id: 1, type: 'meeting', title: 'Встреча с Аней', due: '2026-08-15T13:00:00.000Z' }], '2026-08-01T00:00:00.000Z');
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /SUMMARY:Встреча с Аней/);
  assert.match(ics, /DTSTART:20260815T130000Z/);
});

test('parseIcs: достаёт события с датой и временем', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'SUMMARY:Днюха Пети', 'DTSTART:20260815T160000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:Отпуск', 'DTSTART;VALUE=DATE:20260901', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const evs = parseIcs(ics);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].title, 'Днюха Пети');
  assert.equal(evs[0].hasTime, true);
  assert.match(evs[0].due, /2026-08-15T16:00/);
  assert.equal(evs[1].title, 'Отпуск');
  assert.equal(evs[1].hasTime, false, 'VALUE=DATE -> без времени');
});

test('parseIcs: разворачивает сложенные строки (RFC folding) и escape', () => {
  const ics = 'BEGIN:VEVENT\r\nSUMMARY:Очень длинное\r\n  название встречи\r\nDTSTART:20260101T090000Z\r\nEND:VEVENT';
  const evs = parseIcs(ics);
  assert.equal(evs.length, 1);
  assert.match(evs[0].title, /Очень длинное название встречи/);
});

test('parseIcs: мусор -> пустой массив, без throw', () => {
  assert.deepEqual(parseIcs('не календарь вовсе'), []);
  assert.deepEqual(parseIcs(''), []);
});

test('roundtrip: buildIcs -> parseIcs сохраняет заголовок и время', () => {
  const ics = buildIcs([{ id: 7, type: 'meeting', title: 'Созвон', due: '2026-07-20T15:30:00.000Z' }], '2026-07-01T00:00:00.000Z');
  const evs = parseIcs(ics);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].title, 'Созвон');
  assert.match(evs[0].due, /2026-07-20T15:30/);
});
