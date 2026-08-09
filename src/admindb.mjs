// ОТДЕЛЬНАЯ база админ-журнала: собственный файл, не память бота.
//
// Почему не в memory.json: журнал пишет ВСЁ подряд (пересланные пачки по 20-50
// сообщений), и он не должен ни раздувать основную базу, ни попадать в контекст
// ИИ, ни пересохраняться целиком на каждую запись. Формат - JSONL: одна строка
// на сообщение, дописывается в конец.
//
// Шифрование - как у основной базы (AES-256-GCM с ключом из SM_ENCRYPTION_KEY),
// но построчно: иначе append превратился бы в перезапись всего файла.

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const LIMIT = 50000; // строк; выше - обрезаем старое при следующей записи
const SALT = Buffer.from('second-memory-admin-log-v1');

const hasPass = () => Boolean(process.env.SM_ENCRYPTION_KEY);
let _key = null;
const key = () => {
  if (!_key) _key = scryptSync(process.env.SM_ENCRYPTION_KEY, SALT, 32);
  return _key;
};

const encodeLine = (obj) => {
  const json = JSON.stringify(obj);
  if (!hasPass()) return json;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(json, 'utf8'), c.final()]);
  return 'E:' + Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
};

const decodeLine = (line) => {
  const s = String(line).trim();
  if (!s) return null;
  try {
    if (!s.startsWith('E:')) return JSON.parse(s);
    if (!hasPass()) return null; // зашифровано, а ключа нет - молча пропускаем
    const buf = Buffer.from(s.slice(2), 'base64');
    const d = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
  } catch {
    return null; // битую строку не роняем на весь журнал
  }
};

export class AdminDb {
  constructor(file) {
    this.file = file || join(process.env.SM_DATA ? dirname(process.env.SM_DATA) : 'data', 'admin-log.jsonl');
    this.flagsFile = this.file.replace(/\.jsonl$/, '') + '-flags.json';
    mkdirSync(dirname(this.file), { recursive: true });
    this.flags = this._readFlags();
    this._seq = 0;
  }

  _readFlags() {
    try {
      const raw = JSON.parse(readFileSync(this.flagsFile, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  _writeFlags() {
    const tmp = this.flagsFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.flags));
    renameSync(tmp, this.flagsFile);
  }

  // Пишем ли этот чат.
  isOn(chatId) {
    return Boolean(this.flags[String(chatId)]);
  }

  setOn(chatId, on) {
    if (on) this.flags[String(chatId)] = true;
    else delete this.flags[String(chatId)];
    this._writeFlags();
    return on;
  }

  onChats() {
    return Object.keys(this.flags);
  }

  append(entry) {
    const rec = {
      id: ++this._seq,
      ts: new Date().toISOString(),
      chatId: String(entry.chatId || ''),
      chatTitle: entry.chatTitle || null,
      userId: entry.userId != null ? String(entry.userId) : null,
      username: entry.username || null,
      name: entry.name || null,
      kind: entry.kind || 'text',
      text: entry.text ? String(entry.text).slice(0, 4000) : null,
      fileId: entry.fileId || null,
      fileName: entry.fileName || null,
      mime: entry.mime || null,
      size: Number.isFinite(entry.size) ? entry.size : null,
      forward: entry.forward || null,
      replyTo: entry.replyTo || null,
      albumId: entry.albumId || null,
    };
    appendFileSync(this.file, encodeLine(rec) + '\n');
    return rec;
  }

  all() {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8').split('\n').map(decodeLine).filter(Boolean);
  }

  list({ chatId = null, limit = 100 } = {}) {
    const rows = this.all();
    const filtered = chatId ? rows.filter((r) => r.chatId === String(chatId)) : rows;
    return filtered.slice(-limit);
  }

  stats(chatId = null) {
    const rows = chatId ? this.all().filter((r) => r.chatId === String(chatId)) : this.all();
    const byKind = {};
    const byUser = {};
    for (const r of rows) {
      byKind[r.kind] = (byKind[r.kind] || 0) + 1;
      const who = r.name || r.username || r.userId || '?';
      byUser[who] = (byUser[who] || 0) + 1;
    }
    return { total: rows.length, byKind, byUser, first: rows[0]?.ts || null, last: rows.at(-1)?.ts || null };
  }

  // Обрезка старого: файл не должен расти бесконечно.
  trim(limit = LIMIT) {
    const rows = this.all();
    if (rows.length <= limit) return 0;
    const keep = rows.slice(-limit);
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, keep.map((r) => encodeLine(r) + '\n').join(''));
    renameSync(tmp, this.file);
    return rows.length - keep.length;
  }

  clear(chatId = null) {
    if (!chatId) {
      writeFileSync(this.file, '');
      return;
    }
    const keep = this.all().filter((r) => r.chatId !== String(chatId));
    writeFileSync(this.file, keep.map((r) => encodeLine(r) + '\n').join(''));
  }
}
