// Секретная пипетка ID: /id -> стикер/премиум-эмодзи отдают идентификаторы.
// Гоняем реального бота спай-транспортом (как voice-parity/holdout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { startTelegramBot } from '../src/telegram.mjs';
import { ID_CMD } from '../src/telegram-idpicker.mjs';

for (const k of ['AI_API_KEY', 'AI_AUDIO_API_KEY', 'AI_WORKER_API_KEY', 'SM_ENCRYPTION_KEY', 'WEB_CHAT_ID']) delete process.env[k];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'sm-idp-')), 'm.json'));
  const calls = [], queue = [];
  let uid = 1, out = 9000;
  const emojiStickers = [{ custom_emoji_id: '5368324170671202286', type: 'custom_emoji', emoji: '👍', set_name: 'MyPack' }];
  const M = (u) => (String(u).match(/\/bot[^/]+\/([A-Za-z]+)$/) || [])[1];
  const original = global.fetch;
  global.fetch = async (u, o = {}) => {
    const m = M(u);
    if (m === 'getUpdates') { await sleep(4); return { json: async () => ({ ok: true, result: queue.splice(0) }) }; }
    let p = {}; try { p = JSON.parse(o.body); } catch {}
    calls.push({ m, p });
    if (m === 'getMe') return { json: async () => ({ ok: true, result: { id: 1, is_bot: true, username: 't' } }) };
    if (m === 'getCustomEmojiStickers') return { json: async () => ({ ok: true, result: emojiStickers }) };
    return { json: async () => ({ ok: true, result: { message_id: out++, chat: { id: p.chat_id } } }) };
  };
  const bot = startTelegramBot(store, 'T:T', { log() {}, error() {} });
  const base = (c) => ({ message_id: uid++, chat: { id: c, type: 'private' }, from: { id: c } });
  return {
    store, calls, bot,
    text: (c, t, entities) => queue.push({ update_id: uid++, message: { ...base(c), text: t, ...(entities ? { entities } : {}) } }),
    sticker: (c, s) => queue.push({ update_id: uid++, message: { ...base(c), sticker: s } }),
    cb: (c, data) => queue.push({ update_id: uid++, callback_query: { id: 'x', from: { id: c }, message: { message_id: 1, chat: { id: c } }, data } }),
    texts: (c) => calls.filter((x) => x.m === 'sendMessage' && String(x.p.chat_id) === String(c)).map((x) => x.p.text),
    restore() { bot?.stop?.(); global.fetch = original; },
  };
}
const waitFor = async (fn, ms = 3000) => { const s = Date.now(); while (!fn() && Date.now() - s < ms) await sleep(15); return fn(); };

test('ID_CMD: секретные алиасы команды', () => {
  for (const c of ['/id', '/stickerid', '/emojiid', '/ids', '/id@MyBot']) assert.ok(ID_CMD.test(c), c);
  for (const c of ['/idea', 'id', '/identity']) assert.ok(!ID_CMD.test(c), c);
});

test('/id -> стикер отдаёт file_id, набор и тип', async () => {
  const h = boot();
  try {
    h.store.setUser('55', { name: 'Макс', botName: 'Толик', tzOffset: 180, step: null });
    h.text(55, '/id');
    await waitFor(() => h.texts(55).some((t) => /пипетк/i.test(t)));
    h.sticker(55, { file_id: 'CAACAgIAAx', file_unique_id: 'AgADuwAD', type: 'regular', emoji: '🔥', set_name: 'CoolPack', is_animated: false, is_video: false });
    await waitFor(() => h.texts(55).some((t) => /CAACAgIAAx/.test(t)));
    const last = h.texts(55).at(-1);
    assert.match(last, /file_id/);
    assert.match(last, /<code>CAACAgIAAx<\/code>/, 'ID моноширинным - копируется тапом');
    assert.match(last, /CoolPack/);
    assert.match(last, /🔥/);
  } finally { h.restore(); }
});

test('/id -> премиум-эмодзи отдаёт custom_emoji_id и готовый тег', async () => {
  const h = boot();
  try {
    h.store.setUser('56', { name: 'Макс', botName: 'Толик', tzOffset: 180, step: null });
    h.text(56, '/id');
    await waitFor(() => h.texts(56).some((t) => /пипетк/i.test(t)));
    // премиум-эмодзи приходит как обычный символ + entity custom_emoji
    h.text(56, '👍', [{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '5368324170671202286' }]);
    await waitFor(() => h.texts(56).some((t) => /5368324170671202286/.test(t)));
    const last = h.texts(56).at(-1);
    assert.match(last, /5368324170671202286/);
    assert.match(last, /tg-emoji emoji-id/, 'готовая разметка для вставки');
    assert.match(last, /MyPack/, 'подтянул набор через getCustomEmojiStickers');
  } finally { h.restore(); }
});

test('пипетка выключается кнопкой и словом «готово»', async () => {
  const h = boot();
  try {
    h.store.setUser('57', { name: 'Макс', botName: 'Толик', tzOffset: 180, step: null });
    h.text(57, '/id');
    await waitFor(() => h.texts(57).some((t) => /пипетк/i.test(t)));
    h.cb(57, 'idp:off');
    await waitFor(() => h.texts(57).some((t) => /выключена/i.test(t)));
    assert.ok(h.texts(57).some((t) => /выключена/i.test(t)));

    h.text(57, '/id');
    await waitFor(() => h.texts(57).filter((t) => /пипетк/i.test(t)).length === 2);
    h.text(57, 'готово');
    await waitFor(() => h.texts(57).filter((t) => /выключена/i.test(t)).length === 2);
    assert.equal(h.texts(57).filter((t) => /выключена/i.test(t)).length, 2, 'словом тоже выключается');
  } finally { h.restore(); }
});

test('без включённой пипетки стикеры идут обычным путём (не перехвачены)', async () => {
  const h = boot();
  try {
    h.store.setUser('58', { name: 'Макс', botName: 'Толик', tzOffset: 180, step: null });
    h.sticker(58, { file_id: 'XYZ', file_unique_id: 'u1', type: 'regular', emoji: '😀', is_animated: false, is_video: false });
    await sleep(120);
    assert.ok(!h.texts(58).some((t) => /file_id/.test(t)), 'пипетка молчит, пока выключена');
    // и стикер выучен в библиотеку, как раньше
    assert.ok(h.store.data.meta.stickerLib?.['😀']?.includes('XYZ'), 'learnSticker отработал');
  } finally { h.restore(); }
});
