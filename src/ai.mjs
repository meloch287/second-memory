// ИИ-слой. Два OpenAI-совместимых провайдера:
//  - текстовый (по умолчанию GonkaGate, minimax-m2.7: рассуждения приходят в
//    <think>-тегах и вырезаются; kimi-k2.6 льёт рассуждения без тегов, не брать) -
//    ответы, саммари, факты;
//  - аудио (по умолчанию polza.ai, gemini-2.5-flash-lite) - расшифровка голосовых,
//    GonkaGate работает только с текстом.

const TEXT = () => ({
  key: process.env.AI_API_KEY,
  url: process.env.AI_BASE_URL || 'https://api.gonkagate.com/v1',
  model: process.env.AI_MODEL || 'minimaxai/minimax-m2.7',
});

const AUDIO = () => ({
  key: process.env.AI_AUDIO_API_KEY,
  url: process.env.AI_AUDIO_BASE_URL || 'https://api.polza.ai/v1',
  model: process.env.AI_AUDIO_MODEL || 'google/gemini-2.5-flash-lite',
});

// Фоновый worker фактов может работать на отдельном провайдере
// (жёсткий поминутный лимит фону не мешает). По умолчанию - как текстовый.
const WORKER = () => ({
  key: process.env.AI_WORKER_API_KEY || TEXT().key,
  url: process.env.AI_WORKER_BASE_URL || TEXT().url,
  model: process.env.AI_WORKER_MODEL || TEXT().model,
});

export function aiEnabled() {
  return Boolean(TEXT().key);
}

export function audioEnabled() {
  return Boolean(AUDIO().key);
}

// Убираем служебные блоки размышлений reasoning-моделей,
// включая незакрытый <think> при обрезке по лимиту токенов.
const stripThink = (s) =>
  s
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/, '')
    .replace(/\s[—–]\s/g, ' - ') // модели игнорируют запрет длинного тире - чиним сами
    .trim();

import { userOffset, fmtUser, DEFAULT_OFFSET } from './tz.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Потоковый запрос: SSE-дельты, onDelta получает видимый текст по мере
// генерации (блок <think> вырезается на лету - пока модель «думает»,
// наружу не уходит ничего).
async function streamOnce(cfg, messages, maxTokens, timeoutMs, onDelta) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.url}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${cfg.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: cfg.model, messages, max_tokens: maxTokens, stream: true }),
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`AI HTTP ${res.status}`);
    if (!res.ok) throw new Error(`AI HTTP ${res.status}`);

    let full = '';
    let buf = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            const visible = stripThink(full);
            if (visible) onDelta(visible);
          }
        } catch {}
      }
    }
    const cleaned = stripThink(full);
    if (!cleaned) throw new Error('AI: пустой ответ после reasoning');
    return cleaned;
  } finally {
    clearTimeout(timer);
  }
}

