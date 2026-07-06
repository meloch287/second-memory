// «Мозг» ассистента: превращает разобранную фразу в действие над хранилищем
// и человеческий ответ на русском.

import { parseMessage } from './parser.mjs';
import { normText } from './dates.mjs';
import { aiEnabled, aiSummary, aiAnswer } from './ai.mjs';

const RUB = new Intl.NumberFormat('ru-RU');
const money = (v) => `${RUB.format(v)} ₽`;
const pad = (n) => String(n).padStart(2, '0');

const TYPE_LABEL = { debt: 'долг', meeting: 'встреча', task: 'задача', note: 'заметка' };
const LIST_LABEL = { meeting: 'Встречи', task: 'Задачи', note: 'Заметки' };

const HELP = [
  'Я ваша вторая память. Пишите обычным языком.',
  '',
  'Записать:',
  '• «клиент должен 50 000 до 20 июля» - долг',
  '• «я должен подрядчику 15к до пятницы» - мой долг',
  '• «встреча с командой завтра в 15:00»',
  '• «напомни оплатить счёт через 3 дня» - задача',
  '• всё остальное сохраню заметкой',
  '',
  'Спросить:',
  '• «покажи все долги», «сколько мне должны»',
  '• «что у меня завтра», «сводка»',
  '• «саммари» - умная сводка от ИИ',
  '• вопрос со знаком «?» - ответ ИИ по вашим данным',
  '',
  'Команды: «готово 3», «удали 5», «очистить чат».',
].join('\n');

function fmtDate(iso, hasTime) {
  const d = new Date(iso);
  const s = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  return hasTime ? `${s} ${pad(d.getHours())}:${pad(d.getMinutes())}` : s;
}

function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const byDue = (a, b) => Date.parse(a.due || '9999-01-01') - Date.parse(b.due || '9999-01-01') || a.id - b.id;

export async function handleMessage(store, text, now = new Date(), chatId = 'web') {
  const result = await route(store, text, now);
  const t = String(text || '').trim();
  if (t && !result.cleared) {
    store.pushHistory('user', t, chatId);
    store.pushHistory('assistant', result.reply, chatId);
  }
  return result;
}

// Тихая запись для бота-друга: структурируем долги, встречи и задачи,
// не подменяя живой ответ ИИ. Заметки не дублируем, они уже в сырой базе.
export function captureEntry(store, text, now = new Date()) {
  const p = parseMessage(text, now);
  if (p.kind !== 'entry' || p.entry.type === 'note') return null;
  return store.add(p.entry);
}

async function route(store, text, now) {
  const p = parseMessage(text, now);
  switch (p.kind) {
    case 'empty':
      return {
        reply:
          'Напишите, что записать или показать. Пример: «клиент должен 50 000 до 20 июля». Команда «помощь» покажет всё.',
      };
    case 'help':
      return { reply: HELP };
    case 'summary': {
      if (!aiEnabled()) {
        return {
          reply: 'ИИ-саммари не настроено. Задайте AI_API_KEY в файле .env. Инструкция в README.',
        };
      }
      try {
        return { reply: await aiSummary(store, now), ai: true };
      } catch (e) {
        return { reply: `Не получилось связаться с ИИ (${e.message}). Попробуйте ещё раз.` };
      }
    }
    case 'clearchat':
      store.clearHistory();
      return { reply: 'Чат очищен. Записи в памяти остались.', cleared: true };
    case 'entry': {
      // Фраза со знаком «?» — это вопрос, а не запись: отдаём ИИ с контекстом
      // базы (иначе «у кого из должников горит срок?» станет мусорным долгом).
      if (aiEnabled() && /\?\s*$/.test(String(text).trim())) {
        try {
          return { reply: await aiAnswer(store, text, now), ai: true };
        } catch {
          // ИИ недоступен — обрабатываем по правилам ниже
        }
      }
      return saveEntry(store, p.entry);
    }
    case 'done':
      return markDone(store, p.target);
    case 'delete':
      return removeEntry(store, p.target);
    case 'query':
      return runQuery(store, p, now);
    case 'digest':
      return digest(store, p.range, now);
    default:
      return { reply: 'Не понял. Напишите «помощь», чтобы увидеть примеры.' };
  }
}

