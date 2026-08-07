// Админ-журнал: полная запись всего, что прилетает в чат, — включается
// командой /admin (только владелец бота).
//
// Зачем: чтобы потом можно было поднять историю «кто что прислал и когда» и
// скормить её ИИ. Пишем КТО (id, @ник, имя), КОГДА, ГДЕ (чат) и ЧТО (тип,
// текст, файл: file_id/имя/mime/размер).
//
// Функции работают НАД store (а не методами Store): store.mjs держим в пределах
// 700 строк по конвенции проекта.

const LIMIT = 20000; // потолок записей, чтобы файл памяти не рос бесконечно

const ensure = (store) => {
  if (!Array.isArray(store.data.adminLog)) store.data.adminLog = [];
  return store.data.adminLog;
};

// Включён ли режим для конкретного чата.
export function adminLogOn(store, chatId) {
  return Boolean((store.data.meta.adminLogChats || {})[String(chatId)]);
}

export function setAdminLog(store, chatId, on) {
  const map = { ...(store.data.meta.adminLogChats || {}) };
  if (on) map[String(chatId)] = true;
  else delete map[String(chatId)];
  store.data.meta.adminLogChats = map;
  store.save();
  return on;
}

// Одна запись журнала.
export function logAdmin(store, entry) {
  const log = ensure(store);
  const rec = {
    id: ++store.data.seq,
    ts: new Date().toISOString(),
    chatId: String(entry.chatId || ''),
    chatTitle: entry.chatTitle || null,
    userId: entry.userId != null ? String(entry.userId) : null,
    username: entry.username || null,
    name: entry.name || null,
    kind: entry.kind || 'text', // text | photo | video | audio | voice | document | sticker | ...
    text: entry.text ? String(entry.text).slice(0, 2000) : null,
    fileId: entry.fileId || null,
    fileName: entry.fileName || null,
    mime: entry.mime || null,
    size: Number.isFinite(entry.size) ? entry.size : null,
    // Пересланное: кто АВТОР оригинала (в userId выше - только тот, кто переслал)
    forward: entry.forward || null,
    // Ответ на сообщение: без этого переписка в выгрузке теряет нитку
    replyTo: entry.replyTo || null,
    // Альбом (несколько фото одним отправлением) приходит пачкой отдельных
    // сообщений с общим id - по нему их потом можно склеить обратно
    albumId: entry.albumId || null,
  };
  log.push(rec);
  if (log.length > LIMIT) log.splice(0, log.length - LIMIT);
  store.save();
  return rec;
}

export function adminLogList(store, { chatId = null, limit = 100 } = {}) {
  const log = ensure(store);
  const all = chatId ? log.filter((r) => r.chatId === String(chatId)) : log;
  return all.slice(-limit);
}

export function adminLogStats(store, chatId = null) {
  const log = ensure(store);
  const all = chatId ? log.filter((r) => r.chatId === String(chatId)) : log;
  const byKind = {};
  const byUser = {};
  for (const r of all) {
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    const who = r.name || r.username || r.userId || '?';
    byUser[who] = (byUser[who] || 0) + 1;
  }
  return { total: all.length, byKind, byUser, first: all[0]?.ts || null, last: all.at(-1)?.ts || null };
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
