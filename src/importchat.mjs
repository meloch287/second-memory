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

// Сообщения одного чата -> плоский список. chatName проставляется при
// импорте всего аккаунта, чтобы различать переписки в общей памяти.
function extractMessages(rawMessages, chatName = null) {
  const out = [];
  for (const m of rawMessages || []) {
    if (m.type !== 'message') continue; // service-события пропускаем
    const text = flattenText(m.text).trim();
    if (!text) continue; // медиа без подписи не несут текста
    const author = String(m.from || 'Кто-то').trim() || 'Кто-то';
    const idm = String(m.from_id || '').match(/^user(\d+)$/); // from_id вида "user123456"
    out.push({
      author,
      authorId: idm ? idm[1] : null,
      chat: chatName,
      text: text.slice(0, MAX_TEXT),
      ts: m.date ? new Date(m.date).toISOString() : new Date().toISOString(),
    });
  }
  return out;
}

// Распознать telegram-экспорт. Поддерживаются два формата:
//  - экспорт одного чата: { name, messages: [...] };
//  - экспорт всего аккаунта: { chats: { list: [ {name, messages}, ... ] } }.
// null - это не экспорт.
export function parseTgExport(buf) {
  let data;
  try {
    data = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (!data) return null;

  // Полный экспорт аккаунта: все чаты в одном файле
  if (Array.isArray(data.chats?.list)) {
    let all = [];
    let chatCount = 0;
    for (const c of data.chats.list) {
      if (!Array.isArray(c.messages)) continue;
      const name = String(c.name || c.type || 'без названия').trim() || 'без названия';
      const msgs = extractMessages(c.messages, name);
      if (msgs.length) {
        chatCount++;
        all = all.concat(msgs);
      }
    }
    if (!all.length) return null;
    all.sort((a, b) => a.ts.localeCompare(b.ts)); // по времени, свежие в конце
    return { name: 'Все чаты', messages: all.slice(-MAX_MESSAGES), total: all.length, chatCount, full: true };
  }

  // Экспорт одного чата
  if (!Array.isArray(data.messages)) return null;
  const out = extractMessages(data.messages);
  if (!out.length) return null;
  return { name: data.name || null, messages: out.slice(-MAX_MESSAGES), total: out.length, chatCount: 1, full: false };
}

// Залить сообщения в память чата одной пачкой + пополнить реестр участников.
// Возвращает сводку для ответа пользователю.
export function importIntoStore(store, chatId, parsed) {
  const { messages } = parsed;
  store.addRawBulk(
    chatId,
    // при полном экспорте помечаем, из какого чата сообщение
    messages.map((m) => ({ text: `${m.chat ? `[${m.chat}] ` : ''}${m.author}: ${m.text}`, ts: m.ts }))
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
