// Telegram-бот «друг и дневник». Три команды: /start /help /summary.
// Всё остальное - живой разговор: сообщения падают в сырую базу,
// фоновый worker превращает их в факты, ИИ отвечает как близкий друг.

import { handleMessage, captureEntry } from './brain.mjs';
import { aiEnabled, audioEnabled, aiFriendReply, aiDiarySummary, aiFollowup, aiTranscribe } from './ai.mjs';

const COMMANDS = [
  { command: 'summary', description: 'Итоги дня' },
  { command: 'help', description: 'Как со мной общаться' },
  { command: 'start', description: 'Познакомиться заново' },
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const FALLBACKS = [
  'Слушай, я сегодня что-то туплю. Скажи ещё раз чуть иначе?',
  'Кажется, я задумался и прослушал. Повтори, пожалуйста?',
  'У меня сейчас туман в голове. Напиши ещё раз, я соберусь.',
];

export function startTelegramBot(store, token, log = console) {
  if (!token) return null;

  const api = async (method, params) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    return res.json();
  };

  const send = (chat_id, text, extra = {}) =>
    api('sendMessage', {
      chat_id,
      text: String(text).slice(0, 4000),
      parse_mode: 'HTML',
      ...extra,
    });

  const typing = (chat_id) => api('sendChatAction', { chat_id, action: 'typing' }).catch(() => {});

  /* ---- Онбординг: знакомство как с человеком ---- */

  function startOnboarding(chatId) {
    store.setUser(chatId, { step: 'name' });
    return send(
      chatId,
      'Привет-привет! 👋\n\nЯ твоя вторая память. Буду запоминать всё, что ты мне пишешь: дела, долги, встречи, мысли. А потом напомню, когда спросишь.\n\nДавай знакомиться. Как тебя называть?',
      { reply_markup: { remove_keyboard: true } }
    );
  }

  async function onboardingStep(chatId, user, text) {
    const value = text.trim().slice(0, 100);
    if (user.step === 'name') {
      store.setUser(chatId, { name: value, step: 'rhythm' });
      return send(chatId, `${esc(value)}, отличное имя 😊\n\nТы жаворонок или сова? Мне важно понимать твой ритм.`);
    }
    if (user.step === 'rhythm') {
      store.setUser(chatId, { rhythm: value, step: 'goal' });
      return send(chatId, 'Запомнил. И последний вопрос: что у тебя сейчас главное в жизни? Работа, учёба или просто кайфуешь?');
    }
    if (user.step === 'goal') {
      const u = store.setUser(chatId, { goal: value, step: null });
      return send(
        chatId,
        `Всё, теперь я в теме, ${esc(u.name || 'дружище')} 😉\n\nПросто пиши мне как в дневник. Я слушаю: как прошёл твой день?`
      );
    }
  }

  /* ---- Помощь: тепло и с цитатами ---- */

  function helpText(user) {
    const name = user?.name ? `, ${esc(user.name)}` : '';
    return [
      `Тут всё просто${name} 🙂`,
      '',
      '<blockquote>📖 Пиши мне как в личный дневник. «Планёрка прошла жёстко», «клиент должен 50 000 до пятницы», «завтра созвон в 10:00». Я всё запомню и разложу сам.</blockquote>',
      '',
      '<blockquote>💬 Спрашивай о чём угодно: «что у меня завтра?», «кто мне должен?», «о чём я писал в понедельник?». Отвечу по твоим записям.</blockquote>',
      '',
      '<blockquote>🎙 Лень печатать? Отправь голосовое. Я расшифрую и пойму.</blockquote>',
      '',
      '/summary - итоги дня. /start - познакомиться заново. А я всегда здесь.',
    ].join('\n');
  }

  /* ---- Итоги дня с кнопками продолжения ---- */

  async function sendSummary(chatId) {
    if (!aiEnabled()) {
      return send(chatId, 'Мне нужен ключ ИИ для итогов (AI_API_KEY в .env). Пока могу просто слушать и запоминать.');
    }
    await typing(chatId);
    try {
      const text = await aiDiarySummary(store, chatId);
      return send(chatId, esc(text), {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Расскажи подробнее', callback_data: 'more' },
              { text: 'Что завтра?', callback_data: 'tomorrow' },
            ],
          ],
        },
      });
    } catch (e) {
      log.error('[telegram] summary', e.message);
      return send(chatId, 'Что-то я завис с итогами. Дай мне минуту и спроси ещё раз?');
    }
  }

  /* ---- Обычный разговор ---- */

  async function friendFlow(chatId, text) {
    store.addRaw(chatId, text);
    captureEntry(store, text); // долги, встречи и задачи тихо ложатся в структурированную базу

    let reply;
    if (aiEnabled()) {
      await typing(chatId);
      try {
        reply = await aiFriendReply(store, chatId, text);
      } catch (e) {
        log.error('[telegram] friend', e.message);
      }
    }
    if (!reply) {
      // Без ИИ отвечают правила, без потери данных
      const out = await handleMessage(store, text, new Date(), String(chatId));
      reply = out.reply || FALLBACKS[Math.floor(Date.now() / 60000) % FALLBACKS.length];
    } else {
      store.pushHistory('user', text, String(chatId));
      store.pushHistory('assistant', reply, String(chatId));
    }
    return send(chatId, esc(reply));
  }

  /* ---- Роутинг сообщений ---- */

  async function onMessage(msg) {
    const chatId = msg.chat.id;
    const user = store.getUser(String(chatId));

    if (msg.voice || msg.audio) {
      if (!audioEnabled()) {
        return send(chatId, 'Голосовые пока не разбираю: нет ключа для расшифровки. Напиши текстом, я всё пойму.');
      }
      const voice = msg.voice || msg.audio;
      if ((voice.duration || 0) > 180) {
        return send(chatId, 'Ого, длинное голосовое. Дольше трёх минут не осилю. Скажи покороче?');
      }
      await typing(chatId);
      const info = await api('getFile', { file_id: voice.file_id });
      if (!info.ok) throw new Error('getFile failed');
      const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
      if (!fileRes.ok) throw new Error('file download failed');
      const b64 = Buffer.from(await fileRes.arrayBuffer()).toString('base64');
      const transcript = await aiTranscribe(b64, 'ogg');
      if (!transcript) {
        return send(chatId, 'Я честно слушал, но не расслышал. Скажи ещё раз?');
      }
      if (user?.step) return onboardingStep(chatId, user, transcript);
      return friendFlow(String(chatId), transcript);
    }

    if (typeof msg.text !== 'string') return;
    const text = msg.text.trim();
    if (!text) return;

    const cmd = text.split(/[\s@]/)[0];
    if (cmd === '/start') return startOnboarding(String(chatId));
    if (cmd === '/help') return send(chatId, helpText(user));
    if (cmd === '/summary') return sendSummary(String(chatId));

    if (!user) return startOnboarding(String(chatId)); // первое сообщение без /start - тоже знакомимся
    if (user.step) return onboardingStep(String(chatId), user, text);

    return friendFlow(String(chatId), text);
  }

  async function onCallback(cb) {
    const chatId = String(cb.message?.chat?.id || '');
    api('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
    if (!chatId || !aiEnabled()) return;
    await typing(chatId);
    try {
      const text = await aiFollowup(store, chatId, cb.data === 'tomorrow' ? 'tomorrow' : 'more');
      await send(chatId, esc(text));
    } catch (e) {
      log.error('[telegram] callback', e.message);
      await send(chatId, 'Завис. Спроси меня текстом, так надёжнее 🙂');
    }
  }

  /* ---- Long polling ---- */

  let running = true;
  let offset = 0;

  (async () => {
    log.log('[telegram] бот запущен (long polling)');
    api('setMyCommands', { commands: COMMANDS }).catch(() => {});
    while (running) {
      try {
        const res = await api('getUpdates', {
          offset,
          timeout: 25,
          allowed_updates: ['message', 'callback_query'],
        });
        if (!res.ok) throw new Error(res.description || 'getUpdates failed');
        for (const update of res.result) {
          offset = update.update_id + 1;
          // Ошибка одного update не должна ронять обработку остальных в пачке
          try {
            if (update.message) await onMessage(update.message);
            else if (update.callback_query) await onCallback(update.callback_query);
          } catch (e) {
            log.error('[telegram] update', update.update_id, e.message);
          }
        }
      } catch (e) {
        log.error('[telegram]', e.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();

  return {
    stop() {
      running = false;
    },
  };
}
