// Файловое JSON-хранилище с атомарной записью (tmp + rename).

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { seq: 0, entries: [], history: [] };
    this.load();
  }

  load() {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed && Array.isArray(parsed.entries)) {
        if (!Array.isArray(parsed.history)) parsed.history = [];
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

  // История диалога — контекст для ИИ-саммари и свободных вопросов.
  pushHistory(role, text) {
    this.data.history.push({ role, text: String(text).slice(0, 1000), ts: new Date().toISOString() });
    if (this.data.history.length > 200) this.data.history.splice(0, this.data.history.length - 200);
    this.save();
  }

  recentHistory(n = 30) {
    return this.data.history.slice(-n);
  }

  clearHistory() {
    this.data.history = [];
    this.save();
  }
}
