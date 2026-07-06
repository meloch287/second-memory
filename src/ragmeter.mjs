// Метрика наполненности памяти для RAG: хватает ли данных, чтобы
// отвечать уверенно. Чистые функции, без сети.

import { normText } from './dates.mjs';

const dayOf = (iso) => String(iso).slice(0, 10);

export function memoryStats(store) {
  const entries = store.list();
  const facts = store.data.facts;
  const history = store.data.history;

  const days = new Set([
    ...entries.map((e) => dayOf(e.createdAt || '')),
    ...facts.map((f) => dayOf(f.ts || '')),
  ]);
  days.delete('');

  const weekAgo = Date.now() - 7 * 86400000;
  const recent =
    entries.filter((e) => Date.parse(e.createdAt || 0) > weekAgo).length +
    facts.filter((f) => Date.parse(f.ts || 0) > weekAgo).length;

  const score = Math.min(
    100,
    Math.round(
      Math.min(40, entries.length * 4) +
        Math.min(20, facts.length * 2) +
        Math.min(25, days.size * 2.5) +
        Math.min(15, recent * 1.5)
    )
  );

  let level, label;
  if (score === 0) {
    level = 'empty';
    label = 'Память пуста. Расскажите о делах - я начну запоминать.';
  } else if (score < 30) {
    level = 'low';
    label = 'Данных мало. Чем больше пишете, тем точнее отвечаю.';
  } else if (score < 70) {
    level = 'ok';
    label = 'Кое-что уже помню. Продолжайте - стану точнее.';
  } else {
    level = 'good';
    label = 'Памяти достаточно для уверенных ответов.';
  }

  return {
    score,
    level,
    label,
    counts: {
      entries: entries.length,
      facts: facts.length,
      days: days.size,
      history: history.length,
    },
  };
}

// Насколько память покрывает конкретный вопрос: сколько источников
// (записей, фактов, сообщений) совпало со словами вопроса.
export function questionCoverage(store, question) {
  const base = memoryStats(store);
  if (base.score === 0) {
    return { score: 0, matched: 0, label: 'в памяти пока ничего нет по этому вопросу' };
  }

  const words = normText(question)
    .split(/[^а-яеa-z0-9]+/)
    .filter((w) => w.length > 3);

  const haystacks = [
    ...store.list().map((e) => [e.title, e.counterparty, e.text].filter(Boolean).join(' ')),
    ...store.data.facts.map((f) => f.text + ' ' + (f.people || []).join(' ') + ' ' + (f.tags || []).join(' ')),
    ...store.data.history.filter((h) => h.role === 'user').slice(-60).map((h) => h.text),
  ].map(normText);

  // Лёгкий стемминг: русские падежи меняют окончания («Ромашка» / «про Ромашку»),
  // поэтому длинные слова сравниваем ещё и по основе без двух последних букв.
  const hit = (hay, w) => hay.includes(w) || (w.length > 5 && hay.includes(w.slice(0, -2)));

  let matched = 0;
  for (const hay of haystacks) {
    if (words.some((w) => hit(hay, w))) matched++;
  }

  const score = Math.min(100, Math.round(matched * 22 + base.score * 0.2));
  let label;
  if (score === 0) label = 'в памяти не нашлось ничего по этому вопросу';
  else if (score < 40) label = 'зацепок мало, ответ может быть неполным';
  else if (score < 75) label = 'кое-что нашлось, отвечаю по памяти';
  else label = 'данных достаточно, ответ опирается на память';

  return { score, matched, label };
}
