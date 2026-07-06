// Telegram-бот «друг и дневник». Три команды: /start /help /summary.
// Всё остальное - живой разговор: сообщения падают в сырую базу,
// фоновый worker превращает их в факты, ИИ отвечает как близкий друг.

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMessage, captureEntry } from './brain.mjs';
import {
  aiEnabled, audioEnabled, aiFriendReply, aiDiarySummary, aiFollowup,
  aiTranscribe, aiDescribeImage, audioFormatFromMime, aiTts,
  aiSummarizeDoc, aiSummarizeText,
} from './ai.mjs';
import { extractDocxText } from './docx.mjs';
import { buildIcs } from './ics.mjs';
import { parseTz, DEFAULT_OFFSET, userOffset, wall, fmtUser, resolveWallDate, combineDayTime } from './tz.mjs';
import { aiSearch } from './ai.mjs';
import { parseMessage } from './parser.mjs';

// ffmpeg нужен только для кружков (video note) - вытащить аудиодорожку
const hasFfmpeg = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

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

// Ответ на шаге знакомства похож на встречный вопрос или непонимание,
// а не на само значение. Кириллица: без \b, только includes/startsWith.
export function isConfusedReply(text) {
  const t = String(text).toLowerCase().replace(/ё/g, 'е').trim();
  if (/\?\s*$/.test(t)) return true;
  const starts = ['что', 'чего', 'зачем', 'почему', 'как это', 'в смысле', 'не понял', 'не понимаю', 'а это'];
  if (starts.some((s) => t.startsWith(s))) return true;
  return t.includes('что значит') || t.includes('что это') || t.includes('не знаю что');
}

// Живые объяснения каждого вопроса знакомства + повтор вопроса.
const STEP_EXPLAIN = {
  botname:
    'А, это я про имя для себя 🙂 Ты будешь так ко мне обращаться, а я - подписываться. Подойдёт любое: Барни, Джарвис, Братан, хоть Пельмень.\n\nТак как меня назовёшь?',
  name: 'Всё просто: скажи, как к тебе обращаться. Имя или прозвище, как удобно.\n\nТак как тебя называть?',
  rhythm:
    'Жаворонок - это кто рано встаёт и с утра полон сил. Сова - кто оживает к вечеру и сидит допоздна. Мне это нужно, чтобы понимать твой день.\n\nТак ты кто: жаворонок или сова?',
  goal:
    'Я спрашиваю, что сейчас занимает большую часть твоей жизни: работа, учёба, семья, спорт, отдых. Так мне проще понимать твои записи.\n\nЧто у тебя сейчас главное?',
  tz: 'Часовой пояс нужен, чтобы будить и напоминать в твоё время, а не в моё. Напиши свой город (Москва, Екатеринбург, Новосибирск...) или сдвиг вроде «+3», «мск+2».\n\nВ каком ты поясе?',
};

const FALLBACKS = [
  'Слушай, я сегодня что-то туплю. Скажи ещё раз чуть иначе?',
  'Кажется, я задумался и прослушал. Повтори, пожалуйста?',
  'У меня сейчас туман в голове. Напиши ещё раз, я соберусь.',
];

