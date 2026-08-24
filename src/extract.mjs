// Разбор записи моделью, а не регулярками.
//
// Раньше всё решал parser.mjs: набор шаблонов вылавливал тип, дату и заголовок.
// На простых фразах это работает и стоит ноль, но живая речь в шаблоны не лезет.
// В базе это видно: у встреч заголовки по семьдесят символов - в название падала
// вся фраза целиком, - а время находилось не всегда.
//
// Здесь наоборот: фразу читает модель и возвращает разобранные поля, а парсер
// остаётся страховкой. Такой порядок важен - если модель молчит или отвечает
// ерундой, запись всё равно сохранится по старым правилам, а не потеряется.
//
// Модель НЕ решает, запись это или вопрос: это по-прежнему дело парсера. Здесь
// только уточняются поля уже опознанной записи - тип, заголовок, дата, сумма.

import { TEXT, chatCompletion } from './ai.mjs';

const TIMEOUT_MS = 9000;
const MAX_TOKENS = 300;

const TYPES = new Set(['debt', 'meeting', 'task', 'note']);
/** Заголовок - это тема, а не пересказ. Длинное превращается в кашу в списках. */
const MAX_TITLE = 70;

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Местное время пользователя в виде, который понимает и человек, и модель. */
function localNow(now, offsetMin) {
  const d = new Date(now.getTime() + offsetMin * 60000);
  const dow = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'][
    d.getUTCDay()
  ];
  return {
    iso: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    dow,
  };
}

const SCHEMA = `Верни ТОЛЬКО JSON без пояснений и без markdown:
{
  "type": "debt" | "meeting" | "task" | "note",
  "title": "короткая тема, до 70 знаков, без дат и времени внутри",
  "due": "YYYY-MM-DDTHH:mm" или null,
  "hasTime": true | false,
  "amount": число или null,
  "counterparty": "имя человека или организации" или null,
  "direction": "in" | "out" | null,
  "isRecord": true | false,
  "isCorrection": true | false
}`;

const RULES = `Ты разбираешь короткое сообщение человека в структурную запись.

type:
- debt - речь о деньгах в долг. direction "in" - должны человеку, "out" - должен он.
- meeting - встреча, созвон, совещание, приём, поездка к кому-то в конкретное время.
- task - что-то надо сделать: купить, позвонить, оплатить, напомнить.
- note - всё остальное, что стоит просто запомнить.

title: только суть. «Встреча с Кириллом по договору» - да. Всю фразу целиком, дату
или время внутрь заголовка не клади.

due и hasTime:
- Считай относительные слова от текущего момента: «завтра», «в пятницу», «через час».
- Если время названо («в 15:30», «в три часа дня», «утром» = 09:00, «вечером» = 19:00) -
  ставь его и hasTime: true.
- Если названа только дата - время 00:00 и hasTime: false.
- Если срока нет вовсе - due: null и hasTime: false.
- Голые часы без пометки суток («в 2:30», «в 3:30», «в 11») для встреч, созвонов,
  приёмов и рабочих дел — это ДЕНЬ, а не ночь: 2:30 значит 14:30, 3:30 значит
  15:30, 11 значит 11:00. Ночное время ставь, только если сказано прямо: «в два
  ночи», «в 03:30 ночи», «под утро».
  Это не придирка: владелец дважды писал «созвон в 2:30» и «созвон в 3:30», и
  разбор по правилам дал 14:30 и 03:30 — разное для одинаковых фраз. Ночной
  созвон пришлось отменять руками.
- Если пользователь просит НАПОМНИТЬ о деле («напомни за 15 минут») — это часть
  той же записи, а не отдельная задача. Не создавай запись «напомнить о созвоне»
  рядом с самим созвоном: в календаре появлялись оба.
- Год бери ближайший будущий, если он не назван прямо.

amount: число без пробелов и знаков валюты. «50к» = 50000, «полтора миллиона» = 1500000.

isRecord - человек правда хочет, чтобы это запомнили и напомнили?
- true: конкретное обязательство. «Лена вернёт 15к в пятницу», «оплатить хостинг
  до 31-го», «встреча с инвестором во вторник в 10».
- false: болтовня, приветствие, мнение, предложение без договорённости.
  «ку, как сам», «го гулять вечером», «жара сегодня», «норм фильм».
Сомневаешься - ставь false: лишняя запись в календаре раздражает сильнее, чем
её отсутствие.

isCorrection - человек поправляет то, что ты записал только что, а не заводит
новое дело? «не не в 15:30», «я имел в виду в среду», «нет, 20 тысяч, а не 10»,
«перенеси на пятницу» - true. Новое, ни с чем не связанное дело - false.

Ничего не выдумывай: чего в сообщении нет, то null.`;

/**
 * @returns разобранные поля или null, если модель недоступна или ответила плохо.
 */
export async function extractEntry(text, now = new Date(), offsetMin = 180) {
  const cfg = TEXT();
  if (!cfg.key || !String(text || '').trim()) return null;

  const { iso, dow } = localNow(now, offsetMin);

  try {
    const out = await chatCompletion(
      cfg,
      [
        { role: 'system', content: `${RULES}\n\n${SCHEMA}` },
        {
          role: 'user',
          content: `Сейчас ${iso} (${dow}), часовой пояс UTC+${offsetMin / 60}.\n\nСообщение: ${text}`,
        },
      ],
      // Одна попытка: запись должна сохраниться сразу, а не через полминуты
      // ожиданий. Не вышло - сработает разбор по правилам.
      { maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS, retryDelays: [0] },
    );

    return validate(out, now);
  } catch {
    return null;
  }
}

/**
 * Проверка ответа модели. Строгая намеренно: лучше откатиться на правила, чем
 * записать в календарь встречу в 1970 году или заголовок на три абзаца.
 */
export function validate(raw, now = new Date()) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }

  if (!data || !TYPES.has(data.type)) return null;

  const title = String(data.title || '').trim().slice(0, MAX_TITLE);
  // У поправки темы нет и быть не должно: «не не, в 15:30» - это про время
  // уже записанного дела. Требовать заголовок здесь значило бы выбрасывать
  // саму поправку, а именно из-за этого в базе и росли тройки записей.
  if (!title && data.isCorrection !== true) return null;

  let due = null;
  let hasTime = false;
  if (data.due) {
    const m = String(data.due).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    if (!m) return null;
    const when = new Date(`${data.due}:00Z`);
    if (Number.isNaN(when.getTime())) return null;
    // Окно здравого смысла: год назад и пять лет вперёд. За его пределами это
    // почти всегда ошибка разбора, а не намерение человека.
    const год = 365 * 24 * 3600 * 1000;
    if (when.getTime() < now.getTime() - год || when.getTime() > now.getTime() + 5 * год) {
      return null;
    }
    due = String(data.due);
    hasTime = Boolean(data.hasTime) && !/T00:00$/.test(due);
  }

  let amount = null;
  if (data.amount != null) {
    const n = Number(data.amount);
    if (!Number.isFinite(n) || n < 0) return null;
    amount = n;
  }

  const counterparty = data.counterparty ? String(data.counterparty).trim().slice(0, 60) : null;
  const direction = data.direction === 'in' || data.direction === 'out' ? data.direction : null;

  return {
    type: data.type,
    title,
    due,
    hasTime,
    amount,
    counterparty,
    direction,
    // Молчание считаем согласием только там, где вызывающий сам решил, что это
    // запись. Для спорных случаев он спросит про isRecord явно.
    isRecord: data.isRecord !== false,
    isCorrection: data.isCorrection === true,
  };
}
