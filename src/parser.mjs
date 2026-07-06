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

  // Голос по запросу и тумблер озвучки (№9)
  if (/^(?:отвечай|говори|пиши)\s+(?:мне\s+)?(?:текстом|не голосом|без голоса)/.test(t)) {
    return { kind: 'setvoice', on: false };
  }
  if (/^(?:отвечай|говори)\s+(?:мне\s+)?(?:голос|войсом|аудио)/.test(t)) {
    return { kind: 'setvoice', on: true };
  }
  if (/(?:ответь|скажи|можешь|давай).*(?:голос|войс|аудио)/.test(t) || /^голос(?:ом|овым)?[!?.]*$/.test(t)) {
    return { kind: 'voiceonce' };
  }

  // Поправить память (№2): «забудь про X» / «это не так». Регистр из raw.
  if (/^(?:забудь|удали из памяти|сотри)\s+/.test(t)) {
    const target = raw.replace(/^\s*(?:забудь|удали из памяти|сотри)\s+(?:про|о|об)?\s*/i, '').trim();
    if (target) return { kind: 'forget', target };
  }
  if (/^(?:нет,?\s*)?(?:это не так|я такого не говорил|ты не так понял|это неправда|неправда|ты перепутал)/.test(t)) {
    return { kind: 'correct' };
  }

  // Календарь: «скинь в календарь», «расписание в календарь», «экспорт .ics»
  if (/(?:в календар|скинь календар|календарь.*телефон|\.ics)/.test(t)) {
    return { kind: 'calendar' };
  }

  // Команды-настройки срабатывают, только если сообщение - сама команда
  // (целиком), иначе дневниковые фразы попадали бы в них по ошибке.
  let sm;
  if (/^(?:покажи |дай )?(?:экспорт|выгрузи(?:\s+(?:вс[её]|память|дела|данные))?|скачать(?:\s+память)?|скачай(?:\s+память)?|export)[.!?]*$/.test(t)) {
    return { kind: 'export' };
  }
  if (/^(?:покажи |дай )?(?:баланс|финансы|сводка по долгам|денежный баланс|долги итого)[.!?]*$/.test(t)) {
    return { kind: 'balance' };
  }
  if (/^(?:мои )?настройки[.!?]*$/.test(t) || t === '/settings') {
    return { kind: 'settings' };
  }
  if ((sm = t.match(/^напомина(?:й|ть)\s+за\s+(\d{1,3})\s*(?:мин|минут)/))) {
    return { kind: 'setlead', minutes: Math.min(720, +sm[1]) };
  }
  // Город: только целое короткое сообщение «мой город X» (1-3 слова), регистр из raw
  if ((sm = raw.match(/^\s*(?:мой город|я живу в городе)\s+([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё-]+(?:[ -][A-Za-zА-Яа-яЁё-]+){0,2})[.!?]*\s*$/i))) {
    return { kind: 'setcity', city: sm[1].trim() };
  }
  // Часовой пояс: только короткое целое сообщение-команда
  if (/^(?:часовой пояс|мой пояс|смени пояс|поменяй пояс)\s+.{1,20}$/.test(t)) {
    return { kind: 'settz', text: raw };
  }

  // Правка записи: «перенеси встречу на 16:00», «отмени звонок маме»
  const edit = parseEdit(raw, t, now);
  if (edit) return edit;

  // Повтор: «каждый понедельник созвон в 10:00», «каждый день зарядка в 8»
  const recur = parseRecurring(raw, t, now);
  if (recur) return recur;

  // Поиск по памяти: «что я говорил про Петрова», «найди про отпуск», «вспомни…»
  const search = parseSearch(raw, t);
  if (search) return search;

  // Сводка трат
  if (/^(?:траты|расходы|на что.*(?:трач|деньги|уход)|сколько потрат)/.test(t)) {
    return { kind: 'expenses' };
  }

  if (QUERY_STARTS.some((s) => t.startsWith(s)) || t.includes('что у меня')) {
    return parseQuery(raw, t, now);
  }

  // Трата - раньше обычной записи (иначе уйдёт в заметку)
  const exp = parseExpense(raw, t);
  if (exp) return exp;

  return parseEntry(raw, t, now);
}

const WEEKDAYS = {
  понедельник: 1, пн: 1, вторник: 2, вт: 2, сред: 3, ср: 3, четверг: 4, чт: 4,
  пятниц: 5, пт: 5, суббот: 6, сб: 6, воскресень: 0, вс: 0,
};

function findWeekday(t) {
  for (const [word, wd] of Object.entries(WEEKDAYS)) {
    if (word.length > 2 && t.includes(word)) return wd;
    if (word.length <= 2 && new RegExp('(?<![а-я])' + word + '(?![а-я])').test(t)) return wd;
  }
  return null;
}

function extractHm(t) {
  let m = t.match(/(?:в|к)?\s*(\d{1,2}):(\d{2})/);
  if (m && +m[1] <= 23 && +m[2] <= 59) return { hour: +m[1], min: +m[2] };
  m = t.match(/(?<![\d.,:])в\s+(\d{1,2})(?:\s*час[а-я]*)?(?![\d.,:])/);
  if (m && +m[1] <= 23) return { hour: +m[1], min: 0 };
  return null;
}

