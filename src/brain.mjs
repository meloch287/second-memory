// «Мозг» ассистента: превращает разобранную фразу в действие над хранилищем
// и человеческий ответ на русском.

import { parseMessage } from './parser.mjs';
import { normText } from './dates.mjs';
import { aiEnabled, aiAnswer, aiSearch } from './ai.mjs';
import { balanceReport, expensesReport } from './finance.mjs';
import { questionCoverage } from './ragmeter.mjs';
import { resolveWallDate, userOffset, fmtUser, DEFAULT_OFFSET } from './tz.mjs';

import { money, pad } from './format.mjs';
import { phrase } from './phrase.mjs';
import { extractEntry } from './extract.mjs';

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
// Приводит срок записи к настенному времени пользователя, а задаче-напоминанию
// с датой без времени («напомни завтра оплатить») ставит полдень — иначе точное
// напоминание не сработает (фильтры due требуют hasTime). Едина для бота
// (captureEntry) и веба (route), чтобы напоминания вели себя одинаково.
export function normalizeReminderDue(entry, text, now, offsetMin = DEFAULT_OFFSET) {
  if (entry.due) {
    const r = resolveWallDate(offsetMin, text, now); // срок в часовом поясе пользователя
    if (r.due) {
      entry.due = r.due;
      entry.hasTime = r.hasTime;
    }
  }
  if (entry.type === 'task' && entry.due && !entry.hasTime) {
    const d = new Date(new Date(entry.due).getTime() + offsetMin * 60000); // настенное
    entry.due = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0) - offsetMin * 60000).toISOString();
    entry.hasTime = true;
  }
  return entry;
}

