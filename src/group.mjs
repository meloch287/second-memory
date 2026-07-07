// Групповой режим: бот живёт в группе как участник - общая память группы
// (chatId группы = отдельное пространство, изоляция как у юзеров), ответы по
// @тегу или reply, команды управления группой от админов, теги участников.
// Фабрика: все внешние зависимости приходят из telegram.mjs.

import { parseGroupCmd, findMember } from './parser.mjs';
import { parseTgExport, importIntoStore } from './importchat.mjs';
import { captureEntry, handleMessage } from './brain.mjs';
import { userOffset, DEFAULT_OFFSET } from './tz.mjs';
import { aiEnabled, audioEnabled, aiFriendReply, aiRelay, aiTranscribe } from './ai.mjs';

// Родственные/ролевые слова - валидные «имена» в строчном виде («это мама»,
// «это батя»). Основа = слово без хвостовых гласных/ь/й, как в findMember,
// чтобы совпадало и в падежах.
const REL_STEM = (s) => String(s).toLowerCase().replace(/ё/g, 'е').replace(/[ауыоеиюяьй]+$/, '');
const RELATIONSHIP = new Set(
  ['мама', 'мать', 'мамка', 'папа', 'отец', 'папка', 'батя', 'сестра', 'сестрёнка', 'брат', 'братишка',
   'жена', 'муж', 'супруг', 'супруга', 'бабушка', 'баба', 'дедушка', 'дед', 'деда', 'тётя', 'тетя', 'дядя',
   'сын', 'сынок', 'дочь', 'дочка', 'тёща', 'теща', 'свекровь', 'свёкор', 'зять', 'невестка', 'сноха',
   'внук', 'внучка', 'кум', 'кума', 'крёстный', 'крёстная', 'тесть', 'шурин', 'девушка', 'парень', 'друг', 'подруга'].map(REL_STEM)
);
const isRelName = (w) => RELATIONSHIP.has(REL_STEM(w));

// Частые русские имена (+ уменьшительные) - чтобы отличить «@ник это сергей»
// (имя) от «@ник это видео» (не имя) в строчном виде.
const COMMON_NAMES = new Set(
  ['сергей', 'серега', 'сережа', 'андрей', 'андрюха', 'андрюша', 'дмитрий', 'дима', 'димон', 'александр', 'саша', 'саня', 'шура',
   'алексей', 'леха', 'леша', 'михаил', 'миша', 'иван', 'ваня', 'николай', 'коля', 'владимир', 'вова', 'володя', 'анна', 'аня', 'нюра',
   'елена', 'лена', 'ольга', 'оля', 'наталья', 'наташа', 'ирина', 'ира', 'татьяна', 'таня', 'мария', 'маша', 'маруся', 'екатерина', 'катя',
   'юлия', 'юля', 'дарья', 'даша', 'анастасия', 'настя', 'ксения', 'ксюша', 'виктор', 'витя', 'павел', 'паша', 'роман', 'рома', 'денис',
   'максим', 'макс', 'никита', 'артем', 'тема', 'кирилл', 'егор', 'игорь', 'олег', 'антон', 'глеб', 'петр', 'петя', 'борис', 'боря',
   'георгий', 'гоша', 'жора', 'константин', 'костя', 'валерий', 'валера', 'вадим', 'руслан', 'тимур', 'марат', 'вера', 'надежда', 'надя',
   'галина', 'галя', 'светлана', 'света', 'оксана', 'алина', 'полина', 'поля', 'вероника', 'ника', 'кристина', 'валентина', 'валя', 'зоя',
   'инна', 'лидия', 'лида', 'тамара', 'жанна', 'степан', 'стас', 'станислав', 'федор', 'федя', 'семен', 'сема', 'тимофей', 'тима', 'лев',
   'марк', 'даниил', 'даня', 'арсений', 'сеня', 'матвей', 'влад', 'владислав', 'элина', 'диана', 'карина', 'милана', 'ева', 'варвара', 'варя'].map((s) => s.replace(/ё/g, 'е'))
);