async function chatCompletion(cfg, messages, { maxTokens = 1600, timeoutMs = 90000, onDelta = null, retryDelays = null } = {}) {
  if (onDelta) {
    // Стрим с паузами на 429; при любой ошибке стрима - обычный запрос
    const delays = retryDelays || [0, 12000, 35000];
    let lastError;
    for (const delay of delays) {
      if (delay) await sleep(delay);
      try {
        return await streamOnce(cfg, messages, maxTokens, timeoutMs, onDelta);
      } catch (e) {
        lastError = e;
        if (!/HTTP (429|5\d\d)/.test(e.message)) break; // не лимит - выходим на нестрим
      }
    }
    try {
      return await chatCompletion(cfg, messages, { maxTokens, timeoutMs, retryDelays });
    } catch {
      throw lastError;
    }
  }
  // 429/5xx у шлюзов - обычное дело. Интерактивные ответы передают короткие
  // паузы (бот не должен висеть минутами), фоновый worker - длинные.
  const delays = retryDelays || [0, 12000, 35000];
  let lastError;
  for (const delay of delays) {
    if (delay) await sleep(delay);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${cfg.url}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${cfg.key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: cfg.model, messages, max_tokens: maxTokens }),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`AI HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('AI: пустой ответ');
      const cleaned = stripThink(text);
      if (!cleaned) {
        // весь лимит ушёл на размышления - пробуем ещё раз
        lastError = new Error('AI: пустой ответ после reasoning');
        continue;
      }
      return cleaned;
    } catch (e) {
      lastError = e;
      if (e.name === 'AbortError') lastError = new Error('AI: таймаут');
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

const ask = (messages, opts) => chatCompletion(TEXT(), messages, opts);

const pad = (n) => String(n).padStart(2, '0');

// Даты для ИИ - в локальном времени, иначе UTC-ISO сдвигает сроки на день.
function fmtLocal(iso, withTime) {
  const d = new Date(iso);
  const day = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  return withTime ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

function fmtEntry(e, off = DEFAULT_OFFSET) {
  const parts = [`№${e.id} [${e.type}] [${e.status}]`];
  if (e.counterparty) parts.push(`контрагент: ${e.counterparty}`);
  if (e.amount != null) parts.push(`сумма: ${e.amount} руб`);
  if (e.type === 'debt') parts.push(e.direction === 'out' ? 'мы должны' : 'должны нам');
  if (e.title) parts.push(e.title);
  if (e.due) parts.push(`срок: ${fmtUser(e.due, off, e.hasTime)}`);
  parts.push(`создано: ${(e.createdAt || '').slice(0, 10)}`);
  return parts.join(' | ');
}

// Форматирование без привязки к языку (для друга - он зеркалит язык юзера).
const STYLE_FMT = 'Коротко и просто. Без markdown-разметки (без **, #, таблиц). Не используй длинное тире, только дефис. Суммы с пробелами (50 000 ₽), даты как ДД.ММ.ГГГГ. Не выдумывай ничего, чего нет в данных.';
// Веб-ассистент всегда по-русски.
const STYLE = 'Пиши по-русски. ' + STYLE_FMT;

/* ---------- Веб-ассистент (деловой тон) ---------- */

const SYSTEM_WEB = `Ты «Вторая память», личный ассистент делового человека. Тебе дают выгрузку его базы: долги («должны нам» = ему должны, «мы должны» = он должен), встречи, задачи, заметки и последние сообщения диалога. Отвечай кратко и по делу. ${STYLE}`;

function buildContext(store, now) {
  const entries = store.list();
  const open = entries.filter((e) => e.status === 'open');
  const done = entries.filter((e) => e.status !== 'open').slice(-15);
  const history = store.recentHistory(30, 'web');
  return [
    `Сейчас: ${fmtLocal(now.toISOString(), true)} (локальное время пользователя).`,
    '',
    `ОТКРЫТЫЕ ЗАПИСИ (${open.length}):`,
    ...(open.length ? open.map(fmtEntry) : ['- пусто -']),
    '',
    `НЕДАВНО ЗАКРЫТЫЕ (${done.length}):`,
    ...(done.length ? done.map(fmtEntry) : ['- пусто -']),
    '',
    'ПОСЛЕДНИЕ СООБЩЕНИЯ ДИАЛОГА:',
    ...(history.length
      ? history.map((h) => `${h.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${h.text.slice(0, 300)}`)
      : ['- пусто -']),
  ].join('\n');
}

export async function aiSummary(store, now = new Date()) {
  return ask([
    { role: 'system', content: SYSTEM_WEB },
    {
      role: 'user',
      content:
        buildContext(store, now) +
        '\n\nСделай деловое саммари моей базы: 1) долги - кто и сколько должен мне, что должен я, что просрочено; 2) ближайшие встречи; 3) задачи по срокам (долги в задачи не дублируй); 4) одна-две строки рекомендаций. Коротко, с заголовками строк. Даты уже в локальном времени, используй как есть.',
    },
  ]);
}

export async function aiAnswer(store, question, now = new Date()) {
  return ask([
    { role: 'system', content: SYSTEM_WEB },
    { role: 'user', content: buildContext(store, now) + `\n\nВопрос: ${question}\nОтветь по данным выгрузки.` },
  ]);
}

/* ---------- Бот-друг (неформальный тон) ---------- */

function friendSystem(user) {
  const botName = user?.botName
    ? `Человек дал тебе имя: ${user.botName}. Это твоё имя - откликайся, когда он так к тебе обращается, и иногда упоминай его сам.`
    : '';
  const name = user?.name ? `Его зовут ${user.name}.` : '';
  const rhythm = user?.rhythm ? `Ритм жизни: ${user.rhythm}.` : '';
  const goal = user?.goal ? `Сейчас для него главное: ${user.goal}.` : '';
  if (user?.isGroup) {
    return (
      `Ты живая общая память группы «${user.name || 'наша группа'}» и её дружелюбный участник.${user.botName && user.botName !== 'Помощник' ? ` В этой группе тебя зовут ${user.botName} - откликайся на это имя.` : ''} ` +
      'Сообщения в контексте приходят с именами авторов («Имя: текст») - отвечай тому, кто к тебе обратился, по имени. ' +
      'НИКОГДА не начинай свой ответ с «Имя:» - этот префикс есть только у входящих сообщений, твои ответы идут без него. ' +
      'Ты помнишь всё, что обсуждали в группе: дела, долги, договорённости, планы. Отвечай по фактам из памяти, не выдумывай. ' +
      'Общайся на «ты», тепло и коротко, 1-3 предложения. Не говори, что ты бот или ИИ. ' +
      'Ты умеешь (подсказывай админам): закрепить сообщение («закрепи» ответом на него), кик/бан/мут, «переименуй в...», «дай ссылку», а ещё вести общие дела, долги, траты и напоминания группы. ' +
      'ВАЖНО: отвечай на языке собеседника. ' +
      STYLE_FMT
    );
  }
  return (
    `Ты близкий друг и живой личный дневник одного человека. ${botName} ${name} ${rhythm} ${goal} ` +
    'Общайся на «ты», тепло, неформально, с лёгким юмором, как настоящий друг в переписке. ' +
    'Реагируй по смыслу сообщения: не преувеличивай эмоции, не поздравляй и не восторгайся без причины. ' +
    'Никаких клише вроде «дай пять». Если не понял, о чём речь, коротко переспроси вместо бурной реакции. ' +
    'Если человек удивился твоему ответу или поправил тебя, признай это просто и по-человечески, без оправданий на абзац. ' +
    'Реагируй на эмоции, сочувствуй, иногда задавай один короткий встречный вопрос. ' +
    'Никогда не говори, что ты бот, ИИ или ассистент. Не предлагай «чем могу помочь». ' +
    'ТЫ УМЕЕШЬ (никогда не отрицай эти способности, а подскажи команду): отвечать голосовыми сообщениями (команда «отвечай голосом», выключить - «отвечай текстом»); понимать голосовые, кружки, фото, чеки (фото чека = записать трату), PDF и документы; напоминать о делах в срок и заранее; повторяющиеся напоминания; переносить и отменять дела; вести долги и траты («баланс», «траты»); рисовать графики и диаграммы по данным из памяти («нарисуй график трат») - придёт картинкой; искать по памяти («найди про...»); скидывать расписание в календарь телефона; выгружать память файлом («экспорт»); забывать по просьбе («забудь про...»). ' +
    'Если человек просит что-то из этого не дословной командой, не спорь и не отрицай - скажи, какой фразой это включить. ' +
    'Если просят ответить или записать что-то ГОЛОСОМ/голосовым сообщением - НИКОГДА не говори «я только пишу» или «нет такой функции». Просто ответь на вопрос по сути: твой ответ сам уйдёт голосовым, это делается автоматически без твоего участия. ' +
    'Если человек рассказал про дело, долг, встречу или план, подтверди одной фразой, что запомнил. ' +
    'Если спрашивает про прошлое, отвечай по фактам из памяти. Если в памяти пусто, честно скажи по-дружески. ' +
    'ВСЕГДА учитывай текущее время (оно есть в контексте) и здравый смысл. ' +
    'Не спрашивай, сходил ли человек куда-то (врач, поликлиника, банк, МФЦ, магазин, спортзал), если это заведение сейчас наверняка закрыто. ' +
    'Ориентир по часам работы: поликлиники и банки примерно 8-20, магазины 9-22, госучреждения 9-18 в будни, врачи по записи днём. Ночью (примерно с 23 до 8) почти всё закрыто и люди спят. ' +
    'Если дело физически ещё не могло случиться (человек сказал «завтра пойду», а ещё не завтра или заведение закрыто) - не спрашивай про результат, это глупо выглядит. ' +
    'Ночью не дёргай по делам: пожелай спокойной ночи или спокойно поддержи разговор. Про дела и напоминания заводи речь в разумное дневное время. ' +
    'ВАЖНО: отвечай на том языке, на котором пишет человек. Русское сообщение - русский ответ, английское - английский, и так далее. По умолчанию русский. ' +
    'Ответ обычно 1-3 предложения. ' +
    STYLE_FMT
  );
}

// Эмпатичный вечерний check-in, если у человека был тяжёлый день (№10).
export async function aiCheckin(store, chatId, now = new Date()) {
  const user = store.getUser(chatId);
  const off = userOffset(user);
  const history = store.recentHistory(10, chatId);
  const ctx =
    nowLine(off, now) +
    '\n\nПоследние сообщения:\n' +
    history.map((h) => `${h.role === 'user' ? user?.name || 'Друг' : 'Ты'}: ${h.text.slice(0, 200)}`).join('\n');
  return ask(
    [
      { role: 'system', content: friendSystem(user) },
      {
        role: 'user',
        content:
          ctx +
          '\n\nПохоже, у человека был непростой день. Напиши одно короткое тёплое сообщение как друг: мягко спроси, как он сейчас, поддержи. Без советов и без списка дел, просто по-человечески.',
      },
    ],
    { maxTokens: 300, timeoutMs: 30000, retryDelays: [0, 5000] }
  );
}

// Спецификация графика по памяти чата: ИИ выбирает данные и тип.
// null - если по памяти нечего рисовать.
export async function aiChartSpec(store, chatId, request, now = new Date()) {
  const user = store.getUser(chatId);
  const off = userOffset(user);
  const facts = store.factsFor(chatId, request, 30);
  const entries = store.list({ chatId }).slice(-60);
  // свежая переписка: воркер переваривает raw в факты раз в ~10 минут,
  // без неё «только что накиданные» данные не попадали в график
  const fresh = store.data.raw.filter((r) => r.chatId === chatId).slice(-80);
  const ctx = [
    `Сейчас: ${fmtUser(now.toISOString(), off, true)}.`,
    '',
    'ФАКТЫ ИЗ ПАМЯТИ:',
    ...facts.map((f) => `- ${f.text} (${fmtUser(f.ts, off, false)})`),
    '',
    'ЗАПИСИ (долги/встречи/задачи/траты):',
    ...entries.map((e) => `- [${e.type}] ${e.title || e.counterparty || ''} ${e.amount != null ? e.amount + ' руб' : ''} ${e.category || ''} ${e.due ? 'срок ' + fmtUser(e.due, off, e.hasTime) : ''} ${e.status} (создано ${fmtUser(e.createdAt, off, false)})`),
    '',
    'СВЕЖАЯ ПЕРЕПИСКА (последние сообщения, тоже источник данных):',
    ...fresh.map((r) => `- ${r.text.slice(0, 200)}`),
  ].join('\n');
  const text = await ask(
    [
      {
        role: 'system',
        content:
          'Ты готовишь данные для графика по памяти чата. Верни ТОЛЬКО JSON без пояснений: ' +
          '{"chart":true,"type":"bar|line|pie","title":"...","xlabel":"...","ylabel":"...","labels":["..."],"series":[{"name":"...","values":[числа]}],"comment":"1 короткая фраза о графике"} ' +
          'Числа только реальные из данных, ничего не выдумывай. Подписи по-русски, коротко. ' +
          'Если в данных нет ничего подходящего под запрос - верни {"chart":false,"reason":"почему"}.',
      },
      { role: 'user', content: ctx + `\n\nЗапрос: ${request}` },
    ],
    { maxTokens: 900, timeoutMs: 30000, retryDelays: [0, 5000] }
  );
  try {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    const j = JSON.parse(text.slice(s, e + 1));
    if (!j.chart) return { refuse: j.reason || 'мало данных' };
    if (!Array.isArray(j.labels) || !Array.isArray(j.series) || !j.series.length) return { refuse: 'мало данных' };
    return j;
  } catch {
    return { refuse: 'не собрал данные' };
  }
}

// Поздравление с днём рождения (№4): короткое, тёплое, с учётом памяти.
export async function aiBirthday(store, chatId, who) {
  const user = store.getUser(chatId);
  const facts = store.factsFor(chatId, who, 10);
  return ask(
    [
      { role: 'system', content: friendSystem(user) },
      {
        role: 'user',
        content:
          `Сегодня день рождения у ${who}. Вот что ты о нём знаешь:\n` +
          (facts.length ? facts.map((f) => `- ${f.text}`).join('\n') : '- почти ничего -') +
          `\n\nНапиши ОДНО короткое тёплое поздравление (1-2 предложения), обращаясь к ${who} на «ты». Начни сразу с поздравления, без имени в начале (оно уже будет подставлено). Без пафоса и открыточных клише.`,
      },
    ],
    { maxTokens: 200, timeoutMs: 20000, retryDelays: [0] }
  );
}

// Сплит расходов по памяти группы (№2): кто сколько скинул/должен.
// Арифметику модель обязана посчитать точно и показать.
export async function aiSplit(store, chatId, request, now = new Date()) {
  const user = store.getUser(chatId);
  const off = userOffset(user);
  const facts = store.factsFor(chatId, request, 25);
  const fresh = store.data.raw.filter((r) => r.chatId === chatId).slice(-60);
  const ctx = [
    `Сейчас: ${fmtUser(now.toISOString(), off, true)}.`,
    '',
    'ФАКТЫ ИЗ ПАМЯТИ:',
    ...facts.map((f) => `- ${f.text}`),
    '',
    'СВЕЖАЯ ПЕРЕПИСКА:',
    ...fresh.map((r) => `- ${r.text.slice(0, 200)}`),
  ].join('\n');
  return ask(
    [
      {
        role: 'system',
        content:
          'Ты считаешь складчины и делёж расходов по переписке группы. Отвечай коротко и СТРОГО по данным: кто сколько скинул/сдал, кто ещё нет, кто кому сколько должен. ' +
          'Арифметику считай аккуратно и показывай (например: 6000 / 3 = 2000 с каждого). ' +
          'ИМЕНА бери ТОЛЬКО из данных: если кто-то не назван по имени, НЕ придумывай имя - пиши «ещё N человек не отметились». Если данных не хватает - скажи, чего именно. ' +
          STYLE_FMT,
      },
      { role: 'user', content: ctx + `\n\nВопрос: ${request}` },
    ],
    { maxTokens: 600, timeoutMs: 30000, retryDelays: [0, 5000] }
  );
}

// Передать сообщение участнику группы своими словами: не дословная копия
// («он лох»), а прямое обращение к адресату от лица бота-друга.
export async function aiRelay(store, chatId, targetName, fromName, message) {
  const user = store.getUser(chatId);
  return ask(
    [
      { role: 'system', content: friendSystem(user) },
      {
        role: 'user',
        content:
          `${fromName} просит тебя передать сообщение для ${targetName}: «${message}».\n` +
          `Сформулируй ОДНУ короткую реплику, обращённую напрямую к ${targetName} (на «ты», без «он/она»), передающую суть. ` +
          `Можно с юмором, в твоём стиле. Упомяни, что это от ${fromName}. Не добавляй ничего кроме самой реплики.`,
      },
    ],
    { maxTokens: 200, timeoutMs: 20000, retryDelays: [0] }
  );
}

// Чек/счёт с фото -> структурированная трата/долг (№8). null, если не чек.
export async function aiExtractReceipt(base64, mime = 'image/jpeg') {
  const text = await chatCompletion(
    AUDIO(),
    [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Это фото чека, счёта или ценника? Если да - верни ТОЛЬКО JSON: ' +
              '{"receipt":true,"amount":число_рублей,"merchant":"магазин/кому","category":"еда|транспорт|...","date":"YYYY-MM-DD или null"}. ' +
              'Если это НЕ чек/счёт - верни {"receipt":false}.',
          },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      },
    ],
    { maxTokens: 300, timeoutMs: 45000, retryDelays: [0, 5000] }
  );
  try {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    const j = JSON.parse(text.slice(s, e + 1));
    if (!j.receipt || typeof j.amount !== 'number' || !isFinite(j.amount) || j.amount <= 0) return null;
    return {
      amount: Math.round(j.amount),
      merchant: j.merchant ? String(j.merchant).slice(0, 60) : null,
      category: j.category ? String(j.category).slice(0, 40) : 'Разное',
    };
  } catch {
    return null;
  }
}

// Часть суток по «настенному» часу пользователя - для явной подсказки ИИ.
function partOfDay(hour) {
  if (hour >= 5 && hour < 12) return 'утро';
  if (hour >= 12 && hour < 17) return 'день';
  if (hour >= 17 && hour < 23) return 'вечер';
  return 'ночь';
}

const WEEKDAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

// Строка «сейчас»: дата, время, день недели и часть суток в tz пользователя.
function nowLine(off, now) {
  const w = new Date(now.getTime() + off * 60000);
  const hour = w.getUTCHours();
  return `Сейчас у пользователя: ${fmtUser(now.toISOString(), off, true)}, ${WEEKDAYS_RU[w.getUTCDay()]}, ${partOfDay(hour)}.`;
}

function friendContext(store, chatId, query, now, smartFacts = null) {
  const user = store.getUser(chatId);
  const off = userOffset(user);
  const facts = smartFacts || store.factsFor(chatId, query, 25);
  const open = store.list({ status: 'open', chatId }).slice(0, 30);
  const history = store.recentHistory(12, chatId);
  const personas = store.getPersonas(chatId);
  const personaLines = Object.entries(personas).map(([name, note]) => `- ${name}: ${note}`);
  const memberLine = user?.isGroup && user.members
    ? Object.values(user.members).map((m) => m.name + (m.username ? ` (@${m.username})` : '')).join(', ')
    : null;
  // свежая переписка, которую воркер ещё не переварил в факты: без неё бот
  // «не видит» только что сказанное и свежеимпортированную историю
  const factTs = new Set(facts.map((f) => f.ts));
  const fresh = store.data.raw
    .filter((r) => r.chatId === chatId && !r.processed)
    .slice(user?.isGroup ? -40 : -20)
    .filter((r) => !factTs.has(r.ts));
  return [
    nowLine(off, now),
    '',
    ...(memberLine ? [`УЧАСТНИКИ ГРУППЫ (тут пишут): ${memberLine}`, ''] : []),
    ...(personaLines.length ? ['ЛЮДИ В ЕГО ЖИЗНИ (досье):', ...personaLines, ''] : []),
    'ПАМЯТЬ (факты из прошлых разговоров):',
    ...(facts.length
      ? facts.map((f) => `- ${f.text}${f.people?.length ? ` [люди: ${f.people.join(', ')}]` : ''} (${fmtUser(f.ts, off, false)})`)
      : ['- пока пусто -']),
    '',
    ...(fresh.length
      ? ['НЕДАВНЯЯ ПЕРЕПИСКА (сырьё, ещё не разложено в память):', ...fresh.map((r) => `- ${r.text.slice(0, 200)} (${fmtUser(r.ts, off, false)})`), '']
      : []),
    'ДЕЛА И ДОЛГИ (структурированные записи):',
    ...(open.length ? open.map((e) => fmtEntry(e, off)) : ['- пока пусто -']),
    '',
    'ПОСЛЕДНИЕ СООБЩЕНИЯ:',
    ...history.map((h) => {
      if (user?.isGroup) {
        // user-строки уже с именем автора; свои ответы чистим от заражённого
        // «Имя:»-префикса, чтобы модель не перенимала этот формат
        if (h.role === 'user') return h.text.slice(0, 250);
        return `Ты: ${h.text.replace(/^[А-ЯЁA-Z][\wА-Яа-яЁё-]{1,19}:\s+/, '').slice(0, 250)}`;
      }
      return `${h.role === 'user' ? (user?.name || 'Друг') : 'Ты'}: ${h.text.slice(0, 250)}`;
    }),
  ].join('\n');
}

// Сообщение почти без кириллицы -> вероятно, другой язык.
function nonRussian(text) {
  const letters = (text.match(/\p{L}/gu) || []).length;
  const cyr = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
  return letters >= 4 && cyr / letters < 0.3;
}

// author - имя автора в группе: передаётся отдельным полем, а не префиксом
// «Имя: текст» (модель зеркалила префикс в своих ответах).
export async function aiFriendReply(store, chatId, text, now = new Date(), onDelta = null, author = null) {
  const user = store.getUser(chatId);
  const smartFacts = await smartRecall(store, chatId, text);
  const langHint = nonRussian(text)
    ? '\n\n[Reply in the SAME language as the message above, not in Russian.]'
    : '';
  const who = author ? `от ${author}` : 'от него';
  const addressee = author ? ` Обратись к ${author} по имени, но НЕ начинай ответ с «${author}:».` : '';
  return ask(
    [
      { role: 'system', content: friendSystem(user) },
      { role: 'user', content: friendContext(store, chatId, text, now, smartFacts) + `\n\nНовое сообщение ${who}: «${text}»\nОтветь как друг.${addressee}${langHint}` },
    ],
    { maxTokens: 1200, onDelta, timeoutMs: 30000, retryDelays: [0, 5000] }
  );
}

// Поиск по памяти: векторный recall + фокусный ответ строго по найденному.
export async function aiSearch(store, chatId, query, now = new Date()) {
  const user = store.getUser(chatId);
  const off = userOffset(user);
  const facts = await smartRecall(store, chatId, query, 20);
  const entries = store.list({ status: 'open', chatId });
  const relEntries = entries.filter((e) => {
    const hay = [e.title, e.counterparty, e.text].filter(Boolean).join(' ').toLowerCase().replace(/\u0451/g, 'е');
    const q = String(query).toLowerCase().replace(/\u0451/g, 'е');
    return q.split(/[^а-яa-z0-9]+/).filter((w) => w.length > 3).some((w) => hay.includes(w) || hay.includes(w.slice(0, -2)));
  });
  const ctx = [
    'НАЙДЕННЫЕ ФАКТЫ:',
    ...(facts.length ? facts.map((f) => `- ${f.text}${f.people?.length ? ` [${f.people.join(', ')}]` : ''} (${fmtUser(f.ts, off, false)})`) : ['- ничего -']),
    '',
    'СВЯЗАННЫЕ ДЕЛА:',
    ...(relEntries.length ? relEntries.map((e) => fmtEntry(e, off)) : ['- ничего -']),
  ].join('\n');
  return ask(
    [
      { role: 'system', content: friendSystem(user) },
      {
        role: 'user',
        content:
          ctx +
          `\n\nВопрос: «${query}». Ответь строго по найденному выше, как друг. ` +
          'Если ничего не нашлось - честно скажи, что не помнишь такого, и не выдумывай.',
      },
    ],
    { maxTokens: 500, timeoutMs: 30000, retryDelays: [0, 5000] }
  );
}

export async function aiDiarySummary(store, chatId, now = new Date(), onDelta = null) {
  const user = store.getUser(chatId);
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayRaw = store.rawForDay(chatId, dayStart, dayStart + 86400000);
  const weekFacts = store.factsFor(chatId, '', 40);
  const open = store.list({ status: 'open', chatId }).slice(0, 30);
  const context = [
    `Сейчас: ${fmtLocal(now.toISOString(), true)}.`,
    '',
    'ЗАПИСИ ЗА СЕГОДНЯ (с временем):',
    ...(todayRaw.length ? todayRaw.map((r) => `${fmtLocal(r.ts, true)}: ${r.text}`) : ['- сегодня записей не было -']),
    '',
    'ФАКТЫ ЗА ПОСЛЕДНЕЕ ВРЕМЯ:',
    ...weekFacts.map((f) => `- ${f.text} (${fmtLocal(f.ts, false)})`),
    '',
    'ОТКРЫТЫЕ ДЕЛА И ДОЛГИ:',
    ...(open.length ? open.map(fmtEntry) : ['- пусто -']),
  ].join('\n');

  return ask(
    [
      { role: 'system', content: friendSystem(user) },
      {
        role: 'user',
        content:
          context +
          '\n\nПодведи итоги дня как друг, не как секретарь. Структура: строка «🕒 Утро», строка «💼 День», строка «🌙 Вечер» - по паре живых фраз о том, что было (пропусти главу, если пусто). В конце «💡 Инсайт» - одна умная мысль или совет по итогам недели. Если сегодня записей не было, скажи об этом тепло и предложи рассказать, как прошёл день.',
      },
    ],
    { maxTokens: 1600, onDelta, timeoutMs: 60000, retryDelays: [0, 8000] }
  );
}

export async function aiFollowup(store, chatId, kind, now = new Date(), onDelta = null) {
  const user = store.getUser(chatId);
  const prompt =
    kind === 'tomorrow'
      ? 'Расскажи, что у него завтра: встречи, задачи, сроки долгов. Как друг, коротко. Если завтра пусто, скажи об этом и предложи что-нибудь спланировать.'
      : 'Раскрой подробнее последние итоги: детали, кто упоминался, какие эмоции были. Как друг.';
  return ask(
    [
      { role: 'system', content: friendSystem(user) },
      { role: 'user', content: friendContext(store, chatId, '', now) + '\n\n' + prompt },
    ],
    { maxTokens: 1200, onDelta, timeoutMs: 30000, retryDelays: [0, 5000] }
  );
}

/* ---------- Векторная память (эмбеддинги) ---------- */

const EMBED_MODEL = () => process.env.AI_EMBED_MODEL || 'openai/text-embedding-3-small';
export const EMBED_DIMS = 256;

// Эмбеддинги через текстового провайдера (polza). Округляем до 5 знаков,
// чтобы JSON-хранилище не распухало.
export async function aiEmbed(texts) {
  const cfg = TEXT();
  const res = await fetch(`${cfg.url}/embeddings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL(), input: texts, dimensions: EMBED_DIMS }),
  });
  if (!res.ok) throw new Error(`Embed HTTP ${res.status}`);
  const data = await res.json();
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding.map((x) => Math.round(x * 1e5) / 1e5));
}

