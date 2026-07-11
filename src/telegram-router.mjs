// Роутинг апдейтов Telegram: onMessage (все виды сообщений) и onCallback
// (нажатия инлайн-кнопок). Вынесено из telegram.mjs как отдельный кластер.
// Фабрика: все внешние зависимости (api/send/store/... и локальные хелперы
// telegram.mjs) приходят снаружи - тот же приём, что и в group.mjs.

import { audioFormatFromMime, audioEnabled, aiFollowup, aiEnabled } from './ai.mjs';
import { DEFAULT_OFFSET, fmtUser, userOffset } from './tz.mjs';
import { consumeTgLink } from './webauth.mjs';
import { parseTgExport, importIntoStore } from './importchat.mjs';
import { toCsv, toJson, toMarkdown } from './export.mjs';
import { esc, hasFfmpeg } from './telegram-helpers.mjs';

export function createMessageRouter(deps) {
  const {
    api, send, store, log, activeThread, withTyping, withWake, sleepyText,
    isGroupChat, groupFlow, callerIsAdmin,
    locationFlow, audioFlow, imageFlow, videoTranscript, downloadBase64, readDoc,
    onboardingStep, handleIntent, friendFlow, learnSticker, maybeReact,
    helpText, sendSummary, askReset, startOnboarding, helloAgain,
    upcomingEvents, sendIcs, sendDocumentText,
  } = deps;

  async function onMessage(msg) {
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

    if (msg.location) {
      if (!user) return startOnboarding(String(chatId));
      return locationFlow(chatId, user, msg.location);
    }

    if (msg.voice) {
      return audioFlow(chatId, user, msg.voice.file_id, 'ogg', msg.voice.duration);
    }
    if (msg.audio) {
      return audioFlow(chatId, user, msg.audio.file_id, audioFormatFromMime(msg.audio.mime_type), msg.audio.duration);
    }
    if (msg.document && String(msg.document.mime_type || '').startsWith('audio/')) {
      return audioFlow(chatId, user, msg.document.file_id, audioFormatFromMime(msg.document.mime_type), 0);
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
      if (user?.step) return onboardingStep(chatId, user, transcript);
      if (await handleIntent(String(chatId), user, transcript)) return; // команды из кружка тоже работают
      return friendFlow(String(chatId), transcript);
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

    if (!user) return startOnboarding(String(chatId)); // первое сообщение без /start - тоже знакомимся
    if (user.step) return onboardingStep(String(chatId), user, text);

    // Спец-намерения (правка/повтор/поиск/календарь) - до обычного разговора
    if (await handleIntent(String(chatId), user, text)) return;

    return friendFlow(String(chatId), text);
  }

  async function onCallback(cb) {
    const chatId = String(cb.message?.chat?.id || '');
    api('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
    if (!chatId) return;

    if (cb.data === 'reset_no') {
      return send(chatId, 'Фух. Я уж испугался 😅 Продолжаем, я всё помню.');
    }
    if (cb.data === 'reset_yes') {
      const prof = store.getUser(chatId);
      if (prof?.isGroup) {
        // память группы стирает только админ группы; онбординг не нужен
        if (!(await callerIsAdmin(chatId, cb.from.id))) return send(chatId, 'Стереть память группы может только админ.');
        const title = prof.name;
        store.clearChatData(chatId);
        store.setUser(chatId, { isGroup: true, name: title, botName: 'Помощник', tzOffset: DEFAULT_OFFSET, step: null });
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

  return { onMessage, onCallback };
}