// Извлечь все пары «@ник -> Имя» из текста (в т.ч. несколько строк):
// «@meloch287 это мама», «@jjoopes это сергей», «Никита = @pxpusk», «@ник - Имя».
// Требуем явную связку (это/-/=/зовут) рядом с @ником и что «Имя» похоже на имя,
// иначе «@ник это видео/круто» ложно бы переименовывало человека.
const _NAME = '[А-Яа-яЁёA-Za-z][А-Яа-яЁёA-Za-z0-9_]{1,19}';
const _UN = '@([A-Za-z][A-Za-z0-9_]{3,31})';
const _CONN = '(?:[-—–=:]|это|эт[оа]\\s+это|зовут)';
const _RE_UN_NAME = new RegExp(`${_UN}\\s*${_CONN}\\s+(${_NAME})`, 'i'); // @ник это Имя
const _RE_NAME_UN = new RegExp(`(?:^|\\s)(${_NAME})\\s*${_CONN}\\s*${_UN}`, 'i'); // Имя это @ник
const _STOP = new Set(['это', 'он', 'она', 'оно', 'они', 'зовут', 'запомни', 'видео', 'фото', 'кружок', 'голосовое', 'круто', 'правда', 'верно', 'точно', 'вот', 'тут', 'там', 'сам', 'сама']);
export function extractIdentityPairs(text) {
  const explicit = /запомни|зовут/i.test(text);
  const okName = (n) => {
    const low = n.toLowerCase().replace(/ё/g, 'е');
    if (_STOP.has(low)) return false;
    return /^[А-ЯЁA-Z]/.test(n) || isRelName(n) || COMMON_NAMES.has(low) || explicit;
  };
  const pairs = [];
  const seen = new Set();
  for (const seg of String(text).split(/[\n;]+/).map((s) => s.replace(/\bзапомни(?:те)?[:,]?/gi, ' ').trim()).filter(Boolean)) {
    let un, name, m;
    if ((m = seg.match(_RE_UN_NAME))) { un = m[1]; name = m[2]; }
    else if ((m = seg.match(_RE_NAME_UN))) { name = m[1]; un = m[2]; }
    if (un && name && okName(name) && !seen.has(un.toLowerCase())) {
      seen.add(un.toLowerCase());
      pairs.push({ un, name: name[0].toUpperCase() + name.slice(1) });
    }
  }
  return pairs;
}

