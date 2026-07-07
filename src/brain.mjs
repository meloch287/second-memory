// «Мозг» ассистента: превращает разобранную фразу в действие над хранилищем
// и человеческий ответ на русском.

import { parseMessage } from './parser.mjs';
import { normText } from './dates.mjs';
import { aiEnabled, aiSummary, aiAnswer, aiSearch } from './ai.mjs';
import { balanceReport, expensesReport } from './finance.mjs';
import { memoryStats, questionCoverage } from './ragmeter.mjs';
import { resolveWallDate, userOffset, fmtUser, DEFAULT_OFFSET } from './tz.mjs';

import { money, pad } from './format.mjs';

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

// off=null (веб/без tz-профиля) - рендерим в server-local, как и хранили;
// off=число (юзер бота) - в его часовом поясе (записи хранятся в реальном UTC).
function fmtDate(iso, hasTime, off = null) {
  if (off == null) {
    const d = new Date(iso);
    const s = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
    return hasTime ? `${s} ${pad(d.getHours())}:${pad(d.getMinutes())}` : s;
  }
  return fmtUser(iso, off, hasTime);
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
  const result = await route(store, text, now, chatId);
  const t = String(text || '').trim();
  if (t && !result.cleared) {
    store.pushHistory('user', t, chatId);
    store.pushHistory('assistant', result.reply, chatId);
  }
  return result;
}

// Тихая запись для бота-друга: структурируем долги, встречи и задачи,
// не подменяя живой ответ ИИ. Заметки не дублируем, они уже в сырой базе.
// chatId привязывает запись к пользователю - /reset стирает и их.
// offsetMin - часовой пояс пользователя: срок из фразы («в 15:00») считаем
// в его времени и храним в реальном UTC.
export function captureEntry(store, text, now = new Date(), chatId = 'web', offsetMin = 180) {
  const p = parseMessage(text, now);
  if (p.kind !== 'entry' || p.entry.type === 'note') return null;
  const entry = { ...p.entry, chatId };
  if (entry.due) {
    const r = resolveWallDate(offsetMin, text, now); // срок в часовом поясе пользователя
    if (r.due) {
      entry.due = r.due;
      entry.hasTime = r.hasTime;
    }
  }
  // Задача-напоминание с датой, но без времени («напомни завтра оплатить») иначе
  // никогда не сработает точным напоминанием - ставим полдень по поясу юзера.
  if (entry.type === 'task' && entry.due && !entry.hasTime) {
    const d = new Date(new Date(entry.due).getTime() + offsetMin * 60000); // настенное
    entry.due = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0) - offsetMin * 60000).toISOString();
    entry.hasTime = true;
  }
  return store.add(entry);
}

