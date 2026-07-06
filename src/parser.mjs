// Разбор входящей фразы: запись (долг / встреча / задача / заметка),
// запрос («покажи…», «сколько…»), команда («готово 3», «удали 5») или помощь.

import { extractDate, extractAmount, normText } from './dates.mjs';

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const QUERY_STARTS = [
  'покажи', 'отгрузи', 'выведи', 'выгрузи', 'дай ', 'список', 'какие', 'какой',
  'сколько', 'что у меня', 'что по', 'сводка', 'итог', 'найди', 'поиск ', 'мои ', 'все ',
];

export function parseMessage(text, now = new Date()) {
  const raw = String(text || '').trim();
  if (!raw) return { kind: 'empty' };
  const t = normText(raw).trim();

  let m;
  if ((m = t.match(/^(?:готово|сделано|выполнено|закрой)\s+(.+)$/))) {
    return { kind: 'done', target: m[1].trim() };
  }
  if ((m = t.match(/^удали(?:ть)?\s+(.+)$/))) {
    return { kind: 'delete', target: m[1].trim() };
  }
  if (/^(?:помощь|справка|help|\/start|\/help|что ты умеешь)/.test(t)) {
    return { kind: 'help' };
  }
  if (/^(?:ии[- ]?саммари|саммари|резюме|анализ)/.test(t) || t.includes('саммари')) {
    return { kind: 'summary' };
  }
  if (/^очисти(?:ть)?\s+(?:чат|историю)/.test(t)) {
    return { kind: 'clearchat' };
  }

  if (QUERY_STARTS.some((s) => t.startsWith(s)) || t.includes('что у меня')) {
    return parseQuery(raw, t, now);
  }
  return parseEntry(raw, t, now);
}

function parseQuery(raw, t, now) {
  let type = null;
  if (/долг|должн|дебитор|обязательств/.test(t)) type = 'debt';
  else if (/встреч|созвон|совещан|переговор/.test(t)) type = 'meeting';
  else if (/задач|напомин/.test(t)) type = 'task';
  else if (/заметк|запис/.test(t)) type = 'note';

  const aggregate = t.includes('сколько');

  let direction = null;
  if (/(мне|нам)\s+должн/.test(t)) direction = 'in';
  else if (/(^|\s)(я|мы)\s+должн?/.test(t)) direction = 'out';

  let range = null;
  if (/недел/.test(t)) range = { from: now, days: 7 };
  else if (/месяц/.test(t)) range = { from: now, days: 31 };
  else {
    const { when } = extractDate(raw, now);
    if (when) range = { from: when, days: 1 };
  }

  if (!type) return { kind: 'digest', range };
  return { kind: 'query', type, aggregate, direction, range };
}

function entry(type, fields) {
  return { kind: 'entry', entry: { type, ...fields } };
}

function parseEntry(raw, t, now) {
  const dt = extractDate(raw, now);
  const due = dt.when ? dt.when.toISOString() : null;

  if (/долж|долг|задолж|одолжил|занял/.test(t)) {
    return parseDebt(raw, t, dt, due);
  }

  if (/встреч|созвон|совещан|планерк|переговор|звонок/.test(t)) {
    return entry('meeting', {
      title: meetingTitle(dt.rest),
      due,
      hasTime: dt.hasTime,
      text: raw,
    });
  }

  const taskStart =
    /^(?:напомни|надо|нужно|не забыть|не забудь|задача|сделать|доделать|купить|позвонить|оплатить|отправить|проверить|подготовить|записаться|добавь задачу)/;
  if (taskStart.test(t) || /задач/.test(t) || t.includes('напомни')) {
    const { amount, rest } = extractAmount(dt.rest);
    return entry('task', {
      title: taskTitle(rest),
      amount,
      due,
      hasTime: dt.hasTime,
      text: raw,
    });
  }

  return entry('note', {
    title: cap(dt.rest.slice(0, 80)) || raw.slice(0, 80),
    due,
    hasTime: dt.hasTime,
    text: raw,
  });
}

function parseDebt(raw, t, dt, due) {
  const { amount, rest } = extractAmount(dt.rest);

  let direction = 'in';
  if (
    /(^|\s)(я|мы)\s+долж/.test(t) ||
    /долж[а-я]*\s+(я|мы)(\s|$)/.test(t) || // «должен я Кузнецову…»
    /мой долг|наш долг|(^|\s)я взял/.test(t)
  ) {
    direction = 'out';
  }
  if (/долж[а-я]*\s+(мне|нам)(\s|$)/.test(t) || /(мне|нам)\s+долж/.test(t)) direction = 'in';

  const counterparty = findCounterparty(rest);
  return entry('debt', {
    title: counterparty ? `Долг: ${counterparty}` : 'Долг',
    amount,
    counterparty,
    direction,
    due,
    hasTime: dt.hasTime,
    text: raw,
  });
}

function findCounterparty(body) {
  let m;
  if ((m = body.match(/["«]([^"»«]{2,40})["»]/))) return m[1].trim();
  // между именем и «должен» может стоять «мне»/«нам»: «Петров мне должен 30 тысяч»
  if ((m = body.match(/([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?)\s+(?:(?:мне|нам)\s+)?долж/))) return m[1];
  if ((m = body.match(/долг[ауе]?\s+(?:перед\s+)?([А-ЯЁ][а-яё]+)/))) return m[1];
  if ((m = body.match(/долж(?:ен|на|ны)\s+(?:(?:я|мы)\s+)?([А-ЯЁ][а-яё]+)/))) return m[1];
  if ((m = body.match(/(?:заказчик|клиент)[а-яё]*\s+([A-Za-zА-ЯЁа-яё0-9-]{2,})/i))) {
    if (!/^долж/i.test(normText(m[1]))) return cap(m[1]);
  }
  const stop = new Set([
    'я', 'мы', 'он', 'она', 'они', 'оно', 'кто', 'мне', 'нам', 'еще', 'уже',
    'тоже', 'также', 'сейчас', 'вчера', 'позавчера', 'заказчик', 'клиент',
  ]);
  if ((m = normText(body).match(/(?:^|\s)([а-яеa-z-]{3,})\s+(?:(?:мне|нам)\s+)?долж/))) {
    if (!stop.has(m[1])) return cap(m[1]);
  }
  return null;
}

function stripLead(s) {
  return s
    .replace(
      /^\s*(?:запиши(?:те)?(?:\s+мне)?|запланируй|поставь|добавь|создай|напомни(?:\s+мне)?(?:\s+об?)?|надо|нужно|не забыть|не забудь)\s+/i,
      ''
    )
    .trim();
}

function meetingTitle(rest) {
  let s = stripLead(rest);
  s = s.replace(/^встреч[а-я]*\s*/i, '').trim();
  const low = normText(s);
  if (/^(созвон|совещан|планерк|переговор|звонок)/.test(low)) return cap(s);
  return s ? 'Встреча ' + s : 'Встреча';
}

function taskTitle(rest) {
  let s = stripLead(rest);
  s = s.replace(/^задач[ау]:?\s*/i, '').trim();
  return cap(s) || 'Задача';
}
