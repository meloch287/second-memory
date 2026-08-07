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

// Что именно прислали: разбираем апдейт в понятную запись журнала.
export function describeMessage(msg) {
  if (!msg) return null;
  const base = { text: msg.text || msg.caption || null };
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
  if (base.text) return { ...base, kind: 'text' };
  return { ...base, kind: 'other' };
}
