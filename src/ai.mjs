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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chatCompletion(cfg, messages, { maxTokens = 1600, timeoutMs = 90000 } = {}) {
  // 429/5xx у шлюзов - обычное дело: до двух повторов с паузой.
  // У GonkaGate лимит поминутный, поэтому паузы длинные.
  const delays = [0, 12000, 35000];
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

function fmtEntry(e) {
  const parts = [`№${e.id} [${e.type}] [${e.status}]`];
  if (e.counterparty) parts.push(`контрагент: ${e.counterparty}`);
  if (e.amount != null) parts.push(`сумма: ${e.amount} руб`);
  if (e.type === 'debt') parts.push(e.direction === 'out' ? 'мы должны' : 'должны нам');
  if (e.title) parts.push(e.title);
  if (e.due) parts.push(`срок: ${fmtLocal(e.due, e.hasTime)}`);
  parts.push(`создано: ${(e.createdAt || '').slice(0, 10)}`);
  return parts.join(' | ');
}

const STYLE = 'Пиши по-русски, коротко и просто. Без markdown-разметки (без **, #, таблиц). Не используй длинное тире, только дефис. Суммы с пробелами (50 000 ₽), даты как ДД.ММ.ГГГГ. Не выдумывай ничего, чего нет в данных.';

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
  return (
    `Ты близкий друг и живой личный дневник одного человека. ${botName} ${name} ${rhythm} ${goal} ` +
    'Общайся на «ты», тепло, неформально, с лёгким юмором, как настоящий друг в переписке. ' +
    'Реагируй на эмоции, сочувствуй, радуйся, иногда задавай один короткий встречный вопрос. ' +
    'Никогда не говори, что ты бот, ИИ или ассистент. Не предлагай «чем могу помочь». ' +
    'Если человек рассказал про дело, долг, встречу или план, подтверди одной фразой, что запомнил. ' +
    'Если спрашивает про прошлое, отвечай по фактам из памяти. Если в памяти пусто, честно скажи по-дружески. ' +
    'Ответ обычно 1-3 предложения. ' +
    STYLE
  );
}

function friendContext(store, chatId, query, now) {
  const user = store.getUser(chatId);
  const facts = store.factsFor(chatId, query, 25);
  const open = store.list({ status: 'open' }).slice(0, 30);
  const history = store.recentHistory(12, chatId);
  return [
    `Сейчас: ${fmtLocal(now.toISOString(), true)}.`,
    '',
    'ПАМЯТЬ (факты из прошлых разговоров):',
    ...(facts.length
      ? facts.map((f) => `- ${f.text}${f.people?.length ? ` [люди: ${f.people.join(', ')}]` : ''} (${fmtLocal(f.ts, false)})`)
      : ['- пока пусто -']),
    '',
    'ДЕЛА И ДОЛГИ (структурированные записи):',
    ...(open.length ? open.map(fmtEntry) : ['- пока пусто -']),
    '',
    'ПОСЛЕДНИЕ СООБЩЕНИЯ:',
    ...history.map((h) => `${h.role === 'user' ? (user?.name || 'Друг') : 'Ты'}: ${h.text.slice(0, 250)}`),
  ].join('\n');
}

export async function aiFriendReply(store, chatId, text, now = new Date()) {
  const user = store.getUser(chatId);
  return ask(
    [
      { role: 'system', content: friendSystem(user) },
      { role: 'user', content: friendContext(store, chatId, text, now) + `\n\nНовое сообщение от него: «${text}»\nОтветь как друг.` },
    ],
    { maxTokens: 1200 }
  );
}

export async function aiDiarySummary(store, chatId, now = new Date()) {
  const user = store.getUser(chatId);
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayRaw = store.rawForDay(chatId, dayStart, dayStart + 86400000);
  const weekFacts = store.factsFor(chatId, '', 40);
  const open = store.list({ status: 'open' }).slice(0, 30);
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
    { maxTokens: 1600 }
  );
}

export async function aiFollowup(store, chatId, kind, now = new Date()) {
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
    { maxTokens: 1200 }
  );
}

/* ---------- Worker: сырые записи -> факты (БД №2) ---------- */

export async function aiExtractFacts(rawItems) {
  const list = rawItems.map((r, i) => `${i + 1}. ${r.text}`).join('\n');
  const text = await ask(
    [
      {
        role: 'user',
        content:
          'Преврати сырые дневниковые записи в короткие структурированные факты для базы памяти. ' +
          'Каждый факт - одно законченное утверждение с деталями (кто, что, когда, эмоция, если есть). ' +
          'Верни ТОЛЬКО JSON-массив без пояснений, формат: ' +
          '[{"text":"...","people":["Имя"],"tags":["тема"]}]. Пустой массив [], если фактов нет.\n\nЗАПИСИ:\n' +
          list,
      },
    ],
    { maxTokens: 1600 }
  );
  try {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((f) => f && typeof f.text === 'string' && f.text.trim())
      .map((f) => ({
        text: f.text.trim().slice(0, 400),
        people: Array.isArray(f.people) ? f.people.map(String).slice(0, 6) : [],
        tags: Array.isArray(f.tags) ? f.tags.map(String).slice(0, 6) : [],
      }));
  } catch {
    return [];
  }
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
    { maxTokens: 300 }
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
    { maxTokens: 700 }
  );
  if (!text || text.includes('NO_SPEECH')) return null;
  return text;
}
