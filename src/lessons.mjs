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
