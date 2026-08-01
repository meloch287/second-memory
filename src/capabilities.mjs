// ЕДИНЫЙ РЕЕСТР ВОЗМОЖНОСТЕЙ ТОЛИКА - источник правды о том, что бот умеет.
//
// ПРАВИЛО ПРОЕКТА: добавил фичу -> добавь строку в CAPABILITIES ниже и раздел в
// docs/FEATURES.md. Тогда Толик СРАЗУ про неё знает: реестр уезжает в системный
// промпт (capabilitiesLine), а живое состояние фичи (что реально лежит у юзера в
// календаре/вишлисте/тренировках) - в контекст разговора (featureState).
// Иначе бот будет отрицать собственную функцию - худший баг для ассистента.

import { fmtUser } from './tz.mjs';

// key      - идентификатор фичи (совпадает с разделом в docs/FEATURES.md)
// what     - что умеет (от лица бота, для промпта)
// how      - как это включить/позвать (подсказка юзеру)
export const CAPABILITIES = [
  { key: 'voice', what: 'отвечать голосовыми сообщениями и понимать голосовые, кружки и аудио', how: '«отвечай голосом» / «отвечай текстом»' },
  { key: 'media', what: 'смотреть фото и картинки, читать чеки (фото чека = записать трату), PDF и документы', how: 'просто пришли файл или фото' },
  { key: 'reminders', what: 'напоминать о делах в срок и заранее, в том числе повторяющиеся, переносить и отменять', how: '«напомни завтра в 18 про...»' },
  { key: 'debts', what: 'вести долги: кто кому должен, сроки, добавление/правка/удаление', how: '«баланс» или ЛК → Долги' },
  { key: 'expenses', what: 'считать траты и бюджет, рисовать графики по данным из памяти', how: '«траты», «нарисуй график трат»' },
  { key: 'wishlist', what: 'вести ВИШЛИСТ желаний: товары по ссылке (сам подтягивает название, фото и цену) или вручную, с фото-галереей, правкой и удалением', how: 'ЛК → Вишлист, кнопка «Добавить»' },
  { key: 'calendar', what: 'вести КАЛЕНДАРЬ: месячная сетка, события по дням, подписка на Apple Календарь, выгрузка и загрузка .ics', how: 'ЛК → Календарь; событие добавляется фразой с ключевым словом «календарь»' },
  { key: 'fitness', what: 'быть ЛИЧНЫМ ТРЕНЕРОМ: профиль (вес, рост, возраст, цель, уровень), дни тренировок и программа на каждый день', how: 'ЛК → Фитнес' },
  { key: 'memory', what: 'помнить факты о человеке и его жизни, искать по памяти, забывать по просьбе, выгружать память файлом', how: '«найди про...», «забудь про...», «экспорт»' },
  { key: 'lk', what: 'показывать личный кабинет со статистикой и разделами', how: '/settings или «личный кабинет»' },
];

// Строка возможностей для системного промпта: бот НИКОГДА не должен отрицать,
// что умеет что-то из этого списка.
export function capabilitiesLine() {
  const items = CAPABILITIES.map((c) => `${c.what} (${c.how})`).join('; ');
  return (
    `ТЫ УМЕЕШЬ (никогда не отрицай эти способности и не говори «я такого не могу» - если просят не дословной командой, подскажи нужную фразу): ${items}. ` +
    'Если человек спрашивает, что ты умеешь - расскажи об этом своими словами, коротко и по-дружески. ' +
    'Про его личные данные в этих разделах (что лежит в календаре, вишлисте, какой план тренировок) отвечай ТОЛЬКО по блокам КАЛЕНДАРЬ / ВИШЛИСТ / ФИТНЕС из контекста ниже - не выдумывай их содержимое. '
  );
}