async function route(store, text, now, chatId = 'web') {
  const u = store.getUser(chatId);
  const off = u ? userOffset(u) : null;
  const p = parseMessage(text, now);
  // «что ты обо мне знаешь / какие факты / что помнишь» -> ответ ИИ по RAG-фактам,
  // а не пустой дайджест записей (факты жили в памяти, но нигде не показывались)
  if (
    aiEnabled() &&
    /(?:обо мне|про меня|какие факты|что ты (?:зна|помн))/.test(normText(text)) &&
    (p.kind === 'digest' || p.kind === 'query' || p.kind === 'search' || (p.kind === 'entry' && p.entry.type === 'note'))
  ) {
    try {
      return { reply: await aiAnswer(store, text, now, chatId), ai: true, rag: questionCoverage(store, text, chatId) };
    } catch { /* ИИ недоступен - обычный маршрут ниже */ }
  }
  // Общий вопрос/болтовня, которую парсер принял за дайджест базы («сколько
  // планет», «дай рецепт борща», «всё пучком») - это НЕ запрос к делам, а
  // разговор: отдаём ИИ вместо заглушки «Общая картина: 0 долгов…». Дайджест
  // С диапазоном («что у меня завтра») и деловые слова оставляем структурными.
  if (aiEnabled() && p.kind === 'digest' && !p.range) {
    const biz = /долг|встреч|созвон|совещан|задач|заметк|(?<![а-я])дела(?![а-я])|сводк|саммари|балан|финанс|трат|расход|распис|срок|напомин|долж|итог|повестк/.test(normText(text));
    if (!biz) {
      try {
        return { reply: await aiAnswer(store, text, now, chatId), ai: true, rag: questionCoverage(store, text, chatId) };
      } catch { /* ИИ недоступен - обычный дайджест ниже */ }
    }
  }
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
        const stats = memoryStats(store, chatId);
        return { reply: await aiSummary(store, now, chatId), ai: true, rag: { score: stats.score, label: stats.label } };
      } catch (e) {
        return { reply: `Не получилось связаться с ИИ (${e.message}). Попробуйте ещё раз.` };
      }
    }
    case 'clearchat':
      store.clearHistory(chatId);
      return { reply: 'Очистил переписку в этом чате. Дела и факты в памяти остались - чтобы стереть всё, скажи «очисти память».', cleared: true };
    case 'wipe': {
      const n = store.wipeMemory(chatId);
      const parts = [];
      if (n.facts) parts.push(`${n.facts} ${plural(n.facts, ['факт', 'факта', 'фактов'])}`);
      if (n.entries) parts.push(`${n.entries} ${plural(n.entries, ['запись', 'записи', 'записей'])}`);
      const what = parts.length ? `Удалил ${parts.join(' и ')}. ` : 'Память и так была пуста. ';
      return { reply: `Стёр всю память по этому чату. ${what}Начинаем с чистого листа.`, cleared: true };
    }
    case 'entry': {
      // Фраза со знаком «?» — это вопрос, а не запись: отдаём ИИ с контекстом
      // базы (иначе «у кого из должников горит срок?» станет мусорным долгом).
      if (aiEnabled() && /\?\s*$/.test(String(text).trim())) {
        try {
          const rag = questionCoverage(store, text, chatId);
          return { reply: await aiAnswer(store, text, now, chatId), ai: true, rag };
        } catch {
          // ИИ недоступен — обрабатываем по правилам ниже
        }
      }
      // Болтовня/сленг/просто заметка («ку», «го гулять») - это НЕ «Сохранил
      // заметку», а живой разговор: отдаём ИИ (он понимает сленг), а сам текст
      // тихо кладём в raw - память соберётся фоном (как у бота). Долги, встречи
      // и задачи ниже сохраняются структурно с подтверждением.
      if (p.entry.type === 'note' && aiEnabled()) {
        try {
          store.addRaw(chatId, text);
          const rag = questionCoverage(store, text, chatId);
          return { reply: await aiAnswer(store, text, now, chatId), ai: true, rag };
        } catch {
          // ИИ недоступен — сохраняем заметку по-старому
        }
      }
      return saveEntry(store, { ...p.entry, chatId }, off);
    }
    case 'done':
      return markDone(store, p.target, chatId);
    case 'delete':
      return removeEntry(store, p.target, chatId);
    case 'query':
      return runQuery(store, p, now, chatId, off);
    case 'digest':
      return digest(store, p.range, now, chatId, off);
    case 'balance':
      return { reply: balanceReport(store, chatId, off ?? DEFAULT_OFFSET) };
    case 'expenses':
      return { reply: expensesReport(store, chatId, off ?? DEFAULT_OFFSET) };
    case 'expense': {
      const e = store.add({ type: 'expense', amount: p.amount, category: p.category, title: p.category, text: p.text, chatId });
      return { reply: `Записал трату: ${money(p.amount)} - ${e.category}.`, entry: e };
    }
    case 'forget': {
      const n = store.removeFactsMatching(chatId, p.target);
      return { reply: n ? `Забыл про «${p.target}».` : `Не нашёл в памяти «${p.target}», забывать нечего.` };
    }
    case 'search':
      if (aiEnabled()) {
        try { return { reply: await aiSearch(store, chatId, p.query, now), ai: true, rag: questionCoverage(store, p.query, chatId) }; } catch { /* ниже */ }
      }
      return { reply: 'Поиск по памяти сейчас недоступен.' };
    default:
      // всё, что веб-роутинг не разбирает структурно, при живом ИИ - в разговор
      // (вместо «Не понял»): курс валют, опрос, график, повтор, ДР и т.п.
      if (aiEnabled()) {
        try { return { reply: await aiAnswer(store, text, now, chatId), ai: true, rag: questionCoverage(store, text, chatId) }; } catch { /* ниже */ }
      }
      return { reply: 'Не понял. Напишите «помощь», чтобы увидеть примеры.' };
  }
}

function saveEntry(store, entry, off = null) {
  const e = store.add(entry);
  let reply;
  if (e.type === 'debt') {
    const sum = e.amount != null ? money(e.amount) : 'сумма не указана';
    const till = e.due ? `, срок до ${fmtDate(e.due, false, off)}` : '';
    if (e.direction === 'out') {
      reply = `Записал долг №${e.id}: вы должны${e.counterparty ? ' ' + e.counterparty : ''} ${sum}${till}.`;
    } else if (e.counterparty) {
      reply = `Записал долг №${e.id}: ${e.counterparty} должен вам ${sum}${till}.`;
    } else {
      reply = `Записал долг №${e.id}: вам должны ${sum}${till}.`;
    }
  } else if (e.type === 'meeting') {
    reply = `Записал встречу №${e.id}: ${e.title}${e.due ? `, ${fmtDate(e.due, e.hasTime, off)}` : ', дата не указана'}.`;
  } else if (e.type === 'task') {
    reply = `Записал задачу №${e.id}: ${e.title}${e.due ? `, срок ${fmtDate(e.due, e.hasTime, off)}` : ''}.`;
  } else {
    reply = `Сохранил заметку №${e.id}: «${e.title}».`;
  }
  return { reply, entry: e };
}

