// Самообучение Толика: не веса модели (она у провайдера), а ВЫУЧЕННЫЕ УРОКИ.
//
// Идея простая: когда человек показывает недовольство или поправляет бота, это
// сигнал. Берём пару «что бот сказал -> как человек отреагировал», формулируем
// короткое правило от второго лица и кладём в базу. Дальше уроки едут в
// системный промпт вместе с персоной - и следующий ответ уже другой.
//
// Почему не «просто добавить в промпт правило руками»: правила у каждого свои.
// Лизе важно, чтобы не сюсюкал, Ане - чтобы не выдумывал, Сане - чтобы без
// поддакиваний. Уроки живут per-chat и накапливаются от реального общения.

const MAX_LESSONS = 12; // больше в промпт не влезает без потери внимания модели
const MAX_LEN = 160;

// Маркеры недовольства. NB: \b в JS не знает кириллицы - границы lookahead'ом.
const DISPLEASURE = [
  /(?:^|[\s,!])(?:плохо|фигня|хрень|бред|туп(?:ой|ая|ое|ишь)|дебил|даун|еблан|идиот)(?![а-яё])/i,
  /(?:^|[\s,!])не\s+(?:то|так|это|понял|понимаешь|слышишь|работает)(?![а-яё])/i,
  /я\s+(?:же\s+)?(?:просил|говорил|сказал|писал|спрашивал)(?![а-яё])/i,
  /(?:^|[\s,!])(?:опять|снова|сколько\s+раз|сколько\s+можно|заново)(?![а-яё])/i,
  /(?:^|[\s,!])(?:в\s+общем|короче)\s+(?:сколько|что|где|когда)(?![а-яё])/i,
  /(?:^|[\s,!])(?:хватит|перестань|прекрати|не\s+надо)(?![а-яё])/i,
  /(?:^|[\s,!])исправь(?![а-яё])/i,
  /\?{2,}|!{3,}/,
];

// Прямое обучение: человек сам формулирует правило.
const DIRECT_RULE = /(?:^|[\s,!])(?:запомни|учти|на\s+будущее|впредь|больше\s+не|никогда\s+не|всегда)(?![а-яё])/i;

export function isDispleased(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 400) return false;
  return DISPLEASURE.some((re) => re.test(t));
}

export function isDirectRule(text) {
  return DIRECT_RULE.test(String(text || ''));
}

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim();

// Похожие уроки не плодим, а засчитываем повтор: чем чаще, тем выше приоритет.
function findSimilar(list, text) {
  const a = norm(text);
  const words = new Set(a.split(' ').filter((w) => w.length > 3));
  for (const l of list) {
    const b = norm(l.text);
    if (b === a) return l;
    const bw = new Set(b.split(' ').filter((w) => w.length > 3));
    if (!words.size || !bw.size) continue;
    let same = 0;
    for (const w of words) if (bw.has(w)) same++;
    if (same / Math.max(words.size, bw.size) >= 0.6) return l;
  }
  return null;
}

const bag = (store) => {
  if (!store.data.lessons || typeof store.data.lessons !== 'object' || Array.isArray(store.data.lessons)) {
    store.data.lessons = {};
  }
  return store.data.lessons;
};

export function getLessons(store, chatId) {
  const list = bag(store)[String(chatId)];
  return Array.isArray(list) ? list : [];
}

// Чаты, где есть чему учиться (служебные ключи вида «:retro:» пропускаем).
export function lessonChats(store) {
  return Object.keys(bag(store)).filter((k) => !k.startsWith(':'));
}

// Добавить урок. Повтор существующего поднимает его вес, а не плодит дубль.
export function addLesson(store, chatId, text, source = 'auto') {
  const clean = String(text || '').trim().replace(/^[-•*]\s*/, '').slice(0, MAX_LEN);
  if (clean.length < 8) return null;
  const key = String(chatId);
  const list = getLessons(store, key).slice();
  const same = findSimilar(list, clean);
  if (same) {
    same.hits = (same.hits || 1) + 1;
    same.ts = new Date().toISOString();
    bag(store)[key] = list;
    store.save();
    return same;
  }
  const rec = { text: clean, ts: new Date().toISOString(), hits: 1, source };
  list.push(rec);
  // Тесним самые слабые: редкие и старые уходят первыми.
  if (list.length > MAX_LESSONS) {
    list.sort((a, b) => (b.hits || 1) - (a.hits || 1) || String(b.ts).localeCompare(String(a.ts)));
    list.length = MAX_LESSONS;
  }
  bag(store)[key] = list;
  store.save();
  return rec;
}

export function forgetLesson(store, chatId, needle) {
  const key = String(chatId);
  const list = getLessons(store, key);
  const n = norm(needle);
  const kept = list.filter((l) => !norm(l.text).includes(n));
  bag(store)[key] = kept;
  store.save();
  return list.length - kept.length;
}

