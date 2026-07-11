// Скиллы ИИ: специализированные функции (графики, поздравления, сплиты,
// чеки, документы, worker-извлечение фактов, медиа). Вынесены из ai.mjs,
// чтобы файл не разрастался - используют примитивы ai.mjs (ask,
// chatCompletion, AUDIO, WORKER, fmtLocal, friendSystem, STYLE_FMT).

import { userOffset, fmtUser } from './tz.mjs';
import { ask, chatCompletion, AUDIO, WORKER, fmtLocal, friendSystem, STYLE_FMT } from './ai.mjs';

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

/* ---------- Озвучка ответа (TTS) ---------- */

// polza возвращает JSON {"audio": base64}; на всякий случай понимаем и бинарь.
export async function aiTts(text, voice) {
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
        voice: voice || process.env.AI_TTS_VOICE || 'alloy',
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
