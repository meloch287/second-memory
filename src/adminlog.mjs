// Разбор входящего сообщения для админ-журнала. Само хранение - в отдельной
// базе (src/admindb.mjs): журнал не должен ни раздувать память бота, ни попадать
// в контекст ИИ.
//
// Пишем КТО (id, @ник, имя), КОГДА, ГДЕ (чат) и ЧТО (тип, текст, файл), плюс
// автора пересылки, адресата ответа и id альбома.

import { AdminDb } from './admindb.mjs';

let _db = null;
export function adminDb() {
  if (!_db) _db = new AdminDb(process.env.SM_ADMIN_DB || null);
  return _db;
}

// Тесты и разовые скрипты подменяют базу на временную, чтобы не писать в боевую.
export function useAdminDb(fileOrDb) {
  _db = typeof fileOrDb === 'string' ? new AdminDb(fileOrDb) : fileOrDb;
  return _db;
}

export const adminLogOn = (_store, chatId) => adminDb().isOn(chatId);
export const setAdminLog = (_store, chatId, on) => adminDb().setOn(chatId, on);
export const logAdmin = (_store, entry) => adminDb().append(entry);
export const adminLogList = (_store, opts) => adminDb().list(opts);
export const adminLogStats = (_store, chatId) => adminDb().stats(chatId);

// Разовый перенос старых записей из memory.json в отдельную базу.
export function migrateAdminLog(store) {
  const old = Array.isArray(store?.data?.adminLog) ? store.data.adminLog : [];
  const flags = store?.data?.meta?.adminLogChats || {};
  let moved = 0;
  for (const rec of old) { adminDb().append(rec); moved++; }
  for (const chatId of Object.keys(flags)) adminDb().setOn(chatId, true);
  if (old.length) { store.data.adminLog = []; store.save(); }
  if (Object.keys(flags).length) { delete store.data.meta.adminLogChats; store.save(); }
  return moved;
}

// Откуда переслано. Bot API 7.0+ отдаёт forward_origin, старые клиенты и
// старые апдейты - forward_from / forward_from_chat / forward_sender_name.
// Без этого в журнале видно только того, кто нажал «переслать».
export function forwardOrigin(msg) {
  const who = (u) => ({
    kind: 'user',
    id: u.id != null ? String(u.id) : null,
    username: u.username || null,
    name: [u.first_name, u.last_name].filter(Boolean).join(' ') || null,
  });
  const chat = (c, kind, extra = {}) => ({
    kind,
    id: c?.id != null ? String(c.id) : null,
    username: c?.username || null,
    name: c?.title || null,
    ...extra,
  });

  const o = msg?.forward_origin;
  if (o) {
    const date = o.date ? new Date(o.date * 1000).toISOString() : null;
    if (o.type === 'user' && o.sender_user) return { ...who(o.sender_user), date };
    if (o.type === 'hidden_user') return { kind: 'hidden', id: null, username: null, name: o.sender_user_name || null, date };
    if (o.type === 'chat') return { ...chat(o.sender_chat, 'chat', { signature: o.author_signature || null }), date };
    if (o.type === 'channel') return { ...chat(o.chat, 'channel', { signature: o.author_signature || null, messageId: o.message_id ?? null }), date };
    return { kind: o.type || 'unknown', id: null, username: null, name: null, date };
  }
  // legacy-поля: у ботов на старых апдейтах forward_origin может не быть
  if (msg?.forward_from) return { ...who(msg.forward_from), date: msg.forward_date ? new Date(msg.forward_date * 1000).toISOString() : null };
  if (msg?.forward_from_chat) return { ...chat(msg.forward_from_chat, msg.forward_from_chat.type === 'channel' ? 'channel' : 'chat', { signature: msg.forward_signature || null, messageId: msg.forward_from_message_id ?? null }), date: msg.forward_date ? new Date(msg.forward_date * 1000).toISOString() : null };
  if (msg?.forward_sender_name) return { kind: 'hidden', id: null, username: null, name: msg.forward_sender_name, date: msg.forward_date ? new Date(msg.forward_date * 1000).toISOString() : null };
  return null;
}