function saveEntry(store, entry) {
  const e = store.add(entry);
  let reply;
  if (e.type === 'debt') {
    const sum = e.amount != null ? money(e.amount) : 'сумма не указана';
    const till = e.due ? `, срок до ${fmtDate(e.due, false)}` : '';
    if (e.direction === 'out') {
      reply = `Записал долг №${e.id}: вы должны${e.counterparty ? ' ' + e.counterparty : ''} ${sum}${till}.`;
    } else if (e.counterparty) {
      reply = `Записал долг №${e.id}: ${e.counterparty} должен вам ${sum}${till}.`;
    } else {
      reply = `Записал долг №${e.id}: вам должны ${sum}${till}.`;
    }
  } else if (e.type === 'meeting') {
    reply = `Записал встречу №${e.id}: ${e.title}${e.due ? `, ${fmtDate(e.due, e.hasTime)}` : ', дата не указана'}.`;
  } else if (e.type === 'task') {
    reply = `Записал задачу №${e.id}: ${e.title}${e.due ? `, срок ${fmtDate(e.due, e.hasTime)}` : ''}.`;
  } else {
    reply = `Сохранил заметку №${e.id}: «${e.title}».`;
  }
  return { reply, entry: e };
}

function findTarget(store, target) {
  const t = target.replace(/^№\s*/, '').trim();
  if (/^\d+$/.test(t)) return store.byId(+t);
  const nt = normText(t);
  return (
    store
      .list({ status: 'open' })
      .find((x) => [x.counterparty, x.title, x.text].some((f) => f && normText(f).includes(nt))) || null
  );
}

function markDone(store, target) {
  const e = findTarget(store, target);
  if (!e) return { reply: `Не нашёл запись «${target}».` };
  if (e.status === 'done') return { reply: `Запись №${e.id} уже закрыта.` };
  store.setStatus(e.id, 'done');
  return { reply: `Готово: ${TYPE_LABEL[e.type]} №${e.id} закрыта.`, entry: e };
}

function removeEntry(store, target) {
  const e = findTarget(store, target);
  if (!e) return { reply: `Не нашёл запись «${target}».` };
  store.remove(e.id);
  return { reply: `Удалил: ${TYPE_LABEL[e.type]} №${e.id}.`, entry: e };
}

function runQuery(store, q, now) {
  if (q.type === 'debt') return debtsReply(store, q, now);

  const open = store.list({ type: q.type, status: 'open' });
  let items = open;
  if (q.range) {
    const from = startOfDay(q.range.from).getTime();
    const to = from + q.range.days * 86400000;
    items = open.filter((e) => e.due && Date.parse(e.due) >= from && Date.parse(e.due) < to);
  }
  items = items.slice().sort(byDue);

  if (!items.length) {
    return { reply: `${LIST_LABEL[q.type]}: ничего не найдено${q.range ? ' в этот период' : ''}.`, results: [] };
  }
  const lines = [`${LIST_LABEL[q.type]} (${items.length}):`];
  for (const e of items) {
    lines.push(`  №${e.id} ${e.title}${e.due ? ` - ${fmtDate(e.due, e.hasTime)}` : ''}`);
  }
  return { reply: lines.join('\n'), results: items };
}

function debtsReply(store, q, now) {
  let debts = store.list({ type: 'debt', status: 'open' });
  if (q.direction) debts = debts.filter((d) => (d.direction === 'out') === (q.direction === 'out'));

  const inD = debts.filter((d) => d.direction !== 'out').sort(byDue);
  const outD = debts.filter((d) => d.direction === 'out').sort(byDue);
  const total = (arr) => arr.reduce((s, d) => s + (d.amount || 0), 0);
  const today = startOfDay(now).getTime();

  if (q.aggregate) {
    const parts = [];
    if (!q.direction || q.direction === 'in') {
      parts.push(`Вам должны: ${money(total(inD))} (${inD.length} ${plural(inD.length, ['долг', 'долга', 'долгов'])})`);
    }
    if (!q.direction || q.direction === 'out') {
      parts.push(`Вы должны: ${money(total(outD))} (${outD.length} ${plural(outD.length, ['долг', 'долга', 'долгов'])})`);
    }
    return { reply: parts.join('. ') + '.', results: debts };
  }

  if (!debts.length) return { reply: 'Открытых долгов нет.', results: [] };

  const line = (d) => {
    const overdue = d.due && Date.parse(d.due) < today ? ' - ПРОСРОЧЕН' : '';
    const sum = d.amount != null ? money(d.amount) : 'сумма не указана';
    return `  №${d.id} ${d.counterparty || 'без имени'} - ${sum}${d.due ? `, до ${fmtDate(d.due, false)}` : ''}${overdue}`;
  };

  const lines = [`Открытые долги (${debts.length}):`];
  if (inD.length) {
    lines.push('Вам должны:');
    inD.forEach((d) => lines.push(line(d)));
    lines.push(`  Итого: ${money(total(inD))}`);
  }
  if (outD.length) {
    lines.push('Вы должны:');
    outD.forEach((d) => lines.push(line(d)));
    lines.push(`  Итого: ${money(total(outD))}`);
  }
  return { reply: lines.join('\n'), results: debts };
}