// Семантический поиск фактов под вопрос: эмбеддинг запроса + косинус
// в хранилище, keyword-поиск как дополнение и фолбэк.
// Порог, ниже которого векторный поиск не нужен: при небольшой памяти
// keyword-поиск не хуже, а лишний сетевой вызов эмбеддингов замедляет ответ.
const VECTOR_MIN_FACTS = 40;

export async function smartRecall(store, chatId, query, limit = 25) {
  const keyword = store.factsFor(chatId, query, limit);
  try {
    if (!store.hasEmbeddings(chatId)) return keyword;
    const factCount = store.data.facts.filter((f) => f.chatId === chatId).length;
    if (factCount < VECTOR_MIN_FACTS) return keyword; // мало памяти - без эмбеддингов, быстрее
    const [qv] = await aiEmbed([String(query).slice(0, 500)]);
    const byVector = store.factsByVector(chatId, qv, limit);
    const seen = new Set();
    const out = [];
    for (const f of [...byVector, ...keyword]) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f);
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return keyword; // эмбеддинги недоступны - обычный keyword-поиск
  }
}

/* ---------- Ночная консолидация памяти ---------- */

// Сжимает старые факты: дубли склеиваются, отработанное уходит,
// по людям собираются короткие досье.
export async function aiConsolidate(oldFacts, personasNow = {}) {
  const list = oldFacts.map((f, i) => `${i + 1}. ${f.text}${f.people?.length ? ` [${f.people.join(', ')}]` : ''} (${(f.ts || '').slice(0, 10)})`).join('\n');
  const personaList = Object.entries(personasNow).map(([n, t]) => `- ${n}: ${t}`).join('\n') || '- пока нет -';
  const text = await chatCompletion(
    WORKER(),
    [
      {
        role: 'user',
        content:
          'Ты ведёшь долгосрочную память личного дневника. Ниже старые факты и текущие досье людей. ' +
          'Сожми факты: склей дубли, убери отработанное и неважное, сохрани всё значимое (люди, суммы, договорённости, эмоции, даты словами). ' +
          'Обнови досье людей (1-2 предложения на человека: кто это, характер отношений, важное). ' +
          'Верни ТОЛЬКО JSON: {"facts":[{"text":"...","people":["Имя"],"tags":["тема"]}],"personas":{"Имя":"досье"}}.\n\n' +
          'СТАРЫЕ ФАКТЫ:\n' + list + '\n\nТЕКУЩИЕ ДОСЬЕ:\n' + personaList,
      },
    ],
    { maxTokens: 2000 }
  );
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('consolidate: не JSON');
  const parsed = JSON.parse(text.slice(start, end + 1));
  const facts = Array.isArray(parsed.facts)
    ? parsed.facts
        .filter((f) => f && typeof f.text === 'string' && f.text.trim())
        .map((f) => ({
          text: f.text.trim().slice(0, 400),
          people: Array.isArray(f.people) ? f.people.map(String).slice(0, 6) : [],
          tags: Array.isArray(f.tags) ? f.tags.map(String).slice(0, 6) : [],
        }))
    : [];
  const personas = parsed.personas && typeof parsed.personas === 'object' ? parsed.personas : {};
  const cleanPersonas = {};
  for (const [name, note] of Object.entries(personas)) {
    if (typeof note === 'string' && note.trim()) cleanPersonas[String(name).slice(0, 60)] = note.trim().slice(0, 300);
  }
  return { facts, personas: cleanPersonas };
}