export function captureEntry(store, text, now = new Date(), chatId = 'web', offsetMin = DEFAULT_OFFSET) {
  const p = parseMessage(text, now);
  if (p.kind !== 'entry' || p.entry.type === 'note') return null;
  const entry = normalizeReminderDue({ ...p.entry, chatId }, text, now, offsetMin);
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
        reply: await phrase(
          store,
          chatId,
          'Человек прислал пустое сообщение. Подскажи, что можно записать или спросить, и упомяни команду «помощь».',
          'Напишите, что записать или показать. Пример: «клиент должен 50 000 до 20 июля». Команда «помощь» покажет всё.',
        ),
      };
    case 'help':
      return { reply: HELP };
    case 'clearchat':
      store.clearHistory(chatId);
      return {
        reply: await phrase(
          store,
          chatId,
          'Переписка в этом чате очищена. Дела и факты в памяти остались; чтобы стереть всё, нужно сказать «очисти память».',
          'Очистил переписку в этом чате. Дела и факты в памяти остались - чтобы стереть всё, скажи «очисти память».',
        ),
        cleared: true,
      };
    case 'wipe': {
      const n = store.wipeMemory(chatId);
      const parts = [];
      if (n.facts) parts.push(`${n.facts} ${plural(n.facts, ['факт', 'факта', 'фактов'])}`);
      if (n.entries) parts.push(`${n.entries} ${plural(n.entries, ['запись', 'записи', 'записей'])}`);
      const what = parts.length ? `Удалил ${parts.join(' и ')}. ` : 'Память и так была пуста. ';
      return {
        reply: await phrase(
          store,
          chatId,
          `Вся память по этому чату стёрта. ${what}Начинаем с чистого листа.`,
          `Стёр всю память по этому чату. ${what}Начинаем с чистого листа.`,
        ),
        cleared: true,
      };
    }
    case 'entry': {
      // СНАЧАЛА МОДЕЛЬ, правила — только если её нет.
      //
      // Раньше было наоборот: правила разбирали фразу, а модель звали лишь
      // тогда, когда правила сдались и назвали всё «заметкой». Из-за этого
      // модель никогда не видела как раз те фразы, которые правила понимали
      // НЕВЕРНО. Живой пример из переписки: «созвон в 2:30» правила записали на
      // 14:30, а через четыре дня «созвон в 3:30» — на 03:30, ночь. Одна и та
      // же конструкция, разный разбор, и владельцу пришлось поправлять вручную.
      //
      // Правила не выкинуты: без ключа модели бот должен продолжать работать.
      // Но теперь они запасной путь, а не основной.
      if (aiEnabled() && !/\?\s*$/.test(String(text).trim())) {
        try {
          const умный = await extractEntry(text, now, off ?? DEFAULT_OFFSET);
          if (умный && умный.isRecord && умный.type !== 'note') {
            const собрано = normalizeReminderDue(
              { ...p.entry, type: умный.type, title: умный.title, chatId },
              text,
              now,
              off ?? DEFAULT_OFFSET,
            );
            Object.assign(собрано, await refineEntry(собрано, text, now, off));
            store.addRaw(chatId, text);
            return await saveEntry(store, собрано, off, chatId);
          }
        } catch {
          // Модель молчит — идём по правилам ниже, как раньше.
        }
      }
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
        // Но сперва спрашиваем модель, точно ли это заметка. Правила зовут
        // заметкой всё, что не подошло под их шаблоны, и так терялись настоящие
        // дела: «Лена вернёт 15к в пятницу» - это долг, «в субботу утром забрать
        // посылку» - задача. Раньше оба уходили в разговор и не сохранялись.
        const умный = await extractEntry(text, now, off ?? DEFAULT_OFFSET);
        if (умный && умный.type !== 'note' && умный.isRecord) {
          const собрано = normalizeReminderDue(
            { ...p.entry, type: умный.type, title: умный.title, chatId },
            text,
            now,
            off ?? DEFAULT_OFFSET,
          );
          Object.assign(собрано, await refineEntry(собрано, text, now, off));
          store.addRaw(chatId, text);
          return await saveEntry(store, собрано, off, chatId);
        }
        try {
          store.addRaw(chatId, text);
          const rag = questionCoverage(store, text, chatId);
          return { reply: await aiAnswer(store, text, now, chatId), ai: true, rag };
        } catch {
          // ИИ недоступен — сохраняем заметку по-старому
        }
      }
      // Веб раньше сохранял срок «как распарсилось» (без полудня/пояса) → задачи
      // без времени имели hasTime=false и НИКОГДА не напоминали. Нормализуем как бот.
      // Поля записи уточняет модель: правила ловят «это запись», но плохо
      // достают из живой речи тему, дату и время. Не ответила - остаются
      // разобранные по правилам, как было.
      // Срок сперва разбирают правила: часовой пояс и «послезавтра» они считают
      // верно. Модель дополняет то, что им не даётся, - тему, тип и время суток.
      const уточнение = await refineEntry(p.entry, text, now, off);

      // Правила зовут задачей всё, где мелькнуло слово «задача» или «напомни».
      // Так в дела попадали вопросы боту («Ты можешь решать задачи?»),
      // благодарности («Спасибо, что напомнил») и пустышки («Напомнить»).
      // Модель отвечает отдельно, просят ли это запомнить, - и если нет,
      // разговор остаётся разговором.
      // Пересланное и присланные файлы - чужая речь, а не поручение. Правила
      // же ловят в них слово «должен» и заводят долг: в базе так и лежат
      // «Долг: ПРОМТ- ТЗ копирайтеру.md» и «Долг: При». Для такого текста
      // молчания модели недостаточно - нужно явное «да, это запись».
      const чужаяРечь = /^\s*\[(?:Переслал|Прислал)/i.test(String(text));
      const записывать = чужаяРечь ? уточнение.isRecord === true : уточнение.isRecord !== false;

      if (!записывать && aiEnabled()) {
        try {
          store.addRaw(chatId, text);
          return { reply: await aiAnswer(store, text, now, chatId), ai: true, rag: questionCoverage(store, text, chatId) };
        } catch {
          // ИИ отвалился. Для своей речи запишем по старым правилам - лучше
          // лишнее, чем потерянное. Для чужой не станем: там правила ошибаются
          // чаще, чем угадывают.
          if (чужаяРечь) return { reply: '' };
        }
      }
      if (!записывать && чужаяРечь) {
        store.addRaw(chatId, text);
        return { reply: '' };
      }

      const по_правилам = normalizeReminderDue(
        { ...p.entry, chatId },
        text,
        now,
        off ?? DEFAULT_OFFSET,
      );
      // Уточняем от ИСХОДНОГО разбора, а не от нормализованного: задачам без
      // времени правила проставляют полдень, и «утром» от модели уже не имело
      // шанса - полдень выглядел как найденное время.
      const { isRecord: _1, isCorrection: поправка, ...поля } = уточнение;
      const готово = Object.assign(по_правилам, поля);

      // Поправка меняет прошлую запись, а не заводит новую. Раньше на «не не
      // в 15:30» появлялась вторая задача, а ошибочная оставалась жить и
      // напоминала в свой срок - в базе так и лежат тройки про один созвон.
      if (поправка || похожеНаПоправку(text)) {
        const прошлая = последняяЗапись(store, chatId);
        if (прошлая) {
          store.patch(прошлая.id, поля);
          const t = `Запись №${прошлая.id} исправлена: ${готово.title}.`;
          return { reply: await phrase(store, chatId, t, t), entry: прошлая };
        }
      }

      return await saveEntry(store, готово, off, chatId);
    }
    case 'done':
      return await markDone(store, p.target, chatId);
    case 'delete':
      return await removeEntry(store, p.target, chatId);
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
      return {
        reply: await phrase(
          store,
          chatId,
          `Записана трата ${money(p.amount)}, категория «${e.category}».`,
          `Записал трату: ${money(p.amount)} - ${e.category}.`,
        ),
        entry: e,
      };
    }
    case 'forget': {
      const n = store.removeFactsMatching(chatId, p.target);
      return {
        reply: await phrase(
          store,
          chatId,
          n
            ? `Из памяти убрано всё про «${p.target}».`
            : `В памяти ничего про «${p.target}» не нашлось, забывать нечего.`,
          n ? `Забыл про «${p.target}».` : `Не нашёл в памяти «${p.target}», забывать нечего.`,
        ),
      };
    }
    case 'search':
      if (aiEnabled()) {
        try { return { reply: await aiSearch(store, chatId, p.query, now), ai: true, rag: questionCoverage(store, p.query, chatId) }; } catch { /* ниже */ }
      }
      return {
        reply: await phrase(
          store,
          chatId,
          'Поиск по памяти сейчас недоступен - ИИ не отвечает. Предложи повторить позже.',
          'Поиск по памяти сейчас недоступен.',
        ),
      };
    default:
      // всё, что веб-роутинг не разбирает структурно, при живом ИИ - в разговор
      // (вместо «Не понял»): курс валют, опрос, график, повтор, ДР и т.п.
      if (aiEnabled()) {
        try { return { reply: await aiAnswer(store, text, now, chatId), ai: true, rag: questionCoverage(store, text, chatId) }; } catch { /* ниже */ }
      }
      return {
        reply: await phrase(
          store,
          chatId,
          'Смысл сообщения непонятен. Переспроси и упомяни, что «помощь» покажет примеры.',
          'Не понял. Напишите «помощь», чтобы увидеть примеры.',
        ),
      };
  }
}