// Пользователь видит и закрывает только СВОИ записи (мультиюзер).
function findTarget(store, target, chatId = 'web') {
  const t = target.replace(/^№\s*/, '').trim();
  if (/^\d+$/.test(t)) {
    const e = store.byId(+t);
    return e && (e.chatId || 'web') === chatId ? e : null;
  }
  const nt = normText(t);
  return (
    store
      .list({ status: 'open', chatId })
      .find((x) => [x.counterparty, x.title, x.text].some((f) => f && normText(f).includes(nt))) || null
  );
}

function markDone(store, target, chatId = 'web') {
  const e = findTarget(store, target, chatId);
  if (!e) return { reply: `Не нашёл запись «${target}».` };
  if (e.status === 'done') return { reply: `Запись №${e.id} уже закрыта.` };
  store.setStatus(e.id, 'done');
  return { reply: `Готово: ${TYPE_LABEL[e.type]} №${e.id} закрыта.`, entry: e };
}

function removeEntry(store, target, chatId = 'web') {
  const e = findTarget(store, target, chatId);
  if (!e) return { reply: `Не нашёл запись «${target}».` };
  store.remove(e.id);
  return { reply: `Удалил: ${TYPE_LABEL[e.type]} №${e.id}.`, entry: e };
}

function runQuery(store, q, now, chatId = 'web', off = null) {
  if (q.type === 'debt') return debtsReply(store, q, now, chatId, off);

  const open = store.list({ type: q.type, status: 'open', chatId });
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
    lines.push(`  №${e.id} ${e.title}${e.due ? ` - ${fmtDate(e.due, e.hasTime, off)}` : ''}`);
  }
  return { reply: lines.join('\n'), results: items };
}

function debtsReply(store, q, now, chatId = 'web', off = null) {
  let debts = store.list({ type: 'debt', status: 'open', chatId });
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
    return `  №${d.id} ${d.counterparty || 'без имени'} - ${sum}${d.due ? `, до ${fmtDate(d.due, false, off)}` : ''}${overdue}`;
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

function digest(store, range, now, chatId = 'web', off = null) {
  const open = store.list({ status: 'open', chatId });
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
      upcoming.forEach((e) => lines.push(`  №${e.id} ${e.title} - ${fmtDate(e.due, e.hasTime, off)}`));
    }
    if (tasks.length) {
      lines.push('Открытые задачи:');
      tasks.slice(0, 7).forEach((e) => lines.push(`  №${e.id} ${e.title}${e.due ? ` - ${fmtDate(e.due, e.hasTime, off)}` : ''}`));
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

  const fmtTs = (ms) => fmtDate(new Date(ms).toISOString(), false, off);
  const title = days > 1 ? `Сводка с ${fmtTs(from)} по ${fmtTs(to - 86400000)}:` : `Сводка на ${fmtTs(from)}:`;
  const lines = [title];

  if (meetings.length) {
    lines.push('Встречи:');
    meetings.forEach((e) => lines.push(`  №${e.id} ${e.title} - ${fmtDate(e.due, e.hasTime, off)}`));
  }
  if (tasks.length) {
    lines.push('Задачи:');
    tasks.forEach((e) => lines.push(`  №${e.id} ${e.title} - ${fmtDate(e.due, e.hasTime, off)}`));
  }
  if (debtsDue.length) {
    lines.push('Долги со сроком в этот период:');
    debtsDue.forEach((e) =>
      lines.push(`  №${e.id} ${e.counterparty || 'без имени'} - ${e.amount != null ? money(e.amount) : 'сумма не указана'}, до ${fmtDate(e.due, false, off)}`)
    );
  }
  if (overdue.length) {
    lines.push('Просроченные долги:');
    overdue.forEach((e) =>
      lines.push(`  №${e.id} ${e.counterparty || 'без имени'} - ${e.amount != null ? money(e.amount) : 'сумма не указана'}, было до ${fmtDate(e.due, false, off)}`)
    );
  }
  if (lines.length === 1) lines.push('Ничего не запланировано.');
  return { reply: lines.join('\n'), results: [...meetings, ...tasks, ...debtsDue] };
}