// Человекочитаемо: «Аня (@meloch287)», «канал «Новости»», «скрытый: Аня».
export function forwardLabel(f) {
  if (!f) return '';
  const nm = f.name || (f.username ? `@${f.username}` : f.id ? `id ${f.id}` : 'кто-то');
  if (f.kind === 'channel') return `канал «${nm}»${f.signature ? `, подпись: ${f.signature}` : ''}`;
  if (f.kind === 'chat') return `чат «${nm}»${f.signature ? `, подпись: ${f.signature}` : ''}`;
  if (f.kind === 'hidden') return `${nm} (скрытый профиль)`;
  return nm + (f.username && f.name ? ` (@${f.username})` : '');
}

// На что отвечали: без этого в выгрузке теряется нитка разговора.
function replyInfo(msg) {
  const r = msg?.reply_to_message;
  if (!r) return null;
  const u = r.from || {};
  return {
    messageId: r.message_id ?? null,
    userId: u.id != null ? String(u.id) : null,
    username: u.username || null,
    name: [u.first_name, u.last_name].filter(Boolean).join(' ') || null,
    text: (r.text || r.caption || '').slice(0, 200) || null,
  };
}

// Что именно прислали: разбираем апдейт в понятную запись журнала.
export function describeMessage(msg) {
  if (!msg) return null;
  const base = {
    text: msg.text || msg.caption || null,
    forward: forwardOrigin(msg),
    replyTo: replyInfo(msg),
    albumId: msg.media_group_id || null,
  };
  if (msg.photo?.length) {
    const ph = msg.photo.at(-1);
    return { ...base, kind: 'photo', fileId: ph.file_id, size: ph.file_size };
  }
  if (msg.video) return { ...base, kind: 'video', fileId: msg.video.file_id, fileName: msg.video.file_name, mime: msg.video.mime_type, size: msg.video.file_size };
  if (msg.video_note) return { ...base, kind: 'video_note', fileId: msg.video_note.file_id, size: msg.video_note.file_size };
  if (msg.voice) return { ...base, kind: 'voice', fileId: msg.voice.file_id, mime: msg.voice.mime_type, size: msg.voice.file_size };
  if (msg.audio) return { ...base, kind: 'audio', fileId: msg.audio.file_id, fileName: msg.audio.file_name, mime: msg.audio.mime_type, size: msg.audio.file_size };
  if (msg.document) return { ...base, kind: 'document', fileId: msg.document.file_id, fileName: msg.document.file_name, mime: msg.document.mime_type, size: msg.document.file_size };
  if (msg.sticker) return { ...base, kind: 'sticker', fileId: msg.sticker.file_id, text: msg.sticker.emoji || null };
  if (msg.animation) return { ...base, kind: 'animation', fileId: msg.animation.file_id, mime: msg.animation.mime_type, size: msg.animation.file_size };
  if (msg.location) return { ...base, kind: 'location', text: `${msg.location.latitude},${msg.location.longitude}` };
  if (msg.contact) return { ...base, kind: 'contact', text: `${msg.contact.first_name || ''} ${msg.contact.phone_number || ''}`.trim() };
  if (msg.poll) return { ...base, kind: 'poll', text: msg.poll.question };
  if (msg.story) return { ...base, kind: 'story', text: msg.story.chat?.title || null };
  if (msg.dice) return { ...base, kind: 'dice', text: `${msg.dice.emoji || ''} ${msg.dice.value ?? ''}`.trim() || null };
  if (msg.venue) return { ...base, kind: 'venue', text: [msg.venue.title, msg.venue.address].filter(Boolean).join(', ') || null };
  // служебные события чата тоже стоит видеть в журнале
  if (msg.new_chat_members?.length) return { ...base, kind: 'join', text: msg.new_chat_members.map((u) => [u.first_name, u.username && '@' + u.username].filter(Boolean).join(' ')).join(', ') };
  if (msg.left_chat_member) return { ...base, kind: 'leave', text: [msg.left_chat_member.first_name, msg.left_chat_member.username && '@' + msg.left_chat_member.username].filter(Boolean).join(' ') };
  if (msg.pinned_message) return { ...base, kind: 'pin', text: (msg.pinned_message.text || msg.pinned_message.caption || '').slice(0, 200) || null };
  if (base.text) return { ...base, kind: 'text' };
  return { ...base, kind: 'other' };
}