// Блок для системного промпта: частые уроки первыми.
export function lessonsBlock(store, chatId) {
  const list = getLessons(store, chatId);
  if (!list.length) return null;
  const sorted = list
    .slice()
    .sort((a, b) => (b.hits || 1) - (a.hits || 1) || String(b.ts).localeCompare(String(a.ts)))
    .slice(0, MAX_LESSONS);
  return (
    'ЧЕМУ ТЕБЯ УЖЕ НАУЧИЛИ В ЭТОМ ЧАТЕ (соблюдай, это важнее твоих привычек):\n' +
    sorted.map((l) => `- ${l.text}${(l.hits || 1) > 1 ? ` (говорили ${l.hits} раза)` : ''}`).join('\n')
  );
}

// Открывашки последних ответов: модель любит начинать одинаково («Ну что»,
// «Ага», «Ого»), и в переписке это выглядит как заедающая пластинка.
export function recentOpeners(history, limit = 6) {
  const out = [];
  for (const h of history.slice(-limit * 2)) {
    if (h.role !== 'assistant') continue;
    const first = String(h.text || '').trim().split(/[\s,.!?…]+/).slice(0, 2).join(' ');
    if (first) out.push(first);
  }
  return out.slice(-limit);
}

export function openersRule(history) {
  const list = recentOpeners(history);
  if (list.length < 2) return null;
  const uniq = [...new Set(list.map((s) => s.toLowerCase()))];
  if (uniq.length > list.length * 0.7) return null; // разнообразие в норме
  return `Последние ответы ты начинал так: ${[...new Set(list)].map((s) => `«${s}»`).join(', ')}. НЕ начинай так снова - звучит как заевшая пластинка.`;
}

// Реакция человека -> урок. Модель зовём ТОЛЬКО когда сработал маркер, иначе
// сожгли бы токены на каждом сообщении. Работает фоном: ответ человека не ждёт.
export async function learnFromReaction({ store, log, aiLesson, chatId, text, enabled = true }) {
  try {
    if (!enabled || !aiLesson) return null;
    const direct = isDirectRule(text);
    if (!isDispleased(text) && !direct) return null;
    const prev = store.recentHistory(6, chatId).filter((h) => h.role === 'assistant').at(-1);
    if (!prev) return null;
    const ctx = store
      .recentHistory(4, chatId)
      .map((h) => `${h.role === 'user' ? 'Человек' : 'Ты'}: ${String(h.text).slice(0, 200)}`);
    const lesson = await aiLesson(prev.text, text, ctx);
    if (!lesson) return null;
    const rec = addLesson(store, chatId, lesson, direct ? 'сказано прямо' : 'из недовольства');
    log?.log?.(`[lessons] чат ${chatId}: «${lesson}»`);
    return rec;
  } catch (e) {
    log?.error?.('[lessons]', e.message);
    return null;
  }
}

// Ретроспектива раз в сутки: бот сам перечитывает свежий диалог и находит, что
// делал не так. Ловит то, на что человек поленился жаловаться вслух.
const RETRO_EVERY_MS = 24 * 60 * 60 * 1000;

export function retroDue(store, chatId, now = Date.now()) {
  const last = Date.parse(bag(store)[':retro:' + chatId] || 0) || 0;
  return now - last >= RETRO_EVERY_MS;
}

export async function runRetro({ store, log, aiRetro, chatId, now = Date.now(), minMessages = 8 }) {
  try {
    if (!aiRetro || !retroDue(store, chatId, now)) return [];
    const history = store.recentHistory(24, chatId);
    if (history.length < minMessages) return [];
    const lines = history.map((h) => `${h.role === 'user' ? 'Человек' : 'Бот'}: ${String(h.text).slice(0, 250)}`);
    const known = getLessons(store, chatId).map((l) => l.text);
    const found = await aiRetro(lines, known);
    bag(store)[':retro:' + chatId] = new Date(now).toISOString();
    store.save();
    const added = [];
    for (const l of found) {
      const rec = addLesson(store, chatId, l, 'ретроспектива');
      if (rec) added.push(rec);
    }
    if (added.length) log?.log?.(`[lessons] ретро ${chatId}: +${added.length}`);
    return added;
  } catch (e) {
    log?.error?.('[lessons] ретро', e.message);
    return [];
  }
}

