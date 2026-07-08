// Разбор входящей фразы: запись (долг / встреча / задача / заметка),
// запрос («покажи…», «сколько…»), команда («готово 3», «удали 5») или помощь.

import { extractDate, extractAmount, normText, monthIndex } from './dates.mjs';

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
  // «удали из памяти X» - это forget, проверяем ДО общего delete (иначе мёртвая ветка)
  if (/^(?:забудь|удали из памяти|сотри из памяти)\s+/.test(t)) {
    const target = raw.replace(/^\s*(?:забудь|удали из памяти|сотри из памяти)\s+(?:про|о|об)?\s*/i, '').trim();
    if (target) return { kind: 'forget', target };
  }
  if ((m = t.match(/^удали(?:ть)?\s+(.+)$/))) {
    return { kind: 'delete', target: m[1].trim() };
  }
  if (/^(?:помощь|справка|help|\/start|\/help|что ты умеешь)/.test(t)) {
    return { kind: 'help' };
  }
  if (/^(?:итог|итоги|подведи итог|ии[- ]?саммари|саммари|резюме|анализ)/.test(t) || t.includes('саммари')) {
    return { kind: 'summary' };
  }
  // «очисти память» / «сотри всё» - полное стирание памяти (факты+записи+сырьё)
  if (
    /^(?:очисти(?:ть)?|сотри|стереть|обнули|снеси|удали)\s+(?:всю\s+|мою\s+|свою\s+)*(?:память|памяти)(?![а-яё])/.test(t) ||
    /^(?:очисти(?:ть)?|сотри|обнули)\s+вс[её](?![а-яё])/.test(t)
  ) {
    return { kind: 'wipe' };
  }
  // «очисти чат» / «очисти историю» - только переписка (память остаётся)
  if (/^(?:очисти(?:ть)?|сотри|обнули)\s+(?:чат|историю|переписку|диалог)/.test(t)) {
    return { kind: 'clearchat' };
  }

  // Голос по запросу и тумблер озвучки (№9)
  if (
    /^(?:отвечай|говори|пиши)\s+(?:мне\s+)?(?:текстом|не голосом|без голоса)/.test(t) ||
    /^(?:выключи(?:ть)?|отключи(?:ть)?)\s+(?:голос|войс)/.test(t)
  ) {
    return { kind: 'setvoice', on: false };
  }
  if (
    /^(?:отвечай|говори)\s+(?:мне\s+)?(?:голос|войсом|аудио)/.test(t) ||
    /^включи(?:ть)?\s+(?:голос|войс)/.test(t)
  ) {
    return { kind: 'setvoice', on: true };
  }
  // Разовая просьба голосом: «ответь голосом», «запиши голосовым, что...».
  // Требуем форму «голосом/голосов+/войс/аудио», чтобы «сорвал голос» не ловилось.
  if (
    /(?:ответь|скажи|можешь|давай|запиши|надиктуй|пришли|отправь).*(?:голосом|голосов[а-я]+|войс[а-я]*|аудио)/.test(t) ||
    /^голос(?:ом|овым)?[!?.]*$/.test(t)
  ) {
    return { kind: 'voiceonce' };
  }

  // Поправить память (№2): «забудь про X» / «это не так». Регистр из raw.
  if (/^(?:забудь|сотри)\s+/.test(t)) {
    const target = raw.replace(/^\s*(?:забудь|сотри)\s+(?:про|о|об)?\s*/i, '').trim();
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
  if (/^(?:покажи |дай )?(?:мо[йи] |наши? )?(?:баланс|финансы|сводка по долгам|денежный баланс|долги итого)[.!?]*$/.test(t)) {
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

  // Дни рождения: «у Димы др 15 августа», «мой день рождения 1 января»
  let bd;
  if ((bd = t.match(/^(?:у\s+([а-яa-z]+)\s+|мо[йё]\s+)?(?:др|день рождения|деньрож|днюха)(?:\s+у\s+([а-яa-z]+))?\s+(\d{1,2})\s+([а-я]+)[!.]*$/))) {
    const day = +bd[3];
    const mon = monthIndex(bd[4]);
    if (day >= 1 && day <= 31 && mon >= 0) {
      const rawWho = bd[1] || bd[2];
      // регистр имени из исходного текста
      let person = null;
      if (rawWho) {
        const pm = raw.match(new RegExp(`у\\s+([А-Яа-яЁёA-Za-z]+)`, 'i'));
        person = (pm ? pm[1] : rawWho).trim();
        person = person[0].toUpperCase() + person.slice(1);
      }
      return { kind: 'birthday', person, day, month: mon + 1 };
    }
  }
  if (/^(?:когда\s+)?(?:др|дни рождения|днюхи)(?:\s+у\s+(.+))?[!?.]*$/.test(t) && /дн[июя]|др/.test(t) && t.length < 40) {
    const wm = t.match(/у\s+([а-яa-z]+)/);
    return { kind: 'birthdays', person: wm ? wm[1] : null };
  }

  // Курсы валют: «курс доллара», «300$ в рублях», «100 евро в руб»
  if (/^курс[ыа]?\s+/.test(t) || /(?:\d|\$|€)\s*(?:\$|€|доллар|евро|юан|тенге|фунт|франк|лир)[а-я]*\s+в\s+руб/.test(t)) {
    return { kind: 'currency', request: raw };
  }

  // Опрос (№4): «устрой опрос: пицца или суши», «опрос: вопрос? вар1, вар2»
  const poll = parsePoll(raw, t);
  if (poll) return poll;

  // Сплит (№2): «кто сколько скинул», «раздели 6000 на троих», «кто не сдал»
  if (/раздели(?:ть)?\s+\d|подели(?:ть)?\s+\d|кто\s+(?:не\s+)?(?:сдал|скинул|сбросил)|кто\s+сколько\s+(?:скинул|сдал|должен\s+за)/.test(t)) {
    return { kind: 'split', request: raw };
  }

  // Бюджеты (№8): «бюджет на кофе 5000», «лимит на такси 3000 в месяц»
  let bm;
  if ((bm = t.match(/^(?:бюджет|лимит)\s+на\s+(.+?)\s+(\d[\d\s]*)(?:\s*(?:руб|₽|р))?(?:\s+в\s+месяц)?[!.]*$/))) {
    const amount = Number(bm[2].replace(/\s/g, ''));
    if (amount > 0) return { kind: 'setbudget', category: cap(bm[1].trim()).slice(0, 40), amount };
  }
  if (/^(?:мои\s+)?(?:бюджеты|лимиты)[!?.]*$/.test(t)) {
    return { kind: 'budgets' };
  }

  // График: «нарисуй график трат», «диаграмма долгов», «построй график ...»
  if (/(?:нарисуй|построй|сделай|покажи|составь)?\s*(?:график|диаграмм|чарт)/.test(t) && /график|диаграмм|чарт/.test(t)) {
    return { kind: 'chart', request: raw };
  }

  // Сводка трат
  if (/^(?:траты|расходы|на что.*(?:трач|деньги|уход)|сколько потрат)/.test(t)) {
    return { kind: 'expenses' };
  }

  // Вопросы про долги без «?»: «кто мне должен», «кому я должен», «у кого горит
  // долг» - это запрос, а не новая запись долга.
  if (/^(?:кто|кому|у кого|скольким)(?:\s|$)/.test(t) && /долж|долг|задолж/.test(t)) {
    return parseQuery(raw, t, now);
  }

  if (QUERY_STARTS.some((s) => t.startsWith(s)) || t.includes('что у меня')) {
    return parseQuery(raw, t, now);
  }

  // Трата - раньше обычной записи (иначе уйдёт в заметку)
  const exp = parseExpense(raw, t, now);
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

const WORD_H = { 'час': 1, 'два': 2, 'двух': 2, 'три': 3, 'трех': 3, 'четыре': 4, 'четырех': 4, 'пять': 5, 'пяти': 5, 'шесть': 6, 'шести': 6, 'семь': 7, 'семи': 7, 'восемь': 8, 'восьми': 8, 'девять': 9, 'девяти': 9, 'десять': 10, 'десяти': 10, 'одиннадцать': 11, 'двенадцать': 12, 'полдень': 12, 'полночь': 0 };
function extractHm(t) {
  let m = t.match(/(?:в|к|ко|на)?\s*(\d{1,2}):(\d{2})/);
  if (m && +m[1] <= 23 && +m[2] <= 59) return { hour: +m[1], min: +m[2] };
  m = t.match(/(?<![\d.,:])(?:в|к|ко|на)\s+(\d{1,2})[.\s](\d{2})(?![\d.,:])/); // 16 00 / 16.00
  if (m && +m[1] <= 23 && +m[2] <= 59) return { hour: +m[1], min: +m[2] };
  m = t.match(/(?<![\d.,:])(?:в|к|ко)\s+(\d{1,2})(?:\s*час[а-я]*)?(?![\d.,:])/);
  if (m && +m[1] <= 23) return { hour: +m[1], min: 0 };
  m = t.match(new RegExp('(?<![а-я])(?:в|к|ко)\\s+(' + Object.keys(WORD_H).sort((a, b) => b.length - a.length).join('|') + ')(?![а-я])'));
  if (m) return { hour: WORD_H[m[1]], min: 0 };
  return null;
}

// «каждый …» -> правило повтора. title = что напомнить.
export function parseRecurring(raw, t) {
  if (!/кажд(?:ый|ую|ое|ые)|ежедневн|по (?:понедельник|вторник|сред|четверг|пятниц|суббот|воскресень|пн|вт|ср|чт|пт|сб|вс)/.test(t)) {
    return null;
  }
  const hm = extractHm(t) || { hour: 9, min: 0 };
  let rule = null;

  const dom = t.match(/(\d{1,2})[- ]?(?:го)?\s*числ[оа]/);
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
    .replace(/\d{1,2}[- ]?(?:го)?\s*числ[оа]/gi, '')
    .replace(/(?:в|к|ко|на)\s*\d{1,2}(?:[:.\s]\d{2})?(?:\s*час[а-я]*)?/gi, '')
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

// Опрос: «устрой опрос: пицца или суши?», «опрос: куда едем? Сочи, Питер, Казань»
export function parsePoll(raw, t) {
  if (!/(?:^|[\s,!])(?:опрос|голосовани|проголосуем)/.test(t)) return null;
  const after = raw.replace(/^.*?(?:опрос|голосование|голосования|проголосуем)\s*[:,-]?\s*/i, '').trim();
  if (!after) return null;
  let question = 'Голосуем!';
  let optionsPart = after;
  const qm = after.match(/^(.+?\?)\s*(.*)$/s);
  if (qm && qm[2]) {
    question = qm[1].trim();
    optionsPart = qm[2].trim();
  }
  let options = optionsPart
    .split(/\s*(?:,|;|(?<![а-яa-z])или(?![а-яa-z]))\s*/i)
    .map((s) => s.trim().replace(/[?!.]+$/, ''))
    .filter(Boolean);
  if (options.length < 2) {
    // варианты могли остаться внутри вопроса: «пицца или суши?»
    options = after.replace(/\?$/, '').split(/\s*(?:,|(?<![а-яa-z])или(?![а-яa-z]))\s*/i).map((s) => s.trim()).filter(Boolean);
    question = 'Голосуем!';
  }
  if (options.length < 2) return null;
  return { kind: 'poll', question: question.slice(0, 300), options: options.slice(0, 10).map((o) => o.slice(0, 100)) };
}

// Поиск участника группы по имени/username с учётом падежа («никиту» -> Никита).
// Транслитерация кириллицы в латиницу - имена в Telegram часто латиницей
// («Nikita»), а зовут их кириллицей («тегни Никиту»).
const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const toLat = (s) => s.replace(/[а-яе]/g, (c) => TRANSLIT[c] ?? c);

export function findMember(members, query) {
  const stem = (s) => String(s).toLowerCase().replace(/ё/g, 'е').replace(/[ауыоеиюяьй]+$/, '');
  const q = String(query).toLowerCase().replace(/^@/, '').replace(/ё/g, 'е').trim();
  if (!q) return null;
  for (const [id, m] of Object.entries(members || {})) {
    const u = (m.username || '').toLowerCase();
    if (u && (u === q || q === '@' + u)) return { id, ...m };
  }
  const qs = stem(q);
  if (qs.length < 2) return null;
  // сначала точное совпадение основы (иначе «Саша» может уехать в «Сашенька»
  // по порядку вставки), потом префиксы и транслит
  for (const [id, m] of Object.entries(members || {})) {
    const n = stem(m.name || '');
    if (n && (n === qs || toLat(n) === toLat(qs))) return { id, ...m };
  }
  const match = (n) => n && (n.startsWith(qs) || qs.startsWith(n) || toLat(n).startsWith(toLat(qs)) || toLat(qs).startsWith(toLat(n)));
  for (const [id, m] of Object.entries(members || {})) {
    if (match(stem(m.name || ''))) return { id, ...m };
  }
  // близкие формы: уменьшительные и падежи, которые не сходятся префиксом
  // («Серёгу»->«Сергей»), + опечатки. Правка-расстояние <=1 на основах >=4 букв.
  if (qs.length >= 4) {
    for (const [id, m] of Object.entries(members || {})) {
      const n = stem(m.name || '');
      if (n.length >= 4 && (editLE1(n, qs) || editLE1(toLat(n), toLat(qs)))) return { id, ...m };
    }
  }
  return null;
}

// true, если строки отличаются не более чем на одну правку (вставка/удаление/замена).
function editLE1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let d = 0;
    for (let i = 0; i < la; i++) if (a[i] !== b[i] && ++d > 1) return false;
    return true;
  }
  const s = la < lb ? a : b, l = la < lb ? b : a;
  let i = 0, j = 0, skips = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; }
    else if (++skips > 1) return false;
    else j++;
  }
  return true;
}

