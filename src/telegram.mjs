// Telegram-бот «друг и дневник» по имени Толик. Видимые команды: /start /help /settings /reset.
// Всё остальное - живой разговор: сообщения падают в сырую базу,
// фоновый worker превращает их в факты, ИИ отвечает как близкий друг.
//
// Файл разбит на кластеры-фабрики (тот же приём, что и group.mjs):
// telegram-helpers.mjs - чистые константы/хелперы без состояния;
// telegram-media.mjs   - скачивание/отправка файлов, аудио/видео/картинки;
// telegram-intents.mjs - роутер спец-намерений (handleIntent);
// telegram-router.mjs  - роутинг апдейтов (onMessage/onCallback).
// Здесь остаётся ядро: транспорт, онбординг, разговор, доставка ответа,
// и финальная сшивка всех кластеров через явные зависимости.

import {
  aiEnabled, audioEnabled, aiFriendReply, aiDiarySummary, aiTts, aiFitnessProgram,
  aiTranscribe, aiSummarizeText, audioFormatFromMime, aiLesson,
} from './ai.mjs';
import { handleMessage, captureEntry, entryConfirmation } from './brain.mjs';
import { captureStylePref } from './capabilities.mjs';
import { createIdPicker } from './telegram-idpicker.mjs';
import { createAudioChoice, isAudioFile, audioInfo } from './telegram-audio.mjs';
import { learnFromReaction } from './lessons.mjs';
import { buildIcs } from './ics.mjs';
import { parseTz, DEFAULT_OFFSET, userOffset, wall, fmtUser } from './tz.mjs';
import { tzFromCoords, cityFromCoords } from './weather.mjs';
import { createGroupHandler } from './group.mjs';
import { pickReaction, stickerMood } from './reactions.mjs';
import { createMediaHandlers } from './telegram-media.mjs';
import { createIntentHandler } from './telegram-intents.mjs';
import { createLkHandler } from './telegram-lk.mjs';
import { parseProduct, titleFromSlug } from './wlparse.mjs';
import { parseProductBrowser } from './wlparse-browser.mjs';
import { createMessageRouter } from './telegram-router.mjs';
import {
  COMMANDS, GROUP_COMMANDS, HELLO_AGAIN, esc, isConfusedReply,
  STEP_EXPLAIN, FALLBACKS, SLEEP_FIRST, SLEEP_AGAIN, WAKE_PREFIX, LOW_MOOD_RE,
} from './telegram-helpers.mjs';

// Реэкспорт для тестов (test/brain.test.mjs импортирует isConfusedReply отсюда).
export { isConfusedReply } from './telegram-helpers.mjs';

