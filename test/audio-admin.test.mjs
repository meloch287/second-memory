// Новые фичи: выбор «транскрипция или саммари» для аудиофайлов и админ-журнал
// (/admin, только владелец) с записью всего, что прилетело в чат.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createAudioChoice, isAudioFile, audioInfo } from '../src/telegram-audio.mjs';
import { adminLogOn, setAdminLog, logAdmin, adminLogList, adminLogStats, describeMessage, forwardLabel, useAdminDb } from '../src/adminlog.mjs';

// Журнал живёт в СВОЕЙ базе - в тестах подменяем её на временный файл,
// иначе прогон тестов пишет в боевой журнал.
const freshAdminDb = () => useAdminDb(join(mkdtempSync(join(tmpdir(), 'sm-admdb-')), 'admin-log.jsonl'));

delete process.env.SM_ENCRYPTION_KEY;
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'sm-aa-')), 'm.json');

/* ---- Аудиофайлы ---- */

test('isAudioFile: mp3/m4a/wav и audio-документы - да, голосовое и кружок - нет', () => {
  assert.equal(isAudioFile({ audio: { file_id: 'a' } }), true, 'msg.audio');
  assert.equal(isAudioFile({ document: { file_id: 'd', mime_type: 'audio/mpeg' } }), true, 'audio-документ');
  assert.equal(isAudioFile({ document: { file_id: 'd', file_name: 'lecture.wav' } }), true, 'по расширению');
  assert.equal(isAudioFile({ document: { file_id: 'd', file_name: 'rec.m4a' } }), true);
  assert.equal(isAudioFile({ voice: { file_id: 'v' } }), false, 'голосовое идёт прежним путём');
  assert.equal(isAudioFile({ video_note: { file_id: 'c' } }), false, 'кружок тоже');
  assert.equal(isAudioFile({ document: { file_id: 'd', file_name: 'doc.pdf' } }), false);
  assert.equal(isAudioFile({ text: 'привет' }), false);
});

test('audioInfo: достаёт имя, длительность и mime', () => {
  const a = audioInfo({ audio: { file_id: 'x', mime_type: 'audio/mpeg', duration: 300, file_name: 'podcast.mp3' } });
  assert.equal(a.fileId, 'x');
  assert.equal(a.duration, 300);
  assert.equal(a.title, 'podcast.mp3');
  const d = audioInfo({ document: { file_id: 'y', mime_type: 'audio/wav', file_name: 'rec.wav' } });
  assert.equal(d.title, 'rec.wav');
});

function audioBot({ transcript = 'расшифровка записи', summary = 'краткая суть' } = {}) {
  const sent = [];
  const calls = { transcribe: 0, summarize: 0, onTranscript: 0 };
  const choice = createAudioChoice({
    send: async (chatId, text, extra) => { sent.push({ chatId: String(chatId), text, kb: extra?.reply_markup?.inline_keyboard }); return { ok: true }; },
    withTyping: (_c, fn) => fn(),
    transcribe: async () => { calls.transcribe++; return transcript; },
    summarize: async () => { calls.summarize++; return summary; },
    onTranscript: async () => { calls.onTranscript++; },
    log: { error() {} },
  });
  return { choice, sent, calls, last: () => sent.at(-1) };
}

test('аудио: карточка с кнопками транскрипция/саммари', async () => {
  const b = audioBot();
  await b.choice.ask('1', { fileId: 'f', mime: 'audio/mpeg', duration: 600, title: 'lecture.mp3' });
  const r = b.last();
  assert.match(r.text, /lecture\.mp3/);
  assert.match(r.text, /Что с ним сделать/);
  const flat = r.kb.flat();
  assert.ok(flat.some((x) => /Транскрипция/.test(x.text)));
  assert.ok(flat.some((x) => /Саммари/.test(x.text)));
  assert.equal(b.calls.transcribe, 0, 'до выбора ничего не расшифровываем');
});

test('аудио: «Транскрипция» отдаёт текст, «Саммари» - сжатую суть', async () => {
  const b = audioBot();
  await b.choice.ask('1', { fileId: 'f', duration: 60, title: 'rec.mp3' });
  const key = b.last().kb.flat().find((x) => /Транскрипция/.test(x.text)).callback_data;
  assert.equal(await b.choice.onCallback('1', key), true);
  assert.equal(b.calls.transcribe, 1);
  assert.equal(b.calls.summarize, 0);
  assert.match(b.last().text, /расшифровка записи/);
  assert.equal(b.calls.onTranscript, 1, 'расшифровка ушла в память бота');

  const b2 = audioBot();
  await b2.choice.ask('1', { fileId: 'f', duration: 60, title: 'rec.mp3' });
  const keySum = b2.last().kb.flat().find((x) => /Саммари/.test(x.text)).callback_data;
  await b2.choice.onCallback('1', keySum);
  assert.equal(b2.calls.summarize, 1);
  assert.match(b2.last().text, /краткая суть/);
});