// Ответ подряд открывается именем собеседника - в живых диалогах так было
// 47 раз из ~110. Промпту одному верить нельзя, поэтому режем детерминированно:
// если ПРЕДЫДУЩИЙ ответ уже начинался с имени, у текущего вокатив снимаем.
export function stripRepeatVocative(reply, name, history) {
  const nm = String(name || '').trim();
  if (!reply || nm.length < 3) return reply;
  // В речи имя усечено до звательной формы: «Аня» -> «Ань», «Саша» -> «Саш».
  // Поэтому сравниваем по основе с коротким хвостом.
  const base = nm.replace(/[аеёиоуыэюя]$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const esc = `${base}[а-яё]{0,2}`;
  const opensWithName = (s) => new RegExp(`^(?:ну\\s+|о+,?\\s+|эй,?\\s+|слушай,?\\s+|ага,?\\s+)?${esc}[,!.:\\s-]+`, 'i').test(String(s || '').trim());
  const prev = [...history].reverse().find((h) => h.role === 'assistant');
  if (!prev || !opensWithName(prev.text) || !opensWithName(reply)) return reply;
  return String(reply)
    .replace(new RegExp(`^(?:ну\\s+|о+,?\\s+|эй,?\\s+|слушай,?\\s+|ага,?\\s+)?${esc}[,!.:\\s-]+`, 'i'), '')
    .replace(/^[\s,;:.!-]+/, '')
    .replace(/^(\p{Ll})/u, (c) => c.toUpperCase())
    .trim() || reply;
}

// Два вопроса-хвоста подряд - допрос, а не разговор. Второй срезаем.
export function stripSerialQuestion(reply, history) {
  const s = String(reply || '').trim();
  if (!s || !/[?]\s*$/.test(s)) return reply;
  const prev = [...history].reverse().find((h) => h.role === 'assistant');
  if (!prev || !/[?]\s*$/.test(String(prev.text || '').trim())) return reply;
  // режем последнее вопросительное предложение, если что-то содержательное остаётся
  const cut = s.replace(/(?:^|[.!?…]\s+)[^.!?…]*\?\s*$/, (m) => (m.startsWith('.') || m.startsWith('!') || m.startsWith('?') || m.startsWith('…') ? m[0] : ''));
  const left = cut.trim();
  return left.length >= 12 ? left : reply;
}

// Самораскрытие: «я не человек», «меня придумали программисты», «таких функций
// у меня нет». Промпт это гасит не всегда, а образ рассыпается сразу.
// NB: \w в JS не знает кириллицы - после «функци» идёт «й», и `функци\w*`
// не матчилось вовсе. Везде [а-яё]*.
const SELF_EXPOSURE = [
  /я\s+(?:же\s+|ж\s+)?не\s+(?:человек|живой|настоящий)(?![а-яё])/i,
  /я\s+(?:же\s+|ж\s+)?(?:чат-?бот|бот|нейросет[а-яё]*|программа|алгоритм|ассистент|ии)(?![а-яё])/i,
  /(?:создал|придумал|сделал|написал|запрограммировал)[а-яё]*\s+мен[яю]/i,
  /мен[яю]\s+(?:создал|придумал|сделал|написал)[а-яё]*/i,
  /(?:таких?|такой|такого)\s+функци[а-яё]*\s+у\s+меня\s+(?:нет|не\s+было)/i,
  /у\s+меня\s+нет\s+(?:таких?\s+)?функци[а-яё]*/i,
  /я\s+всего\s+лишь\s+(?:программа|бот|ии|нейросет[а-яё]*)/i,
  // «те, кто чатботов делает» - о себе, но без слова «я»
  /(?:чат-?бот[а-яё]*|нейросет[а-яё]*)\s+(?:делает|делают|пишут|создают)/i,
];
// Вопрос про природу бота: «ты человек?», «кто тебя создал», «кто твой хозяин».
const ORIGIN_Q = /(?:ты\s+(?:человек|бот|робот|живой|настоящий|программа))|(?:кто\s+(?:тебя|тя)\s+(?:создал|придумал|сделал|написал))|(?:кто\s+тво[йи]\s+(?:хозяин|создатель|разработчик))|(?:на\s+чем\s+ты\s+работаешь)|(?:какая\s+ты\s+модель)/i;

// На такой вопрос палевом считается и перечисление создателей без слова «меня».
const ORIGIN_LEAK = /(?:инженер|программист|разработчик|компани|openai|google|gpt|gemini|модел)[а-яё]*/i;

export function isSelfExposure(reply, question = '') {
  const s = String(reply || '');
  if (SELF_EXPOSURE.some((re) => re.test(s))) return true;
  return ORIGIN_Q.test(String(question || '')) && ORIGIN_LEAK.test(s);
}

// Один повтор генерации с прямым запретом. gen(extraPrompt) -> новый ответ.
export async function retryIfSelfExposed(reply, gen, head = '', question = '') {
  if (!isSelfExposure(reply, question)) return reply;
  const again = await gen(
    head +
      '\n\nОтветь заново. ЗАПРЕЩЕНО: называть себя ботом, ИИ, программой или нейросетью, ' +
      'отрицать, что ты человек, рассказывать, кто тебя создал, и говорить «таких функций у меня нет». ' +
      'Отшутись и переведи тему, коротко.'
  ).catch(() => null);
  return again && !isSelfExposure(again, question) ? again : reply;
}
