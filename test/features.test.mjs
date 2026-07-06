import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { parseMessage, parseRecurring, parseEdit, parseSearch } from '../src/parser.mjs';
import { captureEntry } from '../src/brain.mjs';
import { parseTz, resolveWallDate, userDayBounds, fmtUser, DEFAULT_OFFSET } from '../src/tz.mjs';
import { buildIcs } from '../src/ics.mjs';
import { recurringDue, todayEvents, morningHour } from '../src/scheduler.mjs';

const NOW = new Date('2026-07-06T09:00:00.000Z'); // 06.07 12:00 МСК
function freshStore() {
  return new Store(join(mkdtempSync(join(tmpdir(), 'sm-feat-')), 'memory.json'));
}

/* --- №3 Часовой пояс --- */
test('parseTz: города и сдвиги', () => {
  assert.equal(parseTz('Москва'), 180);
  assert.equal(parseTz('новосибирск'), 420);
  assert.equal(parseTz('екб'), 300);
  assert.equal(parseTz('+3'), 180);
  assert.equal(parseTz('мск+2'), 300);
  assert.equal(parseTz('utc-5'), -300);
  assert.equal(parseTz('бла бла'), null);
});

test('resolveWallDate: «в 15:00» считается в поясе пользователя', () => {
  // Новосибирск = +420. «сегодня в 15:00» = 15:00 по Новосибу = 08:00 UTC
  const r = resolveWallDate(420, 'напомни в 15:00 позвонить', NOW);
  assert.ok(r.due);
  assert.equal(r.hasTime, true);
  const d = new Date(r.due);
  assert.equal(d.getUTCHours(), 8); // 15 - 7 = 8 UTC
  // Москва = +180: 15:00 МСК = 12:00 UTC
  const rm = resolveWallDate(180, 'напомни в 15:00 позвонить', NOW);
  assert.equal(new Date(rm.due).getUTCHours(), 12);
});

test('userDayBounds: сутки в поясе пользователя', () => {
  const b = userDayBounds({ tzOffset: 180 }, NOW);
  // московская полночь 06.07 = 05.07 21:00 UTC
  assert.equal(new Date(b.start).getUTCHours(), 21);
  assert.equal(b.end - b.start, 86400000);
});

test('captureEntry учитывает часовой пояс', () => {
  const s = freshStore();
  const e = captureEntry(s, 'напомни в 15:00 позвонить маме', NOW, '1', 420);
  assert.equal(e.type, 'task');
  assert.equal(new Date(e.due).getUTCHours(), 8); // 15:00 Новосиб
});

/* --- №4 Повторы --- */
test('parseRecurring: неделя / день / месяц', () => {
  assert.deepEqual(parseRecurring('каждый понедельник созвон в 10:00', 'каждый понедельник созвон в 10:00').rule, {
    kind: 'weekly', weekday: 1, hour: 10, min: 0,
  });
  assert.deepEqual(parseRecurring('каждый день зарядка в 8', 'каждый день зарядка в 8').rule, {
    kind: 'daily', hour: 8, min: 0,
  });
  assert.deepEqual(parseRecurring('каждый месяц 5 числа оплата', 'каждый месяц 5 числа оплата').rule, {
    kind: 'monthly', day: 5, hour: 9, min: 0,
  });
});

test('recurringDue: срабатывает в нужную минуту и не дважды в день', () => {
  const rule = { kind: 'weekly', weekday: 1, hour: 10, min: 0 }; // понедельник 10:00
  const mon10 = new Date(Date.UTC(2026, 6, 6, 10, 0)); // 06.07.2026 - понедельник
  assert.equal(recurringDue(rule, mon10, null, '2026-07-06'), true);
  assert.equal(recurringDue(rule, mon10, '2026-07-06', '2026-07-06'), false, 'уже сработало сегодня');
  const tue10 = new Date(Date.UTC(2026, 6, 7, 10, 0)); // вторник
  assert.equal(recurringDue(rule, tue10, null, '2026-07-07'), false, 'не тот день недели');
  const mon11 = new Date(Date.UTC(2026, 6, 6, 11, 0));
  assert.equal(recurringDue(rule, mon11, null, '2026-07-06'), false, 'не то время');
});