// Команды управления группой (текст уже нормализован: lower, е вместо ё).
// needsReply - команду надо отправлять ответом (reply) на целевое сообщение.
export function parseGroupCmd(t) {
  let m;
  // ЗАКРЕПИТЬ (ответом на сообщение)
  if (/^(?:закрепи(?:ть)?|запинь|прикрепи(?:ть)?|зафиксируй|запиль|пин(?:ани)?|повесь\s+(?:наверх|вверх|сверху))(?![а-я])/i.test(t))
    return { cmd: 'pin', needsReply: true };
  // ОТКРЕПИТЬ
  if (/^(?:открепи(?:ть)?|сними\s+(?:закреп|пин)|убери\s+(?:закреп|из\s+закрепа)|разкрепи|анпин|отпин)(?![а-я])/i.test(t))
    return { cmd: 'unpin' };
  // ССЫЛКА-ПРИГЛАШЕНИЕ (до «дай/сделай», чтобы не спутать)
  if (/^(?:дай|созда(?:й|ть)|скинь|сделай|кинь|сгенери(?:руй)?|нужн[аы]?|хочу|пришли)\s+(?:мне\s+)?(?:ссылку|инвайт|приглашение|пригласительн[а-я]+|линк|ссыль)/i.test(t)
    || /^(?:инвайт|ссылк[ауи]|пригласительн[а-я]+)[!?.]*$/i.test(t) || /^пригласи\s+по\s+ссылк/i.test(t))
    return { cmd: 'invite' };
  // ОПИСАНИЕ ГРУППЫ
  if ((m = t.match(/^(?:смени(?:ть)?|поменяй|измени(?:ть)?|задай|установи|обнови|постав[ьи]|напиши|сделай)?\s*описание(?:\s+(?:группы|чата|беседы))?\s*(?:на|в)?\s*[:\s-]*(.+)$/i)) && m[1] && m[1].trim())
    return { cmd: 'desc', arg: m[1].trim().replace(/^["«»]|["«»]$/g, '').slice(0, 255) };
  if ((m = t.match(/^опиши(?:\s+(?:группу|чат))?\s+(.+)$/i)))
    return { cmd: 'desc', arg: m[1].trim().replace(/^["«»]|["«»]$/g, '').slice(0, 255) };
  // ПЕРЕИМЕНОВАТЬ ГРУППУ / СМЕНИТЬ НАЗВАНИЕ (топики ловятся раньше в group.mjs)
  if ((m = t.match(/^(?:смени(?:ть)?|поменяй|измени(?:ть)?|обнови)\s+(?:название|имя|назв)(?:\s+(?:группы|чата|беседы))?\s*(?:на|в)?\s*[:\s-]*(.+)$/i)))
    return { cmd: 'title', arg: m[1].trim().replace(/^["«»]|["«»]$/g, '').slice(0, 128) };
  if ((m = t.match(/^(?:переименуй|переназови|назови|обзови|назом)\s+(?:группу|чат|беседу|нас|это|её|ее|его)?\s*(?:в|на|как)?\s*[:\s-]*(.+)$/i)))
    return { cmd: 'title', arg: m[1].trim().replace(/^["«»]|["«»]$/g, '').slice(0, 128) };
  if ((m = t.match(/^(?:название|назв|имя)(?:\s+(?:группы|чата|беседы))?\s*[:-]\s*(.+)$/i)))
    return { cmd: 'title', arg: m[1].trim().replace(/^["«»]|["«»]$/g, '').slice(0, 128) };
  // КИК
  if (/^(?:кикни|кик|выгони|выкини|выпни|вышвырни|исключи|удали\s+из\s+(?:группы|чата)|убери\s+из\s+(?:группы|чата)|гони|погнали\s+его|вон)(?![а-я])/i.test(t))
    return { cmd: 'kick', needsReply: true };
  // БАН
  if (/^(?:забань|бан|заблокируй|блокни|в\s+бан|кинь\s+в\s+бан|отправь\s+в\s+бан|бань)(?![а-я])/i.test(t))
    return { cmd: 'ban', needsReply: true };
  // МУТ (замуть, заткни, ограничь; длительность: N минут/часов/дней/недель)
  if ((m = t.match(/^(?:замуть|замьють|замут|мут|заткни|дай\s+молчанку|ограничь|в\s+мут|режим\s+тишины|помолчи(?:шь)?)(?![а-я])\s*(?:на\s+)?(?:(\d+)\s*)?(минут[а-я]*|мин|час[а-я]*|ч|д(?:ень|н[а-я]*)|сут[а-я]*|недел[а-я]*|нед)?/i))) {
    let mins = 60;
    if (m[2]) { // указана единица - число опционально (напр. «на неделю» = 1)
      const n = m[1] ? +m[1] : 1;
      const u = m[2].toLowerCase();
      mins = /час|^ч$/.test(u) ? n * 60 : /^д|сут/.test(u) ? n * 1440 : /недел|^нед/.test(u) ? n * 10080 : n;
    }
    return { cmd: 'mute', minutes: Math.min(mins, 366 * 1440), needsReply: true };
  }
  // РАЗМУТ
  if (/^(?:размуть|размьють|сними\s+мут|верни\s+(?:голос|слово|звук)|отмут|анмут|дай\s+(?:говорить|слово))(?![а-я])/i.test(t))
    return { cmd: 'unmute', needsReply: true };
  // УДАЛИТЬ СООБЩЕНИЕ (ответом)
  if (/^(?:удали|снеси|убери|сотри|del|дропни|грохни)(?:\s+(?:это|сообщение|соо|мессадж|месаг[уа]|сообщ[а-я]*|его|нафиг))?[!?.]*$/i.test(t))
    return { cmd: 'del', needsReply: true };
  // АДМИН + (повысить)
  if (/^(?:повысь|подними)(?![а-я])/i.test(t)
    || /^(?:сделай|назначь|поставь|дай|выдай)\s+(?:его\s+|её\s+|ее\s+|до\s+)?(?:админ|модератор|прав)/i.test(t)
    || /^в\s+админ/i.test(t))
    return { cmd: 'promote', needsReply: true };
  // АДМИН - (понизить)
  if (/^(?:разжалуй|понизь|разжалов)(?![а-я])/i.test(t)
    || /^(?:сними|убери|лиши|забери|отбери)\s+(?:его\s+|её\s+|ее\s+|с\s+)?(?:админ|модератор|прав)/i.test(t))
    return { cmd: 'demote', needsReply: true };
  return null;
}

