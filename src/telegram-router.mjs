// Роутинг апдейтов Telegram: onMessage (все виды сообщений) и onCallback
// (нажатия инлайн-кнопок). Вынесено из telegram.mjs как отдельный кластер.
// Фабрика: все внешние зависимости (api/send/store/... и локальные хелперы
// telegram.mjs) приходят снаружи - тот же приём, что и в group.mjs.

import { audioFormatFromMime, audioEnabled, aiFollowup, aiEnabled } from './ai.mjs';
import { DEFAULT_OFFSET, fmtUser, userOffset } from './tz.mjs';
import { consumeTgLink } from './webauth.mjs';
import { parseTgExport, importIntoStore } from './importchat.mjs';
import { parseIcs } from './ics.mjs';
import { ID_CMD } from './telegram-idpicker.mjs';
import { adminLogOn, setAdminLog, logAdmin, adminLogList, adminLogStats, describeMessage, forwardLabel } from './adminlog.mjs';
import { toCsv, toJson, toMarkdown } from './export.mjs';
import { esc, hasFfmpeg, LK_TRIGGER_RE, STEP_EXPLAIN } from './telegram-helpers.mjs';
import { parseRemember, rememberEcho } from './remember.mjs';

export function createMessageRouter(deps) {
  const {
    api, send, store, log, activeThread, withTyping, withWake, sleepyText,
    isGroupChat, groupFlow, callerIsAdmin,
    locationFlow, audioFlow, imageFlow, videoTranscript, downloadBase64, readDoc,
    onboardingStep, handleIntent, friendFlow, learnSticker, maybeReact,
    helpText, sendSummary, askReset, startOnboarding, helloAgain,
    upcomingEvents, sendIcs, sendDocumentText, lk, idPicker, audioChoice, isAudioFile, audioInfo,
  } = deps;

  // ЕДИНАЯ маршрутизация готового текста - и набранного руками (onMessage),
  // и расшифрованного из голоса/кружка (audioFlow в telegram-media.mjs).
  // Порядок важен: онбординг раньше всего (ЛК и интенты не должны срабатывать
  // мид-онбординга), затем триггеры ЛК («настройки»/«лк»/«кабинет»), затем
  // ожидания многошаговых сценариев ЛК, затем спец-интенты, затем разговор.
  async function routeText(chatId, user, text) {
    const id = String(chatId);
    if (!user) return startOnboarding(id); // первое сообщение - знакомимся
    if (user.step) return onboardingStep(id, user, text);
    // Личный кабинет (U3a-ui): «настройки»/«лк»/«кабинет» - до разговора
    if (LK_TRIGGER_RE.test(text.trim().toLowerCase().replace(/ё/g, 'е'))) return lk.openSettings(id, user);
    // Продолжение многошагового сценария ЛК (добавить/изменить долг, вишлист, фитнес, календарь)
    if (await lk.consumeInput(id, user, text)) return;
    // «запомни ...» - пишем сразу и дословно, не дожидаясь фонового worker'а
    const note = parseRemember(text);
    if (note) {
      store.addFacts([{ chatId: id, text: note }]);
      return send(id, `записал ✍️\n<i>${esc(rememberEcho(note))}</i>`);
    }
    // Добавление события в календарь по ключевому слову «календарь» (с переспросом).
    // Только по ключевому слову - иначе обычные встречи не сыпятся в календарь.
    if (await lk.tryCalendar(id, user, text)) return;
    // Спец-намерения (правка/повтор/поиск/календарь) - до обычного разговора
    if (await handleIntent(id, user, text)) return;
    return friendFlow(id, text);
  }

  // Владелец бота: только ему доступна команда /admin. Берём из окружения,
  // без него режим недоступен никому.
  const OWNER = String(process.env.OWNER_CHAT_ID || '');
  const isOwner = (msg) => OWNER && String(msg?.from?.id || '') === OWNER;

  function adminPanelText(chatId, title) {
    const on = adminLogOn(store, chatId);
    const s = adminLogStats(store, chatId);
    const kinds = Object.entries(s.byKind).map(([k, n]) => `${k}: ${n}`).join(', ') || 'пусто';
    const people = Object.entries(s.byUser).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w, n]) => `${w} - ${n}`).join('\n') || 'никого';
    return [
      `🛡 <b>Админ-режим</b>${title ? ' · ' + esc(title) : ''}`,
      '',
      on
        ? '🟢 Запись ВКЛЮЧЕНА\n\nПишу в отдельную базу всё: текст, фото, видео, файлы, пересылки - кто, когда и от кого.\n<b>Пока включено, я молчу</b> - ни на что не отвечаю, только записываю. Кроме /admin.'
        : '🔴 Запись выключена - веду себя как обычно',
      '',
      `Записей в этом чате: <b>${s.total}</b>`,
      `Типы: ${esc(kinds)}`,
      '',
      'Кто писал:',
      esc(people),
    ].join('\n');
  }
  const adminPanelKb = (chatId) => [
    [{ text: adminLogOn(store, chatId) ? '🔴 Выключить запись' : '🟢 Включить запись', callback_data: 'adm:toggle' }],
    [{ text: '📊 Последние 20', callback_data: 'adm:last' }, { text: '📥 Выгрузить JSON', callback_data: 'adm:dump' }],
  ];

  async function onMessage(msg) {
    // Админ-журнал: пишем ВСЁ, что пришло в чат, до любой другой обработки -
    // иначе групповые сообщения ушли бы в groupFlow мимо журнала.
    try {
      const cid = msg?.chat?.id;
      if (cid != null && adminLogOn(store, cid)) {
        const d = describeMessage(msg);
        if (d) logAdmin(store, {
          ...d,
          chatId: cid,
          chatTitle: msg.chat.title || null,
          userId: msg.from?.id,
          username: msg.from?.username || null,
          name: msg.from?.first_name || null,
        });
      }
    } catch (e) { log.error('[admin] log', e.message); }

    // Режим записи: бот НЕ отвечает вообще, только пишет в журнал. Иначе на
    // пачку из 20 пересланных сообщений прилетает 20 ответов - ровно то, что
    // делать в этом режиме не надо. Исключение - сама команда /admin, иначе
    // режим было бы не выключить.
    const isAdminCmd = typeof msg.text === 'string' && /^\/admin(?:@\w+)?(?![а-яёa-z])/i.test(msg.text.trim());
    if (!isAdminCmd && msg?.chat?.id != null && adminLogOn(store, msg.chat.id)) return;

    // /admin - панель владельца. Работает и в личке, и в группе.
    if (isAdminCmd) {
      if (!isOwner(msg)) return; // чужим молчим, команды как будто нет
      return send(msg.chat.id, adminPanelText(msg.chat.id, msg.chat.title), {
        reply_markup: { inline_keyboard: adminPanelKb(msg.chat.id) },
      });
    }

    if (isGroupChat(msg)) {
      // тема форум-группы: ответы уходят в неё же
      if (msg.message_thread_id) activeThread.set(String(msg.chat.id), msg.message_thread_id);
      try {
        return await groupFlow(msg);
      } finally {
        activeThread.delete(String(msg.chat.id));
      }
    }

    const chatId = msg.chat.id;
    const user = store.getUser(String(chatId));

    // Секретная пипетка ID (стикеры/премиум-эмодзи): пока включена, забирает
    // сообщения себе. Команду /id ловим тут же - в список команд она не входит.
    if (typeof msg.text === 'string' && ID_CMD.test(msg.text.trim())) {
      if (user && !user.step) return idPicker.start(chatId, msg);
    }
    if (idPicker && (await idPicker.consume(chatId, msg))) return;

    if (msg.location) {
      if (!user) return startOnboarding(String(chatId));
      return locationFlow(chatId, user, msg.location);
    }

    if (msg.voice) {
      return audioFlow(chatId, user, msg.voice.file_id, 'ogg', msg.voice.duration);
    }
    // Аудиофайл (mp3/m4a/wav и audio-документы) - не расшифровываем молча,
    // а спрашиваем: транскрипция или саммари. Голосовые идут выше как раньше.
    if (audioChoice && isAudioFile(msg)) {
      if (!user) return startOnboarding(String(chatId));
      if (!audioEnabled()) return send(chatId, 'Аудио пока не разбираю: нет ключа для расшифровки');
      return audioChoice.ask(chatId, audioInfo(msg));
    }

    if (msg.photo && msg.photo.length) {
      const largest = msg.photo[msg.photo.length - 1];
      return imageFlow(chatId, largest.file_id, '[Прислал фото]', msg.caption, 'image/jpeg', true);
    }

    if (msg.animation) {
      const thumb = msg.animation.thumbnail || msg.animation.thumb;
      if (thumb) return imageFlow(chatId, thumb.file_id, '[Прислал гифку]', msg.caption);
      return send(chatId, 'Гифку получил, но разглядеть не смог 😅 Что там было?');
    }

    if (msg.video_note) {
      if (!audioEnabled()) return send(chatId, 'Кружки пока не разбираю: нет ключа для расшифровки.');
      if (!hasFfmpeg) return send(chatId, 'Кружок получил, но без ffmpeg на сервере не разберу его звук. Скажи голосовым или текстом?');
      if ((msg.video_note.duration || 0) > 180) return send(chatId, 'Ого, длинный кружок. Давай покороче?');
      const transcript = await withTyping(chatId, () => videoTranscript(msg.video_note.file_id)).catch((e) => {
        log.error('[telegram] video_note', e.message);
        return null;
      });
      if (!transcript) return send(chatId, 'Кружок посмотрел, но слов не разобрал. Повтори?');
      return routeText(chatId, user, transcript); // кружок = голос = текст: команды, ЛК и разговор
    }

    // Обычное видео (№14): вытаскиваем звук, расшифровываем, запоминаем
    if (msg.video) {
      if (!audioEnabled() || !hasFfmpeg) return send(chatId, 'Видео получил, но разобрать звук пока не могу.');
      if ((msg.video.file_size || 0) > 15 * 1024 * 1024) return send(chatId, 'Видео тяжелее 15 МБ - не потяну. Можно покороче/пожатое?');
      if ((msg.video.duration || 0) > 300) return send(chatId, 'Видео дольше 5 минут не осилю. Порежь?');
      const transcript = await withTyping(chatId, () => videoTranscript(msg.video.file_id)).catch((e) => {
        log.error('[telegram] video', e.message);
        return null;
      });
      if (!transcript) return send(chatId, 'Видео посмотрел, но речи не разобрал. Расскажешь словами?');
      const text = `[Прислал видео${msg.caption ? `, подпись: ${msg.caption}` : ''}] Что говорится: ${transcript}`;
      if (await handleIntent(String(chatId), user, transcript)) return;
      return friendFlow(String(chatId), text);
    }

    if (msg.document) {
      const doc = msg.document;
      const mime = String(doc.mime_type || '');
      const name = doc.file_name || 'документ';
      if ((doc.file_size || 0) > 15 * 1024 * 1024) {
        return send(chatId, 'Файл тяжелее 15 МБ - не потяну. Пришли что-нибудь полегче?');
      }
      // Импорт календаря .ics - разбираем события и кладём в календарь.
      if (name.toLowerCase().endsWith('.ics') || mime === 'text/calendar') {
        try {
          const buf = Buffer.from(await downloadBase64(doc.file_id), 'base64');
          const events = parseIcs(buf.toString('utf8'));
          const n = lk.importCalendar(String(chatId), events);
          return send(chatId, n
            ? `Добавил ${n} ${n === 1 ? 'событие' : 'событий'} в календарь 📅 Загляни в ЛК → Календарь.`
            : 'В этом .ics не нашёл событий с датой. Проверь файл?');
        } catch (e) {
          log.error('[telegram] ics import', e.message);
          return send(chatId, 'Не смог разобрать .ics. Это точно файл календаря?');
        }
      }
      // Экспорт истории Telegram (result.json) - заливаем прошлое в память
      if (name.toLowerCase().endsWith('.json')) {
        try {
          const buf = Buffer.from(await downloadBase64(doc.file_id), 'base64');
          const parsed = parseTgExport(buf);
          if (parsed) {
            const r = importIntoStore(store, String(chatId), parsed);
            const skipped = r.total > r.count ? ` (взял последние ${r.count} из ${r.total})` : '';
            const scope = parsed.full ? `все чаты (${parsed.chatCount})` : 'историю';
            return send(chatId, `Импортировал ${scope}: ${r.count} сообщений с ${esc(r.first)} по ${esc(r.last)}${skipped} 📚\n\nТеперь помню и то, что было раньше. Фоном переварю в факты - спрашивай.`);
          }
        } catch (e) {
          log.error('[telegram] import', e.message);
          return send(chatId, 'Файл похож на JSON, но прочитать не смог. Это точно экспорт из Telegram Desktop?');
        }
      }
      if (!mime.startsWith('audio/')) {
        if (!audioEnabled()) return send(chatId, 'Документы пока не читаю: нет ключа ИИ.');
        const summary = await withTyping(chatId, () => readDoc(doc, mime, name)).catch((e) => {
          log.error('[telegram] document', e.message);
          return null;
        });
        if (summary === null) {
          return send(chatId, `«${esc(name)}» - такой формат пока не читаю. Понимаю PDF, DOCX и текстовые файлы.`);
        }
        return friendFlow(String(chatId), `[Прислал документ «${name}»] Суть: ${summary}`);
      }
    }

    if (msg.sticker) {
      const s = msg.sticker;
      learnSticker(s); // учим стикеры собеседников, потом отвечаем ими сами
      if (!s.is_animated && !s.is_video) {
        return imageFlow(chatId, s.file_id, '[Прислал стикер]', s.emoji || '', 'image/webp');
      }
      // анимированные стикеры не разглядеть - реагируем на эмоцию
      return friendFlow(String(chatId), `[Прислал стикер с эмоцией ${s.emoji || 'без подписи'}]`);
    }

    if (typeof msg.text !== 'string') return;
    // живая реакция-эмодзи по настроению текста (не на команды)
    if (!msg.text.startsWith('/')) maybeReact(chatId, msg.message_id, msg.text);
    let text = msg.text.trim();
    if (!text) return;
    // Счётчик обращений к Толику (личный кабинет, U3a-ui) - раз на сообщение.
    // Только для уже знакомых: до онбординга/deep-link профиль НЕ создаём,
    // иначе _ensureUser внутри bumpRequests делал бы мёртвой ветку дефолтов
    // в обработчике «/start sm-…» ниже (профиль появлялся бы раньше времени).
    if (user) store.bumpRequests(String(chatId));

    // Пересланное сообщение: запоминаем, от кого оно
    const fwd = msg.forward_origin;
    if (fwd || msg.forward_from || msg.forward_sender_name) {
      const who =
        fwd?.sender_user?.first_name ||
        fwd?.sender_user_name ||
        fwd?.chat?.title ||
        msg.forward_from?.first_name ||
        msg.forward_sender_name ||
        'кого-то';
      if (!text.startsWith('/')) {
        if (user?.step) return onboardingStep(String(chatId), user, text);
        return friendFlow(String(chatId), `[Переслал сообщение от ${who}]: ${text}`);
      }
    }

    const cmd = text.split(/[\s@]/)[0];
    if (cmd === '/start') {
      // Deep-link «Подключить Telegram» из веба: /start sm-<token>. Привязываем
      // этот чат к веб-профилю и переносим ВСЮ веб-память сюда (общая память).
      const param = text.split(/\s+/)[1] || '';
      // Watch Films (specca.online): deep-link «/start wf_<nonce>». Подтверждаем
      // привязку в соседнем сервисе и выходим — своей памяти это не касается.
      // Блок живёт в репозитории, а не заплаткой на проде: раньше его правили
      // прямо на сервере, и очередной деплой его стирал. Вход в Watch Films
      // отваливался молча — .env с ключами деплой переживал, а код нет.
      if (param.startsWith('wf_') && process.env.WF_CALLBACK_URL && process.env.WF_CALLBACK_SECRET) {
        const wfNonce = param.slice(3);
        try {
          const r = await fetch(process.env.WF_CALLBACK_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-auth-secret': process.env.WF_CALLBACK_SECRET },
            body: JSON.stringify({ nonce: wfNonce, telegramId: Number(chatId), telegramName: (user && user.name) || '' }),
          });
          return send(chatId, r.ok
            ? '✅ Вход в Watch Films подтверждён — возвращайтесь в браузер.'
            : '⚠️ Ссылка устарела. Откройте Watch Films и начните вход заново.');
        } catch {
          return send(chatId, '⚠️ Не удалось подтвердить вход. Попробуйте ещё раз.');
        }
      }
      const tok = param.startsWith('sm-') ? param.slice(3) : null;
      const dir = tok ? consumeTgLink(store, tok, chatId) : null;
      if (dir) {
        if (!store.getUser(String(chatId))) store.setUser(String(chatId), { name: '', botName: 'Помощник', tzOffset: DEFAULT_OFFSET, step: null });
        if (dir === 'web') {
          const moved = store.migrateChat('web', String(chatId));
          return send(chatId, `✅ Подключил веб-профиль! Перенёс из веба ${moved} ${moved === 1 ? 'запись' : 'записей/фактов'} - теперь память общая: что в вебе, то и тут. Напоминания буду слать сюда. 🔔`);
        }
        // dir === 'tg': веб начинает показывать память ЭТОГО чата (ничего не переношу)
        const cnt = store.list({ chatId: String(chatId) }).length;
        const fcnt = store.data.facts.filter((f) => f.chatId === String(chatId)).length;
        return send(chatId, `✅ Подключил! Память из Telegram (${cnt} ${cnt === 1 ? 'дело' : 'дел'}, ${fcnt} ${fcnt === 1 ? 'факт' : 'фактов'}) теперь видна и в вебе - общая. Напоминания идут и туда, и сюда. 🔔`);
      }
      // повторный /start не сбрасывает друга - он просто здоровается
      if (user && !user.step) return helloAgain(String(chatId), user);
      return startOnboarding(String(chatId));
    }
    if (cmd === '/help') return send(chatId, helpText(user));
    if (cmd === '/summary') return sendSummary(String(chatId));
    if (cmd === '/reset') return askReset(String(chatId), user);
    if (cmd === '/settings') {
      // ЛК заблокирован, пока идёт знакомство: pending-сценарии ЛК не должны
      // взводиться мид-онбординга и перехватывать первое настоящее сообщение.
      if (!user) return startOnboarding(String(chatId));
      if (user.step) return send(chatId, esc(STEP_EXPLAIN[user.step] || STEP_EXPLAIN.name));
      return lk.openSettings(String(chatId), user);
    }

    // Онбординг, ЛК, интенты и разговор - общий маршрут с голосом (routeText)
    return routeText(chatId, user, text);
  }

  async function onCallback(cb) {
    const chatId = String(cb.message?.chat?.id || '');
    api('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
    if (!chatId) return;

    // в режиме записи бот молчит и на кнопки - кроме своей же админ-панели
    if (!String(cb.data || '').startsWith('adm:') && adminLogOn(store, chatId)) return;

    if (audioChoice && (await audioChoice.onCallback(chatId, cb.data))) return;

    // Панель админ-журнала (только владелец)
    if (cb.data?.startsWith('adm:')) {
      if (!OWNER || String(cb.from?.id || '') !== OWNER) return;
      if (cb.data === 'adm:toggle') {
        setAdminLog(store, chatId, !adminLogOn(store, chatId));
        return api('editMessageText', {
          chat_id: chatId, message_id: cb.message.message_id, parse_mode: 'HTML',
          text: adminPanelText(chatId, cb.message.chat?.title),
          reply_markup: { inline_keyboard: adminPanelKb(chatId) },
        });
      }
      if (cb.data === 'adm:last') {
        const rows = adminLogList(store, { chatId, limit: 20 });
        if (!rows.length) return send(chatId, 'Журнал пуст - включи запись и напиши что-нибудь');
        const body = rows.map((r) => {
          const t2 = new Date(r.ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
          const who = r.name || r.username || r.userId || '?';
          const what = r.kind === 'text' ? (r.text || '') : `[${r.kind}]${r.fileName ? ' ' + r.fileName : ''} ${r.text || ''}`;
          // пересылку и ответ подписываем: иначе видно только того, кто нажал кнопку
          const fwd = r.forward ? ` ⤴ от ${forwardLabel(r.forward)}` : '';
          const rep = r.replyTo ? ` ↩ ${r.replyTo.name || r.replyTo.username || r.replyTo.userId || '?'}` : '';
          return `${t2} · ${who}${r.username ? ' (@' + r.username + ')' : ''}${fwd}${rep}: ${what}`.slice(0, 200);
        }).join('\n');
        return send(chatId, `<b>Последние ${rows.length}</b>\n\n<code>${esc(body)}</code>`);
      }
      if (cb.data === 'adm:dump') {
        const rows = adminLogList(store, { chatId, limit: 5000 });
        if (!rows.length) return send(chatId, 'Журнал пуст');
        return sendDocumentText(chatId, JSON.stringify(rows, null, 2), 'admin-log.json', 'application/json',
          `Журнал: ${rows.length} записей. Можно скормить ИИ целиком`);
      }
      return;
    }

    if (cb.data === 'idp:off' && idPicker) { if (await idPicker.onCallback(chatId, cb.data)) return; }

    // Личный кабинет (U3a-ui): все callback_data вида lk:... - домен lk.onCallback.
    // Мид-онбординга (или без профиля) ЛК недоступен: молча гасим клик, чтобы
    // pending-сценарий не взводился и не перехватил первое настоящее сообщение.
    if (cb.data && cb.data.startsWith('lk:')) {
      const u = store.getUser(chatId);
      if (!u || u.step) return;
      if (await lk.onCallback(chatId, cb.data, cb, u)) return;
    }

    if (cb.data === 'reset_no') {
      return send(chatId, 'Фух. Я уж испугался 😅 Продолжаем, я всё помню.');
    }
    if (cb.data === 'reset_yes') {
      lk.clearPending(chatId); // незавершённый сценарий ЛК не должен пережить сброс
      const prof = store.getUser(chatId);
      if (prof?.isGroup) {
        // память группы стирает только админ группы; онбординг не нужен
        if (!(await callerIsAdmin(chatId, cb.from.id))) return send(chatId, 'Стереть память группы может только админ.');
        const title = prof.name;
        store.clearChatData(chatId);
        store.setUser(chatId, { isGroup: true, name: title, botName: 'Толик', tzOffset: DEFAULT_OFFSET, step: null });
        return send(chatId, 'Всё, память группы чистая. Начинаем с нуля 👋');
      }
      store.clearChatData(chatId);
      await send(chatId, 'Всё. Меня больше нет... а вот и я, новенький! 👋');
      return startOnboarding(chatId);
    }

    // Календарь телефона: пользователь может отказаться. Список событий
    // собираем из памяти в момент клика - переживает перезапуск бота.
    if (cb.data === 'cal_no') {
      return send(chatId, 'Ок, не буду. Скажешь «скинь в календарь» - соберу в любой момент.');
    }
    if (cb.data === 'cal_all' || cb.data === 'cal_week' || cb.data.startsWith('cal_one_')) {
      let events;
      let fname = 'raspisanie.ics';
      if (cb.data === 'cal_all') events = upcomingEvents(chatId);
      else if (cb.data === 'cal_week') events = upcomingEvents(chatId, 7);
      else {
        const e = store.byId(Number(cb.data.slice(8)));
        events = e && (e.chatId || 'web') === chatId && e.status === 'open' ? [e] : [];
        fname = 'sobytie.ics';
      }
      if (!events.length) return send(chatId, 'Похоже, событий уже нет. Попроси «скинь в календарь», если что-то появится.');
      try {
        const r = await sendIcs(chatId, events, fname);
        if (!r.ok) throw new Error(r.description || 'sendDocument failed');
        return;
      } catch (e) {
        log.error('[telegram] ics', e.message);
        return send(chatId, 'Не смог собрать файл. Попробуем позже?');
      }
    }

    // Экспорт памяти в выбранном формате
    if (cb.data === 'exp_no') return send(chatId, 'Ок. Скажешь «экспорт» - выгружу.');
    if (cb.data === 'exp_csv' || cb.data === 'exp_md' || cb.data === 'exp_json') {
      // экспорт памяти ГРУППЫ - только админам (данные уходят файлом наружу)
      const prof = store.getUser(chatId);
      if (prof?.isGroup && !(await callerIsAdmin(chatId, cb.from.id))) {
        return send(chatId, 'Экспорт памяти группы - только для админов 🙂');
      }
      try {
        if (cb.data === 'exp_csv') await sendDocumentText(chatId, toCsv(store, chatId), 'pamyat.csv', 'text/csv', 'Таблица дел и долгов. Открывается в Excel 📊');
        else if (cb.data === 'exp_md') await sendDocumentText(chatId, toMarkdown(store, chatId), 'dnevnik.md', 'text/markdown', 'Твой дневник по дням 📝');
        else await sendDocumentText(chatId, toJson(store, chatId), 'pamyat.json', 'application/json', 'Вся память одним файлом 🗄');
        return;
      } catch (e) {
        log.error('[telegram] export', e.message);
        return send(chatId, 'Не смог собрать файл. Попробуем позже?');
      }
    }

    // Подтверждение выполнения просроченного дела (вечерний вопрос)
    if (cb.data && cb.data.startsWith('done_')) {
      const id = Number(cb.data.slice(5));
      const e = store.byId(id);
      if (e && (e.chatId || 'web') === chatId && e.status === 'open') {
        store.setStatus(id, 'done');
        return send(chatId, 'Красава, закрыл 👍');
      }
      return send(chatId, 'Уже закрыто, всё ок 🙂');
    }
    if (cb.data && cb.data.startsWith('keep_')) {
      return send(chatId, 'Понял, оставил. Напомню ещё.');
    }
    // Отложить напоминание (№5): snooze_<id>_<минуты>
    if (cb.data && cb.data.startsWith('snooze_')) {
      const [, id, mins] = cb.data.split('_');
      const e = store.byId(Number(id));
      if (!e || (e.chatId || 'web') !== chatId || e.status !== 'open') return send(chatId, 'Это дело уже неактуально 🙂');
      const newDue = new Date(Date.now() + Number(mins) * 60000).toISOString();
      store.patch(e.id, { due: newDue, hasTime: true, reminded: false });
      const off = userOffset(store.getUser(chatId));
      const when = Number(mins) >= 1440 ? fmtUser(newDue, off, false) : fmtUser(newDue, off, true).slice(-5);
      return send(chatId, `Ок, напомню ${Number(mins) >= 1440 ? '' : 'в '}${when} 👍`);
    }

    if (!aiEnabled()) return;
    try {
      const text = await withTyping(chatId, () =>
        aiFollowup(store, chatId, cb.data === 'tomorrow' ? 'tomorrow' : 'more')
      );
      await send(chatId, esc(withWake(chatId, text)));
    } catch (e) {
      log.error('[telegram] callback', e.message);
      await send(chatId, esc(sleepyText(chatId)));
    }
  }

  return { onMessage, onCallback, routeText };
}
