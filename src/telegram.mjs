// Telegram-бот «друг и дневник». Три команды: /start /help /summary.
// Всё остальное - живой разговор: сообщения падают в сырую базу,
// фоновый worker превращает их в факты, ИИ отвечает как близкий друг.

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
import { tzFromCoords, cityFromCoords } from './weather.mjs';
import { aiSearch } from './ai.mjs';
import { parseMessage } from './parser.mjs';
import { balanceReport, expensesReport } from './finance.mjs';
import { toCsv, toJson, toMarkdown } from './export.mjs';
import { aiExtractReceipt } from './ai.mjs';

const RUB = new Intl.NumberFormat('ru-RU');

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
  goal:
    'Я спрашиваю, что сейчас занимает большую часть твоей жизни: работа, учёба, семья, спорт, отдых. Так мне проще понимать твои записи.\n\nЧто у тебя сейчас главное?',
  tz: 'Мне нужен твой часовой пояс, чтобы напоминать вовремя, а не среди ночи. Нажми кнопку «📍 Отправить геолокацию» - определю сам. Или напиши город (Москва, Екатеринбург...) либо сдвиг вроде «+3».',
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

  // Таймаут на каждый запрос к Telegram: без него зависший вызов (медленный
  // прокси) стопорил бота молча. getUpdates - длинный (long poll), остальное
  // короткое. Аборт роняет вызов, а цикл/обработчик ловит и продолжает.
  const api = async (method, params) => {
    const controller = new AbortController();
    const timeoutMs = method === 'getUpdates' ? 35000 : 15000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  };

  const send = (chat_id, text, extra = {}) =>
    api('sendMessage', {
      chat_id,
      text: String(text).slice(0, 4000),
      parse_mode: 'HTML',
      ...extra,
    });

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
      store.setUser(chatId, { name: value, step: 'tz' });
      return askLocation(chatId);
    }
    if (user.step === 'tz') {
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
        `Всё, теперь я в теме, ${esc(u.name || 'дружище')} 😉 ${u.botName ? esc(u.botName) + ' к твоим услугам.' : ''}\n\nПросто пиши мне как в дневник. Как прошёл твой день?`,
        { reply_markup: { remove_keyboard: true } }
      );
    }
  }

  function askLocation(chatId) {
    return send(
      chatId,
      `${''}Чтобы напоминать в твоё время и показывать погоду - нажми «📍 Отправить геолокацию» (определю пояс и город сам). Или просто напиши город / сдвиг вроде «+3».`,
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
    const signed = user?.botName ? ` Твой ${esc(user.botName)}.` : '';
    return [
      `Тут всё просто${name} 🙂${signed}`,
      '',
      '<blockquote>📖 Пиши мне как в личный дневник. «Планёрка прошла жёстко», «клиент должен 50 000 до пятницы», «завтра созвон в 10:00». Я всё запомню и разложу сам.</blockquote>',
      '',
      '<blockquote>⏰ Напоминания: «напомни в 15:00 позвонить маме» - и я звякну ровно в это время. «Каждый понедельник созвон в 10:00» - буду напоминать регулярно. «Перенеси встречу на 16:00» или «отмени звонок» - подвину или уберу.</blockquote>',
      '',
      '<blockquote>💬 Спрашивай что угодно: «что у меня завтра?», «баланс» (долги), «траты» (расходы за месяц), «найди про Петрова». «Скинь в календарь» - файл для календаря телефона. «Экспорт» - вся память (CSV, дневник, JSON).</blockquote>',
      '',
      '<blockquote>💸 Трать словами: «потратил 500 на кофе» - учту. Кинь фото чека - распознаю сумму сам. Поправить память: «забудь про Петрова» или «это не так».</blockquote>',
      '',
      '<blockquote>🎙 «Отвечай голосом» - буду отвечать войсами, «отвечай текстом» - обратно. Пишешь на другом языке - отвечу на нём.</blockquote>',
      '',
      '<blockquote>🎙 Отправь голосовое, кружок или mp3 (даже длинное) - расшифрую и сразу отвечу. Фото, стикеры и документы (PDF, DOCX) тоже пойму.</blockquote>',
      '',
      '<blockquote>⚙️ «Настройки» покажут всё про тебя. Пришли геолокацию - сам определю часовой пояс и город. «Напоминай за 30 минут», «мой город Казань» - тоже подстрою. По утрам расскажу про дела и погоду.</blockquote>',
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

  function settingsText(user) {
    const lead = Number.isFinite(user?.remindLead) ? user.remindLead : 15;
    const offH = userOffset(user) / 60;
    return [
      '⚙️ Твои настройки:',
      '',
      `Имя: ${esc(user?.name || '-')}`,
      `Моё имя: ${esc(user?.botName || '-')}`,
      `Ритм: ${esc(user?.rhythm || '-')}`,
      `Город: ${esc(user?.city || 'не задан')}`,
      `Часовой пояс: UTC${offH >= 0 ? '+' : ''}${offH}`,
      `Напоминаю за: ${lead} мин до дела`,
      '',
      'Поменять: пришли геолокацию (определю пояс и город сам), «напоминай за 30 минут», «мой город Казань», «часовой пояс +5», /start - сменить имя.',
    ].join('\n');
  }

  async function sendDocumentText(chatId, content, filename, mime, caption) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([content], { type: mime }), filename);
    if (caption) form.append('caption', caption);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
    return res.json();
  }

  // Возвращает true, если сообщение обработано как спец-намерение.
  async function handleIntent(chatId, user, text) {
    const p = parseMessage(text, wall(user));

    if (p.kind === 'done') {
      const e = store.findEntry(String(chatId), p.target);
      if (!e) { await send(chatId, `Не нашёл, что закрыть под «${esc(p.target)}». Скажи точнее?`); return true; }
      if (e.status === 'done') { await send(chatId, 'Это уже закрыто 🙂'); return true; }
      store.setStatus(e.id, 'done');
      await send(chatId, `Готово, закрыл: ${kindOf(e.type)} «${esc(e.title || e.counterparty || '')}» 👍`);
      return true;
    }

    if (p.kind === 'delete') {
      const e = store.findEntry(String(chatId), p.target);
      if (!e) { await send(chatId, `Не нашёл, что удалить под «${esc(p.target)}».`); return true; }
      store.remove(e.id);
      await send(chatId, `Удалил: ${kindOf(e.type)} «${esc(e.title || e.counterparty || '')}».`);
      return true;
    }

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
      // Правильно комбинируем день и время: то, что не задано в фразе,
      // берём из старой записи. «на 16:00» -> день прежний; «на пятницу» -> время прежнее.
      const hasDayWord = /завтра|послезавтра|сегодня|понедельник|вторник|сред|четверг|пятниц|суббот|воскресень|\d{1,2}[.\/]\d{1,2}|числа|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр|недел/.test(
        text.toLowerCase().replace(/ё/g, 'е')
      );
      let due, hasTime;
      if (r.hasTime && hasDayWord) {
        due = r.due; hasTime = true;
      } else if (r.hasTime && !hasDayWord) {
        due = e.due ? combineDayTime(off, e.due, r.due) : r.due; hasTime = true; // новое время, день прежний
      } else if (!r.hasTime && hasDayWord) {
        due = e.due && e.hasTime ? combineDayTime(off, r.due, e.due) : r.due; hasTime = Boolean(e.hasTime); // новый день, время прежнее
      } else {
        due = r.due; hasTime = false;
      }
      store.patch(e.id, { due, hasTime, reminded: false });
      await send(chatId, `Перенёс: ${kindOf(e.type)} «${esc(e.title || e.counterparty || '')}» теперь на ${esc(fmtUser(due, off, hasTime))}.`);
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
      if (!aiEnabled()) {
        await send(chatId, 'Поиск по памяти работает через ИИ, а ключ пока не задан. Но всё, что ты пишешь, я исправно храню.');
        return true;
      }
      try {
        const answer = await withTyping(chatId, () => aiSearch(store, String(chatId), p.query, wall(user)));
        await send(chatId, esc(answer));
      } catch (e) {
        log.error('[telegram] search', e.message);
        await send(chatId, esc(sleepyText(chatId)));
      }
      return true;
    }

    if (p.kind === 'balance') {
      await send(chatId, esc(balanceReport(store, String(chatId), userOffset(user))));
      return true;
    }

    if (p.kind === 'expenses') {
      await send(chatId, esc(expensesReport(store, String(chatId), userOffset(user))));
      return true;
    }

    if (p.kind === 'expense') {
      store.add({ type: 'expense', title: p.category, category: p.category, amount: p.amount, chatId: String(chatId), text: p.text, status: 'done' });
      store.addRaw(String(chatId), p.text); // пусть попадёт и в память дневника
      await send(chatId, `Записал трату: ${esc(p.category)} - ${RUB.format(p.amount)} ₽ 💸`);
      return true;
    }

    if (p.kind === 'forget') {
      const n = store.removeFactsMatching(String(chatId), p.target);
      await send(chatId, n ? `Забыл про «${esc(p.target)}». Стёр из памяти.` : `А про «${esc(p.target)}» я ничего и не помнил.`);
      return true;
    }

    if (p.kind === 'correct') {
      const n = store.removeRecentFacts(String(chatId), 2);
      await send(chatId, n ? 'Понял, стёр последнее из памяти. Расскажи, как правильно - запомню заново.' : 'Ок, я и не записал ничего такого. Как оно на самом деле?');
      return true;
    }

    if (p.kind === 'setvoice') {
      store.setUser(String(chatId), { voiceReplies: p.on });
      await send(chatId, p.on ? 'Окей, теперь отвечаю голосом 🎙' : 'Понял, отвечаю текстом.');
      return true;
    }

    if (p.kind === 'voiceonce') {
      if (!audioEnabled()) { await send(chatId, 'Голосом пока не могу - нет ключа озвучки. Отвечу текстом.'); return true; }
      store.setUser(String(chatId), { voiceNext: true });
      await send(chatId, 'Давай, спрашивай - отвечу голосом 🎙');
      return true;
    }

    if (p.kind === 'export') {
      await send(chatId, 'В каком виде выгрузить твою память?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📊 CSV (для Excel)', callback_data: 'exp_csv' }, { text: '📝 Дневник (Markdown)', callback_data: 'exp_md' }],
            [{ text: '🗄 Всё (JSON)', callback_data: 'exp_json' }, { text: 'Не надо', callback_data: 'exp_no' }],
          ],
        },
      });
      return true;
    }

    if (p.kind === 'settings') {
      await send(chatId, settingsText(user));
      return true;
    }
    if (p.kind === 'setlead') {
      store.setUser(chatId, { remindLead: p.minutes });
      await send(chatId, `Готово, буду напоминать за ${p.minutes} мин до дела.`);
      return true;
    }
    if (p.kind === 'setcity') {
      const off = parseTz(p.city);
      store.setUser(chatId, { city: p.city, ...(off != null ? { tzOffset: off } : {}) });
      await send(chatId, `Запомнил город: ${esc(p.city)}. Буду показывать погоду по утрам${off != null ? ' и подстрою часовой пояс' : ''}.`);
      return true;
    }
    if (p.kind === 'settz') {
      const off = parseTz(p.text);
      if (off == null) { await send(chatId, 'Не понял пояс. Напиши город или сдвиг вроде «+3».'); return true; }
      store.setUser(chatId, { tzOffset: off });
      await send(chatId, `Поставил часовой пояс. Теперь напоминания в твоё время.`);
      return true;
    }

    if (p.kind === 'calendar') {
      const events = upcomingEvents(String(chatId));
      if (!events.length) { await send(chatId, 'Пока нет встреч или задач со временем для календаря телефона.'); return true; }
      const off = userOffset(user);
      const list = events.slice(0, 8).map((e) => `• ${e.title || e.counterparty} - ${fmtUser(e.due, off, e.hasTime)}`).join('\n');
      await send(chatId, `Держу в памяти ${events.length} событий. Что закинуть в календарь телефона?\n${esc(list)}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📅 Всё расписание', callback_data: 'cal_all' }, { text: '📅 Только на неделю', callback_data: 'cal_week' }],
            [{ text: 'Не надо', callback_data: 'cal_no' }],
          ],
        },
      });
      return true;
    }

    return false;
  }

  // Будущие события пользователя (встречи и задачи со временем), свежие тоже.
  function upcomingEvents(chatId, withinDays = null) {
    const now = Date.now();
    const to = withinDays ? now + withinDays * 86400000 : Infinity;
    return store
      .list({ status: 'open', chatId })
      .filter((e) => e.due && (e.type === 'meeting' || (e.type === 'task' && e.hasTime)))
      .filter((e) => Date.parse(e.due) >= now - 86400000 && Date.parse(e.due) <= to);
  }

  async function sendIcs(chatId, events, filename = 'raspisanie.ics') {
    const ics = buildIcs(events, new Date().toISOString());
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([ics], { type: 'text/calendar' }), filename);
    form.append('caption', 'Открой файл - события добавятся в календарь телефона 📅');
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

  // Признаки тяжёлого настроения - для эмпатичных check-in'ов (№10).
  const LOW_MOOD_RE = /(?:плохо|устал|вымотал|бесит|бесят|грустно|тоскливо|тяжело|болит|поругал|поссор|ссор|стресс|выгор|депресс|не хочу|достало|хреново|паршиво|обидно|плачу|реву|одинок|подавлен|нет сил|всё бесит|заебал)/;

  // Ответ: голосом (если просили/включено) или текстом. one-shot флаг гасим.
  async function deliver(chatId, replyText, user) {
    const wantVoice = audioEnabled() && (user?.voiceReplies || user?.voiceNext);
    if (user?.voiceNext) store.setUser(String(chatId), { voiceNext: false });
    if (wantVoice) {
      const stop = typingLoop(chatId, 'record_voice');
      try {
        const ogg = await aiTts(replyText);
        const r = await sendVoice(chatId, ogg, replyText);
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
    // долги/встречи/задачи тихо ложатся в базу с учётом часового пояса
    const captured = captureEntry(store, text, new Date(), chatId, userOffset(user));
    // фиксируем тяжёлый день для вечернего check-in'а
    if (LOW_MOOD_RE.test(text.toLowerCase().replace(/ё/g, 'е'))) {
      const w = wall(user, new Date());
      store.setUser(String(chatId), { lastLowMoodDay: `${w.getUTCFullYear()}-${w.getUTCMonth()}-${w.getUTCDate()}` });
    }

    if (!aiEnabled()) {
      const out = await handleMessage(store, text, new Date(), String(chatId));
      const reply = out.reply || FALLBACKS[Math.floor(Date.now() / 60000) % FALLBACKS.length];
      await deliver(chatId, reply, store.getUser(String(chatId)));
      await maybeOfferCalendar(String(chatId), store.getUser(String(chatId)), captured);
      return;
    }

    let reply;
    try {
      reply = await withTyping(chatId, () => aiFriendReply(store, chatId, text));
    } catch (e) {
      log.error('[telegram] friend', e.message);
    }
    if (!reply) {
      return send(chatId, esc(sleepyText(chatId)));
    }
    reply = withWake(chatId, reply);
    store.pushHistory('user', text, String(chatId));
    store.pushHistory('assistant', reply, String(chatId));
    await deliver(chatId, reply, store.getUser(String(chatId)));
    await maybeOfferCalendar(String(chatId), store.getUser(String(chatId)), captured);
  }

  /* ---- Роутинг сообщений ---- */

  // Длинное аудио режем ffmpeg на куски по 150 сек и расшифровываем по частям.
  async function transcribeLong(b64, format) {
    if (!hasFfmpeg) return null;
    const stamp = Date.now();
    const inFile = join(tmpdir(), `long-${stamp}.${format === 'mp3' ? 'mp3' : 'ogg'}`);
    const outPat = join(tmpdir(), `long-${stamp}-%03d.ogg`);
    const parts = [];
    try {
      writeFileSync(inFile, Buffer.from(b64, 'base64'));
      const r = spawnSync('ffmpeg', ['-y', '-i', inFile, '-f', 'segment', '-segment_time', '150', '-c:a', 'libopus', '-b:a', '32k', outPat], {
        stdio: 'ignore',
        timeout: 120000,
      });
      if (r.status !== 0) return null;
      for (let i = 0; i < 20; i++) {
        const f = join(tmpdir(), `long-${stamp}-${String(i).padStart(3, '0')}.ogg`);
        if (!existsSync(f)) break;
        parts.push(f);
      }
      const texts = [];
      for (const f of parts) {
        const t = await aiTranscribe(readFileSync(f).toString('base64'), 'ogg').catch(() => null);
        if (t) texts.push(t);
      }
      return texts.join(' ').trim() || null;
    } finally {
      rmSync(inFile, { force: true });
      for (const f of parts) rmSync(f, { force: true });
    }
  }

  // Аудио любого вида: голосовое, mp3, аудиофайл документом.
  async function audioFlow(chatId, user, fileId, format, durationSec) {
    if (!audioEnabled()) {
      return send(chatId, 'Голосовые пока не разбираю: нет ключа для расшифровки. Напиши текстом, я всё пойму.');
    }
    const long = (durationSec || 0) > 170;
    if (long && !hasFfmpeg) {
      return send(chatId, 'Запись длинновата, а без ffmpeg на сервере длинное не осилю. Скажи покороче?');
    }
    if ((durationSec || 0) > 20 * 60) {
      return send(chatId, 'Ого, больше двадцати минут - это уже подкаст 🙂 Давай частями?');
    }
    const transcript = await withTyping(chatId, async () => {
      const b64 = await downloadBase64(fileId);
      return long ? transcribeLong(b64, format) : aiTranscribe(b64, format);
    });
    if (!transcript) {
      return send(chatId, 'Я честно слушал, но не расслышал. Скажи ещё раз?');
    }
    if (user?.step) return onboardingStep(chatId, user, transcript);
    // Без дублирования расшифровки - сразу ответ на голосовое текстом.
    return friendFlow(String(chatId), transcript);
  }

  // Картинка (фото, статичный стикер, превью гифки): сначала пробуем распознать
  // чек и записать трату (№8), иначе описываем и запоминаем.
  async function imageFlow(chatId, fileId, label, caption, mime = 'image/jpeg', tryReceipt = false) {
    if (!audioEnabled()) {
      return send(chatId, 'Картинки пока не разглядываю: нет ключа мультимодального ИИ. Расскажи словами?');
    }
    let b64;
    try {
      b64 = await withTyping(chatId, () => downloadBase64(fileId));
    } catch (e) {
      log.error('[telegram] image dl', e.message);
      return send(chatId, 'Не смог скачать картинку. Попробуй ещё раз?');
    }

    if (tryReceipt) {
      const rec = await withTyping(chatId, () => aiExtractReceipt(b64, mime)).catch(() => null);
      if (rec) {
        store.add({ type: 'expense', title: rec.category, category: rec.category, amount: rec.amount, counterparty: rec.merchant, chatId: String(chatId), text: `Чек: ${rec.merchant || rec.category}`, status: 'done' });
        store.addRaw(String(chatId), `Потратил ${rec.amount} на ${rec.category}${rec.merchant ? ` (${rec.merchant})` : ''}`);
        return send(chatId, `Чек распознал: ${esc(rec.category)}${rec.merchant ? ` (${esc(rec.merchant)})` : ''} - ${RUB.format(rec.amount)} ₽. Записал в траты 💸`);
      }
    }

    let description;
    try {
      description = await withTyping(chatId, () => aiDescribeImage(b64, mime, caption || ''));
    } catch (e) {
      log.error('[telegram] image', e.message);
      return send(chatId, 'Разглядывал-разглядывал, но так и не понял, что там. Расскажешь словами?');
    }
    const text = `${label}: ${description}${caption ? `. Моя подпись: ${caption}` : ''}`;
    return friendFlow(String(chatId), text);
  }

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

  async function onMessage(msg) {
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
      return friendFlow(String(chatId), transcript); // без эха, сразу ответ текстом
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
