// Кто есть кто в группе. Регрессия по реальным ошибкам из чата «Банда»:
//  1) имя участника = невидимый символ (U+2060) -> подпись «⁠: текст», бот
//     переставал понимать, кто говорит;
//  2) botName в группах был «Помощник», хотя люди зовут Толиком;
//  3) бот заводил досье на самого себя и называл живого участника ботом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { startTelegramBot } from '../src/telegram.mjs';

for (const k of ['AI_API_KEY', 'AI_AUDIO_API_KEY', 'AI_WORKER_API_KEY', 'SM_ENCRYPTION_KEY', 'WEB_CHAT_ID']) delete process.env[k];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GID = -4890723651;

function boot() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'sm-grp-')), 'm.json'));
  const calls = [], queue = [];
  let uid = 1, out = 9000;
  const M = (u) => (String(u).match(/\/bot[^/]+\/([A-Za-z]+)$/) || [])[1];
  const original = global.fetch;
  global.fetch = async (u, o = {}) => {
    const m = M(u);
    if (m === 'getUpdates') { await sleep(4); return { json: async () => ({ ok: true, result: queue.splice(0) }) }; }
    let p = {}; try { p = JSON.parse(o.body); } catch {}
    calls.push({ m, p });
    if (m === 'getMe') return { json: async () => ({ ok: true, result: { id: 77, is_bot: true, username: 'tolik_bot' } }) };
    if (m === 'getChatMember') return { json: async () => ({ ok: true, result: { status: 'administrator' } }) };
    return { json: async () => ({ ok: true, result: { message_id: out++, chat: { id: p.chat_id } } }) };
  };
  const bot = startTelegramBot(store, 'T:T', { log() {}, error() {} });
  const msg = (from, text) => queue.push({
    update_id: uid++,
    message: { message_id: uid, chat: { id: GID, type: 'supergroup', title: 'Банда' }, from, text },
  });
  return { store, calls, msg, restore() { bot?.stop?.(); global.fetch = original; } };
}
const waitFor = async (fn, ms = 3000) => { const s = Date.now(); while (!fn() && Date.now() - s < ms) await sleep(15); return fn(); };

test('невидимое имя (U+2060) не попадает в участников - берётся username', async () => {
  const h = boot();
  try {
    // ровно случай из «Банды»: first_name состоит из word-joiner
    h.msg({ id: 1057399602, is_bot: false, first_name: '⁠', username: 'qk1nlyNTG' }, 'привет');
    await waitFor(() => Object.keys(h.store.getUser(String(GID))?.members || {}).length > 0);
    const m = h.store.getUser(String(GID)).members['1057399602'];
    assert.ok(/[\p{L}\p{N}]/u.test(m.name), `имя должно быть читаемым, а не «${m.name}»`);
    assert.equal(m.name, 'qk1nlyNTG', 'падаем на username');
    assert.equal(m.username, 'qk1nlyNTG');
  } finally { h.restore(); }
});

test('имя из одних эмодзи/пробелов тоже отбраковывается', async () => {
  const h = boot();
  try {
    h.msg({ id: 5, is_bot: false, first_name: '🌚  ', username: 'ghost' }, 'ку');
    await waitFor(() => h.store.getUser(String(GID))?.members?.['5']);
    assert.equal(h.store.getUser(String(GID)).members['5'].name, 'ghost');
  } finally { h.restore(); }
});

test('нормальное имя не портится', async () => {
  const h = boot();
  try {
    h.msg({ id: 750201677, is_bot: false, first_name: 'Аня', username: 'meloch287' }, 'мальчики');
    await waitFor(() => h.store.getUser(String(GID))?.members?.['750201677']);
    assert.equal(h.store.getUser(String(GID)).members['750201677'].name, 'Аня');
  } finally { h.restore(); }
});

test('в группе бот - Толик, а не «Помощник»', async () => {
  const h = boot();
  try {
    h.msg({ id: 1, is_bot: false, first_name: 'Аня' }, 'привет');
    await waitFor(() => h.store.getUser(String(GID))?.botName);
    assert.equal(h.store.getUser(String(GID)).botName, 'Толик');
  } finally { h.restore(); }
});

test('старый «Помощник» в существующей группе апгрейдится до Толика', async () => {
  const h = boot();
  try {
    h.store.setUser(String(GID), { isGroup: true, name: 'Банда', botName: 'Помощник', tzOffset: 180, step: null });
    h.msg({ id: 1, is_bot: false, first_name: 'Аня' }, 'ку');
    await waitFor(() => h.store.getUser(String(GID))?.botName === 'Толик');
    assert.equal(h.store.getUser(String(GID)).botName, 'Толик');
  } finally { h.restore(); }
});

test('кастомное имя бота в группе не перетирается', async () => {
  const h = boot();
  try {
    h.store.setUser(String(GID), { isGroup: true, name: 'Банда', botName: 'Дружок', tzOffset: 180, step: null });
    h.msg({ id: 1, is_bot: false, first_name: 'Аня' }, 'ку');
    await sleep(150);
    assert.equal(h.store.getUser(String(GID)).botName, 'Дружок');
  } finally { h.restore(); }
});

