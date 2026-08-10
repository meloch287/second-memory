// Реестр участников группы в человекочитаемом виде - один и тот же блок
// уходит и в обычный разговор, и в /summary.
//
// Зачем отдельный модуль: раньше список собирался прямо в friendContext и БЕЗ
// псевдонимов, а саммари не получало его вовсе. Из-за этого «мама» и «Аня»
// (один человек) уезжали в модель как двое разных, и итоги по чату выходили
// про несуществующих людей.
//
// Главное правило: КАК НАУЧИЛИ - ТАК И ЗОВЁМ. Сказали «мама - @meloch287» -
// значит она везде «Мама», даже если в Telegram её зовут Аня и её сообщения
// подписаны «Аня:». Паспортное имя остаётся рядом - оно нужно, чтобы связывать
// подписи сообщений с человеком, но обращение всегда выученное.

import { canonStem, NAME_GROUPS } from './nicknames.mjs';

// Имя, которое реально можно показать: невидимые символы и пустышки отсеиваем,
// иначе в списке участников оседает «⁠» и человек теряется.
const readable = (m) => {
  const nm = String(m?.name || '').trim();
  if (/[\p{L}\p{N}]/u.test(nm)) return nm;
  return m?.username ? `@${m.username}` : null;
};

const low = (s) => String(s).trim().toLowerCase().replace(/ё/g, 'е');

// Ходовые формы имени: «Саня» -> Саша, Александр. Нужно, чтобы на «знаешь Сашу?»
// бот узнал Саню из общей группы.
function nameForms(name) {
  const canon = canonStem(name);
  const out = new Set([name]);
  for (const group of NAME_GROUPS) {
    if (!group.some((v) => canonStem(v) === canon)) continue;
    for (const v of group.slice(0, 3)) out.add(v[0].toUpperCase() + v.slice(1));
  }
  return [...out].slice(0, 4);
}

// Псевдонимы: всё прочее, чем человека зовут в чате. Само обращение и @ник
// сюда не попадают - иначе в списке дубли.
const aliasesOf = (m, call, real) => {
  const list = Array.isArray(m?.aliases) ? m.aliases : [];
  const skip = new Set([low(call), low(real), low(m?.username || '')]);
  return [...new Set(list.map((a) => String(a).trim()).filter(Boolean))]
    .filter((a) => !skip.has(low(a)))
    .slice(0, 5);
};

// [{ id, call, real, username, aliases }]
//   call - как звать (выученное обращение, иначе имя),
//   real - паспортное имя, если оно отличается от обращения.
export function membersList(user) {
  if (!user?.isGroup || !user.members) return [];
  return Object.entries(user.members)
    .map(([id, m]) => {
      const name = readable(m);
      const call = String(m?.callName || '').trim() || name;
      if (!call) return null;
      const real = name && low(name) !== low(call) ? name : null;
      return { id, call, real, name: call, username: m.username || null, aliases: aliasesOf(m, call, real || '') };
    })
    .filter(Boolean);
}

// «Мама (@meloch287, по паспорту Аня), Сергей (@Jjjoopes)» - одной строкой.
export function membersBlock(user) {
  const list = membersList(user);
  if (!list.length) return null;
  return list
    .map((m) => {
      const tag = m.username && m.call !== `@${m.username}` ? `@${m.username}` : '';
      const real = m.real ? `по паспорту ${m.real}` : '';
      const alias = m.aliases.length ? `он же: ${m.aliases.join(', ')}` : '';
      const inner = [tag, real, alias].filter(Boolean).join(', ');
      return m.call + (inner ? ` (${inner})` : '');
    })
    .join(', ');
}

// Правило для модели: как звать людей и что имя, @ник и прозвище - один человек.
export function membersRule(user) {
  const list = membersList(user);
  if (!list.length) return null;
  const renamed = list.filter((m) => m.real);
  const same = list
    .filter((m) => m.real || m.aliases.length)
    .map((m) => [m.call, m.real, ...m.aliases, ...(m.username ? [`@${m.username}`] : [])].filter(Boolean).join(' = '))
    .join('; ');
  return (
    'Имя, @ник и прозвище одного участника - ЭТО ОДИН ЧЕЛОВЕК, не считай их разными людьми. ' +
    (same ? `Одно и то же лицо: ${same}. ` : '') +
    (renamed.length
      ? `ЗОВИ ЛЮДЕЙ ТАК, КАК УКАЗАНО ПЕРВЫМ В СПИСКЕ - так тебя попросили: ${renamed
          .map((m) => `${m.real} -> ${m.call}`)
          .join(', ')}. Даже если её сообщения подписаны паспортным именем, в своих ответах и итогах пиши выученное обращение. `
      : '') +
    'Людей, которых нет в списке участников, в чате нет - не выдумывай их.'
  );
}