test('аудио: длинная расшифровка режется на несколько сообщений', async () => {
  const b = audioBot({ transcript: 'а'.repeat(8000) });
  await b.choice.ask('1', { fileId: 'f', duration: 60, title: 'long.mp3' });
  const key = b.last().kb.flat().find((x) => /Транскрипция/.test(x.text)).callback_data;
  const before = b.sent.length;
  await b.choice.onCallback('1', key);
  assert.ok(b.sent.length - before >= 3, 'разбито на части: ' + (b.sent.length - before));
});

test('аудио: «Ничего» и протухший ключ не падают', async () => {
  const b = audioBot();
  await b.choice.ask('1', { fileId: 'f', duration: 10, title: 'x.mp3' });
  const no = b.last().kb.flat().find((x) => /Ничего/.test(x.text)).callback_data;
  await b.choice.onCallback('1', no);
  assert.match(b.last().text, /не трогаю/);
  assert.equal(await b.choice.onCallback('1', 'aud:tr:9999'), true);
  assert.match(b.last().text, /протухла/);
  assert.equal(await b.choice.onCallback('1', 'lk:home'), false, 'чужие колбэки не перехватываем');
});

/* ---- Админ-журнал ---- */

test('describeMessage: разбирает все типы вложений', () => {
  assert.equal(describeMessage({ text: 'привет' }).kind, 'text');
  assert.equal(describeMessage({ photo: [{ file_id: 'p1', file_size: 100 }], caption: 'подпись' }).kind, 'photo');
  assert.equal(describeMessage({ photo: [{ file_id: 'p1' }], caption: 'подпись' }).text, 'подпись');
  assert.equal(describeMessage({ video: { file_id: 'v', mime_type: 'video/mp4' } }).kind, 'video');
  assert.equal(describeMessage({ voice: { file_id: 'vo' } }).kind, 'voice');
  assert.equal(describeMessage({ audio: { file_id: 'a', file_name: 'x.mp3' } }).fileName, 'x.mp3');
  assert.equal(describeMessage({ document: { file_id: 'd', file_name: 'x.pdf' } }).kind, 'document');
  assert.equal(describeMessage({ sticker: { file_id: 's', emoji: '🔥' } }).text, '🔥');
  assert.equal(describeMessage({ location: { latitude: 55.7, longitude: 37.6 } }).kind, 'location');
});

test('админ-журнал: включение по чату, запись и статистика', () => {
  const s = new Store(tmpFile());
  freshAdminDb();
  assert.equal(adminLogOn(s, '-100'), false, 'по умолчанию выключен');
  setAdminLog(s, '-100', true);
  assert.equal(adminLogOn(s, '-100'), true);
  assert.equal(adminLogOn(s, '-200'), false, 'другой чат не задет');

  logAdmin(s, { chatId: '-100', chatTitle: 'Банда', userId: 1, username: 'anya', name: 'Аня', kind: 'text', text: 'привет' });
  logAdmin(s, { chatId: '-100', userId: 2, username: 'sanya', name: 'Саня', kind: 'photo', fileId: 'p1' });
  logAdmin(s, { chatId: '-200', userId: 3, kind: 'text', text: 'чужой чат' });

  const rows = adminLogList(s, { chatId: '-100' });
  assert.equal(rows.length, 2, 'только свой чат');
  assert.equal(rows[0].name, 'Аня');
  assert.equal(rows[0].username, 'anya');
  assert.equal(rows[0].chatTitle, 'Банда');
  assert.ok(rows[0].ts, 'время записано');
  assert.equal(rows[1].kind, 'photo');
  assert.equal(rows[1].fileId, 'p1');

  const st = adminLogStats(s, '-100');
  assert.equal(st.total, 2);
  assert.equal(st.byKind.text, 1);
  assert.equal(st.byKind.photo, 1);
  assert.equal(st.byUser['Аня'], 1);
});

test('админ-журнал: выключение и персистентность', () => {
  const f = tmpFile();
  const s = new Store(f);
  freshAdminDb();
  setAdminLog(s, '-100', true);
  logAdmin(s, { chatId: '-100', userId: 1, kind: 'text', text: 'запись' });
  s.flush();

  const re = new Store(f);
  assert.equal(adminLogOn(re, '-100'), true, 'режим пережил перезапуск');
  assert.equal(adminLogList(re, { chatId: '-100' }).length, 1, 'записи на месте');

  setAdminLog(re, '-100', false);
  assert.equal(adminLogOn(re, '-100'), false);
});