/**
 * Уточнение полей записи моделью.
 *
 * Возвращает только те поля, которые модель определила уверенно. Пустые не
 * отдаём: пусть лучше останется значение из правил, чем затрётся на null.
 * Текст исходного сообщения не трогаем никогда - он единственный источник
 * правды о том, что человек написал.
 */
async function refineEntry(base, text, now, off) {
  const offsetMin = off ?? DEFAULT_OFFSET;
  const умный = await extractEntry(text, now, offsetMin);
  if (!умный) return {};

  const патч = {
    type: умный.type,
    // Поправка приходит без темы - прежнюю не затираем.
    ...(умный.title ? { title: умный.title } : {}),
    // Служебные признаки: до самой записи они не доходят, их снимают ниже.
    isRecord: умный.isRecord,
    isCorrection: умный.isCorrection,
  };
  if (умный.amount != null) патч.amount = умный.amount;
  if (умный.counterparty) патч.counterparty = умный.counterparty;
  if (умный.direction) патч.direction = умный.direction;

  // Со сроком осторожно. Правила знают часовой пояс и относительные дни лучше
  // модели, поэтому спорить с ними не даём. Берём модель только там, где
  // правила промолчали: срока нет вовсе или день найден, а время суток - нет.
  // Это и был главный изъян календаря: «в половине четвёртого» превращалось
  // в запись на весь день.
  if (умный.due) {
    const utc = localToUtc(умный.due, offsetMin);
    if (utc) {
      if (!base.due) {
        патч.due = utc;
        патч.hasTime = умный.hasTime;
      } else if (!base.hasTime && умный.hasTime && sameDay(base.due, utc, offsetMin)) {
        // День тот же, а время нашлось - дополняем, не сдвигая дату.
        патч.due = utc;
        патч.hasTime = true;
      } else if (умный.hasTime && ночноеСомнительно(base, text, offsetMin) && sameDay(base.due, utc, offsetMin)) {
        // «Созвон в 3:30» правила читают как полчетвёртого ночи. Человек почти
        // никогда не имеет это в виду - и в переписке это видно: пришлось
        // поправлять вручную. Если ночь не названа прямо, верим модели.
        патч.due = utc;
        патч.hasTime = true;
      }
    }
  }
  return патч;
}

/**
 * Слова, которыми поправляют только что сказанное. Список короткий намеренно:
 * широкий шаблон начнёт съедать новые дела, а это хуже дубля.
 */
function похожеНаПоправку(text) {
  const t = String(text).toLowerCase().trim();
  return /^(?:не[ ,]+не|нет[ ,]|неа|я имел в виду|имел в виду|не так|ошибся|поправка|перенеси|исправь)/.test(t);
}

