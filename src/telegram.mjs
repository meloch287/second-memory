// Telegram-бот «друг и дневник». Три команды: /start /help /summary.
// Всё остальное - живой разговор: сообщения падают в сырую базу,
// фоновый worker превращает их в факты, ИИ отвечает как близкий друг.

import { handleMessage, captureEntry } from './brain.mjs';
import {
  aiEnabled, audioEnabled, aiFriendReply, aiDiarySummary, aiFollowup,
  aiTranscribe, aiDescribeImage, audioFormatFromMime,
} from './ai.mjs';

const COMMANDS = [
  { command: 'summary', description: 'Итоги дня' },
  { command: 'help', description: 'Как со мной общаться' },
  { command: 'start', description: 'Поздороваться' },
  { command: 'reset', description: 'Стереть мою память и начать заново' },
];

// Повторный /start не сбрасывает бота - он просто здоровается. 20 вариантов.
const HELLO_AGAIN = [
  '{name}! Ну что у тебя сегодня произошло?',
  'О, {name}, ты вернулся! Как день прошёл?',
  '{name}, привет! Рассказывай, что нового?',
  'Мы уже знакомы, {name} 😄 Лучше расскажи, как твой день?',
  'Я всё помню, {name}. А вот что было у тебя сегодня - ещё нет. Делись!',
  '{name}, снова /start? Я никуда и не уходил 🙂 Что происходит у тебя?',
  'Привет-привет, {name}! Чем сегодня жил?',
  '{name}, я тут, я слушаю. Что случилось за день?',
  'Опять знакомиться не будем, {name} 😉 Просто расскажи, как ты?',
  'Рад тебя видеть, {name}! Что сегодня было интересного?',
  '{name}, ну наконец-то! Скучал. Рассказывай новости.',
  'Всё на месте, память со мной, {name}. Что запишем про сегодня?',
  '{name}, как настроение? Что за день выдался?',
  'Слушаю тебя, {name}. С чего начнём: дела или эмоции?',
  '{name}, я готов. Вываливай всё, что накопилось 🙂',
  'Что нового, {name}? Хоть одну хорошую новость давай!',
  '{name}, привет! Кто-нибудь сегодня тебя удивил?',
  'Я тут перечитывал наши записи, {name}. Ну а сегодня что было?',
  '{name}, день к вечеру - самое время рассказать, как он прошёл.',
  'Ну здравствуй ещё раз, {name} 😄 Что у тебя происходит?',
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

  // «Печатает…» держится, пока готовим ответ: Telegram гасит статус через
  // ~5 секунд, поэтому шлём его циклом до самой отправки сообщения.
  function typingLoop(chat_id) {
    const ping = () => api('sendChatAction', { chat_id, action: 'typing' }).catch(() => {});
    ping();
    const interval = setInterval(ping, 4500);
    return () => clearInterval(interval);
  }

  // Обёртка: держим «печатает…» на время асинхронной работы.
  async function withTyping(chat_id, work) {
    const stop = typingLoop(chat_id);
    try {
      return await work();
    } finally {
      stop();
    }
  }

  async function downloadBase64(file_id) {
    const info = await api('getFile', { file_id });
    if (!info.ok) throw new Error('getFile failed');
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
    if (!res.ok) throw new Error('file download failed');
    return Buffer.from(await res.arrayBuffer()).toString('base64');
  }

  /* ---- Онбординг: знакомство как с человеком ---- */

  function startOnboarding(chatId) {
    store.setUser(chatId, { step: 'botname' });
    return send(
      chatId,
      'Привет-привет! 👋\n\nЯ твоя вторая память и, кажется, твой новый друг. Буду запоминать всё, что ты мне пишешь: дела, долги, встречи, мысли.\n\nТолько я пока без имени. Придумаешь? Как меня назовёшь?',
      { reply_markup: { remove_keyboard: true } }
    );
  }

  function helloAgain(chatId, user) {
    const phrase = HELLO_AGAIN[Math.floor(Math.random() * HELLO_AGAIN.length)];
    return send(chatId, esc(phrase.replaceAll('{name}', user.name || 'дружище')));
  }

  async function onboardingStep(chatId, user, text) {
    const value = text.trim().slice(0, 100);
    if (user.step === 'botname') {
      store.setUser(chatId, { botName: value, step: 'name' });
      return send(chatId, `${esc(value)} - звучит! Так меня ещё никто не называл 😄\n\nА тебя как называть?`);
    }
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
        `Всё, теперь я в теме, ${esc(u.name || 'дружище')} 😉 ${u.botName ? esc(u.botName) + ' к твоим услугам.' : ''}\n\nПросто пиши мне как в дневник. Я слушаю: как прошёл твой день?`
      );
    }
  }

  /* ---- /reset: стереть личность и память ---- */

  function askReset(chatId, user) {
    const name = esc(user?.name || 'дружище');
    return send(
      chatId,
      `${name}, уверен, что хочешь убить меня?(( Сотрётся ВСЁ: моё имя, наше знакомство, вся память разговоров и все твои записи - долги, встречи, задачи. Появится новый друг, который тебя не знает.`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Нет, живи 🙂', callback_data: 'reset_no' },
              { text: 'Да, стереть всё', callback_data: 'reset_yes' },
            ],
          ],
        },
      }
    );
  }

  /* ---- Помощь: тепло и с цитатами ---- */

  function helpText(user) {
    const name = user?.name ? `, ${esc(user.name)}` : '';
    const signed = user?.botName ? ` Твой ${esc(user.botName)}.` : '';
    return [
      `Тут всё просто${name} 🙂${signed}`,
      '',
      '<blockquote>📖 Пиши мне как в личный дневник. «Планёрка прошла жёстко», «клиент должен 50 000 до пятницы», «завтра созвон в 10:00». Я всё запомню и разложу сам.</blockquote>',
      '',
      '<blockquote>💬 Спрашивай о чём угодно: «что у меня завтра?», «кто мне должен?», «о чём я писал в понедельник?». Отвечу по твоим записям.</blockquote>',
      '',
      '<blockquote>🎙 Лень печатать? Отправь голосовое или mp3 - расшифрую и пойму. Фото и стикеры тоже разгляжу.</blockquote>',
      '',
      '/summary - итоги дня. /reset - стереть мою память и завести нового друга (осторожно!). А я всегда здесь.',
    ].join('\n');
  }

  /* ---- Итоги дня с кнопками продолжения ---- */

  async function sendSummary(chatId) {
    if (!aiEnabled()) {
      return send(chatId, 'Мне нужен ключ ИИ для итогов (AI_API_KEY в .env). Пока могу просто слушать и запоминать.');
    }
    try {
      const text = await withTyping(chatId, () => aiDiarySummary(store, chatId));
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
    captureEntry(store, text, new Date(), chatId); // долги, встречи и задачи тихо ложатся в структурированную базу

    let reply;
    if (aiEnabled()) {
      try {
        reply = await withTyping(chatId, () => aiFriendReply(store, chatId, text));
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

  // Аудио любого вида: голосовое, mp3, аудиофайл документом.
  async function audioFlow(chatId, user, fileId, format, durationSec) {
    if (!audioEnabled()) {
      return send(chatId, 'Голосовые пока не разбираю: нет ключа для расшифровки. Напиши текстом, я всё пойму.');
    }
    if ((durationSec || 0) > 180) {
      return send(chatId, 'Ого, длинная запись. Дольше трёх минут не осилю. Можно покороче?');
    }
    const transcript = await withTyping(chatId, async () => {
      const b64 = await downloadBase64(fileId);
      return aiTranscribe(b64, format);
    });
    if (!transcript) {
      return send(chatId, 'Я честно слушал, но не расслышал. Скажи ещё раз?');
    }
    if (user?.step) return onboardingStep(chatId, user, transcript);
    await send(chatId, `🎙 «${esc(transcript)}»`);
    return friendFlow(String(chatId), transcript);
  }

  // Картинка (фото, статичный стикер, превью гифки): описываем и запоминаем.
  async function imageFlow(chatId, fileId, label, caption, mime = 'image/jpeg') {
    if (!audioEnabled()) {
      return send(chatId, 'Картинки пока не разглядываю: нет ключа мультимодального ИИ. Расскажи словами?');
    }
    let description;
    try {
      description = await withTyping(chatId, async () => {
        const b64 = await downloadBase64(fileId);
        return aiDescribeImage(b64, mime, caption || '');
      });
    } catch (e) {
      log.error('[telegram] image', e.message);
      return send(chatId, 'Разглядывал-разглядывал, но так и не понял, что там. Расскажешь словами?');
    }
    const text = `${label}: ${description}${caption ? `. Моя подпись: ${caption}` : ''}`;
    return friendFlow(String(chatId), text);
  }

  async function onMessage(msg) {
    const chatId = msg.chat.id;
    const user = store.getUser(String(chatId));

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
      return imageFlow(chatId, largest.file_id, '[Прислал фото]', msg.caption);
    }

    if (msg.animation) {
      const thumb = msg.animation.thumbnail || msg.animation.thumb;
      if (thumb) return imageFlow(chatId, thumb.file_id, '[Прислал гифку]', msg.caption);
      return send(chatId, 'Гифку получил, но разглядеть не смог 😅 Что там было?');
    }

    if (msg.sticker) {
      const s = msg.sticker;
      if (!s.is_animated && !s.is_video) {
        return imageFlow(chatId, s.file_id, '[Прислал стикер]', s.emoji || '', 'image/webp');
      }
      // анимированные стикеры не разглядеть - реагируем на эмоцию
      return friendFlow(String(chatId), `[Прислал стикер с эмоцией ${s.emoji || 'без подписи'}]`);
    }

    if (typeof msg.text !== 'string') return;
    const text = msg.text.trim();
    if (!text) return;

    const cmd = text.split(/[\s@]/)[0];
    if (cmd === '/start') {
      // повторный /start не сбрасывает друга - он просто здоровается
      if (user && !user.step) return helloAgain(String(chatId), user);
      return startOnboarding(String(chatId));
    }
    if (cmd === '/help') return send(chatId, helpText(user));
    if (cmd === '/summary') return sendSummary(String(chatId));
    if (cmd === '/reset') return askReset(String(chatId), user);

    if (!user) return startOnboarding(String(chatId)); // первое сообщение без /start - тоже знакомимся
    if (user.step) return onboardingStep(String(chatId), user, text);

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
      store.clearChatData(chatId);
      await send(chatId, 'Всё. Меня больше нет... а вот и я, новенький! 👋');
      return startOnboarding(chatId);
    }

    if (!aiEnabled()) return;
    try {
      const text = await withTyping(chatId, () =>
        aiFollowup(store, chatId, cb.data === 'tomorrow' ? 'tomorrow' : 'more')
      );
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
