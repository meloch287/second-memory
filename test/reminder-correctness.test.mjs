// U2 — корректность напоминаний (репортнутый баг): «напомни мне 29 июля, что
// мне должно прийти 95к по зп» ассистент (а) проигнорировал дату 29 июля и
// напомнил через ~3 дня, и (б) записал это как ДОЛГ пользователя. Оба — баги.
//
// 1) «напомни/переспроси» всегда побеждает классификацию долга.
// 2) «должно прийти/поступить» (ожидание дохода) — это не долг.
// 3) Напоминание с датой в будущем срабатывает РОВНО в день срока (не раньше,
//    не позже), без дублей — проверяем через реальный scheduler + bot-шпион.
// 4) Интервальные напоминания («через N минут/часов/дней») получают точный due.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMessage } from '../src/parser.mjs';
import { captureEntry } from '../src/brain.mjs';
import { Store } from '../src/store.mjs';
import { startScheduler } from '../src/scheduler.mjs';

delete process.env.SM_ENCRYPTION_KEY;

const NOW = new Date(2026, 6, 6, 9, 0); // понедельник, 6 июля 2026, 09:00 (МСК = local в тестовом окружении)

function freshStore() {
  return new Store(join(mkdtempSync(join(tmpdir(), 'sm-remcorr-')), 'm.json'));
}

// --- bot-шпион и подмена «текущего времени» для scheduler.tick(), которая
// сама внутри делает `new Date()` без аргументов и не принимает now извне ---
function spyBot() {
  const sent = [];
  return {
    sent,
    sendButtons: async (chatId, text) => { sent.push({ m: 'buttons', chatId: String(chatId), text }); },
    sendText: async (chatId, text) => { sent.push({ m: 'text', chatId: String(chatId), text }); },
    sendHtml: async (chatId, text) => { sent.push({ m: 'html', chatId: String(chatId), text }); },
  };
}
const to = (bot, cid) => bot.sent.filter((s) => s.chatId === String(cid));

async function withFakeNow(fakeMs, fn) {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fakeMs);
      else super(...args);
    }
    static now() {
      return fakeMs;
    }
  }
  globalThis.Date = FakeDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

// --- 1) «напомни» ВСЕГДА побеждает классификацию долга ---

test('«напомни мне 29 июля, что должно прийти 95к по зп» — задача, не долг, дата 29 июля', () => {
  const p = parseMessage('напомни мне 29 июля что должно прийти 95к по зп', NOW);
  assert.equal(p.kind, 'entry');
  assert.notEqual(p.entry.type, 'debt', 'не должно классифицироваться как долг');
  assert.equal(p.entry.type, 'task');
  assert.ok(p.entry.due, 'дата должна извлечься');
  const d = new Date(p.entry.due);
  assert.equal(d.getDate(), 29, 'день — 29-е');
  assert.equal(d.getMonth(), 6, 'месяц — июль (индекс 6)');
});

test('«напомни 29 июля переспросить про зарплату» — задача с датой 29 июля', () => {
  const p = parseMessage('напомни 29 июля переспросить про зарплату', NOW);
  assert.equal(p.kind, 'entry');
  assert.equal(p.entry.type, 'task');
  const d = new Date(p.entry.due);
  assert.equal(d.getDate(), 29);
  assert.equal(d.getMonth(), 6);
});

test('«напомни... долг...» — реминдер-глагол побеждает, даже если рядом слово «долг/должен»', () => {
  const cases = [
    'напомни, что я должен Пете 5000',
    'не забудь спросить, должно ли прийти финансирование',
    'спроси меня завтра, пришли ли деньги, которые мне должны',
  ];
  for (const t of cases) {
    const p = parseMessage(t, NOW);
    if (p.kind === 'entry') assert.notEqual(p.entry.type, 'debt', `${t}: не должно быть долгом`);
  }
});

// --- 2) «должно прийти / поступит» (ожидание дохода) — это не долг ---

test('«мне должно прийти 95000 по зп» — это НЕ долг', () => {
  const p = parseMessage('мне должно прийти 95000 по зп', NOW);
  if (p.kind === 'entry') assert.notEqual(p.entry.type, 'debt');
});