// «каждый …» -> правило повтора. title = что напомнить.
export function parseRecurring(raw, t) {
  if (!/кажд(?:ый|ую|ое|ые)|ежедневн|по (?:пн|вт|ср|чт|пт|сб|вс|понедельник|вторник|сред|четверг|пятниц|суббот|воскресень)/.test(t)) {
    return null;
  }
  const hm = extractHm(t) || { hour: 9, min: 0 };
  let rule = null;

  const dom = t.match(/(\d{1,2})[- ]?(?:го)?\s*числа/);
  if (/ежемесячн|кажд(?:ый|ое)\s+месяц/.test(t) || dom) {
    rule = { kind: 'monthly', day: dom ? Math.min(28, +dom[1]) : 1, hour: hm.hour, min: hm.min };
  } else if (/ежедневн|кажд(?:ый|ое)\s+(?:день|утро|вечер)/.test(t)) {
    rule = { kind: 'daily', hour: hm.hour, min: hm.min };
  } else {
    const wd = findWeekday(t);
    if (wd != null) rule = { kind: 'weekly', weekday: wd, hour: hm.hour, min: hm.min };
  }
  if (!rule) return null;

  // Заголовок: убираем «каждый …», «по …», время
  let title = raw
    .replace(/кажд(?:ый|ую|ое|ые)\s+\S+/gi, '')
    .replace(/по\s+(?:пн|вт|ср|чт|пт|сб|вс|понедельник\S*|вторник\S*|сред\S*|четверг\S*|пятниц\S*|суббот\S*|воскресень\S*)/gi, '')
    .replace(/ежедневн\S*|ежемесячн\S*/gi, '')
    .replace(/\d{1,2}[- ]?(?:го)?\s*числа/gi, '')
    .replace(/(?:в|к)\s*\d{1,2}(?::\d{2})?(?:\s*час[а-я]*)?/gi, '')
    .replace(/напомни(?:ть)?(?:\s+мне)?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '');
  title = cap(title) || 'Напоминание';
  return { kind: 'recurring', rule, title, text: raw };
}

// «перенеси/отмени …» -> правка существующей записи.
export function parseEdit(raw, t, now) {
  let m;
  if ((m = t.match(/^(?:отмени(?:ть)?|отмена)\s+(.+)$/))) {
    return { kind: 'edit', op: 'cancel', target: m[1].trim() };
  }
  if ((m = t.match(/^(?:перенеси|передвинь|перенести|подвинь|измени|поменяй)\s+(.+)$/))) {
    // цель — до предлога «на», новое время — после
    const body = m[1];
    const split = body.match(/^(.*?)\s+на\s+(.+)$/);
    const targetPart = split ? split[1] : body;
    const dt = extractDate(split ? 'на ' + split[2] : body, now);
    return { kind: 'edit', op: 'reschedule', target: targetPart.trim(), when: dt.when ? dt.when.toISOString() : null, hasTime: dt.hasTime };
  }
  return null;
}

const SEARCH_STARTS = ['найди', 'вспомни', 'поищи', 'что я говорил', 'что я писал', 'что я рассказывал', 'что там с', 'что там про', 'что известно про', 'помнишь'];

export function parseSearch(raw, t) {
  if (!SEARCH_STARTS.some((s) => t.startsWith(s) || t.includes(s))) return null;
  // не перехватываем расписание/дела на период — это digest/query
  if (/что у меня (?:завтра|сегодня|на недел|на этой недел)/.test(t)) return null;
  const query = raw
    .replace(/^(?:найди|вспомни|поищи)\s+(?:мне\s+)?(?:про|о|об)?\s*/i, '')
    .replace(/^(?:что\s+я\s+(?:говорил|писал|рассказывал))\s*(?:про|о|об)?\s*/i, '')
    .replace(/^(?:что\s+там\s+(?:с|про))\s*/i, '')
    .replace(/^(?:что\s+известно\s+про)\s*/i, '')
    .replace(/^помнишь\s*/i, '')
    .replace(/[?!.]+$/, '')
    .trim();
  return { kind: 'search', query: query || raw };
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

// Трата (№7): «потратил 2000 на бензин», «купил кофе за 300», «минус 500 такси».
// Окончание съедается вместе с глаголом ([аи]?), иначе «потратила» матчится
// по мужской форме и хвост «а» уползает в категорию.
const EXPENSE_RE = /(?:потратил|истратил|купил|заплатил|оплатил|отдал|спустил)[аи]?|минус/;
export function parseExpense(raw, t) {
  if (!EXPENSE_RE.test(t)) return null;
  // не путаем с долгом («заплатил Пете» = долг? нет, трата; «должен» ловится раньше)
  const { amount, rest } = extractAmount(raw);
  if (amount == null) return null;
  // категория: убираем глагол, «за», «на», предлоги, сумму
  let cat = rest
    .replace(EXPENSE_RE, '')
    .replace(/^\s*(?:за|на|в|по)\s+/i, '')
    .replace(/\s*(?:за|на)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  cat = cap(cat) || 'Разное';
  return { kind: 'expense', amount, category: cat.slice(0, 60), text: raw };
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