// Основа имени без падежного окончания: «маму», «маме», «мамой» -> «мам».
// Сравнивать «по первым N буквам» нельзя: так «Аня» слипалась с «Антоном».
// Одной основы мало: у «Сергей» окончание -ей отрезать нельзя, а у «мамой»
// нужно. Поэтому держим ВСЕ правдоподобные основы и ищем пересечение.
export function stemsOf(word) {
  const w = low(word).replace(/^@/, '');
  const out = new Set(w ? [w] : []);
  const add = (s) => { if (s.length >= 2) out.add(s); };
  add(w.replace(/(?:ами|ями|ах|ях|ой|ей|ом|ем|ов|ев)$/, ''));
  const noVowel = w.replace(/[аеиоуыэюяй]$/, '');
  add(noVowel);
  add(noVowel.replace(/[аеиоуыэюяй]$/, ''));
  return out;
}

// Как звать человека, о котором сказали любым его обозначением.
// «Аню», «@meloch287», «маму» -> «Мама».
//
// Два прохода: сначала ТОЧНОЕ совпадение по всем участникам, и только потом
// сравнение основ. Иначе «Лёня» отдавал «Лену» - у них общая основа «лен», а
// первый в реестре выигрывал. И если по основам подходят двое разных людей,
// честнее вернуть null: склеить двоих хуже, чем не узнать одного.
export function canonicalName(user, word) {
  const w = low(word).replace(/^@/, '');
  if (!w) return null;
  const list = membersList(user);
  const formsOf = (m) => [m.call, m.real, ...m.aliases, ...(m.username ? [m.username] : [])].filter(Boolean);

  for (const m of list) if (formsOf(m).some((f) => low(f) === w)) return m.call;

  const ws = stemsOf(w);
  const hits = list.filter((m) => formsOf(m).some((f) => [...stemsOf(f)].some((s) => ws.has(s))));
  return hits.length === 1 ? hits[0].call : null;
}

// Подписи в записях («Аня: текст») переписываем на выученное обращение -
// иначе модель читает паспортное имя и зовёт человека им, вопреки просьбе.
export function renameAuthors(line, user) {
  const list = membersList(user).filter((m) => m.real);
  if (!list.length) return line;
  let out = String(line);
  for (const m of list) {
    const esc = m.real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|\\n)${esc}(?=:)`, 'gi'), `$1${m.call}`);
  }
  return out;
}

// Кого этот человек знает через общие с ботом группы. Приватные данные чужих
// чатов сюда НЕ попадают - только факт «вы в одной группе» и как звать.
// Живой промах: Аня спросила «ты знаешь Сашу?», а Саша сидит с ней в «Банде».
export function sharedPeople(store, chatId) {
  const me = String(chatId);
  const out = new Map();
  for (const [gid, g] of Object.entries(store.data.users || {})) {
    if (!g?.isGroup || !g.members) continue;
    if (!Object.keys(g.members).includes(me)) continue; // человек не в этой группе
    for (const m of membersList(g)) {
      if (String(m.id) === me) continue;
      const prev = out.get(m.call);
      out.set(m.call, { name: m.call, username: m.username, groups: [...(prev?.groups || []), g.name || gid].slice(0, 3) });
    }
  }
  return [...out.values()];
}

export function sharedPeopleLine(store, chatId) {
  const list = sharedPeople(store, chatId);
  if (!list.length) return null;
  return (
    'ОБЩИЕ ЗНАКОМЫЕ (вы вместе в этих чатах, так что этих людей ты знаешь): ' +
    list
      .map((p) => {
        const forms = nameForms(p.name).filter((f) => f.toLowerCase() !== p.name.toLowerCase());
        return `${p.name}${forms.length ? ` (он же ${forms.join(', ')})` : ''}${p.username ? ` @${p.username}` : ''} - ${p.groups.join(', ')}`;
      })
      .join('; ') +
    '. Спросят про такого человека ЛЮБЫМ из этих имён - ты его знаешь по общему чату, так и скажи. Что он писал в ДРУГИХ чатах - не рассказывай.'
  );
}
