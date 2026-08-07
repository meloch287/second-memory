// Реестр участников группы в человекочитаемом виде - один и тот же блок
// уходит и в обычный разговор, и в /summary.
//
// Зачем отдельный модуль: раньше список собирался прямо в friendContext и БЕЗ
// псевдонимов, а саммари не получало его вовсе. Из-за этого «мама» и «Аня»
// (один человек) уезжали в модель как двое разных, и итоги по чату выходили
// про несуществующих людей.

// Имя, которое реально можно показать: невидимые символы и пустышки отсеиваем,
// иначе в списке участников оседает «⁠» и человек теряется.
const readable = (m) => {
  const nm = String(m?.name || '').trim();
  if (/[\p{L}\p{N}]/u.test(nm)) return nm;
  return m?.username ? `@${m.username}` : null;
};

// Псевдонимы: «Мама», «Батя», второе имя - всё, чем человека зовут в чате.
const aliasesOf = (m, name) => {
  const list = Array.isArray(m?.aliases) ? m.aliases : [];
  const low = String(name).toLowerCase();
  return [...new Set(list.map((a) => String(a).trim()).filter(Boolean))]
    .filter((a) => a.toLowerCase() !== low)
    .slice(0, 5);
};

// [{ id, name, username, aliases }] - только те, кого есть как показать.
export function membersList(user) {
  if (!user?.isGroup || !user.members) return [];
  return Object.entries(user.members)
    .map(([id, m]) => {
      const name = readable(m);
      if (!name) return null;
      return { id, name, username: m.username || null, aliases: aliasesOf(m, name) };
    })
    .filter(Boolean);
}

// «Аня (@meloch287, она же: Мама), Сергей (@Jjjoopes)» - одной строкой.
export function membersBlock(user) {
  const list = membersList(user);
  if (!list.length) return null;
  return list
    .map((m) => {
      const tag = m.username && m.name !== `@${m.username}` ? `@${m.username}` : '';
      const alias = m.aliases.length ? `он же: ${m.aliases.join(', ')}` : '';
      const inner = [tag, alias].filter(Boolean).join(', ');
      return m.name + (inner ? ` (${inner})` : '');
    })
    .join(', ');
}

// Правило для модели: имя, @ник и прозвище - один человек, а не трое.
export function membersRule(user) {
  const list = membersList(user);
  if (!list.length) return null;
  const withAlias = list.filter((m) => m.aliases.length);
  const same = withAlias
    .map((m) => [m.name, ...m.aliases, ...(m.username ? [`@${m.username}`] : [])].join(' = '))
    .join('; ');
  return (
    'Имя, @ник и прозвище одного участника - ЭТО ОДИН ЧЕЛОВЕК, не считай их разными людьми. ' +
    (same ? `Одно и то же лицо: ${same}. ` : '') +
    'Людей, которых нет в списке участников, в чате нет - не выдумывай их.'
  );
}

// Основа имени без падежного окончания: «маму», «маме», «мамой» -> «мам».
// Сравнивать «по первым N буквам» нельзя: так «Аня» слипалась с «Антоном».
// Одной основы мало: у «Сергей» окончание -ей отрезать нельзя, а у «мамой»
// нужно. Поэтому держим ВСЕ правдоподобные основы и ищем пересечение.
const low = (s) => String(s).trim().toLowerCase().replace(/ё/g, 'е');
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

// Каноническое имя по любому из его обозначений («маму» -> «Аня»).
export function canonicalName(user, word) {
  const w = low(word).replace(/^@/, '');
  if (!w) return null;
  const ws = stemsOf(w);
  for (const m of membersList(user)) {
    const forms = [m.name, ...m.aliases, ...(m.username ? [m.username] : [])];
    for (const f of forms) {
      if (low(f) === w) return m.name;
      for (const s of stemsOf(f)) if (ws.has(s)) return m.name;
    }
  }
  return null;
}
