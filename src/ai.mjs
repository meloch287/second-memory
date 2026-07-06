// ИИ-слой: саммари, свободные вопросы по базе (RAG-подход: контекст = записи
// из хранилища + последние сообщения) и транскрибация аудио.
// Провайдер — любой OpenAI-совместимый API (по умолчанию polza.ai, как в
// проекте Holistica). Настраивается через AI_API_KEY / AI_BASE_URL / AI_MODEL.

const BASE_URL = () => process.env.AI_BASE_URL || 'https://api.polza.ai/v1';
const MODEL = () => process.env.AI_MODEL || 'google/gemini-2.5-flash-lite';

export function aiEnabled() {
  return Boolean(process.env.AI_API_KEY);
}

async function chatCompletion(messages, { maxTokens = 900, timeoutMs = 45000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL()}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${process.env.AI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL(), messages, max_tokens: maxTokens }),
    });
    if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('AI: пустой ответ');
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

const pad = (n) => String(n).padStart(2, '0');

// Даты для ИИ — в локальном времени, иначе UTC-ISO сдвигает сроки на день.
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

function buildContext(store, now) {
  const entries = store.list();
  const open = entries.filter((e) => e.status === 'open');
  const done = entries.filter((e) => e.status !== 'open').slice(-15);
  const history = store.recentHistory(30);
  return [
    `Сейчас: ${fmtLocal(now.toISOString(), true)} (локальное время пользователя).`,
    '',
    `ОТКРЫТЫЕ ЗАПИСИ (${open.length}):`,
    ...(open.length ? open.map(fmtEntry) : ['— пусто —']),
    '',
    `НЕДАВНО ЗАКРЫТЫЕ (${done.length}):`,
    ...(done.length ? done.map(fmtEntry) : ['— пусто —']),
    '',
    'ПОСЛЕДНИЕ СООБЩЕНИЯ ДИАЛОГА:',
    ...(history.length
      ? history.map((h) => `${h.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${h.text.slice(0, 300)}`)
      : ['— пусто —']),
  ].join('\n');
}

const SYSTEM = [
  'Ты — «Вторая память», личный ассистент делового человека (русский язык).',
  'Тебе дают выгрузку его базы: долги (direction: «должны нам» = ему должны, «мы должны» = он должен), встречи, задачи, заметки и последние сообщения диалога.',
  'Отвечай кратко, по делу, обычным текстом без markdown-разметки (без **, #, таблиц).',
  'Суммы форматируй с пробелами (50 000 ₽), даты — как ДД.ММ.ГГГГ.',
  'Никогда не выдумывай записи, которых нет в выгрузке. Если данных нет — так и скажи.',
].join(' ');

export async function aiSummary(store, now = new Date()) {
  return chatCompletion([
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content:
        buildContext(store, now) +
        '\n\nСделай деловое саммари моей базы: 1) долги — кто и сколько должен мне, что должен я, что просрочено или горит; 2) ближайшие встречи; 3) задачи по приоритету срока (записи типа [task]; долги в задачи не дублируй); 4) одна-две строки выводов/рекомендаций. Коротко, структурировано, с заголовками строк. Даты в выгрузке уже в локальном времени — используй их как есть.',
    },
  ]);
}

export async function aiAnswer(store, question, now = new Date()) {
  return chatCompletion([
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: buildContext(store, now) + `\n\nВопрос: ${question}\nОтветь по данным выгрузки.`,
    },
  ]);
}

// Транскрибация аудио через мультимодальную модель (формат: 'ogg' у Telegram).
export async function aiTranscribe(base64, format = 'ogg') {
  const text = await chatCompletion(
    [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Расшифруй это голосовое сообщение на русском дословно, без комментариев. Если речи нет — ответь ровно NO_SPEECH.',
          },
          { type: 'input_audio', input_audio: { data: base64, format } },
        ],
      },
    ],
    { maxTokens: 500 }
  );
  if (!text || text.includes('NO_SPEECH')) return null;
  return text;
}