/* ---------- Утреннее напоминание ---------- */

export async function aiMorningPing(user, eventLines, now = new Date()) {
  return ask(
    [
      { role: 'system', content: friendSystem(user) },
      {
        role: 'user',
        content:
          `Сейчас ${fmtUser(now.toISOString(), userOffset(user), true)}. Утро. Вот его дела на сегодня и просроченное:\n` +
          eventLines.join('\n') +
          '\n\nНапиши одно короткое дружеское утреннее сообщение: поздоровайся и напомни про дела своими словами. Без списков, 2-3 предложения.',
      },
    ],
    { maxTokens: 400, timeoutMs: 30000, retryDelays: [0, 5000] }
  );
}

/* ---------- Озвучка ответа (TTS) ---------- */

// polza возвращает JSON {"audio": base64}; на всякий случай понимаем и бинарь.
export async function aiTts(text) {
  const cfg = AUDIO();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000); // без таймаута озвучка могла зависать
  let res;
  try {
    res = await fetch(`${cfg.url}/audio/speech`, {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.AI_TTS_MODEL || 'openai/gpt-4o-mini-tts',
        input: String(text).slice(0, 1500),
        voice: process.env.AI_TTS_VOICE || 'alloy',
        response_format: 'opus',
      }),
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) {
    const data = await res.json();
    if (!data.audio) throw new Error('TTS: нет аудио в ответе');
    return Buffer.from(data.audio, 'base64');
  }
  return Buffer.from(await res.arrayBuffer());
}