export function createGroupHandler(deps) {
  const { api, send, esc, store, log, withTyping, handleIntent, sendSummary, askReset, readDoc, downloadBase64, sleepyText, maybeReact, deliver } = deps;

  let botUsername = null;
  let botId = null;
  async function ensureSelf() {
    if (botUsername) return;
    try {
      const me = await api('getMe', {});
      botUsername = me.result?.username || null;
      botId = me.result?.id || null;
    } catch { /* подхватим на следующем сообщении */ }
  }

  const isGroupChat = (msg) => ['group', 'supergroup'].includes(msg.chat?.type);
  const authorName = (msg) => msg.from?.first_name || msg.from?.username || 'Кто-то';

  function mentionsBot(text) {
    return !!(botUsername && text && new RegExp(`@${botUsername}(?![\\w])`, 'i').test(text));
  }
  const stripMention = (text) => text.replace(new RegExp(`@${botUsername}`, 'ig'), '').replace(/\s{2,}/g, ' ').trim();

  async function callerIsAdmin(chatId, userId) {
    try {
      const r = await api('getChatMember', { chat_id: chatId, user_id: userId });
      return ['creator', 'administrator'].includes(r.result?.status);
    } catch {
      return false;
    }
  }

  const mentionOf = (m, id) => (m.username ? `@${m.username}` : `<a href="tg://user?id=${id}">${esc(m.name || 'Эй')}</a>`);

  async function runGroupCmd(chatId, msg, cmd) {
    const reply = msg.reply_to_message;
    if (cmd.needsReply && !reply) {
      return send(chatId, 'Ответь этой командой на нужное сообщение (reply), иначе не пойму, о ком/о чём речь.');
    }
    if (!(await callerIsAdmin(chatId, msg.from.id))) {
      return send(chatId, `${esc(authorName(msg))}, это только для админов группы 🙂`);
    }
    const target = reply?.from;
    const fail = async (r, what) => {
      log.error('[telegram] group cmd', cmd.cmd, r.description || '');
      return send(chatId, `Не смог ${what}: ${esc(r.description || 'нет прав?')}. Проверь, что я админ с нужными правами.`);
    };
    let r;
    switch (cmd.cmd) {
      case 'pin':
        r = await api('pinChatMessage', { chat_id: chatId, message_id: reply.message_id });
        return r.ok ? send(chatId, 'Закрепил 📌') : fail(r, 'закрепить');
      case 'unpin':
        r = await api('unpinChatMessage', { chat_id: chatId });
        return r.ok ? send(chatId, 'Открепил.') : fail(r, 'открепить');
      case 'title':
        r = await api('setChatTitle', { chat_id: chatId, title: cmd.arg });
        return r.ok ? undefined : fail(r, 'переименовать'); // Telegram сам покажет смену названия
      case 'desc':
        r = await api('setChatDescription', { chat_id: chatId, description: cmd.arg });
        return r.ok ? send(chatId, 'Описание обновил.') : fail(r, 'сменить описание');
      case 'invite':
        r = await api('createChatInviteLink', { chat_id: chatId });
        return r.ok ? send(chatId, `Держи ссылку: ${esc(r.result.invite_link)}`) : fail(r, 'создать ссылку');
      case 'kick': {
        if (!target) return;
        r = await api('banChatMember', { chat_id: chatId, user_id: target.id });
        if (r.ok) await api('unbanChatMember', { chat_id: chatId, user_id: target.id, only_if_banned: true }); // кик, не бан
        return r.ok ? send(chatId, `${esc(target.first_name || 'Участник')} выгнан из группы.`) : fail(r, 'кикнуть');
      }
      case 'ban':
        if (!target) return;
        r = await api('banChatMember', { chat_id: chatId, user_id: target.id });
        return r.ok ? send(chatId, `${esc(target.first_name || 'Участник')} забанен.`) : fail(r, 'забанить');
      case 'mute':
        if (!target) return;
        r = await api('restrictChatMember', {
          chat_id: chatId,
          user_id: target.id,
          permissions: { can_send_messages: false },
          until_date: Math.floor(Date.now() / 1000) + cmd.minutes * 60,
        });
        return r.ok ? send(chatId, `${esc(target.first_name || 'Участник')} помолчит ${cmd.minutes >= 60 ? Math.round(cmd.minutes / 60) + ' ч' : cmd.minutes + ' мин'} 🤐`) : fail(r, 'замутить');
      case 'unmute':
        if (!target) return;
        r = await api('restrictChatMember', {
          chat_id: chatId,
          user_id: target.id,
          permissions: { can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true },
        });
        return r.ok ? send(chatId, `${esc(target.first_name || 'Участник')} снова в эфире.`) : fail(r, 'размутить');
      case 'del':
        r = await api('deleteMessage', { chat_id: chatId, message_id: reply.message_id });
        return r.ok ? undefined : fail(r, 'удалить сообщение');
      case 'promote':
        if (!target) return;
        r = await api('promoteChatMember', { chat_id: chatId, user_id: target.id, can_pin_messages: true, can_delete_messages: true, can_invite_users: true, can_restrict_members: true, can_change_info: true });
        return r.ok ? send(chatId, `${esc(target.first_name || 'Участник')} теперь админ.`) : fail(r, 'назначить админом');
      case 'demote':
        if (!target) return;
        r = await api('promoteChatMember', { chat_id: chatId, user_id: target.id, can_pin_messages: false, can_delete_messages: false, can_invite_users: false, can_restrict_members: false, can_change_info: false, can_manage_video_chats: false, can_promote_members: false });
        return r.ok ? send(chatId, `${esc(target.first_name || 'Участник')} больше не админ.`) : fail(r, 'снять админа');
    }
  }

  async function groupFlow(msg) {
    await ensureSelf();
    const chatId = msg.chat.id;
    const key = String(chatId);

    // профиль группы: общая память, без онбординга, пинги отключены флагом isGroup
    let g = store.getUser(key);
    if (!g || !g.isGroup) {
      g = store.setUser(key, { isGroup: true, name: msg.chat.title || 'Группа', botName: g?.botName || 'Помощник', tzOffset: g?.tzOffset ?? DEFAULT_OFFSET, step: null });
    }

    // реестр участников: каждый, кто пишет (или кого добавили) - в справочник,
    // чтобы бот мог реально тегать людей (@username или tg://user?id=)
    const members = { ...(g.members || {}) };
    let membersChanged = false;
    const remember = (u) => {
      if (!u || u.is_bot) return;
      const cur = members[u.id];
      const name = u.first_name || u.username || '';
      const username = u.username || null;
      if (!cur || cur.name !== name || cur.username !== username) {
        members[u.id] = { name, username };
        membersChanged = true;
      }
    };
    remember(msg.from);
    remember(msg.reply_to_message?.from);
    (msg.new_chat_members || []).forEach(remember);
    // @username-ы из текста тоже в реестр («Вот он @pxpusk»): id нет,
    // но для рабочего тега хватает username; ключ u:<ник>
    for (const mm of (msg.text || msg.caption || '').matchAll(/@([A-Za-z][A-Za-z0-9_]{3,31})/g)) {
      const un = mm[1].toLowerCase();
      if (un === (botUsername || '').toLowerCase()) continue;
      if (!Object.values(members).some((x) => (x.username || '').toLowerCase() === un)) {
        members['u:' + un] = { name: mm[1], username: mm[1] };
        membersChanged = true;
      }
    }
    if (membersChanged) g = store.setUser(key, { members });

    // бота добавили в группу - представиться
    if (msg.new_chat_members?.some((u) => u.id === botId)) {
      return send(
        chatId,
        `Привет! Я общая память этой группы 🙂\n\nЗапоминаю всё, что тут пишут: дела, долги, договорённости. Спросить меня - тегни @${botUsername} (например «@${botUsername} что мы решили по бюджету?»).\n\nАдмины могут через меня управлять группой: «закрепи» (ответом на сообщение), «кикни», «замуть на час», «переименуй в ...», «дай ссылку».\n\nСделайте меня админом, чтобы я видел все сообщения и мог управлять.`
      );
    }

    // имя автора: приоритет тому, как человек сам представился («я Саня»),
    // телеграмный first_name бывает ником или пустышкой
    const regName = msg.from && g.members?.[msg.from.id]?.name;
    const fromName = (regName && regName.trim()) || authorName(msg);

    // Документы в группе: читаем и запоминаем (PDF, DOCX, текст). Бот следит
    // за чатом - файл ложится в общую память; при @теге отвечаем сутью.
    if (msg.document && !String(msg.document.mime_type || '').startsWith('audio/')) {
      const doc = msg.document;
      const mime = String(doc.mime_type || '');
      const name = doc.file_name || 'документ';
      const docAddressed = mentionsBot(msg.caption || '');
      if ((doc.file_size || 0) > 15 * 1024 * 1024) {
        if (docAddressed) await send(chatId, 'Файл тяжелее 15 МБ - не потяну. Пришли полегче?');
        return;
      }

      // Экспорт истории Telegram (result.json): заливаем прошлое группы в
      // память. Только админ - импорт меняет общую память задним числом.
      if (name.toLowerCase().endsWith('.json')) {
        try {
          const buf = Buffer.from(await downloadBase64(doc.file_id), 'base64');
          const parsed = parseTgExport(buf);
          if (parsed) {
            if (!(await callerIsAdmin(chatId, msg.from.id))) {
              return send(chatId, 'Импорт истории - только для админов группы 🙂');
            }
            const r = importIntoStore(store, key, parsed);
            const skipped = r.total > r.count ? ` (взял последние ${r.count} из ${r.total})` : '';
            const scope = parsed.full ? `все чаты (${parsed.chatCount})` : 'историю';
            return send(
              chatId,
              `Импортировал ${scope}: ${r.count} сообщений с ${esc(r.first)} по ${esc(r.last)}${skipped} 📚\n\nТеперь я помню, что было до меня. Фоном переварю это в факты - через часок буду отвечать по старой переписке совсем уверенно, но спрашивать можно уже сейчас.`
            );
          }
        } catch (e) {
          log.error('[telegram] group import', e.message);
          return send(chatId, 'Файл похож на JSON, но прочитать не смог. Это точно экспорт из Telegram Desktop?');
        }
      }
      if (!audioEnabled()) {
        if (docAddressed) await send(chatId, 'Документы пока не читаю: нет ключа ИИ.');
        return;
      }
      const summary = await (docAddressed ? withTyping(chatId, () => readDoc(doc, mime, name)) : readDoc(doc, mime, name)).catch((e) => {
        log.error('[telegram] group doc', e.message);
        return null;
      });
      if (!summary) {
        if (docAddressed) await send(chatId, `«${esc(name)}» - такой формат не читаю. Понимаю PDF, DOCX и текст.`);
        return;
      }
      store.addRaw(key, `${fromName} прислал документ «${name}». Суть: ${summary}`);
      if (docAddressed) await send(chatId, `Прочитал «${esc(name)}». Суть: ${esc(summary)}`);
      return;
    }

    // Голосовые в группе (№5): транскрибируем в общую память; если это
    // reply на бота - обрабатываем как обращение
    let rawText = msg.text || msg.caption || '';
    let fromVoice = false;
    if (!rawText && msg.voice && audioEnabled() && (msg.voice.duration || 0) <= 180) {
      const isReplyToBot = msg.reply_to_message?.from?.id === botId;
      try {
        const b64 = await (isReplyToBot ? withTyping(chatId, () => downloadBase64(msg.voice.file_id)) : downloadBase64(msg.voice.file_id));
        rawText = (await aiTranscribe(b64, 'ogg')) || '';
        fromVoice = true;
      } catch (e) {
        log.error('[telegram] group voice', e.message);
      }
    }
    if (!rawText) return; // прочие медиа в группах пока не разбираем

    const addressed = mentionsBot(rawText) || msg.reply_to_message?.from?.id === botId;
    const text = addressed ? stripMention(rawText) : rawText;

    // Слэш-команды в группе работают и без @тега
    if (rawText.startsWith('/')) {
      const slash = rawText.split(/[@\s]/)[0].toLowerCase();
      if (slash === '/reset') {
        if (!(await callerIsAdmin(chatId, msg.from.id))) return send(chatId, 'Сброс памяти группы - только для админов 🙂');
        return askReset(chatId, { ...g, name: fromName }); // обращение к тому, кто просит
      }
      if (slash === '/summary') return sendSummary(key);
      if (slash === '/help' || slash === '/start') {
        return send(
          chatId,
          `Я общая память этой группы 🙂 Слежу за чатом 24/7, запоминаю дела, долги и договорённости, понимаю голосовые, читаю файлы (PDF, DOCX). Хочешь, чтобы я знал, что было ДО меня - экспортируй историю чата (или весь аккаунт разом) в Telegram Desktop (JSON) и кинь сюда result.json (только админ).\n\nТегни @${botUsername} и спроси что угодно: «что мы решили по бюджету?», «баланс», «траты», «найди про...», «нарисуй график трат», «тегни Никиту», «тегни всех», «устрой опрос: пицца или суши», «кто сколько скинул на подарок?».\n\nАдминам: «закрепи» (ответом), «кикни», «замуть на час», «переименуй в ...», «дай ссылку». /summary - итоги, /reset - стереть память группы (только админ).`
        );
      }
      return; // чужие/неизвестные команды в группе молча пропускаем
    }

    // живая реакция-эмодзи по настроению (бот - участник чата)
    if (!fromVoice && msg.message_id) maybeReact?.(chatId, msg.message_id, text);

    // всё в общую память группы (с автором), тихий захват дел/долгов
    store.addRaw(key, `${fromName}: ${text}`);
    captureEntry(store, text, new Date(), key, userOffset(g));

    // «я Никита» - работает и БЕЗ обращения к боту: человек просто
    // представился в чате; имя в реестр + факт (RAG знает сразу)
    const iam = text.match(/^(?:я|меня зовут)\s+([А-Яа-яЁёA-Za-z]{2,20})[!.]*$/i);
    if (iam && msg.from) {
      const newName = iam[1][0].toUpperCase() + iam[1].slice(1);
      const members2 = { ...(g.members || {}) };
      members2[msg.from.id] = { ...(members2[msg.from.id] || {}), name: newName, username: msg.from.username || members2[msg.from.id]?.username || null };
      g = store.setUser(key, { members: members2 });
      store.addFacts([{ chatId: key, text: `Участника${msg.from.username ? ` @${msg.from.username}` : ''} зовут ${newName}`, people: [newName] }]);
      if (addressed) return send(chatId, `Принял, ${esc(newName)}! Теперь знаю тебя по имени 🙂`);
      return; // тихо запомнили, не влезаем в разговор
    }

    // Связка личности по РЕПЛАЮ: ответ на чьё-то сообщение + «это Саша» /
    // «он Саша» / «её зовут Саша» / «это @ник» -> тот человек получает имя.
    const rt = msg.reply_to_message?.from;
    if (rt && !rt.is_bot && rt.id !== msg.from?.id) {
      const rm = text.match(/^(?:это|эт[оа]\s+же|он|она|его зовут|её зовут|ее зовут|зовут|запомни[:,]?\s*(?:это\s+)?)\s+(?:мо[йяю]\s+|наш[аеи]?\s+|это\s+)?([А-Яа-яЁёA-Za-z@][А-Яа-яЁёA-Za-z0-9_]{1,31})[!.]*$/i);
      // защита от «это круто/правда»: имя с заглавной, @ник, родственное слово («мама»), или явно к боту
      if (rm && (rm[1].startsWith('@') || /^[А-ЯЁA-Z]/.test(rm[1]) || isRelName(rm[1]) || addressed)) {
        const raw2 = rm[1];
        const isUn = raw2.startsWith('@');
        const members2 = { ...(g.members || {}) };
        const cur = members2[rt.id] || {};
        members2[rt.id] = {
          name: isUn ? (cur.name || rt.first_name || raw2) : raw2[0].toUpperCase() + raw2.slice(1),
          username: isUn ? raw2.slice(1) : rt.username || cur.username || null,
        };
        g = store.setUser(key, { members: members2 });
        const nm2 = members2[rt.id].name;
        store.addFacts([{ chatId: key, text: `Участника${members2[rt.id].username ? ` @${members2[rt.id].username}` : ''} зовут ${nm2}`, people: [nm2] }]);
        if (addressed) return send(chatId, `Понял, это ${esc(nm2)} 👌 Запомнил.`);
        return;
      }
    }

    // Связка «@ник это Имя» / «Имя это @ник», в т.ч. НЕСКОЛЬКО пар за раз по
    // строкам: «@meloch287 это мама\n@jjoopes это сергей». Люди реально
    // становятся Мамой и Сергеем в реестре -> потом «тегни маму» их пингует.
    // Работает и без обращения к боту (явная команда запомнить).
    const pairs = extractIdentityPairs(text);
    if (pairs.length) {
      const members2 = { ...(g.members || {}) };
      for (const { un, name } of pairs) {
        const existing = Object.entries(members2).find(([, x]) => (x.username || '').toLowerCase() === un.toLowerCase());
        if (existing) members2[existing[0]] = { ...existing[1], name };
        else members2['u:' + un.toLowerCase()] = { name, username: un };
      }
      g = store.setUser(key, { members: members2 });
      store.addFacts(pairs.map(({ un, name }) => ({ chatId: key, text: `${name} - это @${un}`, people: [name] })));
      if (addressed) {
        const list = pairs.map(({ un, name }) => `${esc(name)} - @${esc(un)}`).join(', ');
        return send(chatId, `Запомнил: ${list} 👌`);
      }
      return;
    }

    if (!addressed) return; // без обращения молчим, только запоминаем

    // «Тегни всех» (№3): пинг всех из реестра, кулдаун 10 минут от спама
    if (/(?:^|[\s,!])(?:тегни|позови|собери|подними)\s+всех|^@?все сюда/i.test(text)) {
      if (Date.now() - (g.lastAllPing || 0) < 10 * 60000) {
        return send(chatId, 'Всех уже недавно звал - не буду спамить, подожди пару минут 🙂');
      }
      const people = Object.entries(g.members || {}).filter(([id]) => String(id) !== String(msg.from?.id));
      if (!people.length) return send(chatId, 'Пока никого не знаю в этой группе - пусть люди напишут по разу.');
      store.setUser(key, { lastAllPing: Date.now() });
      const mentions = people.map(([id, m]) => mentionOf(m, id));
      // Telegram уведомляет максимум ~5 упоминаний на сообщение - шлём чанками
      for (let i = 0; i < mentions.length; i += 5) {
        await send(chatId, `${mentions.slice(i, i + 5).join(' ')}${i === 0 ? ` - ${esc(fromName)} собирает всех 📢` : ''}`);
      }
      return;
    }

    // «тегни его/её» ответом на чьё-то сообщение - тегаем автора того сообщения
    if (/^(?:тегни|тэгни|пингани|позови|призови)\s+(?:его|её|ее)[!?.\s]*$/i.test(text)) {
      const t = msg.reply_to_message?.from;
      if (t && !t.is_bot) {
        return send(chatId, `${mentionOf({ username: t.username, name: t.first_name }, t.id)}, тебя ${esc(fromName)} зовёт 🙂`);
      }
      return send(chatId, 'Ответь командой «тегни его» на сообщение самого человека - тогда пойму, кого звать.');
    }

    // Тегнуть участника: «тегни Никиту», «серег, тегни никиту и скажи что...».
    // «скажи/передай что X» - ИИ формулирует реплику адресату сам.
    const tag = text.match(/(?:^|[\s,!])(?:т[еэ]гни+|пингани|позови|призови)\s+@?(.+)$/i);
    if (tag) {
      let who = tag[1].trim();
      let relay = null;
      const say = who.match(/^(.+?)\s+(?:и\s+)?(?:скажи|передай|напиши)(?:\s+(?:ему|ей))?\s*,?\s*(?:что\s+)?(.+)$/i);
      if (say) {
        who = say[1].trim();
        relay = say[2].trim();
      }
      who = who.replace(/[,!?.\s]+$/, '');
      const relayText = async (targetName) => {
        if (!relay) return null;
        if (aiEnabled()) {
          const phrased = await withTyping(chatId, () => aiRelay(store, key, targetName, fromName, relay)).catch(() => null);
          if (phrased) return phrased.trim();
        }
        return `${fromName} просил передать: «${relay}»`;
      };
      if (/^(?:его|её|ее)$/i.test(who)) {
        const t = msg.reply_to_message?.from;
        if (t && !t.is_bot) {
          const m2 = mentionOf({ username: t.username, name: t.first_name }, t.id);
          const phrase = await relayText(t.first_name || 'друг');
          return send(chatId, phrase ? `${m2}, ${esc(phrase)}` : `${m2}, тебя ${esc(fromName)} зовёт 🙂`);
        }
        return send(chatId, 'Ответь командой на сообщение самого человека - пойму, кого звать.');
      }
      const hit = findMember(g.members, who);
      if (!hit) {
        return send(chatId, `Не видел, чтобы ${esc(who)} тут писал. Пусть черкнёт разок, или скажи «${esc(who)} - это @ник», и я запомню.`);
      }
      const mention = mentionOf(hit, hit.id);
      const phrase = await relayText(hit.name || 'друг');
      if (phrase) return send(chatId, `${mention}, ${esc(phrase)}`);
      return send(chatId, `${mention}, тебя ${esc(fromName)} зовёт 🙂`);
    }

    // Смена имени бота в группе: только целое короткое сообщение-команда,
    // иначе обычные фразы с «тебя зовут...» случайно переименовывали бота
    const nm = text.match(/^(?:ты теперь|(?:теперь )?тебя зовут|зовись)\s+([А-Яа-яЁёA-Za-z0-9_-]{2,20})[!.)]*$/i);
    if (nm) {
      const newName = nm[1][0].toUpperCase() + nm[1].slice(1);
      store.setUser(key, { botName: newName });
      return send(chatId, `Принято, теперь я тут ${esc(newName)} 😎`);
    }

    // Создание тем (топиков) форума: «создай топик X», «добавь топик: X, Y, Z».
    // Реально дёргаем createForumTopic (нужен форум + бот-админ с правами).
    const topicM = text.match(/^(?:созда(?:й|ть)|добавь|заведи|сделай)\s+топик[иов]*(?=[\s:,-]|$)[:\s-]*(.+)$/i);
    if (topicM) {
      if (!msg.chat?.is_forum) {
        return send(chatId, 'В этой группе темы (топики) выключены. Включи их в настройках группы («Темы»), и я создам.');
      }
      if (!(await callerIsAdmin(chatId, msg.from.id))) {
        return send(chatId, 'Создавать темы может админ группы 🙂');
      }
      const names = topicM[1].split(/\s*(?:,|;|(?<=\s|^)и(?=\s|$))\s*/i).map((s) => s.trim().replace(/^["«»]|["«»]$/g, '')).filter(Boolean).slice(0, 8);
      if (!names.length) return send(chatId, 'Как назвать темы? Напиши «создай топик Флудилка, Задачи».');
      const made = [];
      for (const name of names) {
        const r = await api('createForumTopic', { chat_id: chatId, name: name.slice(0, 128) });
        if (r.ok) made.push(name);
        else log.error('[telegram] createForumTopic', r.description || '');
      }
      if (!made.length) return send(chatId, 'Не смог создать темы. Проверь, что я админ с правом «Управление темами».');
      return send(chatId, `Готово, создал ${made.length === 1 ? 'тему' : 'темы'}: ${made.map((n) => `«${esc(n)}»`).join(', ')} 📂`);
    }

    // 1) команды управления группой
    const gc = parseGroupCmd(text.toLowerCase().replace(/ё/g, 'е').trim());
    if (gc) return runGroupCmd(chatId, msg, gc);

    // 2) общие интенты (траты, баланс, поиск, календарь, опрос...) на памяти группы
    if (await handleIntent(key, g, text)) return;

    // 3) разговор по общей памяти группы
    if (!aiEnabled()) {
      const out = await handleMessage(store, text, new Date(), key);
      return send(chatId, esc(out.reply || 'Записал.'));
    }
    let reply;
    try {
      reply = await withTyping(chatId, () => aiFriendReply(store, key, text, new Date(), null, fromName));
    } catch (e) {
      log.error('[telegram] group friend', e.message);
    }
    if (!reply) return send(chatId, esc(sleepyText(key)));
    // модель любит зеркалить формат входящих «Имя: ...» - срезаем известные
    // имена в цикле (бывает задвоение) с трима
    const known = new Set(
      [fromName, g.botName, ...Object.values(g.members || {}).map((m) => m.name)].filter(Boolean).map((s) => s.toLowerCase())
    );
    reply = reply.trim();
    for (let i = 0; i < 3; i++) {
      const pm = reply.match(/^([\wА-Яа-яЁё-]{2,20})\s*:\s+/);
      if (pm && known.has(pm[1].toLowerCase())) reply = reply.slice(pm[0].length).trim();
      else break;
    }
    // осиротевшая ведущая пунктуация («, ну я понял...») - после срезки имени
    // или косяка модели ответ иногда начинался с запятой/двоеточия
    reply = reply.replace(/^[\s,;:.]+/, '').trim();
    if (!reply) return send(chatId, esc(sleepyText(key)));
    store.pushHistory('user', `${fromName}: ${text}`, key);
    store.pushHistory('assistant', reply, key);
    // голосом, если у группы включён режим (иначе текст) - как в личке
    return deliver(chatId, reply, store.getUser(key));
  }

  return { groupFlow, isGroupChat, callerIsAdmin };
}
