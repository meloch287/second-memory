// Фоновый worker: сырые записи (БД №1) -> ИИ-суммаризация -> факты с
// эмбеддингами (БД №2) + структурные записи (долги/задачи/встречи),
// которые мог упустить быстрый парсер. Факты читает RAG бота-друга.

import { aiEnabled, aiExtractFacts, aiEmbed } from './ai.mjs';

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

// ИИ-запись считается дублем, если у пользователя уже есть похожая
// открытая запись: тот же тип и совпадающая сумма или похожее название.
export function isDuplicateEntry(candidate, existing) {
  for (const e of existing) {
    if (e.type !== candidate.type) continue;
    if (candidate.amount != null && e.amount === candidate.amount) return true;
    const a = norm(candidate.title);
    const b = norm(e.title);
    if (a && b && (a.includes(b) || b.includes(a))) return true;
    if (
      candidate.counterparty &&
      e.counterparty &&
      norm(candidate.counterparty).slice(0, 5) === norm(e.counterparty).slice(0, 5)
    ) {
      return true;
    }
  }
  return false;
}

export function startFactWorker(store, log = console, intervalMs = 600000) {
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
          const { facts, entries } = await aiExtractFacts(items);

          if (facts.length) {
            let embeddings = [];
            try {
              embeddings = await aiEmbed(facts.map((f) => f.text));
            } catch (e) {
              log.error('[worker] embed', e.message); // факты сохраняем и без векторов
            }
            store.addFacts(facts.map((f, i) => ({ ...f, chatId, embedding: embeddings[i] || undefined })));
          }

          const existing = store.list({ status: 'open', chatId });
          let added = 0;
          for (const entry of entries) {
            if (isDuplicateEntry(entry, existing)) continue;
            store.add({ ...entry, chatId, text: entry.title, source: 'ai' });
            added++;
          }

          store.markRawProcessed(items.map((i) => i.id));
          if (facts.length || added) {
            log.log(`[worker] чат ${chatId}: +${facts.length} фактов, +${added} записей из ${items.length} заметок`);
          }
        }
      }
    } catch (e) {
      log.error('[worker]', e.message);
    }
    busy = false;
  };

  const interval = setInterval(tick, intervalMs);
  const kickoff = setTimeout(tick, 90000);

  return {
    tick,
    stop() {
      clearInterval(interval);
      clearTimeout(kickoff);
    },
  };
}