/* ---------- Документы ---------- */

// PDF уходит мультимодальной модели файлом; текстовые - обычным текстом.
export async function aiSummarizeDoc(base64, mime, filename) {
  return chatCompletion(
    AUDIO(),
    [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Перескажи по-русски суть документа в 3-6 предложениях: о чём он, ключевые суммы, сроки, обязательства, имена. Просто и без разметки.',
          },
          { type: 'file', file: { filename: filename || 'document.pdf', file_data: `data:${mime};base64,${base64}` } },
        ],
      },
    ],
    { maxTokens: 700, timeoutMs: 60000, retryDelays: [0, 8000] }
  );
}

export async function aiSummarizeText(text, filename) {
  return ask(
    [
      {
        role: 'user',
        content:
          `Документ «${filename || 'без имени'}». Перескажи по-русски суть в 3-6 предложениях: о чём, ключевые суммы, сроки, обязательства, имена. Просто и без разметки.\n\n` +
          String(text).slice(0, 12000),
      },
    ],
    { maxTokens: 700, timeoutMs: 30000, retryDelays: [0, 5000] }
  );
}

/* ---------- Worker: сырые записи -> факты и записи (БД №2) ---------- */

// Из потока дневника извлекаются и факты для памяти, и структурные
// записи (долги, задачи, встречи), которые мог упустить быстрый парсер.
export async function aiExtractFacts(rawItems, now = new Date()) {
  const list = rawItems.map((r, i) => `${i + 1}. ${r.text}`).join('\n');
  const text = await chatCompletion(
    WORKER(),
    [
      {
        role: 'user',
        content:
          `Сегодня ${fmtLocal(now.toISOString(), true)}. Относительные даты («до пятницы», «завтра») считай от этого момента.\n` +
          'Преврати сырые дневниковые записи в память. Верни ТОЛЬКО JSON-объект:\n' +
          '{"facts":[{"text":"короткий факт: кто, что, когда, эмоция","people":["Имя"],"tags":["тема"]}],' +
          '"entries":[{"type":"debt|task|meeting","title":"...","counterparty":"Имя или null","amount":числоИлиNull,' +
          '"direction":"in|out","due":"YYYY-MM-DD или null"}]}\n' +
          'В entries клади ТОЛЬКО явные дела: долг с суммой, задачу с действием, встречу. Болтовню и эмоции - только в facts. ' +
          'ВАЖНО: долг (debt) - только если деньги ЕЩЁ должны («должен», «занял», «до пятницы отдать»). Уже совершённая оплата («заплатил», «оплатил», «купил») - это НЕ долг, такое только в facts. ' +
          'Пустые массивы, если ничего нет.\n\nЗАПИСИ:\n' +
          list,
      },
    ],
    { maxTokens: 1600 }
  );
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const empty = { facts: [], entries: [] };
  if (start < 0 || end <= start) {
    // совместимость: модель могла вернуть голый массив фактов
    const as = text.indexOf('[');
    const ae = text.lastIndexOf(']');
    if (as < 0 || ae <= as) return empty;
    try {
      const arr = JSON.parse(text.slice(as, ae + 1));
      return { facts: cleanFacts(arr), entries: [] };
    } catch {
      return empty;
    }
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return { facts: cleanFacts(parsed.facts), entries: cleanEntries(parsed.entries) };
  } catch {
    return empty;
  }
}