test('промпт консолидации запрещает досье на себя и участников-«ботов»', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync('src/ai-skills.mjs', 'utf8'));
  assert.match(src, /НЕ заводи досье на самого себя/);
  assert.match(src, /НИКОГО из участников не называй ботом/);
  assert.match(src, /один человек = одно досье/);
});

test('групповая персона умеет связывать @ник с именем участника', async () => {
  const { groupPersona } = await import('../src/capabilities.mjs');
  const g = groupPersona({ isGroup: true, name: 'Банда', botName: 'Толик' }, '');
  assert.match(g, /@username/);
  assert.match(g, /это тот же человек/);
  assert.match(g, /Бот в этом чате - ЭТО ТЫ САМ/);
});

test('список участников в контексте пропускает мусорные имена', async () => {
  const { friendSystem } = await import('../src/ai.mjs');
  // косвенно: персона строится без падения даже на мусорных участниках
  const g = friendSystem({ isGroup: true, name: 'Банда', members: { 1: { name: '⁠', username: 'ghost' }, 2: { name: 'Аня' } } });
  assert.match(g, /участник группы «Банда»/);
});

test('групповая персона: список участников и запрет звать себя ботом', async () => {
  const { groupPersona } = await import('../src/capabilities.mjs');
  const g = groupPersona({ isGroup: true, name: 'Банда', botName: 'Толик' }, '');
  assert.match(g, /перечисляй ЛЮДЕЙ ИЗ СПИСКА УЧАСТНИКОВ/);
  assert.match(g, /Никогда не отвечай «никого нет»/);
  assert.match(g, /спрашивают про УЧАСТНИКА с этим именем, а НЕ про тебя/);
  assert.match(g, /ЗАПРЕЩЕНО называть себя ботом/);
});

test('человеческое имя не откатывается на @username при новом сообщении', async () => {
  const h = boot();
  try {
    // в реестре уже есть нормальное имя (подтянули из профиля/назвали в чате)
    h.store.setUser(String(GID), {
      isGroup: true, name: 'Банда', botName: 'Толик', tzOffset: 180, step: null,
      members: { 1057399602: { name: 'Саня', username: 'qk1nlyNTG' } },
    });
    // приходит сообщение, где first_name по-прежнему невидимый символ
    h.msg({ id: 1057399602, is_bot: false, first_name: '⁠', username: 'qk1nlyNTG' }, 'ку');
    await sleep(200);
    assert.equal(h.store.getUser(String(GID)).members['1057399602'].name, 'Саня', 'имя сохранилось');
  } finally { h.restore(); }
});

test('заглушка «u:ник» схлопывается, когда человек написал сам', async () => {
  const h = boot();
  try {
    h.store.setUser(String(GID), {
      isGroup: true, name: 'Банда', botName: 'Толик', tzOffset: 180, step: null,
      members: { 'u:jjjoopes': { name: 'Сергей', username: 'Jjjoopes' } },
    });
    h.msg({ id: 51, is_bot: false, first_name: 'Серёга', username: 'Jjjoopes' }, 'хай');
    await sleep(200);
    const ms = h.store.getUser(String(GID)).members;
    assert.ok(!ms['u:jjjoopes'], 'заглушка убрана');
    assert.equal(ms['51'].name, 'Серёга');
    assert.ok((ms['51'].aliases || []).includes('Сергей'), 'прежнее имя стало псевдонимом');
  } finally { h.restore(); }
});

/* --- Как научили - так и зовём: «мама - @meloch287» --- */

test('«мама, маму - @ник»: обращение становится основным, паспортное имя цело', async () => {
  const h = boot();
  try {
    h.msg({ id: 750201677, is_bot: false, first_name: 'Аня', username: 'meloch287' }, 'мальчики');
    await waitFor(() => h.store.getUser(String(GID))?.members?.['750201677']);
    h.msg({ id: 1057399602, is_bot: false, first_name: 'Саня', username: 'qk1nlyNTG' }, 'мама, маму - @meloch287');
    await waitFor(() => h.store.getUser(String(GID))?.members?.['750201677']?.callName);
    const m = h.store.getUser(String(GID)).members['750201677'];
    assert.equal(m.callName, 'Мама', 'зовём так, как попросили');
    assert.equal(m.name, 'Аня', 'паспортное имя нужно, чтобы связывать её сообщения');
  } finally { h.restore(); }
});

test('выученное обращение переживает новые сообщения от человека', async () => {
  const h = boot();
  try {
    h.msg({ id: 750201677, is_bot: false, first_name: 'Аня', username: 'meloch287' }, 'привет');
    await waitFor(() => h.store.getUser(String(GID))?.members?.['750201677']);
    h.msg({ id: 1057399602, is_bot: false, first_name: 'Саня', username: 'qk1nlyNTG' }, 'мама - @meloch287');
    await waitFor(() => h.store.getUser(String(GID))?.members?.['750201677']?.callName);
    // именно тут псевдоним терялся: следующее сообщение перезаписывало участника
    h.msg({ id: 750201677, is_bot: false, first_name: 'Аня', username: 'meloch287' }, 'ну что там');
    await sleep(120);
    const m = h.store.getUser(String(GID)).members['750201677'];
    assert.equal(m.callName, 'Мама');
    assert.equal(m.name, 'Аня');
  } finally { h.restore(); }
});
