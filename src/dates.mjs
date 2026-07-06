// Извлечение дат, времени и денежных сумм из русского текста.
// Внимание: \b в JS-регулярках не работает с кириллицей, поэтому границы
// слов задаются явными lookbehind/lookahead (B и E).

const B = '(?<![0-9a-zа-я])';
const E = '(?![0-9a-zа-я])';
const P = '(?:(?:до|к|на|в|во)\\s+)?';

const re = (pattern, flags = '') => new RegExp(pattern, flags);

export const normText = (s) => String(s).toLowerCase().replace(/ё/g, 'е');

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function nextWeekday(base, wd) {
  let diff = (wd - base.getDay() + 7) % 7;
  if (diff === 0) diff = 7;
  return addDays(base, diff);
}

const MONTH_WORD =
  '(январ[яье]?|феврал[яье]?|март[ае]?|апрел[яье]?|ма[йяе]|июн[яье]?|июл[яье]?|август[ае]?|сентябр[яье]?|октябр[яье]?|ноябр[яье]?|декабр[яье]?)';

const MONTH_BY_STEM = {
  янв: 0, фев: 1, мар: 2, апр: 3, май: 4, мая: 4, мае: 4,
  июн: 5, июл: 6, авг: 7, сен: 8, окт: 9, ноя: 10, дек: 11,
};

function monthIndex(word) {
  const key = word.slice(0, 3);
  return key in MONTH_BY_STEM ? MONTH_BY_STEM[key] : -1;
}

const WEEKDAY_WORD =
  '(воскресень[ея]|понедельник[ау]?|вторник[ау]?|сред[ауы]|четверг[ау]?|пятниц[ауы]|суббот[ауы])';

function weekdayIndex(word) {
  if (word.startsWith('воскрес')) return 0;
  if (word.startsWith('понедел')) return 1;
  if (word.startsWith('вторн')) return 2;
  if (word.startsWith('сред')) return 3;
  if (word.startsWith('четверг')) return 4;
  if (word.startsWith('пятниц')) return 5;
  return 6;
}

/**
 * Находит в тексте дату и время, возвращает { when, hasTime, rest }.
 * rest — исходный текст без найденных фрагментов даты/времени.
 */