/**
 * Последняя запись этого чата - её и правит человек, когда говорит «не не, в
 * 15:30». Берём самую свежую по времени создания, а не по сроку: поправляют
 * всегда только что сказанное.
 */
function последняяЗапись(store, chatId) {
  const свои = store.data.entries.filter((e) => String(e.chatId) === String(chatId));
  if (!свои.length) return null;
  const последняя = свои[свои.length - 1];
  // Через час это уже не поправка, а новое дело: человек давно ушёл к другому.
  const возраст = Date.now() - new Date(последняя.createdAt || последняя.ts || 0).getTime();
  return Number.isFinite(возраст) && возраст < 60 * 60 * 1000 ? последняя : null;
}

/** Настенное «2026-08-27T15:30» в честный UTC, как хранит база. */
function localToUtc(local, offsetMin) {
  const t = Date.parse(`${local}:00Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t - offsetMin * 60000).toISOString();
}

/**
 * Похоже ли, что правила ошиблись с половиной суток. «В 3:30» без слова «ночи»
 * почти всегда значит полчетвёртого дня: ночью люди не назначают созвоны.
 */
function ночноеСомнительно(base, text, offsetMin) {
  if (!base.due || !base.hasTime) return false;
  const час = new Date(new Date(base.due).getTime() + offsetMin * 60000).getUTCHours();
  if (час >= 7) return false;
  return !/ноч|утра|am\b|рано/i.test(String(text));
}

/** Один ли это день по часам пользователя, а не по Гринвичу. */
function sameDay(a, b, offsetMin) {
  const день = (iso) => new Date(new Date(iso).getTime() + offsetMin * 60000).toISOString().slice(0, 10);
  return день(a) === день(b);
}

// Текст подтверждения для УЖЕ сохранённой записи (без повторного store.add).
// Вынесено, чтобы бот мог подтвердить тихо пойманную запись при сбое ИИ.
export function entryConfirmation(e, off = null) {
  if (e.type === 'debt') {
    const sum = e.amount != null ? money(e.amount) : 'сумма не указана';
    const till = e.due ? `, срок до ${fmtDate(e.due, false, off)}` : '';
    if (e.direction === 'out') {
      return `Записал долг №${e.id}: вы должны${e.counterparty ? ' ' + e.counterparty : ''} ${sum}${till}.`;
    }
    if (e.counterparty) return `Записал долг №${e.id}: ${e.counterparty} должен вам ${sum}${till}.`;
    return `Записал долг №${e.id}: вам должны ${sum}${till}.`;
  }
  if (e.type === 'meeting') {
    return `Записал встречу №${e.id}: ${e.title}${e.due ? `, ${fmtDate(e.due, e.hasTime, off)}` : ', дата не указана'}.`;
  }
  if (e.type === 'task') {
    return `Записал задачу №${e.id}: ${e.title}${e.due ? `, срок ${fmtDate(e.due, e.hasTime, off)}` : ''}.`;
  }
  return `Сохранил заметку №${e.id}: «${e.title}».`;
}

async function saveEntry(store, entry, off = null, chatId = 'web') {
  const e = store.add(entry);
  // entryConfirmation остаётся точным описанием факта и уходит откатом:
  // подтверждение обязано прийти, даже если модель молчит.
  const шаблон = entryConfirmation(e, off);
  return { reply: await phrase(store, chatId, шаблон, шаблон), entry: e };
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

async function markDone(store, target, chatId = 'web') {
  const e = findTarget(store, target, chatId);
  if (!e) {
    const t = `Запись «${target}» не найдена.`;
    return { reply: await phrase(store, chatId, t, `Не нашёл запись «${target}».`) };
  }
  if (e.status === 'done') {
    const t = `Запись №${e.id} уже была закрыта раньше.`;
    return { reply: await phrase(store, chatId, t, `Запись №${e.id} уже закрыта.`) };
  }
  store.setStatus(e.id, 'done');
  const t = `${TYPE_LABEL[e.type]} №${e.id} закрыта.`;
  return { reply: await phrase(store, chatId, t, `Готово: ${t}`), entry: e };
}

async function removeEntry(store, target, chatId = 'web') {
  const e = findTarget(store, target, chatId);
  if (!e) {
    const t = `Запись «${target}» не найдена.`;
    return { reply: await phrase(store, chatId, t, `Не нашёл запись «${target}».`) };
  }
  store.remove(e.id);
  const t = `${TYPE_LABEL[e.type]} №${e.id} удалена.`;
  return { reply: await phrase(store, chatId, t, `Удалил: ${t}`), entry: e };
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