function digest(store, range, now) {
  const open = store.list({ status: 'open' });
  const today = startOfDay(now).getTime();

  if (!range) {
    const debts = open.filter((e) => e.type === 'debt');
    const meetings = open.filter((e) => e.type === 'meeting');
    const tasks = open.filter((e) => e.type === 'task');
    const notes = open.filter((e) => e.type === 'note');
    if (!open.length) return { reply: 'Пока пусто. Напишите что-нибудь, я запомню. Команда «помощь» покажет примеры.' };

    const lines = [
      `Общая картина: ${debts.length} ${plural(debts.length, ['долг', 'долга', 'долгов'])}, ` +
        `${meetings.length} ${plural(meetings.length, ['встреча', 'встречи', 'встреч'])}, ` +
        `${tasks.length} ${plural(tasks.length, ['задача', 'задачи', 'задач'])}, ` +
        `${notes.length} ${plural(notes.length, ['заметка', 'заметки', 'заметок'])}.`,
    ];
    const inD = debts.filter((d) => d.direction !== 'out');
    const outD = debts.filter((d) => d.direction === 'out');
    if (debts.length) {
      const t = [];
      if (inD.length) t.push(`вам должны ${money(inD.reduce((s, d) => s + (d.amount || 0), 0))}`);
      if (outD.length) t.push(`вы должны ${money(outD.reduce((s, d) => s + (d.amount || 0), 0))}`);
      lines.push(`Долги: ${t.join(', ')}.`);
    }
    const upcoming = meetings.filter((e) => e.due && Date.parse(e.due) >= today).sort(byDue).slice(0, 5);
    if (upcoming.length) {
      lines.push('Ближайшие встречи:');
      upcoming.forEach((e) => lines.push(`  №${e.id} ${e.title} - ${fmtDate(e.due, e.hasTime)}`));
    }
    if (tasks.length) {
      lines.push('Открытые задачи:');
      tasks.slice(0, 7).forEach((e) => lines.push(`  №${e.id} ${e.title}${e.due ? ` - ${fmtDate(e.due, e.hasTime)}` : ''}`));
    }
    return { reply: lines.join('\n'), results: open };
  }

  const from = startOfDay(range.from).getTime();
  const days = range.days || 1;
  const to = from + days * 86400000;
  const inRange = (e) => e.due && Date.parse(e.due) >= from && Date.parse(e.due) < to;

  const meetings = open.filter((e) => e.type === 'meeting' && inRange(e)).sort(byDue);
  const tasks = open.filter((e) => e.type === 'task' && inRange(e)).sort(byDue);
  const debtsDue = open.filter((e) => e.type === 'debt' && inRange(e)).sort(byDue);
  const overdue = open.filter((e) => e.type === 'debt' && e.due && Date.parse(e.due) < today).sort(byDue);

  const fmtTs = (ms) => fmtDate(new Date(ms).toISOString(), false);
  const title = days > 1 ? `Сводка с ${fmtTs(from)} по ${fmtTs(to - 86400000)}:` : `Сводка на ${fmtTs(from)}:`;
  const lines = [title];

  if (meetings.length) {
    lines.push('Встречи:');
    meetings.forEach((e) => lines.push(`  №${e.id} ${e.title} - ${fmtDate(e.due, e.hasTime)}`));
  }
  if (tasks.length) {
    lines.push('Задачи:');
    tasks.forEach((e) => lines.push(`  №${e.id} ${e.title} - ${fmtDate(e.due, e.hasTime)}`));
  }
  if (debtsDue.length) {
    lines.push('Долги со сроком в этот период:');
    debtsDue.forEach((e) =>
      lines.push(`  №${e.id} ${e.counterparty || 'без имени'} - ${e.amount != null ? money(e.amount) : 'сумма не указана'}, до ${fmtDate(e.due, false)}`)
    );
  }
  if (overdue.length) {
    lines.push('Просроченные долги:');
    overdue.forEach((e) =>
      lines.push(`  №${e.id} ${e.counterparty || 'без имени'} - ${e.amount != null ? money(e.amount) : 'сумма не указана'}, было до ${fmtDate(e.due, false)}`)
    );
  }
  if (lines.length === 1) lines.push('Ничего не запланировано.');
  return { reply: lines.join('\n'), results: [...meetings, ...tasks, ...debtsDue] };
}