export function extractDate(text, base = new Date()) {
  let src = String(text);
  let day = null;
  let hasTime = false;
  let hh = 0;
  let mm = 0;

  const low = () => normText(src);
  const cut = (m) => {
    src = src.slice(0, m.index) + ' ' + src.slice(m.index + m[0].length);
  };

  const dayMatchers = [
    [re(B + P + 'послезавтра' + E), () => addDays(base, 2)],
    [re(B + P + 'завтра' + E), () => addDays(base, 1)],
    [re(B + P + 'сегодня(?:шн[а-я]*)?' + E), () => new Date(base)],
    [
      re(B + 'через\\s+(\\d+\\s*)?(день|дня|дней|недел[а-я]*|месяц[а-я]*)' + E),
      (m) => {
        const n = m[1] ? parseInt(m[1], 10) : 1;
        if (m[2].startsWith('недел')) return addDays(base, n * 7);
        if (m[2].startsWith('месяц')) {
          const x = new Date(base);
          x.setMonth(x.getMonth() + n);
          return x;
        }
        return addDays(base, n);
      },
    ],
    [
      re(B + P + 'конц[ае]\\s+(недел[иье]|месяца|года)' + E),
      (m) => {
        if (m[1].startsWith('недел')) return nextWeekday(base, 0);
        if (m[1] === 'года') return new Date(base.getFullYear(), 11, 31);
        return new Date(base.getFullYear(), base.getMonth() + 1, 0);
      },
    ],
    [
      re('(?<![\\d.,:])(\\d{1,2})\\s*(?:-?го)?\\s+' + MONTH_WORD + '(?:\\s+(\\d{4}))?' + E),
      (m) => {
        const d = +m[1];
        const mo = monthIndex(m[2]);
        if (mo < 0 || d < 1 || d > 31) return null;
        const y = m[3] ? +m[3] : base.getFullYear();
        let dt = new Date(y, mo, d);
        // дата без года, сильно в прошлом — значит, речь о следующем годе
        if (!m[3] && dt < addDays(startOfDay(base), -60)) dt = new Date(y + 1, mo, d);
        return dt;
      },
    ],
    [
      /(?<![\d.,:])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d.:])(?!\s*(?:млн|тыс|руб|₽|%))/,
      (m) => {
        const d = +m[1];
        const mo = +m[2] - 1;
        if (d < 1 || d > 31 || mo < 0 || mo > 11) return null;
        let y = m[3] ? +m[3] : base.getFullYear();
        if (y < 100) y += 2000;
        return new Date(y, mo, d);
      },
    ],
    [re(B + P + WEEKDAY_WORD + E), (m) => nextWeekday(base, weekdayIndex(m[1]))],
  ];

  for (const [rx, make] of dayMatchers) {
    const m = low().match(rx);
    if (!m) continue;
    const d = make(m);
    if (!d) continue;
    day = d;
    cut(m);
    break;
  }

  {
    const t = low();
    let m = t.match(/(?:(?<![0-9a-zа-я])(?:в|к|на)\s+)?(\d{1,2}):(\d{2})(?![\d.:])/);
    if (m && +m[1] <= 23 && +m[2] <= 59) {
      hh = +m[1];
      mm = +m[2];
      hasTime = true;
      cut(m);
    } else {
      m = t.match(
        re(
          B +
            'в\\s+(\\d{1,2})(\\s*час(?:а|ов)?|\\s*ч' + E + ')?(\\s+утра|\\s+вечера|\\s+дня|\\s+ночи)?' +
            '(?![.,]?\\d)(?!\\s+\\d)(?!\\s*(?:руб|₽|тыс|млн|мин|км|кг|шт|раз|%))'
        )
      );
      if (m && +m[1] <= 23) {
        hh = +m[1];
        hasTime = true;
        const suffix = (m[3] || '').trim();
        if (suffix === 'вечера' && hh < 12) hh += 12;
        if (suffix === 'дня' && hh <= 6) hh += 12;
        if (suffix === 'ночи' && hh === 12) hh = 0;
        cut(m);
      }
    }
  }

  if (hasTime && !day) day = new Date(base);

  let when = null;
  if (day) when = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm);

  const rest = src
    .replace(/\s{2,}/g, ' ')
    .replace(re('\\s+(до|к|на|в|во|и)\\s*$'), '')
    .trim()
    .replace(/^[\s,.:;!?–—-]+/, '')
    .replace(/[\s,.:;–—-]+$/, '');

  return { when, hasTime, rest };
}

/**
 * Находит денежную сумму («50 000», «15к», «1,5 млн», «120 000 руб»).
 * Возвращает { amount, rest }. Числа без валюты/множителя меньше 100 игнорируются.
 */
export function extractAmount(text) {
  const rx =
    /(?<![№#\d,.:])(\d[\d\s]*(?:[.,]\d+)?)\s*(млн|миллион[а-я]*|тыс[а-я]*\.?|к(?![0-9a-zа-я])|k(?![0-9a-zа-я]))?\s*(руб[а-я]*\.?|р\.|₽)?/gi;

  let best = null;
  for (const m of normText(text).matchAll(rx)) {
    const numStr = m[1].replace(/\s+/g, '').replace(',', '.');
    let v = parseFloat(numStr);
    if (!isFinite(v)) continue;
    const unit = m[2] || '';
    if (unit.startsWith('млн') || unit.startsWith('миллион')) v *= 1e6;
    else if (unit) v *= 1e3;
    const strong = Boolean(m[2] || m[3]);
    if (!strong && v < 100) continue;
    const cand = { v, strong, index: m.index, len: m[0].length };
    if (!best || (cand.strong && !best.strong) || (cand.strong === best.strong && cand.v > best.v)) {
      best = cand;
    }
  }

  if (!best) return { amount: null, rest: String(text) };
  const rest = (String(text).slice(0, best.index) + ' ' + String(text).slice(best.index + best.len))
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { amount: best.v, rest };
}
