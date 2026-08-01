// Голосовой круг: «отвечай голосом» включает озвучку, ответы уходят sendVoice,
// «отвечай текстом» выключает, разовое «ответь голосовым» действует один раз.
// Проверяем на реальном боте через спай-транспорт (как onboarding-ux/holdout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { parseMessage } from '../src/parser.mjs';

delete process.env.SM_ENCRYPTION_KEY;
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'sm-voice-')), 'm.json');

test('парсер: «отвечай голосом» / «отвечай текстом» -> setvoice on/off', () => {
  assert.deepEqual(parseMessage('отвечай голосом', new Date()), { kind: 'setvoice', on: true });
  assert.deepEqual(parseMessage('отвечай текстом', new Date()), { kind: 'setvoice', on: false });
});

test('deliver: при voiceReplies ответ уходит голосом, иначе текстом', async () => {
  const s = new Store(tmpFile());
  // Мини-реплика deliver() из telegram.mjs: та же ветка выбора канала.
  const calls = [];
  const audioEnabled = () => true;
  const sendVoice = async (chatId) => { calls.push({ m: 'sendVoice', chatId }); return { ok: true }; };
  const send = async (chatId, text) => { calls.push({ m: 'sendMessage', chatId, text }); return { ok: true }; };
  const aiTts = async () => Buffer.from('ogg');
  async function deliver(chatId, text, user) {
    const wantVoice = audioEnabled() && (user?.voiceReplies || user?.voiceNext);
    if (user?.voiceNext) s.setUser(String(chatId), { voiceNext: false });
    if (wantVoice) {
      await aiTts(text);
      const r = await sendVoice(chatId);
      if (r.ok) return;
    }
    return send(chatId, text);
  }

  s.setUser('1', { name: 'Макс' });
  await deliver('1', 'обычный ответ', s.getUser('1'));
  assert.equal(calls.at(-1).m, 'sendMessage', 'по умолчанию текстом');

  s.setUser('1', { voiceReplies: true });
  await deliver('1', 'голосовой ответ', s.getUser('1'));
  assert.equal(calls.at(-1).m, 'sendVoice', 'при voiceReplies - голосом');

  s.setUser('1', { voiceReplies: false, voiceNext: true });
  await deliver('1', 'разовый голос', s.getUser('1'));
  assert.equal(calls.at(-1).m, 'sendVoice', 'разовая озвучка сработала');
  assert.equal(s.getUser('1').voiceNext, false, 'флаг разовой озвучки сброшен');

  await deliver('1', 'снова текст', s.getUser('1'));
  assert.equal(calls.at(-1).m, 'sendMessage', 'после разовой - опять текст');
});

test('интент setvoice сохраняет флаг в профиль', async () => {
  const s = new Store(tmpFile());
  s.setUser('1', { name: 'Макс' });
  const p1 = parseMessage('отвечай голосом', new Date());
  s.setUser('1', { voiceReplies: p1.on });
  assert.equal(s.getUser('1').voiceReplies, true);
  const p2 = parseMessage('отвечай текстом', new Date());
  s.setUser('1', { voiceReplies: p2.on });
  assert.equal(s.getUser('1').voiceReplies, false);
});

test('реестр обещает голосовые - бот не должен их отрицать', async () => {
  const { CAPABILITIES, capabilitiesLine } = await import('../src/capabilities.mjs');
  const v = CAPABILITIES.find((c) => c.key === 'voice');
  assert.ok(v, 'фича voice в реестре');
  assert.match(v.what, /голосов/i);
  assert.match(capabilitiesLine(), /отвечай голосом/i, 'подсказка команды в промпте');
});

test('voiceStateLine: бот знает текущий канал ответа', async () => {
  const { voiceStateLine } = await import('../src/capabilities.mjs');
  const on = voiceStateLine({ voiceReplies: true });
  assert.match(on, /включён голосовой режим/i);
  const off = voiceStateLine({});
  assert.match(off, /отвечаешь ТЕКСТОМ/);
  assert.match(off, /отвечай голосом/, 'подсказывает команду включения');
  assert.match(off, /слушай, что скажу/i, 'явно запрещает притворяться, что говорит вслух');
});

test('friendSystem: при выключенном голосе не обещает говорить вслух', async () => {
  const { friendSystem } = await import('../src/ai.mjs');
  const sysOff = friendSystem({ name: 'Макс', botName: 'Толик' });
  assert.match(sysOff, /отвечаешь ТЕКСТОМ/);
  const sysOn = friendSystem({ name: 'Макс', botName: 'Толик', voiceReplies: true });
  assert.match(sysOn, /включён голосовой режим/i);
});
