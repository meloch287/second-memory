// E2E доставки уведомлений по ВСЕМ каналам: личка ТГ, группа ТГ, веб-опрос,
// алерт подключённого ТГ. Гоняем реальный планировщик (startScheduler) с
// bot-шпионом и точную логику /api/reminders/due. Время не пиновано, поэтому
// сроки ставим относительно now (due чуть в прошлом → «Пора»).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { startScheduler } from '../src/scheduler.mjs';
import { linkedChatId } from '../src/webauth.mjs';
import { wall } from '../src/tz.mjs';

delete process.env.SM_ENCRYPTION_KEY;
delete process.env.WEB_CHAT_ID;

const freshStore = () => new Store(join(mkdtempSync(join(tmpdir(), 'sm-notif-')), 'm.json'));
const duePast = () => new Date(Date.now() - 60000).toISOString(); // минуту назад → «Пора»

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

// точная копия фильтра /api/reminders/due (server.mjs)
function webDue(store, nowMs = Date.now()) {
  const cid = linkedChatId(store) || process.env.WEB_CHAT_ID || 'web';
  const due = store.list({ status: 'open', chatId: cid })
    .filter((e) => e.hasTime && e.due && !e.webShown && Date.parse(e.due) <= nowMs && Date.parse(e.due) > nowMs - 86400000);
  for (const e of due) store.patch(e.id, { webShown: true });
  return due;
}

test('ТГ личка + группа: напоминание доставляется в оба чата (и НЕ в веб-only)', async () => {
  const s = freshStore();
  s.setUser('111', { name: 'Саша', step: null });            // личный чат
  s.setUser('-222', { isGroup: true, step: null });          // группа
  s.add({ chatId: '111', type: 'task', title: 'позвонить маме', due: duePast(), hasTime: true });
  s.add({ chatId: '-222', type: 'task', title: 'дейли-стендап', due: duePast(), hasTime: true });
  s.add({ chatId: 'web', type: 'task', title: 'веб-дело', due: duePast(), hasTime: true }); // нет юзера 'web'

  const bot = spyBot();
  const sched = startScheduler(s, bot, { log() {}, error() {} }, 3600000);
  try {
    await sched.tick();

    const personal = to(bot, '111');
    assert.equal(personal.length, 1, 'в личку пришло ровно одно напоминание');
    assert.equal(personal[0].m, 'buttons', 'с кнопками (Сделал/Отложить)');
    assert.match(personal[0].text, /🔔/);
    assert.match(personal[0].text, /позвонить маме/);

    const group = to(bot, '-222');
    assert.equal(group.length, 1, 'в группу пришло ровно одно напоминание');
    assert.match(group[0].text, /дейли-стендап/);

    assert.equal(to(bot, 'web').length, 0, 'веб-only запись НЕ уходит в ТГ (у web нет чата бота)');

    // дедуп: второй тик ничего не шлёт повторно (reminded=true)
    await sched.tick();
    assert.equal(to(bot, '111').length, 1, 'нет дубля в личку');
    assert.equal(to(bot, '-222').length, 1, 'нет дубля в группу');
  } finally {
    sched.stop();
  }
});

test('Веб-опрос: /api/reminders/due отдаёт наступившее (и не дублирует)', async () => {
  const s = freshStore();
  s.add({ chatId: 'web', type: 'task', title: 'веб-напоминание', due: duePast(), hasTime: true });
  s.add({ chatId: 'web', type: 'task', title: 'ещё не пора', due: new Date(Date.now() + 3 * 3600000).toISOString(), hasTime: true });

  const first = webDue(s);
  assert.equal(first.length, 1, 'наступившее одно');
  assert.match(first[0].title, /веб-напоминание/);
  const second = webDue(s);
  assert.equal(second.length, 0, 'повторный опрос не дублирует (webShown)');
});

test('Подключённый ТГ: одно напоминание приходит И в ТГ-алерт, И в веб (флаги независимы)', async () => {
  const s = freshStore();
  s.setUser('333', { name: 'Владелец', step: null });
  s.data.meta.web = { linkedChatId: '333' };                 // веб привязан к ТГ 333
  assert.equal(linkedChatId(s), '333', 'webChat резолвится в linkedChatId');
  s.add({ chatId: '333', type: 'task', title: 'общая задача', due: duePast(), hasTime: true });

  const bot = spyBot();
  const sched = startScheduler(s, bot, { log() {}, error() {} }, 3600000);
  try {
    await sched.tick();
    // 1) ТГ-алерт
    const tg = to(bot, '333');
    assert.equal(tg.length, 1, 'напоминание пришло в ТГ подключённого чата');
    assert.match(tg[0].text, /общая задача/);
    // 2) веб-опрос того же чата тоже отдаёт (reminded не мешает webShown)
    const web = webDue(s);
    assert.equal(web.length, 1, 'то же напоминание видно в вебе');
    assert.match(web[0].title, /общая задача/);
  } finally {
    sched.stop();
  }
});

test('Объём: 50 напоминаний в личке срабатывают по разу, ничего не теряется и не дублируется', async () => {
  const s = freshStore();
  s.setUser('111', { name: 'Саша', step: null });
  for (let i = 0; i < 50; i++) {
    s.add({ chatId: '111', type: 'task', title: `дело ${i}`, due: duePast(), hasTime: true });
  }
  const bot = spyBot();
  const sched = startScheduler(s, bot, { log() {}, error() {} }, 3600000);
  try {
    await sched.tick();
    const got = to(bot, '111');
    assert.equal(got.length, 50, 'все 50 доставлены');
    const titles = new Set(got.map((g) => g.text.replace(/^.*?: /, '')));
    assert.equal(titles.size, 50, 'все уникальны, дублей нет');
    await sched.tick();
    assert.equal(to(bot, '111').length, 50, 'второй тик не создаёт дублей');
  } finally {
    sched.stop();
  }
});

test('Повторяющееся напоминание уходит в чат (🔁)', async () => {
  const s = freshStore();
  s.setUser('111', { name: 'Саша', step: null });
  // ежедневное правило на ТЕКУЩЕЕ настенное время юзера (реальная схема:
  // { kind, hour, min }, сравнение по wall(user) в UTC-полях).
  const w = wall(s.getUser('111'), new Date());
  s.addRecurring({ chatId: '111', title: 'выпить воды', kind: 'daily', hour: w.getUTCHours(), min: w.getUTCMinutes() });
  const bot = spyBot();
  const sched = startScheduler(s, bot, { log() {}, error() {} }, 3600000);
  try {
    await sched.tick();
    const rec = to(bot, '111').filter((x) => /🔁|выпить воды/.test(x.text));
    assert.ok(rec.length >= 1, 'повторяющееся напоминание доставлено');
  } finally {
    sched.stop();
  }
});
