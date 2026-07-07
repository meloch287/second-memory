// Импорт экспорта истории чата из Telegram Desktop (result.json):
// «Экспорт истории чата» -> JSON -> кидаешь файл боту -> вся история
// ложится в память чата, воркер переварит её в факты.

const MAX_MESSAGES = 1500; // последние N: кап сырой памяти 2000, оставляем запас живой переписке
const MAX_TEXT = 800;

// text в экспорте бывает строкой или массивом кусков (форматирование).
function flattenText(t) {
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) {
    return t.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  return '';
}

// Распознать telegram-экспорт и вытащить сообщения. null - это не экспорт.
export function parseTgExport(buf) {
  let data;
  try {
    data = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.messages)) return null;
  const out = [];
  for (const m of data.messages) {
    if (m.type !== 'message') continue; // service-события пропускаем
    const text = flattenText(m.text).trim();
    if (!text) continue; // медиа без подписи не несут текста
    const author = String(m.from || 'Кто-то').trim() || 'Кто-то';
    // from_id вида "user123456" - настоящий Telegram id автора
    const idm = String(m.from_id || '').match(/^user(\d+)$/);
    out.push({
      author,
      authorId: idm ? idm[1] : null,
      text: text.slice(0, MAX_TEXT),
      ts: m.date ? new Date(m.date).toISOString() : new Date().toISOString(),
    });
  }
  if (!out.length) return null;
  return { name: data.name || null, messages: out.slice(-MAX_MESSAGES), total: out.length };
}

// Залить сообщения в память чата одной пачкой + пополнить реестр участников.
// Возвращает сводку для ответа пользователю.
export function importIntoStore(store, chatId, parsed) {
  const { messages } = parsed;
  store.addRawBulk(
    chatId,
    messages.map((m) => ({ text: `${m.author}: ${m.text}`, ts: m.ts }))
  );

  // участники из экспорта - в реестр группы (не перетирая известных)
  const g = store.getUser(chatId);
  if (g?.isGroup) {
    const members = { ...(g.members || {}) };
    let changed = false;
    for (const m of messages) {
      if (!m.authorId || members[m.authorId]) continue;
      members[m.authorId] = { name: m.author, username: null };
      changed = true;
    }
    if (changed) store.setUser(chatId, { members });
  }

  const first = messages[0]?.ts?.slice(0, 10) || '';
  const last = messages[messages.length - 1]?.ts?.slice(0, 10) || '';
  return { count: messages.length, total: parsed.total, first, last };
}