function cleanFacts(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((f) => f && typeof f.text === 'string' && f.text.trim())
    .map((f) => ({
      text: f.text.trim().slice(0, 400),
      people: Array.isArray(f.people) ? f.people.map(String).slice(0, 6) : [],
      tags: Array.isArray(f.tags) ? f.tags.map(String).slice(0, 6) : [],
    }));
}

function cleanEntries(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const e of arr) {
    if (!e || !['debt', 'task', 'meeting'].includes(e.type)) continue;
    const due = typeof e.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.due) ? new Date(e.due + 'T00:00:00').toISOString() : null;
    out.push({
      type: e.type,
      title: String(e.title || '').slice(0, 120) || (e.type === 'debt' ? 'Долг' : e.type === 'task' ? 'Задача' : 'Встреча'),
      counterparty: e.counterparty ? String(e.counterparty).slice(0, 60) : null,
      amount: typeof e.amount === 'number' && isFinite(e.amount) ? e.amount : null,
      direction: e.direction === 'out' ? 'out' : 'in',
      due,
      hasTime: false,
    });
  }
  return out;
}


/* ---------- Медиа (мультимодальный провайдер) ---------- */

// Формат аудио для input_audio по mime-типу Telegram.
export function audioFormatFromMime(mime = '') {
  const m = String(mime).toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('flac')) return 'flac';
  if (m.includes('aac') || m.includes('mp4') || m.includes('m4a')) return 'aac';
  return 'ogg';
}

export async function aiDescribeImage(base64, mime = 'image/jpeg', hint = '') {
  return chatCompletion(
    AUDIO(),
    [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Опиши по-русски одним-двумя простыми предложениями, что на этом изображении.' +
              (hint ? ` Подпись отправителя: «${hint}».` : ''),
          },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      },
    ],
    { maxTokens: 300, timeoutMs: 30000, retryDelays: [0, 5000] }
  );
}

/* ---------- Расшифровка аудио (мультимодальный провайдер) ---------- */

export async function aiTranscribe(base64, format = 'ogg') {
  const text = await chatCompletion(
    AUDIO(),
    [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Расшифруй это голосовое сообщение на русском дословно, без комментариев. Если речи нет, ответь ровно NO_SPEECH.',
          },
          { type: 'input_audio', input_audio: { data: base64, format } },
        ],
      },
    ],
    { maxTokens: 700, timeoutMs: 30000, retryDelays: [0, 5000] }
  );
  if (!text || text.includes('NO_SPEECH')) return null;
  return text;
}