test('админ-журнал: текст обрезается, лишние записи вытесняются', () => {
  const s = new Store(tmpFile());
  freshAdminDb();
  const rec = logAdmin(s, { chatId: '1', kind: 'text', text: 'x'.repeat(5000) });
  assert.equal(rec.text.length, 4000, 'длинный текст обрезан по лимиту записи');
  assert.equal(adminLogStats(s).total, 1);
});

/* --- Пересланные сообщения: в журнале должен остаться АВТОР оригинала --- */

test('пересылка от пользователя: сохраняется кто автор, а не только кто переслал', () => {
  const d = describeMessage({
    text: 'вот, глянь',
    forward_origin: { type: 'user', date: 1754500000, sender_user: { id: 750201677, first_name: 'Аня', username: 'meloch287' } },
  });
  assert.equal(d.kind, 'text');
  assert.deepEqual(d.forward, { kind: 'user', id: '750201677', username: 'meloch287', name: 'Аня', date: new Date(1754500000000).toISOString() });
  assert.equal(forwardLabel(d.forward), 'Аня (@meloch287)');
});

test('пересылка из канала: название канала и подпись автора', () => {
  const d = describeMessage({
    caption: 'важное',
    photo: [{ file_id: 'f1', file_size: 100 }],
    forward_origin: { type: 'channel', date: 1754500000, chat: { id: -1001, title: 'Новости', username: 'news' }, message_id: 42, author_signature: 'Редакция' },
  });
  assert.equal(d.kind, 'photo');
  assert.equal(d.forward.kind, 'channel');
  assert.equal(d.forward.messageId, 42);
  assert.equal(forwardLabel(d.forward), 'канал «Новости», подпись: Редакция');
});

test('пересылка от скрытого профиля: остаётся хотя бы имя', () => {
  const d = describeMessage({ text: 'секрет', forward_origin: { type: 'hidden_user', date: 1754500000, sender_user_name: 'Аня' } });
  assert.equal(d.forward.kind, 'hidden');
  assert.equal(forwardLabel(d.forward), 'Аня (скрытый профиль)');
});

test('старый формат forward_from тоже разбирается', () => {
  const d = describeMessage({ text: 'ретро', forward_from: { id: 5986736818, first_name: 'Сергей' }, forward_date: 1754500000 });
  assert.equal(d.forward.id, '5986736818');
  assert.equal(d.forward.name, 'Сергей');
});

test('обычное сообщение: forward пустой, ничего не выдумываем', () => {
  const d = describeMessage({ text: 'просто текст' });
  assert.equal(d.forward, null);
  assert.equal(forwardLabel(d.forward), '');
});

test('ответ на сообщение и альбом попадают в запись', () => {
  const d = describeMessage({
    photo: [{ file_id: 'p1' }],
    media_group_id: '13579',
    reply_to_message: { message_id: 7, from: { id: 1, first_name: 'Аня', username: 'meloch287' }, text: 'а покажи' },
  });
  assert.equal(d.albumId, '13579');
  assert.deepEqual(d.replyTo, { messageId: 7, userId: '1', username: 'meloch287', name: 'Аня', text: 'а покажи' });
});

test('журнал сохраняет автора пересылки, ответ и альбом', () => {
  const store = new Store(tmpFile());
  freshAdminDb();
  const d = describeMessage({
    text: 'смотри что скинули',
    media_group_id: '99',
    forward_origin: { type: 'user', date: 1754500000, sender_user: { id: 750201677, first_name: 'Аня', username: 'meloch287' } },
    reply_to_message: { message_id: 3, from: { id: 2, first_name: 'Сергей' }, text: 'ну?' },
  });
  logAdmin(store, { ...d, chatId: '-100', userId: '1057399602', username: 'qk1nlyNTG', name: 'Саня' });
  const [rec] = adminLogList(store, { chatId: '-100', limit: 5 });
  assert.equal(rec.userId, '1057399602');       // переслал Саня
  assert.equal(rec.forward.name, 'Аня');         // а написала Аня
  assert.equal(rec.replyTo.name, 'Сергей');
  assert.equal(rec.albumId, '99');
});

test('служебные события чата тоже видны в журнале', () => {
  assert.equal(describeMessage({ new_chat_members: [{ first_name: 'Аня', username: 'meloch287' }] }).kind, 'join');
  assert.equal(describeMessage({ left_chat_member: { first_name: 'Сергей' } }).kind, 'leave');
  assert.equal(describeMessage({ pinned_message: { text: 'важное' } }).kind, 'pin');
});