const WD_SHORT = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WD_FULL = ['', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

// Живое состояние фич пользователя для контекста разговора: календарь, вишлист,
// фитнес-план (с пониманием, тренировочный ли СЕГОДНЯ день).
export function featureState(store, chatId, off, now = new Date()) {
  const lines = [];
  lines.push(...calendarBlock(store, chatId, off, now));
  lines.push(...wishlistBlock(store, chatId));
  lines.push(...fitnessBlock(store, chatId, off, now));
  return lines;
}

function calendarBlock(store, chatId, off, now) {
  const all = (store.calEvents ? store.calEvents(chatId) : []).sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
  if (!all.length) return [];
  const upcoming = all.filter((e) => Date.parse(e.due) >= now.getTime() - 3600000);
  const show = (upcoming.length ? upcoming : all).slice(0, 8);
  return [
    'КАЛЕНДАРЬ (события, добавленные в календарь):',
    ...show.map((e) => `- ${e.title || 'событие'} - ${fmtUser(e.due, off, e.hasTime)}`),
    '',
  ];
}

function wishlistBlock(store, chatId) {
  const items = store.listWish ? store.listWish(chatId) : [];
  if (!items.length) return [];
  return [
    `ВИШЛИСТ (его хотелки, всего ${items.length}):`,
    ...items.slice(0, 10).map((w, i) => {
      const price = w.price != null ? ` - ${w.price} ₽` : '';
      const pic = Array.isArray(w.photos) && w.photos.length ? ' (с фото)' : '';
      return `- ${i + 1}. ${w.title || 'без названия'}${price}${pic}`;
    }),
    '',
  ];
}

function fitnessBlock(store, chatId, off, now) {
  const f = store.getFitness ? store.getFitness(chatId) : null;
  if (!f || (!f.days?.length && !f.plan && !f.weight)) return [];
  const lines = ['ФИТНЕС (личный тренер):'];
  if (f.weight || f.height || f.goal) {
    lines.push(`- профиль: ${f.weight || '?'} кг, ${f.height || '?'} см, цель ${f.goal || 'не задана'}, уровень ${f.level || 'не задан'}`);
  }
  const days = Array.isArray(f.days) ? [...f.days].sort((a, b) => a - b) : [];
  if (days.length) lines.push(`- тренировочные дни: ${days.map((d) => WD_SHORT[d]).join(', ')}`);

  const jsDow = new Date(now.getTime() + off * 60000).getUTCDay();
  const today = jsDow === 0 ? 7 : jsDow; // ISO: 1=Пн..7=Вс
  const planToday = f.plan ? f.plan[today] : null;
  if (days.includes(today)) {
    lines.push(
      planToday
        ? `- СЕГОДНЯ (${WD_FULL[today]}) тренировочный день, вот план на сегодня:\n${planToday}`
        : `- сегодня (${WD_FULL[today]}) тренировочный день, но программа ещё не составлена (ЛК → Фитнес → «Составить план»)`,
    );
  } else if (days.length) {
    const next = days.find((d) => d > today) ?? days[0];
    lines.push(`- сегодня (${WD_FULL[today]}) НЕ тренировочный день; ближайшая тренировка: ${WD_FULL[next]}`);
  }
  lines.push('');
  return lines;
}

/* ---- Личные предпочтения общения (юзер их задаёт словами) ---- */

// Базовый тон общения: обычно дружеский на «ты», но по просьбе человека
// («общайся официально») - строго формальный. Именно ЭТОТ блок переключается,
// иначе формальная просьба конфликтует с «общайся неформально» и проигрывает.
export function toneBlock(user) {
  if (user?.talkStyle === 'official') {
    return (
      'Общайся ВЕЖЛИВО и ОФИЦИАЛЬНО, строго на «вы» - человек сам об этом попросил. ' +
      'Деловой и уважительный тон: без сленга, без панибратства, без подколов, без смайликов и без дурашливости. ' +
      'На шутки и провокации отвечай корректно и сдержанно, не переходя на фамильярность. ' +
      'Реагируй по смыслу: не преувеличивай эмоции, не поздравляй без причины. '
    );
  }
  return (
    'Общайся на «ты», тепло, неформально, с лёгким юмором, как настоящий друг. Реагируй по смыслу: не преувеличивай эмоции, не поздравляй и не восторгайся без причины. Никаких клише вроде «дай пять». ' +
    'Если тебя дразнят, подкалывают, обзывают в шутку или просят дурашливое - не теряйся и НЕ отвечай «я не понимаю»: подыграй с юмором, отшутись, можешь любя подколоть в ответ, как живой друг. Отвечай живой репликой, а не канцеляритом: не пересказывай просьбу словами «я понял, что нужно...» и не притворяйся, что физически идёшь её выполнять («уже в пути») - просто выдай шутку по сути. '
  );
}


// Кусок системного промпта под сохранённые предпочтения.
export function stylePref(user) {
  const parts = [];
  if (user?.talkStyle === 'official') {
    parts.push('Человек просил общаться ОФИЦИАЛЬНО и на «вы»: вежливо и формально, без сленга, панибратства, подколов и смайликов.');
  }
  if (user?.talkStyle === 'mat') {
    parts.push('Человек прямо разрешил крепкие словечки и мат: можешь ругаться и говорить грубовато для экспрессии, но по-доброму к нему, без оскорблений в его адрес.');
  }
  if (user?.addressAs) {
    parts.push(`Обращайся к нему «${user.addressAs}» - он сам попросил так его называть.`);
  }
  if (user?.noName) {
    parts.push('Человек просил НЕ обращаться к нему по имени - не вставляй его имя в ответы.');
  }
  if (Array.isArray(user?.dontDo) && user.dontDo.length) {
    parts.push(`Человек просил кое-чего НЕ делать: ${user.dontDo.join('; ')}. Строго уважай это.`);
  }
  return parts.length ? parts.join(' ') + ' ' : '';
}

// NB: \b с кириллицей в JS не работает - границы слов через lookaround.
const RE_ADDRESS = /(?:называй|зови|обращайся\s+ко?\s*мне\s+как)\s+(?:меня\s+)?(?:по\s+имени\s+)?[«"']?([А-ЯЁA-Za-zа-яё][\wА-Яа-яЁё-]{1,19})[»"']?/i;
const RE_NO_NAME = /(?:не\s+(?:называй|зови)\s+меня\s+по\s+имени|без\s+имени\s+обращайся|не\s+обращайся\s+по\s+имени)/i;
const RE_OFFICIAL = /(?:обща(?:йся|ться)|говори|пиши|отвечай)[а-яё\s]{0,20}(?:официальн|формальн|делов|строг|на\s+вы)|перейд[ие]м?\s+на\s+вы/i;
const RE_CASUAL = /(?:обща(?:йся|ться)|говори|пиши|отвечай)[а-яё\s]{0,20}(?:попроще|проще|неформальн|как\s+друг|по-дружески|на\s+ты)|перейд[ие]м?\s+на\s+ты/i;
const RE_MAT = /(?:можешь|можно|разрешаю)[а-яё\s]{0,15}(?:материться|мат[ое]м?|ругаться)|обща(?:йся|ться)[а-яё\s]{0,10}мат[ое]м|мат(?:ерись|юкайся)/i;
const RE_NO_MAT = /(?:не\s+(?:матерись|ругайся)|без\s+мата|хватит\s+материться)/i;
const RE_DONT = /(?:не\s+надо\s+|перестань\s+|прекрати\s+|хватит\s+|больше\s+не\s+)([а-яё][а-яё\s,]{3,60})/i;

// Разбор просьбы про стиль общения. Возвращает патч профиля или null.
// Только явные формулировки - чтобы обычная болтовня не меняла настройки.
export function parseStylePref(text) {
  const t = String(text || '').replace(/ё/g, 'е');
  const patch = {};

  // «не называй меня по имени» - снимаем и прозвище: человек просит вообще
  // не обращаться персонально, иначе бот продолжит звать «Братан».
  if (RE_NO_NAME.test(t)) { patch.noName = true; patch.addressAs = null; }
  else {
    const m = t.match(RE_ADDRESS);
    if (m) {
      const word = m[1].trim();
      // «называй меня по имени» / «называй меня как хочешь» - не обращение
      if (!/^(меня|по|как|так|имени|хочешь)$/i.test(word)) {
        patch.addressAs = word.charAt(0).toUpperCase() + word.slice(1);
        patch.noName = false;
      }
    }
  }

  if (RE_OFFICIAL.test(t)) patch.talkStyle = 'official';
  else if (RE_MAT.test(t) && !RE_NO_MAT.test(t)) patch.talkStyle = 'mat';
  else if (RE_NO_MAT.test(t) || RE_CASUAL.test(t)) patch.talkStyle = null;

  return Object.keys(patch).length ? patch : null;
}

// Просьба «не делай X» -> накапливаем список запретов (максимум 5, без дублей).
export function parseDontDo(text, current = []) {
  const t = String(text || '');
  const m = t.match(RE_DONT);
  if (!m) return null;
  const what = m[1].trim().replace(/[.!?,]+$/, '');
  if (what.length < 4) return null;
  const list = Array.isArray(current) ? [...current] : [];
  const norm = what.toLowerCase();
  if (list.some((x) => String(x).toLowerCase() === norm)) return null;
  list.push(what);
  return list.slice(-5);
}

// Применить просьбы про стиль/запреты к профилю. Возвращает короткое
// подтверждение для пользователя или null, если ничего не распознали.
export function captureStylePref(store, chatId, text) {
  const user = store.getUser(String(chatId)) || {};
  const patch = parseStylePref(text) || {};
  const dont = parseDontDo(text, user.dontDo);
  if (dont) patch.dontDo = dont;
  if (!Object.keys(patch).length) return null;
  store.setUser(String(chatId), patch);
  if (patch.addressAs) return `Понял, теперь ты ${patch.addressAs} 👌`;
  if (patch.noName) return 'Понял, по имени больше не зову.';
  if (patch.talkStyle === 'official') return 'Хорошо, перехожу на официальный тон.';
  if (patch.talkStyle === 'mat') return null; // пусть ответит уже в новом стиле
  if (patch.talkStyle === null) return null;
  return null;
}