// Команды по темам (топикам) форума. Текст нормализован (lower, е). Операции над
// ТЕКУЩЕЙ темой (той, где написана команда), кроме create - тот создаёт новые.
const _TOPIC = '(?:топик[а-я]*|тем[ыуа]|раздел[а-я]*)';
export function parseTopicCmd(t) {
  let m;
  // создать (можно несколько имён): «создай топик X, Y»
  if ((m = t.match(new RegExp(`^(?:созда(?:й|ть)|добавь|доба[вф]ь|заведи|сделай|новый|нов[ыа][йя]|запили|замути|открой)\\s+${_TOPIC}[иов]*(?=[\\s:,-]|$)[:\\s-]*(.+)$`, 'i'))))
    return { op: 'create', arg: m[1] };
  if (new RegExp(`^(?:закрой|заверши|заморозь|заархивируй)\\s+${_TOPIC}`, 'i').test(t)) return { op: 'close' };
  if (new RegExp(`^(?:открой|возобнови|разморозь|переоткрой|разархивируй)\\s+${_TOPIC}`, 'i').test(t)) return { op: 'reopen' };
  if (new RegExp(`^(?:удали|снеси|убери|сотри|дропни|грохни)\\s+${_TOPIC}`, 'i').test(t)) return { op: 'delete' };
  if ((m = t.match(new RegExp(`^(?:переименуй|переназови|назови|смени(?:\\s+название)?|поменяй(?:\\s+название)?|обзови)\\s+(?:эт[уо]т?\\s+|текущ[а-я]+\\s+)?${_TOPIC}\\s*(?:в|на|как)?\\s*[:\\s-]*(.+)$`, 'i'))))
    return { op: 'rename', arg: m[1].trim().replace(/^["«»]|["«»]$/g, '').slice(0, 128) };
  return null;
}