const SLEEP_FIRST = 'Я устал... Пойду прилягу, поэтому пока не буду отвечать 😴';
const SLEEP_AGAIN = 'Всё ещё сплю... 😴';
const WAKE_PREFIX = 'Так, я выспался! 😄\n\n';

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
  function typingLoop(chat_id, action = 'typing') {
    const ping = () => api('sendChatAction', { chat_id, action }).catch(() => {});
    ping();
    const interval = setInterval(ping, 4500);
    return () => clearInterval(interval);
  }

  // Отправка голосового: multipart, JSON тут не работает.
  async function sendVoice(chat_id, oggBuffer, caption) {
    const form = new FormData();
    form.append('chat_id', String(chat_id));
    form.append('voice', new Blob([oggBuffer], { type: 'audio/ogg' }), 'reply.ogg');
    if (caption) form.append('caption', String(caption).slice(0, 1000));
    const res = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, { method: 'POST', body: form });
    return res.json();
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

    // Встречный вопрос - объясняем и переспрашиваем, ничего не сохраняя
    if (isConfusedReply(value)) {
      return send(chatId, esc(STEP_EXPLAIN[user.step] || STEP_EXPLAIN.name));
    }
    // Имя из целого предложения - вероятно, это не имя
    if ((user.step === 'botname' || user.step === 'name') && (value.length > 30 || value.split(/\s+/).length > 3)) {
      return send(
        chatId,
        `Хм, длинновато для имени 🙂 Давай короче. ${user.step === 'botname' ? 'Как меня назовёшь?' : 'Как тебя называть?'}`
      );
    }

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
      return send(chatId, 'Запомнил. Что у тебя сейчас главное в жизни? Работа, учёба или просто кайфуешь?');
    }
    if (user.step === 'goal') {
      store.setUser(chatId, { goal: value, step: 'tz' });
      return send(chatId, 'И последнее: в каком ты часовом поясе? Напиши город (например, Москва или Новосибирск) или сдвиг вроде «+3». Это чтобы напоминания приходили вовремя.');
    }
    if (user.step === 'tz') {
      const off = parseTz(value);
      const u = store.setUser(chatId, { tzOffset: off ?? DEFAULT_OFFSET, step: null });
      const tzNote = off == null ? ' Часовой пояс не понял, поставил московский - потом поправим, если что.' : '';
      return send(
        chatId,
        `Всё, теперь я в теме, ${esc(u.name || 'дружище')} 😉 ${u.botName ? esc(u.botName) + ' к твоим услугам.' : ''}${tzNote}\n\nПросто пиши мне как в дневник. Я слушаю: как прошёл твой день?`
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
      '<blockquote>⏰ Напоминания: «напомни в 15:00 позвонить маме» - и я звякну ровно в это время. «Каждый понедельник созвон в 10:00» - буду напоминать регулярно. «Перенеси встречу на 16:00» или «отмени звонок» - подвину или уберу.</blockquote>',
      '',
      '<blockquote>💬 Спрашивай что угодно: «что у меня завтра?», «кто мне должен?». А «найди про Петрова» или «что я говорил про отпуск» - поищу в памяти. «Скинь в календарь» - пришлю файл для календаря телефона.</blockquote>',
      '',
      '<blockquote>🎙 Лень печатать? Отправь голосовое, кружок или mp3 - расшифрую и отвечу голосом. Фото, стикеры и документы (PDF, DOCX) тоже пойму.</blockquote>',
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

  /* ---- Спец-намерения: правки, повторы, поиск, календарь ---- */

  const kindOf = (t) => { const w = { debt: 'долг', meeting: 'встреча', task: 'задача', note: 'заметка' }; return w[t] || 'запись'; };

  // Возвращает true, если сообщение обработано как спец-намерение.
  async function handleIntent(chatId, user, text) {
    const p = parseMessage(text, wall(user));

    if (p.kind === 'edit') {
      const e = store.findEntry(String(chatId), p.target);
      if (!e) { await send(chatId, `Не нашёл, что ты имеешь в виду под «${esc(p.target)}». Скажи точнее?`); return true; }
      if (p.op === 'cancel') {
        store.setStatus(e.id, 'done');
        await send(chatId, `Отменил: ${kindOf(e.type)} «${esc(e.title || e.counterparty || '')}». Убрал из дел.`);
        return true;
      }
      // reschedule: пересчитываем время из фразы в tz пользователя
      const off = userOffset(user);
      const r = resolveWallDate(off, text, new Date());
      if (!r.due) { await send(chatId, 'На когда перенести? Скажи дату или время.'); return true; }
      // «на 16:00» без дня - сохраняем исходный день, меняем только время
      const hasDayWord = /завтра|послезавтра|сегодня|понедельник|вторник|сред|четверг|пятниц|суббот|воскресень|\d{1,2}[.\/]\d{1,2}|числа|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр|недел/.test(
        text.toLowerCase().replace(/ё/g, 'е')
      );
      let due = r.due;
      if (!hasDayWord && r.hasTime && e.due) due = combineDayTime(off, e.due, r.due);
      store.patch(e.id, { due, hasTime: true, reminded: false });
      await send(chatId, `Перенёс: ${kindOf(e.type)} «${esc(e.title || e.counterparty || '')}» теперь на ${esc(fmtUser(due, off, true))}.`);
      return true;
    }

    if (p.kind === 'recurring') {
      store.addRecurring({ chatId: String(chatId), title: p.title, ...p.rule });
      const when =
        p.rule.kind === 'daily' ? `каждый день в ${p.rule.hour}:${String(p.rule.min).padStart(2, '0')}`
        : p.rule.kind === 'weekly' ? `каждую неделю (${['вс','пн','вт','ср','чт','пт','сб'][p.rule.weekday]}) в ${p.rule.hour}:${String(p.rule.min).padStart(2, '0')}`
        : `каждый месяц ${p.rule.day} числа в ${p.rule.hour}:${String(p.rule.min).padStart(2, '0')}`;
      store.addRaw(chatId, text);
      await send(chatId, `Запомнил повтор: «${esc(p.title)}» - ${when}. Буду напоминать 🔁`);
      return true;
    }

    if (p.kind === 'search') {
      if (!aiEnabled()) return false;
      try {
        const answer = await withTyping(chatId, () => aiSearch(store, String(chatId), p.query, wall(user)));
        await send(chatId, esc(answer));
      } catch (e) {
        log.error('[telegram] search', e.message);
        await send(chatId, esc(sleepyText(chatId)));
      }
      return true;
    }

    if (p.kind === 'calendar') {
      const off = userOffset(user);
      const now = Date.now();
      const events = store
        .list({ status: 'open', chatId: String(chatId) })
        .filter((e) => e.due && Date.parse(e.due) >= now - 86400000 && (e.type === 'meeting' || e.type === 'task'));
      if (!events.length) { await send(chatId, 'Пока нет встреч или задач со временем, которые можно скинуть в календарь.'); return true; }
      const list = events.slice(0, 8).map((e) => `• ${e.title || e.counterparty} - ${fmtUser(e.due, off, e.hasTime)}`).join('\n');
      pendingCal.set(String(chatId), events);
      await send(chatId, `Могу скинуть в календарь телефона (${events.length}):\n${esc(list)}\n\nСкинуть файлом?`, {
        reply_markup: { inline_keyboard: [[{ text: '📅 Да, скинь', callback_data: 'cal_yes' }, { text: 'Не надо', callback_data: 'cal_no' }]] },
      });
      return true;
    }

    return false;
  }

  const pendingCal = new Map(); // chatId -> список событий, ожидающих подтверждения экспорта

  async function sendIcs(chatId, events) {
    const ics = buildIcs(events, new Date().toISOString());
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([ics], { type: 'text/calendar' }), 'raspisanie.ics');
    form.append('caption', 'Открой файл - события добавятся в календарь телефона 📅');
    const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
    return res.json();
  }

  /* ---- Обычный разговор ---- */

  async function friendFlow(chatId, text, { asVoice = false } = {}) {
    store.addRaw(chatId, text);
    const user = store.getUser(String(chatId));
    // долги/встречи/задачи тихо ложатся в базу с учётом часового пояса
    captureEntry(store, text, new Date(), chatId, userOffset(user));

    if (!aiEnabled()) {
      // Без ключа ИИ отвечают правила, без потери данных
      const out = await handleMessage(store, text, new Date(), String(chatId));
      const reply = out.reply || FALLBACKS[Math.floor(Date.now() / 60000) % FALLBACKS.length];
      return send(chatId, esc(reply));
    }

    // На голосовое отвечаем голосом: вместо драфта - статус «записывает
    // голосовое», ответ озвучивается TTS, текст уходит подписью.
    if (asVoice) {
      const stopAction = typingLoop(chatId, 'record_voice');
      try {
        const reply = withWake(chatId, await aiFriendReply(store, chatId, text));
        store.pushHistory('user', text, String(chatId));
        store.pushHistory('assistant', reply, String(chatId));
        try {
          const ogg = await aiTts(reply);
          const sent = await sendVoice(chatId, ogg, reply);
          if (sent.ok) return sent;
        } catch (e) {
          log.error('[telegram] tts', e.message); // голос не вышел - ответим текстом
        }
        return send(chatId, esc(reply));
      } catch (e) {
        log.error('[telegram] friend-voice', e.message);
        return send(chatId, esc(sleepyText(chatId)));
      } finally {
        stopAction();
      }
    }

    let reply;
    try {
      reply = await withTyping(chatId, () => aiFriendReply(store, chatId, text));
    } catch (e) {
      log.error('[telegram] friend', e.message);
    }
    if (!reply) {
      // ИИ отлетел: записи уже сохранены, а бот идёт спать
      return send(chatId, esc(sleepyText(chatId)));
    }
    reply = withWake(chatId, reply);
    store.pushHistory('user', text, String(chatId));
    store.pushHistory('assistant', reply, String(chatId));
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
    return friendFlow(String(chatId), transcript, { asVoice: true });
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

    if (msg.video_note) {
      if (!audioEnabled()) return send(chatId, 'Кружки пока не разбираю: нет ключа для расшифровки.');
      if (!hasFfmpeg) return send(chatId, 'Кружок получил, но без ffmpeg на сервере не разберу его звук. Скажи голосовым или текстом?');
      if ((msg.video_note.duration || 0) > 180) return send(chatId, 'Ого, длинный кружок. Давай покороче?');
      const transcript = await withTyping(chatId, async () => {
        const b64 = await downloadBase64(msg.video_note.file_id);
        const stamp = Date.now();
        const inFile = join(tmpdir(), `vn-${stamp}.mp4`);
        const outFile = join(tmpdir(), `vn-${stamp}.ogg`);
        try {
          writeFileSync(inFile, Buffer.from(b64, 'base64'));
          const r = spawnSync('ffmpeg', ['-y', '-i', inFile, '-vn', '-acodec', 'libopus', '-b:a', '32k', outFile], {
            stdio: 'ignore',
            timeout: 30000,
          });
          if (r.status !== 0) throw new Error('ffmpeg failed');
          return aiTranscribe(readFileSync(outFile).toString('base64'), 'ogg');
        } finally {
          rmSync(inFile, { force: true });
          rmSync(outFile, { force: true });
        }
      }).catch((e) => {
        log.error('[telegram] video_note', e.message);
        return null;
      });
      if (!transcript) return send(chatId, 'Кружок посмотрел, но слов не разобрал. Повтори?');
      if (user?.step) return onboardingStep(chatId, user, transcript);
      await send(chatId, `🎥 «${esc(transcript)}»`);
      return friendFlow(String(chatId), transcript, { asVoice: true });
    }

    if (msg.document) {
      const doc = msg.document;
      const mime = String(doc.mime_type || '');
      const name = doc.file_name || 'документ';
      if ((doc.file_size || 0) > 15 * 1024 * 1024) {
        return send(chatId, 'Файл тяжелее 15 МБ - не потяну. Пришли что-нибудь полегче?');
      }
      if (!mime.startsWith('audio/')) {
        if (!audioEnabled()) return send(chatId, 'Документы пока не читаю: нет ключа ИИ.');
        const summary = await withTyping(chatId, async () => {
          const b64 = await downloadBase64(doc.file_id);
          if (mime === 'application/pdf') return aiSummarizeDoc(b64, mime, name);
          if (name.toLowerCase().endsWith('.docx')) {
            const text = extractDocxText(Buffer.from(b64, 'base64'));
            if (!text) throw new Error('docx: пустой текст');
            return aiSummarizeText(text, name);
          }
          if (mime.startsWith('text/')) {
            return aiSummarizeText(Buffer.from(b64, 'base64').toString('utf8'), name);
          }
          return null;
        }).catch((e) => {
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
      if (!s.is_animated && !s.is_video) {
        return imageFlow(chatId, s.file_id, '[Прислал стикер]', s.emoji || '', 'image/webp');
      }
      // анимированные стикеры не разглядеть - реагируем на эмоцию
      return friendFlow(String(chatId), `[Прислал стикер с эмоцией ${s.emoji || 'без подписи'}]`);
    }

    if (typeof msg.text !== 'string') return;
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
      store.clearChatData(chatId);
      await send(chatId, 'Всё. Меня больше нет... а вот и я, новенький! 👋');
      return startOnboarding(chatId);
    }

    // Экспорт в календарь: пользователь может отказаться
    if (cb.data === 'cal_no') {
      pendingCal.delete(chatId);
      return send(chatId, 'Ок, не буду. Скажешь - скину в любой момент.');
    }
    if (cb.data === 'cal_yes') {
      const events = pendingCal.get(chatId);
      pendingCal.delete(chatId);
      if (!events || !events.length) return send(chatId, 'Что-то список потерялся. Попроси календарь ещё раз?');
      try {
        const r = await sendIcs(chatId, events);
        if (!r.ok) throw new Error(r.description || 'sendDocument failed');
        return;
      } catch (e) {
        log.error('[telegram] ics', e.message);
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

  /* ---- Long polling ---- */

  let running = true;
  let offset = 0;

  // Очередь на каждый чат: внутри чата сообщения обрабатываются по порядку,
  // но один зависший ответ не блокирует остальные чаты и приём апдейтов.
  const chatQueues = new Map();
  function enqueue(chatKey, work) {
    const prev = chatQueues.get(chatKey) || Promise.resolve();
    const next = prev
      .then(work)
      .catch((e) => log.error('[telegram] flow', chatKey, e.message))
      .finally(() => {
        if (chatQueues.get(chatKey) === next) chatQueues.delete(chatKey);
      });
    chatQueues.set(chatKey, next);
  }

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
          const chatKey = String(
            update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? 'unknown'
          );
          if (update.message) enqueue(chatKey, () => onMessage(update.message));
          else if (update.callback_query) enqueue(chatKey, () => onCallback(update.callback_query));
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
    sendButtons(chatId, text, inline_keyboard) {
      return send(chatId, esc(text), { reply_markup: { inline_keyboard } });
    },
  };
}