test('«должно прийти / поступить / зачислят» — варианты ожидания дохода не становятся долгом', () => {
  const cases = [
    'должны прийти 20000 от клиента',
    'должно поступить 50000 на карту',
    'мне должны зачислить аванс 30000',
  ];
  for (const t of cases) {
    const p = parseMessage(t, NOW);
    if (p.kind === 'entry') assert.notEqual(p.entry.type, 'debt', `${t}: не долг`);
  }
});

test('регрессия: реальные долги остаются долгами (направление и контрагент верны)', () => {
  const cases = [
    ['Иванов должен 50000', 'in', 'Иванов'],
    ['я должен Петрову 15к', 'out', 'Петрову'],
    ['занял у Пети 5000', 'out', 'Пети'],
  ];
  for (const [t, dir, cp] of cases) {
    const p = parseMessage(t, NOW);
    assert.equal(p.entry.type, 'debt', `${t}: должен остаться долгом`);
    assert.equal(p.entry.direction, dir, `${t}: направление`);
    assert.equal(p.entry.counterparty, cp, `${t}: контрагент`);
  }
});

// --- 3) Напоминание с будущей датой срабатывает РОВНО в день срока ---

test('напоминание с датой 29 июля: не срабатывает раньше, срабатывает точно на дату, без дублей', async () => {
  const s = freshStore();
  s.setUser('111', { name: 'Юзер', step: null });

  const createdAt = new Date(2026, 6, 1, 9, 0); // 1 июля — задолго до 29-го
  const e = captureEntry(s, 'напомни мне 29 июля что должно прийти 95к по зп', createdAt, '111', 180);
  assert.ok(e, 'запись создана');
  assert.equal(e.type, 'task', 'это задача, не долг');
  assert.equal(e.hasTime, true, 'дата без времени должна получить полдень (иначе scheduler её не увидит)');

  const dueMs = Date.parse(e.due);
  const dueLocal = new Date(dueMs);
  assert.equal(dueLocal.getDate(), 29, 'due приходится на 29-е число');
  assert.equal(dueLocal.getMonth(), 6, 'due приходится на июль');

  const bot = spyBot();
  const sched = startScheduler(s, bot, { log() {}, error() {} }, 3600000);
  try {
    // тик «сейчас» (1 июля) — рано, напоминание не должно улететь
    await withFakeNow(createdAt.getTime(), () => sched.tick());
    assert.equal(to(bot, '111').length, 0, 'рано ещё — не сработало');

    // тик ровно в момент due (полдень 29 июля МСК) — срабатывает
    await withFakeNow(dueMs, () => sched.tick());
    const fired = to(bot, '111');
    assert.equal(fired.length, 1, 'сработало ровно один раз, в день срока');
    assert.equal(fired[0].m, 'buttons');
    assert.match(fired[0].text, /🔔/);

    // повторный тик в тот же момент — без дубля
    await withFakeNow(dueMs, () => sched.tick());
    assert.equal(to(bot, '111').length, 1, 'нет повторной отправки');
  } finally {
    sched.stop();
  }
});

// --- 4) Интервальные напоминания получают точный due (МСК) ---

test('интервалы: «через 10 минут», «через 2 часа» — точное смещение от now', () => {
  const s = freshStore();
  const base = new Date(2026, 6, 1, 9, 0);

  const e1 = captureEntry(s, 'напомни через 10 минут выпить воды', base, '1', 180);
  assert.ok(e1.hasTime);
  assert.equal(Math.round((Date.parse(e1.due) - base.getTime()) / 60000), 10);

  const e2 = captureEntry(s, 'напомни через 2 часа созвон', base, '1', 180);
  assert.ok(e2.hasTime);
  assert.equal(Math.round((Date.parse(e2.due) - base.getTime()) / 60000), 120);
});

test('интервал «через 3 дня» без времени — та же дата, но полдень МСК (не сегодня, не через день)', () => {
  const s = freshStore();
  const base = new Date(2026, 6, 1, 9, 0); // 1 июля
  const e = captureEntry(s, 'напомни через 3 дня отправить отчёт', base, '1', 180);
  assert.ok(e.hasTime, 'дата без времени получает дефолт-полдень');
  const d = new Date(e.due);
  assert.equal(d.getDate(), 4, 'через 3 дня от 1 июля — 4 июля');
  assert.equal(d.getMonth(), 6);
  assert.equal(d.getHours(), 12, 'дефолт — полдень МСК');
});
