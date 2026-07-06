// Файловое JSON-хранилище с атомарной записью (tmp + rename).

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { seq: 0, entries: [], history: [], users: {}, raw: [], facts: [] };
    this.load();
  }

  load() {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed && Array.isArray(parsed.entries)) {
        if (!Array.isArray(parsed.history)) parsed.history = [];
        if (!parsed.users || typeof parsed.users !== 'object') parsed.users = {};
        if (!Array.isArray(parsed.raw)) parsed.raw = [];
        if (!Array.isArray(parsed.facts)) parsed.facts = [];
        this.data = parsed;
      }
    } catch {
      // повреждённый файл откладываем в сторону, данные не затираем молча
      copyFileSync(this.file, this.file + '.corrupt-' + Date.now());
    }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
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

  list({ type, status } = {}) {
    return this.data.entries
      .filter((e) => (!type || e.type === type) && (!status || e.status === status))
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
