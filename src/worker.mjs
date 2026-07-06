// Фоновый worker: сырые записи (БД №1) -> ИИ-суммаризация -> факты (БД №2).
// Факты потом читает RAG-контекст бота-друга.

import { aiEnabled, aiExtractFacts } from './ai.mjs';

export function startFactWorker(store, log = console, intervalMs = 180000) {
  if (!aiEnabled()) return null;

  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const batch = store.unprocessedRaw(30);
      if (batch.length) {
        // Группируем по чату: факты наследуют chatId своей группы
        const byChat = new Map();
        for (const r of batch) {
          if (!byChat.has(r.chatId)) byChat.set(r.chatId, []);
          byChat.get(r.chatId).push(r);
        }
        for (const [chatId, items] of byChat) {
          const facts = await aiExtractFacts(items);
          if (facts.length) store.addFacts(facts.map((f) => ({ ...f, chatId })));
          store.markRawProcessed(items.map((i) => i.id));
          if (facts.length) log.log(`[worker] чат ${chatId}: +${facts.length} фактов из ${items.length} записей`);
        }
      }
    } catch (e) {
      log.error('[worker]', e.message);
    }
    busy = false;
  };

  const interval = setInterval(tick, intervalMs);
  const kickoff = setTimeout(tick, 20000);

  return {
    tick,
    stop() {
      clearInterval(interval);
      clearTimeout(kickoff);
    },
  };
}
