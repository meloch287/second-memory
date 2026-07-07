// Файловое JSON-хранилище с атомарной записью (tmp + rename).
// Опционально шифруется на диске (AES-256-GCM) при заданном SM_ENCRYPTION_KEY.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, createHash, scryptSync } from 'node:crypto';

// Два формата шифрования на диске:
//  SMENC1 - ключ = sha256(пароль), без соли (легаси, только чтение);
//  SMENC2 - ключ = scrypt(пароль, соль из файла) - дорого брутфорсить.
const ENC_MAGIC1 = Buffer.from('SMENC1\n');
const ENC_MAGIC2 = Buffer.from('SMENC2\n');

const hasPass = () => Boolean(process.env.SM_ENCRYPTION_KEY);
const keyV1 = () => createHash('sha256').update(process.env.SM_ENCRYPTION_KEY).digest();
const keyV2 = (salt) => scryptSync(process.env.SM_ENCRYPTION_KEY, salt, 32);

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { seq: 0, entries: [], history: [], users: {}, raw: [], facts: [], personas: {}, meta: {}, recurring: [] };
    this.load();
  }

  load() {
    if (!existsSync(this.file)) return;
    let wasPlaintext = false;
    let isEncrypted = false;
    try {
      const buf = readFileSync(this.file);
      let text;
      const isV2 = buf.length >= 7 && buf.subarray(0, 7).equals(ENC_MAGIC2);
      const isV1 = !isV2 && buf.length >= 7 && buf.subarray(0, 7).equals(ENC_MAGIC1);
      if (isV1 || isV2) {
        isEncrypted = true;
        if (!hasPass()) throw new Error('данные зашифрованы, но SM_ENCRYPTION_KEY не задан');
        let off = 7;
        let key;
        if (isV2) {
          const salt = buf.subarray(off, off + 16);
          off += 16;
          key = keyV2(salt);
        } else {
          key = keyV1();
        }
        const iv = buf.subarray(off, off + 12);
        const tag = buf.subarray(off + 12, off + 28);
        const ct = buf.subarray(off + 28);
        const d = createDecipheriv('aes-256-gcm', key, iv);
        d.setAuthTag(tag);
        text = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
        if (isV1) this._needsRekey = true; // перешифруем в SMENC2 при первом save
      } else {
        text = buf.toString('utf8');
        wasPlaintext = true;
      }
      const parsed = JSON.parse(text);
      if (parsed && Array.isArray(parsed.entries)) {
        if (!Array.isArray(parsed.history)) parsed.history = [];
        if (!parsed.users || typeof parsed.users !== 'object') parsed.users = {};
        if (!Array.isArray(parsed.raw)) parsed.raw = [];
        if (!Array.isArray(parsed.facts)) parsed.facts = [];
        if (!parsed.personas || typeof parsed.personas !== 'object') parsed.personas = {};
        if (!parsed.meta || typeof parsed.meta !== 'object') parsed.meta = {};
        if (!Array.isArray(parsed.recurring)) parsed.recurring = [];
        this.data = parsed;
      }
    } catch (e) {
      // Зашифрованный файл не расшифровался (неверный/потерянный ключ) -
      // падаем сразу: иначе процесс стартует с пустой памятью и первый же
      // save() перезапишет настоящие данные.
      if (isEncrypted) {
        throw new Error(`не удалось расшифровать ${this.file}: ${e.message}. Проверь SM_ENCRYPTION_KEY - данные НЕ тронуты.`);
      }
      // повреждённый открытый JSON откладываем в сторону, данные не затираем молча
      copyFileSync(this.file, this.file + '.corrupt-' + Date.now());
      return;
    }
    // Миграция: файл был открытым, а ключ задан - перешифруем при первом сохранении
    if ((wasPlaintext || this._needsRekey) && hasPass()) this.save();
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const json = JSON.stringify(this.data, null, 2);
    let out;
    if (hasPass()) {
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', keyV2(salt), iv);
      const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
      out = Buffer.concat([ENC_MAGIC2, salt, iv, cipher.getAuthTag(), ct]);
    } else {
      out = Buffer.from(json, 'utf8');
    }
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, out);
    renameSync(tmp, this.file);
  }

  add(entry) {
    const e = {
      id: ++this.data.seq,
      status: 'open',
      createdAt: new Date().toISOString(),
      ...entry,
    };
    this.data.entries.push(e);
    this.save();
    return e;
  }

  byId(id) {
    return this.data.entries.find((e) => e.id === id) || null;
  }

  list({ type, status, chatId } = {}) {
    return this.data.entries
      .filter(
        (e) =>
          (!type || e.type === type) &&
          (!status || e.status === status) &&
          (!chatId || (e.chatId || 'web') === chatId)
      )
      .slice()
      .sort((a, b) => {
        if (a.due && b.due) return Date.parse(a.due) - Date.parse(b.due) || a.id - b.id;
        if (a.due) return -1;
        if (b.due) return 1;
        return a.id - b.id;
      });
  }

  setStatus(id, status) {
    const e = this.byId(id);
    if (!e) return null;
    e.status = status;
    this.save();
    return e;
  }

  remove(id) {
    const i = this.data.entries.findIndex((e) => e.id === id);
    if (i < 0) return null;
    const [e] = this.data.entries.splice(i, 1);
    this.save();
    return e;
  }

  patch(id, fields) {
    const e = this.byId(id);
    if (!e) return null;
    Object.assign(e, fields);
    this.save();
    return e;
  }

  // Нечёткий поиск открытой записи пользователя по номеру/имени/тексту.
  findEntry(chatId, target) {
    const t = String(target).replace(/^№\s*/, '').trim();
    if (/^\d+$/.test(t)) {
      const e = this.byId(+t);
      return e && (e.chatId || 'web') === chatId ? e : null;
    }
    const nt = t.toLowerCase().replace(/ё/g, 'е');
    const words = nt.split(/\s+/).filter((w) => w.length > 2);
    // лёгкий стемминг: падежи меняют окончания («встречу» vs «встреча»)
    const hit = (hay, w) => hay.includes(w) || (w.length > 4 && hay.includes(w.slice(0, -2)));
    const open = this.list({ status: 'open', chatId });
    let best = null;
    let bestScore = 0;
    for (const e of open) {
      const hay = [e.counterparty, e.title, e.text].filter(Boolean).join(' ').toLowerCase().replace(/ё/g, 'е');
      const score = words.reduce((s, w) => s + (hit(hay, w) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return bestScore > 0 ? best : null;
  }

  // Просроченные дела пользователя (со сроком в прошлом), свежие первыми.
  overdue(chatId, now = Date.now()) {
    return this.list({ status: 'open', chatId })
      .filter((e) => e.due && Date.parse(e.due) < now)
      .sort((a, b) => Date.parse(b.due) - Date.parse(a.due));
  }

  // Записи со сроком-временем, которым пора напомнить: срабатывают за
  // leadMin до срока и до конца окна после; не напомненные.
  dueReminders(chatId, now = Date.now(), leadMin = 0, windowMs = 6 * 3600000) {
    const lead = leadMin * 60000;
    return this.list({ status: 'open', chatId }).filter(
      (e) => e.hasTime && e.due && !e.reminded && Date.parse(e.due) - lead <= now && Date.parse(e.due) >= now - windowMs
    );
  }

  // --- Повторяющиеся напоминания ---
  addRecurring(rec) {
    const r = { id: ++this.data.seq, createdAt: new Date().toISOString(), lastFired: null, ...rec };
    this.data.recurring.push(r);
    this.save();
    return r;
  }

  recurringFor(chatId) {
    return this.data.recurring.filter((r) => r.chatId === chatId);
  }

  markRecurringFired(id, dayKey) {
    const r = this.data.recurring.find((x) => x.id === id);
    if (r) {
      r.lastFired = dayKey;
      this.save();
    }
  }

  // История диалога — контекст для ИИ. chatId разделяет веб ('web') и телеграм-чаты.
  pushHistory(role, text, chatId = 'web') {
    this.data.history.push({ role, chatId, text: String(text).slice(0, 1000), ts: new Date().toISOString() });
    if (this.data.history.length > 400) this.data.history.splice(0, this.data.history.length - 400);
    this.save();
  }

  recentHistory(n = 30, chatId = null) {
    const list = chatId ? this.data.history.filter((h) => (h.chatId || 'web') === chatId) : this.data.history;
    return list.slice(-n);
  }

  clearHistory(chatId = null) {
    if (chatId) this.data.history = this.data.history.filter((h) => (h.chatId || 'web') !== chatId);
    else this.data.history = [];
    this.save();
  }

  // Профиль пользователя бота (онбординг «друга»).
  getUser(chatId) {
    return this.data.users[chatId] || null;
  }

  setUser(chatId, patch) {
    this.data.users[chatId] = { ...(this.data.users[chatId] || {}), ...patch };
    this.save();
    return this.data.users[chatId];
  }

  // БД №1: сырой поток сообщений пользователя.
  addRaw(chatId, text) {
    const item = { id: ++this.data.seq, chatId, text: String(text).slice(0, 1500), ts: new Date().toISOString(), processed: false };
    this.data.raw.push(item);
    if (this.data.raw.length > 2000) this.data.raw.splice(0, this.data.raw.length - 2000);
    this.save();
    return item;
  }

  unprocessedRaw(limit = 30) {
    return this.data.raw.filter((r) => !r.processed).slice(0, limit);
  }

  markRawProcessed(ids) {
    const set = new Set(ids);
    for (const r of this.data.raw) if (set.has(r.id)) r.processed = true;
    this.save();
  }

  rawForDay(chatId, dayStart, dayEnd) {
    return this.data.raw.filter((r) => r.chatId === chatId && Date.parse(r.ts) >= dayStart && Date.parse(r.ts) < dayEnd);
  }

  // БД №2: структурированные факты после суммаризации (её читает RAG).
  addFacts(list) {
    for (const f of list) {
      this.data.facts.push({ id: ++this.data.seq, ts: new Date().toISOString(), people: [], tags: [], ...f });
    }
    if (this.data.facts.length > 3000) this.data.facts.splice(0, this.data.facts.length - 3000);
    this.save();
  }

  // Полный сброс по пользователю (/reset у бота): профиль, сырые записи,
  // факты, история И все его деловые записи (долги, встречи, задачи).
  clearChatData(chatId) {
    delete this.data.users[chatId];
    this.data.raw = this.data.raw.filter((r) => r.chatId !== chatId);
    this.data.facts = this.data.facts.filter((f) => f.chatId !== chatId);
    this.data.history = this.data.history.filter((h) => (h.chatId || 'web') !== chatId);
    this.data.entries = this.data.entries.filter((e) => (e.chatId || 'web') !== chatId);
    this.save();
  }

  // Досье людей (обновляет ночная консолидация).
  getPersonas(chatId) {
    return this.data.personas[chatId] || {};
  }

  // Забыть факты по запросу («забудь про Петрова»). Возвращает число удалённых.
  removeFactsMatching(chatId, query) {
    const words = String(query).toLowerCase().replace(/ё/g, 'е').split(/[^а-яa-z0-9]+/).filter((w) => w.length > 3);
    if (!words.length) return 0;
    const hit = (hay, w) => hay.includes(w) || (w.length > 4 && hay.includes(w.slice(0, -2)));
    const before = this.data.facts.length;
    this.data.facts = this.data.facts.filter((f) => {
      if (f.chatId !== chatId) return true;
      const hay = (f.text + ' ' + (f.people || []).join(' ') + ' ' + (f.tags || []).join(' ')).toLowerCase().replace(/ё/g, 'е');
      return !words.some((w) => hit(hay, w));
    });
    // заодно чистим досье упомянутых людей
    const personas = this.data.personas[chatId];
    if (personas) {
      for (const name of Object.keys(personas)) {
        const n = name.toLowerCase().replace(/ё/g, 'е');
        if (words.some((w) => hit(n, w))) delete personas[name];
      }
    }
    this.save();
    return before - this.data.facts.length;
  }

  // Забыть последние N фактов чата («нет, это было не так»).
  removeRecentFacts(chatId, n = 1) {
    const ids = this.data.facts.filter((f) => f.chatId === chatId).slice(-n).map((f) => f.id);
    const set = new Set(ids);
    this.data.facts = this.data.facts.filter((f) => !set.has(f.id));
    this.save();
    return ids.length;
  }

  setPersonas(chatId, map) {
    this.data.personas[chatId] = map;
    this.save();
  }

  // Замена старых фактов чата консолидированными (свежие остаются как есть).
  replaceOldFacts(chatId, olderThanMs, newFacts) {
    const cutoff = Date.now() - olderThanMs;
    const fresh = this.data.facts.filter((f) => f.chatId !== chatId || Date.parse(f.ts) >= cutoff);
    const consolidated = newFacts.map((f) => ({
      id: ++this.data.seq,
      chatId,
      ts: new Date().toISOString(),
      people: [],
      tags: [],
      ...f,
    }));
    this.data.facts = [...consolidated, ...fresh];
    this.save();
  }

  hasEmbeddings(chatId) {
    return this.data.facts.some((f) => (!chatId || f.chatId === chatId) && Array.isArray(f.embedding));
  }

  // Косинусная близость: вектора нормированы у OpenAI-эмбеддингов,
  // поэтому достаточно скалярного произведения.
  factsByVector(chatId, queryVector, limit = 25) {
    const scored = [];
    for (const f of this.data.facts) {
      if (chatId && f.chatId !== chatId) continue;
      if (!Array.isArray(f.embedding)) continue;
      let dot = 0;
      const n = Math.min(queryVector.length, f.embedding.length);
      for (let i = 0; i < n; i++) dot += queryVector[i] * f.embedding[i];
      scored.push({ f, dot });
    }
    return scored
      .sort((a, b) => b.dot - a.dot)
      .slice(0, limit)
      .filter((x) => x.dot > 0.2)
      .map((x) => x.f);
  }

  // Резервная копия файла данных, храним последние 14.
  backup() {
    if (!existsSync(this.file)) return null;
    const dir = join(dirname(this.file), 'backups');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const dest = join(dir, `memory-${stamp}.json`);
    copyFileSync(this.file, dest);
    const old = readdirSync(dir).filter((f) => f.startsWith('memory-')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 14))) rmSync(join(dir, f), { force: true });
    return dest;
  }

  // Простой keyword-RAG: свежие факты + совпадения по словам запроса.
  factsFor(chatId, query = '', limit = 25) {
    const mine = this.data.facts.filter((f) => !chatId || f.chatId === chatId);
    const words = String(query).toLowerCase().split(/[^а-яёa-z0-9]+/).filter((w) => w.length > 3);
    const scored = mine.map((f) => {
      const hay = (f.text + ' ' + (f.people || []).join(' ') + ' ' + (f.tags || []).join(' ')).toLowerCase();
      const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
      return { f, score };
    });
    const matched = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).map((x) => x.f);
    const recent = mine.slice(-12);
    const seen = new Set();
    const out = [];
    for (const f of [...matched, ...recent]) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f);
      if (out.length >= limit) break;
    }
    return out;
  }
}