// Трата (№7): «потратил 2000 на бензин», «купил кофе за 300», «минус 500 такси».
// Окончание съедается вместе с глаголом ([аи]?), иначе «потратила» матчится
// по мужской форме и хвост «а» уползает в категорию.
const EXPENSE_RE = /(?:потратил|истратил|купил|заплатил|оплатил|отдал|спустил)[аи]?|минус/;
export function parseExpense(raw, t, now = new Date()) {
  if (!EXPENSE_RE.test(t)) return null;
  // не путаем с долгом («заплатил Пете» = долг? нет, трата; «должен» ловится раньше)
  // сперва вырезаем время («в 16:00»), иначе его цифры утекают в сумму
  const noTime = extractDate(raw, now).rest || raw;
  const { amount, rest } = extractAmount(noTime);
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
  // Прощания/приветствия - это болтовня (уйдёт в ИИ), а не «встреча». «до
  // встречи» иначе ловилось словом «встреч» и создавало фейковую встречу.
  if (/^(?:ну\s+)?(?:пока|до встречи|до связи|до скорого|до завтра|бывай|бб|чао|прощай|спок(?:и|ойной ночи)|удачи|споки)[!.…]*$/.test(t)) {
    return entry('note', { title: cap(raw.slice(0, 80)) || raw, text: raw });
  }

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
    /^(?:напомни|надо|нужно|не забыть|не забудь|задача|сделать|доделать|купить|позвонить|оплатить|отправить|проверить|подготовить|записаться|добавь задачу|поставь таймер|таймер|поставь будильник|будильник|засеки|засечь)/;
  // NB: \b не работает с кириллицей в JS — используем lookaround, иначе
  // «поставь мне таймер…» падало в note и напоминание не создавалось.
  if (taskStart.test(t) || /задач/.test(t) || t.includes('напомни') || /(?:^|[^а-яё])(?:таймер|будильник)(?![а-яё])/.test(t)) {
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

// Слова, которые не могут быть именем контрагента после «одолжил».
const DEBT_STOP = new Set([
  'у', 'мне', 'нам', 'тебе', 'вам', 'ему', 'ей', 'им', 'себе',
  'немного', 'чуть', 'ещё', 'еще', 'свои', 'свою', 'деньги', 'денег',
]);

function parseDebt(raw, t, dt, due) {
  const { amount, rest } = extractAmount(dt.rest);

  let direction = 'in';
  let counterparty = null;
  let m;

  // «занял/одолжил у X», «взял в долг у X» — я взял в долг → я должен (out).
  // Раньше direction/counterparty смотрели только на корень «долж» и теряли эти фразы.
  const borrowVerb =
    /занял|заняла|одолжил|одолжила/.test(t) ||
    /(^|\s)взял[аи]?\s+(?:в\s+долг|денег|деньги)/.test(t);
  if (borrowVerb && (m = t.match(/(?:^|\s)у\s+([а-яёa-z][а-яёa-z-]+)/))) {
    direction = 'out';
    counterparty = cap(m[1]);
  } else if (
    (m = t.match(/(?:одолжил|одолжила)\s+(?:денег\s+|деньги\s+)?([а-яёa-z][а-яёa-z-]+)/)) &&
    !DEBT_STOP.has(m[1])
  ) {
    // «одолжил Диме», «одолжил денег другу» — дал в долг → мне должны (in).
    direction = 'in';
    counterparty = cap(m[1]);
  } else {
    if (
      /(^|\s)(я|мы)\s+долж/.test(t) ||
      /долж[а-я]*\s+(я|мы)(\s|$)/.test(t) || // «должен я Кузнецову…»
      /мой долг|наш долг|(^|\s)я взял/.test(t)
    ) {
      direction = 'out';
    }
    if (/долж[а-я]*\s+(мне|нам)(\s|$)/.test(t) || /(мне|нам)\s+долж/.test(t)) direction = 'in';

    counterparty = findCounterparty(rest);
  }

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