/* --- №5 Правки --- */
test('parseEdit: перенос и отмена', () => {
  const r = parseEdit('перенеси встречу с клиентом на 16:00', 'перенеси встречу с клиентом на 16:00', NOW);
  assert.equal(r.op, 'reschedule');
  assert.equal(r.target, 'встречу с клиентом');
  const c = parseEdit('отмени звонок маме', 'отмени звонок маме', NOW);
  assert.equal(c.op, 'cancel');
  assert.equal(c.target, 'звонок маме');
});

test('findEntry: нечёткий поиск своей записи', () => {
  const s = freshStore();
  s.add({ type: 'meeting', title: 'Встреча с клиентом', chatId: '1', due: NOW.toISOString() });
  s.add({ type: 'task', title: 'Позвонить маме', chatId: '1' });
  s.add({ type: 'meeting', title: 'Чужая встреча', chatId: '2' });
  assert.equal(s.findEntry('1', 'встреча с клиентом').title, 'Встреча с клиентом');
  assert.equal(s.findEntry('1', 'позвонить маме').title, 'Позвонить маме');
  // слово из чужой записи не должно возвращать её пользователю 1
  assert.equal(s.findEntry('1', 'чужая'), null, 'чужое не находит');
  assert.equal(s.findEntry('2', 'чужая').title, 'Чужая встреча', 'своё находит');
});

/* --- №7 Календарь --- */
test('buildIcs: валидный VCALENDAR с событиями', () => {
  const ics = buildIcs(
    [{ id: 1, type: 'meeting', title: 'Созвон', due: '2026-07-07T09:00:00.000Z' }],
    '2026-07-06T09:00:00.000Z'
  );
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /SUMMARY:Созвон/);
  assert.match(ics, /DTSTART:20260707T090000Z/);
  assert.match(ics, /END:VCALENDAR/);
});

test('parseMessage: календарь-намерение', () => {
  assert.equal(parseMessage('скинь в календарь', NOW).kind, 'calendar');
  assert.equal(parseMessage('расписание в календарь телефона', NOW).kind, 'calendar');
});

/* --- №8 Поиск --- */
test('parseSearch: извлекает запрос, не ломает расписание', () => {
  assert.equal(parseSearch('что я говорил про Петрова', 'что я говорил про петрова').query, 'Петрова');
  assert.equal(parseSearch('найди про отпуск', 'найди про отпуск').query, 'отпуск');
  assert.equal(parseSearch('вспомни про машину', 'вспомни про машину').query, 'машину');
  assert.equal(parseSearch('что у меня завтра', 'что у меня завтра'), null, 'расписание - не поиск');
});

/* --- №1 + №9 напоминания и просрочка --- */
test('dueReminders: только со временем, в окне, не напомненные', () => {
  const s = freshStore();
  const now = Date.parse('2026-07-06T12:00:00.000Z');
  s.add({ type: 'task', title: 'Пора', chatId: '1', hasTime: true, due: '2026-07-06T11:59:00.000Z' });
  s.add({ type: 'task', title: 'Рано', chatId: '1', hasTime: true, due: '2026-07-06T18:00:00.000Z' });
  s.add({ type: 'task', title: 'Без времени', chatId: '1', hasTime: false, due: '2026-07-06T11:59:00.000Z' });
  s.add({ type: 'task', title: 'Уже напомнено', chatId: '1', hasTime: true, reminded: true, due: '2026-07-06T11:59:00.000Z' });
  const due = s.dueReminders('1', now);
  assert.equal(due.length, 1);
  assert.equal(due[0].title, 'Пора');
});

test('overdue: просроченные дела, только свои', () => {
  const s = freshStore();
  const now = Date.parse('2026-07-06T12:00:00.000Z');
  s.add({ type: 'task', title: 'Старое', chatId: '1', due: '2026-07-01T10:00:00.000Z' });
  s.add({ type: 'task', title: 'Будущее', chatId: '1', due: '2026-07-10T10:00:00.000Z' });
  s.add({ type: 'task', title: 'Чужое старое', chatId: '2', due: '2026-07-01T10:00:00.000Z' });
  const od = s.overdue('1', now);
  assert.equal(od.length, 1);
  assert.equal(od[0].title, 'Старое');
});
