// Запасная модель: локальный Claude по подписке владельца.
//
// Основной путь — OpenAI-совместимый роутер. Он молча кончился: на балансе
// осталось 0,97 ₽ при цене запроса в рубль, и провайдер начал отвечать 402. Со
// стороны это выглядело не как поломка, а как поглупевший бот: код честно
// ловил ошибку и откатывался на разбор по правилам, а правила — это шаблоны,
// которые путают «созвон в 2:30» с ночью.
//
// Поэтому здесь второй путь, не требующий денег: тот же Claude по подписке,
// которым уже пользуются соседние сервисы на этой машине.
let sdk = null;

export function claudeEnabled() {
  return Boolean((process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim());
}

function proxyEnv() {
  const proxy = (process.env.CLAUDE_PROXY ?? '').trim();
  if (!proxy) return {};
  return { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1' };
}

/** Один проход: собрать текстовый ответ. Бросает, если ничего не вышло. */
export async function askClaude(messages, { timeoutMs = 90000 } = {}) {
  const token = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim();
  if (!token) throw new Error('CLAUDE_CODE_OAUTH_TOKEN не задан');
  if (!sdk) sdk = await import('@anthropic-ai/claude-agent-sdk');

  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const user = messages.filter((m) => m.role !== 'system')
    .map((m) => (m.role === 'assistant' ? `Ассистент: ${m.content}` : `Пользователь: ${m.content}`))
    .join('\n\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const chunks = [];
  try {
    const stream = sdk.query({
      prompt: user,
      options: {
        ...(system ? { systemPrompt: system } : {}),
        // Ходов с запасом: инструментов нет, зациклиться не на чем, а одного
        // хода модели иногда не хватает — тогда поток обрывается с ошибкой.
        maxTurns: 12,
        allowedTools: [],
        abortController: controller,
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_API_KEY: '', ...proxyEnv() },
      },
    });
    try {
      for await (const msg of stream) {
        if (msg?.type !== 'assistant' || !msg.message) continue;
        for (const block of msg.message.content ?? []) {
          if (block?.type === 'text') chunks.push(String(block.text ?? ''));
        }
      }
    } catch (err) {
      // Поток мог оборваться, уже отдав готовый текст — берём что есть.
      if (!chunks.join('').trim()) throw err;
    }
  } finally {
    clearTimeout(timer);
  }
  const text = chunks.join('\n').trim();
  if (!text) throw new Error('Claude вернул пустой ответ');
  return text;
}