export function startTelegramBot(store, token, log = console) {
  if (!token) return null;

  // Таймаут на каждый запрос к Telegram: без него зависший вызов (медленный
  // прокси) стопорил бота молча. getUpdates - длинный (long poll), остальное
  // короткое. Аборт роняет вызов, а цикл/обработчик ловит и продолжает.
  // Сеть до Telegram рвётся: node переиспользует keep-alive соединение, а фронт
  // его закрывает - первая же попытка падает с «fetch failed». В логах это было
  // ~14 раз в час: long polling переподключался (бот «тормозил»), а сообщения
  // из flow терялись совсем. Поэтому сетевые сбои переигрываем сами.
  const NET_ERR = /fetch failed|ECONNRESET|socket hang up|ETIMEDOUT|EPIPE|ENOTFOUND|other side closed|terminated/i;
  const apiOnce = async (method, params, timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify(params),
      });
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  };
  const api = async (method, params) => {
    const timeoutMs = method === 'getUpdates' ? 35000 : 15000;
    // getUpdates переигрывать не нужно - его цикл сам сделает следующий заход
    const tries = method === 'getUpdates' ? 1 : 3;
    let lastError;
    for (let i = 0; i < tries; i++) {
      try {
        return await apiOnce(method, params, timeoutMs);
      } catch (e) {
        lastError = e;
        const cause = e?.cause?.message || '';
        if (!NET_ERR.test(e?.message || '') && !NET_ERR.test(cause)) throw e;
        if (i < tries - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
    throw lastError;
  };

  // Топики форум-групп: пока обрабатывается сообщение из темы, все ответы
  // уходят в неё же (очередь per-chat последовательная, гонок нет).
  const activeThread = new Map(); // chatKey -> message_thread_id
  const threadExtra = (chat_id) => {
    const th = activeThread.get(String(chat_id));
    return th ? { message_thread_id: th } : {};
  };

  const send = (chat_id, text, extra = {}) =>
    api('sendMessage', {
      chat_id,
      text: String(text).slice(0, 4000),
      parse_mode: 'HTML',
      ...threadExtra(chat_id),
      ...extra,
    });

  // Текст с инлайн-клавиатурой, экранированный целиком (для вызывающих,
  // которые сами не думают про HTML - scheduler.mjs, telegram-lk.mjs).
  const sendButtons = (chatId, text, inline_keyboard) => send(chatId, esc(text), { reply_markup: { inline_keyboard } });

  /* ---- Реакции и выученные стикеры (№8) ---- */

  // Ставим эмодзи-реакцию на сообщение по настроению (fire-and-forget).
  function maybeReact(chatId, messageId, text) {
    const emoji = pickReaction(text);
    if (!emoji || !messageId) return;
    api('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
    }).catch(() => {});
  }

  // Библиотека стикеров, выученных у собеседников: emoji -> [file_id]
  function learnSticker(s) {
    if (!s?.file_id || !s.emoji) return;
    const lib = { ...(store.data.meta.stickerLib || {}) };
    const arr = lib[s.emoji] || [];
    if (arr.includes(s.file_id)) return;
    lib[s.emoji] = [...arr, s.file_id].slice(-10);
    store.data.meta.stickerLib = lib;
    store.save();
  }

  // Иногда докидываем выученный стикер под настроение (после текста ответа).
  async function maybeSticker(chatId, userText) {
    const moods = stickerMood(userText);
    if (!moods) return;
    const lib = store.data.meta.stickerLib || {};
    for (const emoji of moods) {
      const arr = lib[emoji];
      if (arr?.length) {
        const form = new FormData();
        form.append('chat_id', String(chatId));
        const th = activeThread.get(String(chatId));
        if (th) form.append('message_thread_id', String(th));
        form.append('sticker', arr[Math.floor(Math.random() * arr.length)]);
        await fetch(`https://api.telegram.org/bot${token}/sendSticker`, { method: 'POST', body: form }).catch(() => {});
        return;
      }
    }
  }

  /* ---- «Сон» при недоступном ИИ ---- */
  const sleepAnnounced = new Set();
  function sleepyText(chatId) {
    const key = String(chatId);
    if (sleepAnnounced.has(key)) return SLEEP_AGAIN;
    sleepAnnounced.add(key);
    return SLEEP_FIRST;
  }
  function withWake(chatId, reply) {
    return sleepAnnounced.delete(String(chatId)) ? WAKE_PREFIX + reply : reply;
  }

  // «Печатает…» держится, пока готовим ответ: Telegram гасит статус через
  // ~5 секунд, поэтому шлём его циклом до самой отправки сообщения.
  function typingLoop(chat_id, action = 'typing') {
    const ping = () => api('sendChatAction', { chat_id, action, ...threadExtra(chat_id) }).catch(() => {});
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

  // Толик - постоянное имя бота в личных чатах (U0). Пустой или устаревший
  // botName (например, 'Вторая память' - имя веб-ассистента) подменяем
  // Толиком, чтобы и старые профили без имени видели того же друга.
  function botNameOf(user) {
    return user?.botName && user.botName !== 'Вторая память' ? user.botName : 'Толик';
  }

  /* ---- Онбординг: знакомство как с человеком ---- */

  function startOnboarding(chatId) {
    store.setUser(chatId, { botName: 'Толик', step: 'name' });
    return send(
      chatId,
      'Привет! Я Толик, твой ассистент и, считай, друг. Буду запоминать всё, что ты мне пишешь: дела, долги, встречи, мысли.\n\nА тебя как зовут?',
      { reply_markup: { remove_keyboard: true } }
    );
  }

  function helloAgain(chatId, user) {
    const phrase = HELLO_AGAIN[Math.floor(Math.random() * HELLO_AGAIN.length)];
    return send(chatId, esc(phrase.replaceAll('{name}', user.name || 'дружище')));
  }

  async function onboardingStep(chatId, user, text) {
    const value = text.trim().slice(0, 100);

    // Встречный вопрос - объясняем и переспрашиваем, ничего не сохраняя
    if (isConfusedReply(value)) {
      return send(chatId, esc(STEP_EXPLAIN[user.step] || STEP_EXPLAIN.name));
    }
    // Имя из целого предложения - вероятно, это не имя
    if (user.step === 'name' && (value.length > 30 || value.split(/\s+/).length > 3)) {
      return send(chatId, 'Хм, длинновато для имени 🙂 Давай короче. Как тебя называть?');
    }

    if (user.step === 'name') {
      store.setUser(chatId, { name: value, step: 'tz' });
      // Подтверждаем имя явно — иначе переход сразу к геолокации выглядит как
      // «бот не увидел имя», и юзер вводит имя снова (оно уходило в «город»).
      return askLocation(chatId, `Приятно, ${esc(value)}! `);
    }
    if (user.step === 'tz') {
      // Повторно ввели имя (думая, что бот его не принял) — не пишем его в город.
      const norm = (x) => String(x || '').toLowerCase().replace(/ё/g, 'е').trim();
      if (norm(value) === norm(user.name)) return askLocation(chatId, `Имя уже запомнил, ${esc(user.name)} 🙂 Теперь про город — `);
      // ответ текстом (город или сдвиг); геолокация ловится отдельно (locationFlow)
      const off = parseTz(value);
      const looksLikeCity = /[а-яa-z]/i.test(value) && !/[+\-−]\s*\d/.test(value) && value.length <= 40;
      store.setUser(chatId, { tzOffset: off ?? DEFAULT_OFFSET, city: looksLikeCity ? value : null, step: 'goal' });
      const tzNote = off == null ? ' Пояс не понял, поставил московский - потом поправим.' : '';
      return send(chatId, `Принял.${tzNote}\n\nИ последнее: что у тебя сейчас главное в жизни? Работа, учёба или просто кайфуешь?`, {
        reply_markup: { remove_keyboard: true },
      });
    }
    if (user.step === 'goal') {
      const u = store.setUser(chatId, { goal: value, step: null });
      return send(
        chatId,
        `Всё, теперь я в теме, ${esc(u.name || 'дружище')} 😉 ${esc(botNameOf(u))} к твоим услугам.\n\nПросто пиши мне как в дневник. Как прошёл твой день?`,
        { reply_markup: { remove_keyboard: true } }
      );
    }
  }

  function askLocation(chatId, prefix = '') {
    return send(
      chatId,
      `${prefix}Чтобы напоминать в твоё время и показывать погоду - нажми «📍 Отправить геолокацию» (определю пояс и город сам). Или просто напиши город / сдвиг вроде «+3».`,
      {
        reply_markup: {
          keyboard: [[{ text: '📍 Отправить геолокацию', request_location: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      }
    );
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
    const signed = ` Твой ${esc(botNameOf(user))}.`;
    return [
      `Тут всё просто${name} 🙂${signed}`,
      '',
      '<blockquote>📖 Пиши мне как в личный дневник. «Планёрка прошла жёстко», «клиент должен 50 000 до пятницы», «завтра созвон в 10:00». Я всё запомню и разложу сам.</blockquote>',
      '',
      '<blockquote>⏰ Напоминания: «напомни в 15:00 позвонить маме» - и я звякну ровно в это время. «Каждый понедельник созвон в 10:00» - буду напоминать регулярно. «Перенеси встречу на 16:00» или «отмени звонок» - подвину или уберу.</blockquote>',
      '',
      '<blockquote>💬 Спрашивай что угодно: «что у меня завтра?», «баланс» (долги), «траты», «курс доллара», «у Димы др 15 августа» - поздравлю сам, «найди про Петрова». «Скинь в календарь» - файл для календаря телефона. «Экспорт» - вся память (CSV, дневник, JSON).</blockquote>',
      '',
      '<blockquote>💸 Трать словами: «потратил 500 на кофе» - учту. «Бюджет на кофе 5000» - слежу за лимитом («бюджеты» - прогресс). Кинь фото чека - распознаю сумму сам. Поправить память: «забудь про Петрова» или «это не так».</blockquote>',
      '',
      '<blockquote>🎙 «Отвечай голосом» - буду отвечать войсами, «отвечай текстом» - обратно. Пишешь на другом языке - отвечу на нём.</blockquote>',
      '',
      '<blockquote>🎙 Голосовое или кружок - расшифрую и сразу отвечу. А если кинешь аудиофайл (mp3, m4a, wav) - спрошу, что сделать: 📝 транскрипцию или 🧾 саммари. Фото, стикеры и документы (PDF, DOCX) тоже пойму.</blockquote>',
      '',
      '<blockquote>⚙️ «Настройки» покажут всё про тебя. Пришли геолокацию - сам определю часовой пояс и город. «Напоминай за 30 минут», «мой город Казань» - тоже подстрою. По утрам расскажу про дела и погоду.</blockquote>',
      '',
      `<blockquote>🗣 Как я говорю: по-простому, как свой, со сленгом и без канцелярита - но без мата. Хочешь пожёстче - скажи «${esc(botNameOf(user))}, включи мат», и буду материться. Выключить - «не общайся матом». Нужен деловой тон - «общайся официально». Ещё понимаю «называй меня братан», «не называй меня по имени» и «не задавай встречных вопросов».</blockquote>`,
      '',
      '/reset - стереть мою память и завести нового друга (осторожно!). А я всегда здесь.',
    ].join('\n');
  }

  /* ---- Итоги дня с кнопками продолжения ---- */

  async function sendSummary(chatId) {
    if (!aiEnabled()) {
      return send(chatId, 'Мне нужен ключ ИИ для итогов (AI_API_KEY в .env). Пока могу просто слушать и запоминать.');
    }
    try {
      const text = withWake(chatId, await withTyping(chatId, () => aiDiarySummary(store, chatId)));
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
      return send(chatId, esc(sleepyText(chatId)));
    }
  }

  /* ---- Мелкие хелперы, нужные роутеру намерений (telegram-intents.mjs) ---- */

  const kindOf = (t) => { const w = { debt: 'долг', meeting: 'встреча', task: 'задача', note: 'заметка' }; return w[t] || 'запись'; };

  function settingsText(user) {
    const lead = Number.isFinite(user?.remindLead) ? user.remindLead : 15;
    const offH = userOffset(user) / 60;
    return [
      '⚙️ Твои настройки:',
      '',
      `Имя: ${esc(user?.name || '-')}`,
      `Моё имя: ${esc(botNameOf(user))}`,
      `Ритм: ${esc(user?.rhythm || '-')}`,
      `Город: ${esc(user?.city || 'не задан')}`,
      `Часовой пояс: UTC${offH >= 0 ? '+' : ''}${offH}`,
      `Напоминаю за: ${lead} мин до дела`,
      '',
      'Поменять: пришли геолокацию (определю пояс и город сам), «напоминай за 30 минут», «мой город Казань», «часовой пояс +5», /start - сменить имя.',
    ].join('\n');
  }

  /* ---- Будущие события и календарь телефона ---- */

  // Будущие события пользователя (встречи и задачи со временем), свежие тоже.
  function upcomingEvents(chatId, withinDays = null) {
    const now = Date.now();
    const to = withinDays ? now + withinDays * 86400000 : Infinity;
    return store
      .list({ status: 'open', chatId })
      .filter((e) => e.due && (e.type === 'meeting' || (e.type === 'task' && e.hasTime)))
      .filter((e) => Date.parse(e.due) >= now - 86400000 && Date.parse(e.due) <= to);
  }

  // Подпись к .ics - пошагово, что делать с файлом: без неё юзер получает
  // документ и не понимает, куда его девать (реальная жалоба).
  const ICS_CAPTION = [
    '📅 Файл с твоими событиями',
    '',
    'Что делать дальше:',
    '1. Нажми на файл выше - откроется просмотр',
    '2. Кнопка «Поделиться» (квадрат со стрелкой)',
    '3. Выбери «Календарь» → «Добавить все»',
    '',
    'Это разовый снимок - новые события сюда уже не попадут. Чтобы календарь обновлялся сам, подключи подписку: ЛК → Календарь → Подключение.',
  ].join('\n');

  async function sendIcs(chatId, events, filename = 'raspisanie.ics') {
    const ics = buildIcs(events, new Date().toISOString());
    const form = new FormData();
    form.append('chat_id', String(chatId));
    const _th = activeThread.get(String(chatId));
    if (_th) form.append('message_thread_id', String(_th));
    form.append('document', new Blob([ics], { type: 'text/calendar' }), filename);
    form.append('caption', ICS_CAPTION);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
    return res.json();
  }

  // Проактивно предлагаем календарь телефона, когда записали встречу или
  // задачу со временем. Не чаще раза в 20 минут, чтобы не надоедать.
  async function maybeOfferCalendar(chatId, user, entry) {
    if (!entry || !entry.due) return;
    const calendarable = entry.type === 'meeting' || (entry.type === 'task' && entry.hasTime);
    if (!calendarable) return;
    const last = user?.lastCalOffer || 0;
    if (Date.now() - last < 20 * 60000) return;
    store.setUser(chatId, { lastCalOffer: Date.now() });
    const off = userOffset(user);
    await send(chatId, `Закинуть в календарь телефона? «${esc(entry.title || entry.counterparty || 'событие')}» - ${esc(fmtUser(entry.due, off, entry.hasTime))}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📅 Это событие', callback_data: `cal_one_${entry.id}` }, { text: '📅 Всё расписание', callback_data: 'cal_all' }],
          [{ text: 'Не надо', callback_data: 'cal_no' }],
        ],
      },
    });
  }

  // Ответ: голосом (если просили/включено) или текстом. one-shot флаг гасим.
  async function deliver(chatId, replyText, user) {
    const wantVoice = audioEnabled() && (user?.voiceReplies || user?.voiceNext);
    if (user?.voiceNext) store.setUser(String(chatId), { voiceNext: false });
    if (wantVoice) {
      const stop = typingLoop(chatId, 'record_voice');
      try {
        const ogg = await aiTts(replyText);
        const r = await sendVoice(chatId, ogg); // чистый войс, без текста-транскрибации
        if (r.ok) return;
      } catch (e) {
        log.error('[telegram] tts', e.message);
      } finally {
        stop();
      }
    }
    return send(chatId, esc(replyText));
  }

  /* ---- Обычный разговор ---- */

  async function friendFlow(chatId, text) {
    store.addRaw(chatId, text);
    const user = store.getUser(String(chatId));
    // фиксируем тяжёлый день для вечернего check-in'а
    if (LOW_MOOD_RE.test(text.toLowerCase().replace(/ё/g, 'е'))) {
      const w = wall(user, new Date());
      store.setUser(String(chatId), { lastLowMoodDay: `${w.getUTCFullYear()}-${w.getUTCMonth()}-${w.getUTCDate()}` });
    }

    if (!aiEnabled()) {
      // Без ИИ разговор ведёт route()/handleMessage — он САМ структурно сохраняет
      // долг/встречу/задачу (saveEntry) и возвращает её в out.entry. Отдельный
      // captureEntry тут НЕ зовём: иначе одна и та же фраза ляжет в базу дважды
      // (дубль с новым id, но тем же title/type/due).
      const out = await handleMessage(store, text, new Date(), String(chatId));
      const reply = out.reply || FALLBACKS[Math.floor(Date.now() / 60000) % FALLBACKS.length];
      await deliver(chatId, reply, store.getUser(String(chatId)));
      // Календарь предлагаем только для СВЕЖЕсохранённой открытой записи:
      // out.entry возвращают и «готово N»/«удали N» (закрытая/стёртая запись).
      const saved = out.entry && store.byId(out.entry.id)?.status === 'open' ? out.entry : null;
      await maybeOfferCalendar(String(chatId), store.getUser(String(chatId)), saved);
      return;
    }

    // Просьбы про стиль общения («называй меня братан», «давай официально»,
    // «можешь материться», «не делай X») сохраняем ДО генерации ответа - тогда
    // бот сразу отвечает уже в новом стиле, а не со следующего сообщения.
    captureStylePref(store, String(chatId), text);
    // Самообучение: человек недоволен или диктует правило - вытаскиваем урок из
    // предыдущей пары «ответ бота -> реакция» и запоминаем ЭТОМУ чату.
    void learnFromReaction({ store, log, aiLesson, chatId: String(chatId), text, enabled: aiEnabled() });

    // С ИИ живой ответ даёт модель, а долги/встречи/задачи тихо ложатся в базу
    // здесь (route не вызываем) — с учётом часового пояса пользователя.
    const captured = captureEntry(store, text, new Date(), chatId, userOffset(user));
    let reply;
    try {
      reply = await withTyping(chatId, () => aiFriendReply(store, chatId, text));
    } catch (e) {
      log.error('[telegram] friend', e.message);
    }
    if (!reply) {
      // ИИ недоступен, но долг/встречу/задачу мы уже сохранили — подтверждаем это,
      // иначе юзер думает, что запись не прошла, и вводит её повторно (дубль).
      const note = captured ? ' ' + entryConfirmation(captured, userOffset(user)) : '';
      return send(chatId, esc(sleepyText(chatId) + note));
    }
    reply = withWake(chatId, reply);
    store.pushHistory('user', text, String(chatId));
    store.pushHistory('assistant', reply, String(chatId));
    await deliver(chatId, reply, store.getUser(String(chatId)));
    await maybeSticker(chatId, text); // иногда - выученный стикер под настроение
    await maybeOfferCalendar(String(chatId), store.getUser(String(chatId)), captured);
  }

  /* ---- Геолокация ---- */

  // Геолокация -> часовой пояс и город (для напоминаний и погоды).
  async function locationFlow(chatId, user, loc) {
    const [off, city] = await Promise.all([tzFromCoords(loc.latitude, loc.longitude), cityFromCoords(loc.latitude, loc.longitude)]);
    const patch = {};
    if (Number.isFinite(off)) patch.tzOffset = off;
    if (city) patch.city = city;
    const wasOnboarding = user?.step === 'tz';
    if (wasOnboarding) patch.step = 'goal'; // после локации спросим про цель
    store.setUser(String(chatId), patch);
    const parts = [];
    if (city) parts.push(`Город: ${esc(city)}`);
    if (Number.isFinite(off)) parts.push(`пояс UTC${off >= 0 ? '+' : ''}${off / 60}`);
    const line = parts.length ? `Поймал: ${parts.join(', ')}. ` : 'Не смог разобрать локацию, ну да ладно. ';
    if (wasOnboarding) {
      return send(chatId, `${line}И последнее: что у тебя сейчас главное в жизни? Работа, учёба или просто кайфуешь?`, {
        reply_markup: { remove_keyboard: true },
      });
    }
    return send(chatId, `${line}Буду напоминать в твоё время и показывать погоду 🙂`, { reply_markup: { remove_keyboard: true } });
  }

  /* ---- Сшивка вынесенных кластеров: media / intents / group / router ----
   * media.audioFlow гонит расшифровку через router.routeText (голос = текст:
   * тот же маршрут онбординг → ЛК → интенты → разговор), а роутер создаётся
   * ПОЗЖЕ media (ему нужны audioFlow/imageFlow) - циклическая зависимость.
   * Ссылка через `let` держит её живой: к моменту реального вызова (уже во
   * время работы бота) routeText назначен настоящей функцией роутера,
   * обёртка лишь пробрасывает аргументы. */
  let routeText = null;

  const media = createMediaHandlers({
    token, api, activeThread, store, send, log, withTyping, friendFlow,
    routeText: (chatId, user, text) => routeText(chatId, user, text),
  });
  const downloadBase64 = media.downloadBase64;
  const sendPhoto = media.sendPhoto;
  const sendVoice = media.sendVoice;
  const sendDocumentText = media.sendDocumentText;
  const readDoc = media.readDoc;
  const videoTranscript = media.videoTranscript;
  const transcribeLong = media.transcribeLong;
  const audioFlow = media.audioFlow;
  const imageFlow = media.imageFlow;

  const intents = createIntentHandler({
    api, send, store, log, kindOf, withTyping, sleepyText, typingLoop, sendPhoto, settingsText, upcomingEvents,
  });
  const handleIntent = intents.handleIntent;

// Аудиофайл (mp3/m4a/wav, не голосовое) - спрашиваем: расшифровка или саммари.
  const audioChoice = createAudioChoice({
    send, withTyping, log,
    transcribe: async (card) => {
      const b64 = await downloadBase64(card.fileId);
      const fmt = audioFormatFromMime(card.mime || '') || 'mp3';
      return (card.duration || 0) > 170 ? transcribeLong(b64, fmt) : aiTranscribe(b64, fmt);
    },
    summarize: (text, title) => aiSummarizeText(text, title || 'аудио'),
    // расшифровка всё равно ложится в память - как обычный рассказ
    onTranscript: (chatId, text) => { try { store.addRaw(String(chatId), text.slice(0, 4000)); } catch {} },
  });

  const { groupFlow, isGroupChat, callerIsAdmin } = createGroupHandler({
    api, send, esc, store, log, withTyping, handleIntent, sendSummary, askReset, readDoc, downloadBase64, sleepyText, maybeReact, deliver,
    audioChoice, isAudioFile, audioInfo,
  });

  // Личный кабинет (U3a-ui статистика+долги, U3c-ui вишлист): текст+кнопки.
  // sendPhoto для вишлиста не переиспользует media.sendPhoto (тот только для
  // локальных PNG-буферов графиков) - карточки товара шлются по URL через api()
  // напрямую (sendPhoto в Bot API принимает как файл, так и http/https-строку).
  // Двухступенчатый разбор ссылки вишлиста: сначала быстрый zero-dep fetch;
  // если не вышло или добыли только слаг без фото - пробуем реальным браузером
  // (Playwright, если установлен на сервере). Я.Маркет/JS-магазины браузер берёт;
  // Ozon/WB режут по IP и в браузере -> оба ok:false -> ЛК уходит на ручной ввод.
  const parseProductSmart = async (url) => {
    const fast = await parseProduct(url);
    if (fast.ok && fast.title && Array.isArray(fast.photos) && fast.photos.length) return fast;
    let viaBrowser = null;
    try { viaBrowser = await parseProductBrowser(url); } catch { viaBrowser = null; }
    if (viaBrowser && viaBrowser.ok && viaBrowser.title) return viaBrowser;
    if (fast.ok && fast.title) return fast; // слаг из fetch-пути (напр. капча-retpath)
    // Последний шанс: имя из слага URL. Ozon режет антиботом даже РФ-IP - но имя
    // товара из ссылки лучше пустого отказа (юзер дозаполнит фото/цену вручную).
    const slug = titleFromSlug(url);
    if (slug) {
      let source = null;
      try { source = new URL(url).hostname.replace(/^www\./i, ''); } catch {}
      return { ok: true, url, title: slug, description: null, photos: [], price: null, source };
    }
    return fast.ok ? fast : viaBrowser || fast;
  };
  const publicUrl = process.env.PUBLIC_BASE_URL || 'https://secondmemory.103.88.241.202.sslip.io';
  const lk = createLkHandler({ store, send, sendButtons, api, botNameOf, log, withTyping, aiFitnessProgram, sendIcs, publicUrl, parseProduct: parseProductSmart });

  // Секретная пипетка ID (стикеры и премиум-эмодзи) - команда /id.
  const idPicker = createIdPicker({ send, api, log });


  const router = createMessageRouter({
    api, send, store, log, activeThread, withTyping, withWake, sleepyText,
    isGroupChat, groupFlow, callerIsAdmin,
    locationFlow, audioFlow, imageFlow, videoTranscript, downloadBase64, readDoc,
    onboardingStep, handleIntent, friendFlow, learnSticker, maybeReact,
    helpText, sendSummary, askReset, startOnboarding, helloAgain,
    upcomingEvents, sendIcs, sendDocumentText, lk, idPicker, audioChoice, isAudioFile, audioInfo,
  });
  const onMessage = router.onMessage;
  const onCallback = router.onCallback;
  routeText = router.routeText; // замыкает цикл media -> routeText (см. комментарий выше)

  /* ---- Long polling ---- */

  let running = true;
  let offset = 0;

  // Очередь на каждый чат: внутри чата сообщения обрабатываются по порядку,
  // но один зависший ответ не блокирует остальные чаты и приём апдейтов.
  const chatQueues = new Map();
  // Команды, которые не ходят в ИИ и не зависят от порядка сообщений.
  const FAST_CMD = /^\/(?:settings|help|start|admin|id|stickerid|emojiid|ids|reset)(?:@\w+)?\s*$/i;
  const isFastCommand = (msg) =>
    msg?.chat?.type === 'private' && typeof msg.text === 'string' && FAST_CMD.test(msg.text.trim());

  // Мимо очереди, но с тем же логом ошибок.
  function runNow(chatKey, work) {
    Promise.resolve()
      .then(work)
      .catch((e) => log.error('[telegram] flow', chatKey, e.message));
  }

  function enqueue(chatKey, work) {
    const prev = chatQueues.get(chatKey) || Promise.resolve();
    const queued = Date.now();
    const next = prev
      // очередь на чат последовательная: медленный ИИ-ответ задерживает
      // следующее нажатие кнопки. Без замера это выглядит как «бот завис»
      .then(async () => {
        const started = Date.now();
        const r = await work();
        const wait = started - queued;
        const took = Date.now() - started;
        if (wait + took > 5000) log.log(`[telegram] чат ${chatKey}: ожидание ${wait}мс, обработка ${took}мс`);
        return r;
      })
      .catch((e) => log.error('[telegram] flow', chatKey, e.message))
      .finally(() => {
        if (chatQueues.get(chatKey) === next) chatQueues.delete(chatKey);
      });
    chatQueues.set(chatKey, next);
  }

  (async () => {
    log.log('[telegram] бот запущен (long polling)');
    api('setMyCommands', { commands: COMMANDS }).catch(() => {});
    // в группах меню другое: /summary вместо ЛК
    api('setMyCommands', { commands: GROUP_COMMANDS, scope: { type: 'all_group_chats' } }).catch(() => {});
    // узнаём свой @username - нужен вебу для deep-link «Подключить Telegram»
    api('getMe', {}).then((me) => {
      if (me?.ok && me.result?.username && store.data.meta.botUsername !== me.result.username) {
        store.data.meta.botUsername = me.result.username;
        store.save();
      }
    }).catch(() => {});
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
          const chatKey = String(
            update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? 'unknown'
          );
          // Очередь на чат последовательная - иначе разговор путается. Но
          // ЛК, кнопки и служебные команды - это чистая локальная работа
          // (200-400мс), и стоять 11 секунд за ответом ИИ им незачем: именно
          // так «/settings шёл миллион лет». Пускаем их мимо очереди.
          // Только в личке: в группах порядок и тема сообщения важнее.
          if (update.callback_query) {
            const cb = update.callback_query;
            if (cb.message?.chat?.type === 'private') runNow(chatKey, () => onCallback(cb));
            else enqueue(chatKey, () => onCallback(cb));
          } else if (update.message) {
            if (isFastCommand(update.message)) runNow(chatKey, () => onMessage(update.message));
            else enqueue(chatKey, () => onMessage(update.message));
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
    sendText(chatId, text) {
      return send(chatId, esc(text));
    },
    // Для сообщений с готовой HTML-разметкой (теги-упоминания): вызывающий
    // сам отвечает за экранирование пользовательского текста внутри.
    sendHtml(chatId, html) {
      return send(chatId, html);
    },
    sendButtons,
  };
}
