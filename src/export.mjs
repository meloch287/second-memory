// Экспорт всей памяти пользователя: CSV (открывается в Excel), JSON, Markdown.
// Всё по одному пользователю (chatId), без чужих данных.

const pad = (n) => String(n).padStart(2, '0');
function fmt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const TYPE_RU = { debt: 'долг', meeting: 'встреча', task: 'задача', note: 'заметка' };

// CSV с BOM, чтобы Excel сразу видел кириллицу в UTF-8; разделитель «;» (RU-Excel).
export function toCsv(store, chatId) {
  if (!chatId) return '﻿id;тип;название'; // не выгружаем всё при пустом chatId
  const rows = [['id', 'тип', 'название', 'контрагент', 'сумма', 'направление', 'срок', 'статус', 'создано']];
  for (const e of store.list({ chatId })) {
    rows.push([
      e.id,
      TYPE_RU[e.type] || e.type,
      e.title || '',
      e.counterparty || '',
      e.amount != null ? e.amount : '',
      e.type === 'debt' ? (e.direction === 'out' ? 'мы должны' : 'должны нам') : '',
      fmt(e.due),
      e.status === 'done' ? 'закрыто' : 'открыто',
      fmt(e.createdAt),
    ]);
  }
  const esc = (v) => {
    let s = String(v);
    // защита от формул Excel: значения с =,+,-,@ в начале обезвреживаем
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n');
}

// Полный срез памяти пользователя одним JSON.
export function toJson(store, chatId) {
  if (!chatId) return '{}';
  const slice = {
    exportedAt: new Date().toISOString(),
    user: store.getUser(chatId),
    entries: store.list({ chatId }),
    facts: store.data.facts.filter((f) => f.chatId === chatId).map(({ embedding, ...f }) => f),
    personas: store.getPersonas(chatId),
    recurring: store.recurringFor(chatId),
    diary: store.data.raw.filter((r) => r.chatId === chatId).map(({ processed, ...r }) => r),
  };
  return JSON.stringify(slice, null, 2);
}

// Человекочитаемый дневник в Markdown: по дням, с фактами и записями.
export function toMarkdown(store, chatId) {
  if (!chatId) return '# Пусто';
  const user = store.getUser(chatId);
  const byDay = new Map();
  const add = (day, line) => {
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(line);
  };
  const dayOf = (iso) => (iso || '').slice(0, 10);

  for (const r of store.data.raw.filter((x) => x.chatId === chatId)) add(dayOf(r.ts), `> ${r.text}`);
  for (const f of store.data.facts.filter((x) => x.chatId === chatId)) add(dayOf(f.ts), `- ${f.text}`);
  for (const e of store.list({ chatId })) {
    const extra = [e.counterparty, e.amount != null ? e.amount + ' руб' : null, e.due ? 'срок ' + fmt(e.due) : null].filter(Boolean).join(', ');
    add(dayOf(e.createdAt), `- (${TYPE_RU[e.type]}) ${e.title || ''}${extra ? ' — ' + extra : ''}`);
  }

  const lines = [`# Моя вторая память${user?.name ? ` — ${user.name}` : ''}`, '', `Экспорт: ${fmt(new Date().toISOString())}`, ''];
  for (const day of [...byDay.keys()].sort().reverse()) {
    lines.push(`## ${day}`, '', ...byDay.get(day), '');
  }
  const people = store.getPersonas(chatId);
  if (Object.keys(people).length) {
    lines.push('## Люди', '');
    for (const [name, note] of Object.entries(people)) lines.push(`- **${name}**: ${note}`);
  }
  return lines.join('\n');
}
