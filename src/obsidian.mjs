// Экспорт памяти в Obsidian-vault: заметки с [[связями]], чтобы Obsidian
// сам нарисовал граф (люди <-> дни <-> темы).
// Запуск: npm run obsidian  (или node src/obsidian.mjs [папка])

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const safe = (s) => String(s).replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Без имени';
const money = (v) => new Intl.NumberFormat('ru-RU').format(v) + ' ₽';

const TYPE_RU = { debt: 'долг', meeting: 'встреча', task: 'задача', note: 'заметка' };

export function exportVault(store, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  for (const sub of ['Люди', 'Дни', 'Темы']) mkdirSync(join(outDir, sub), { recursive: true });

  const entries = store.list();
  const facts = store.data.facts;
  const raw = store.data.raw;

  // Собираем сущности
  const people = new Map(); // имя -> {debts:[], facts:[], days:Set}
  const days = new Map(); // YYYY-MM-DD -> {raw:[], entries:[], facts:[]}
  const tags = new Map(); // тема -> {facts:[], days:Set}

  const person = (name) => {
    const key = safe(name);
    if (!people.has(key)) people.set(key, { debts: [], facts: [], days: new Set() });
    return people.get(key);
  };
  const day = (iso) => {
    const key = dayKey(iso);
    if (!days.has(key)) days.set(key, { raw: [], entries: [], facts: [] });
    return days.get(key);
  };
  const tag = (name) => {
    const key = safe(name).toLowerCase();
    if (!tags.has(key)) tags.set(key, { facts: [], days: new Set() });
    return tags.get(key);
  };

  for (const e of entries) {
    day(e.createdAt).entries.push(e);
    if (e.counterparty) {
      const p = person(e.counterparty);
      if (e.type === 'debt') p.debts.push(e);
      p.days.add(dayKey(e.createdAt));
    }
  }
  for (const r of raw) day(r.ts).raw.push(r);
  for (const f of facts) {
    day(f.ts).facts.push(f);
    for (const name of f.people || []) {
      const p = person(name);
      p.facts.push(f);
      p.days.add(dayKey(f.ts));
    }
    for (const t of f.tags || []) {
      const g = tag(t);
      g.facts.push(f);
      g.days.add(dayKey(f.ts));
    }
  }

  // Люди
  for (const [name, p] of people) {
    const lines = ['---', 'type: person', `name: ${name}`, '---', '', `# ${name}`, ''];
    if (p.debts.length) {
      lines.push('## Долги', '');
      for (const d of p.debts) {
        const dir = d.direction === 'out' ? 'мы должны' : 'должен нам';
        lines.push(`- ${dir} ${d.amount != null ? money(d.amount) : 'сумма не указана'}${d.due ? `, срок ${dayKey(d.due)}` : ''} (${d.status === 'open' ? 'открыт' : 'закрыт'})`);
      }
      lines.push('');
    }
    if (p.facts.length) {
      lines.push('## Упоминания', '');
      for (const f of p.facts.slice(-30)) {
        lines.push(`- ${f.text} ([[Дни/${dayKey(f.ts)}]])`);
      }
      lines.push('');
    }
    if (p.days.size) {
      lines.push('## Дни', '', [...p.days].sort().map((d) => `[[Дни/${d}]]`).join(' · '), '');
    }
    writeFileSync(join(outDir, 'Люди', `${name}.md`), lines.join('\n'));
  }

  // Дни
  for (const [key, d] of [...days.entries()].sort()) {
    const lines = ['---', 'type: day', `date: ${key}`, '---', '', `# ${key}`, ''];
    if (d.entries.length) {
      lines.push('## Записи', '');
      for (const e of d.entries) {
        const who = e.counterparty ? ` [[Люди/${safe(e.counterparty)}]]` : '';
        lines.push(`- (${TYPE_RU[e.type]}) ${e.title || e.text}${who}${e.amount != null ? `, ${money(e.amount)}` : ''}`);
      }
      lines.push('');
    }
    if (d.facts.length) {
      lines.push('## Факты', '');
      for (const f of d.facts) {
        const links = [
          ...(f.people || []).map((x) => `[[Люди/${safe(x)}]]`),
          ...(f.tags || []).map((x) => `[[Темы/${safe(x).toLowerCase()}]]`),
        ].join(' ');
        lines.push(`- ${f.text} ${links}`.trim());
      }
      lines.push('');
    }
    if (d.raw.length) {
      lines.push('## Дневник (сырые записи)', '');
      for (const r of d.raw) lines.push(`> ${r.text}`);
      lines.push('');
    }
    writeFileSync(join(outDir, 'Дни', `${key}.md`), lines.join('\n'));
  }

  // Темы
  for (const [name, g] of tags) {
    const lines = ['---', 'type: topic', `topic: ${name}`, '---', '', `# ${name}`, ''];
    for (const f of g.facts.slice(-40)) {
      lines.push(`- ${f.text} ([[Дни/${dayKey(f.ts)}]])`);
    }
    lines.push('', [...g.days].sort().map((d) => `[[Дни/${d}]]`).join(' · '), '');
    writeFileSync(join(outDir, 'Темы', `${name}.md`), lines.join('\n'));
  }

  // Обзор
  const open = entries.filter((e) => e.status === 'open');
  const overview = [
    '---',
    'type: overview',
    '---',
    '',
    '# Обзор памяти',
    '',
    `Записей: ${entries.length}. Открыто: ${open.length}. Фактов: ${facts.length}. Людей: ${people.size}.`,
    '',
    '## Люди',
    '',
    [...people.keys()].map((n) => `[[Люди/${n}]]`).join(' · ') || 'Пока никого.',
    '',
    '## Темы',
    '',
    [...tags.keys()].map((n) => `[[Темы/${n}]]`).join(' · ') || 'Пока пусто.',
    '',
    '## Дни',
    '',
    [...days.keys()].sort().map((d) => `[[Дни/${d}]]`).join(' · ') || 'Пока пусто.',
    '',
    'Откройте эту папку как Obsidian-vault и включите Graph View: связи людей, дней и тем нарисуются сами.',
    '',
  ].join('\n');
  writeFileSync(join(outDir, 'Обзор.md'), overview);

  return { people: people.size, days: days.size, topics: tags.size, entries: entries.length, facts: facts.length };
}

// CLI
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
  const out = process.argv[2] || join(ROOT, 'data', 'obsidian');
  const store = new Store(process.env.SM_DATA || join(ROOT, 'data', 'memory.json'));
  const stats = exportVault(store, out);
  console.log(`Obsidian-vault: ${out}`);
  console.log(`Людей: ${stats.people}, дней: ${stats.days}, тем: ${stats.topics}, записей: ${stats.entries}, фактов: ${stats.facts}`);
}
