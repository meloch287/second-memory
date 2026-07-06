// Планировщик «живого друга»: утреннее напоминание о делах, вечернее
// предложение подвести итоги, ночная консолидация памяти + Obsidian + бэкап.
// Часы подстраиваются под ритм пользователя из онбординга (сова/жаворонок).

import { join, dirname } from 'node:path';
import { aiEnabled, aiMorningPing, aiConsolidate } from './ai.mjs';
import { exportVault } from './obsidian.mjs';

const DAY_MS = 86400000;

export function morningHour(rhythm) {
  const r = String(rhythm || '').toLowerCase().replace(/ё/g, 'е');
  if (r.includes('жаворон') || r.includes('утр') || r.includes('рано')) return 8;
  if (r.includes('сов') || r.includes('ноч') || r.includes('поздн')) return 11;
  return 9;
}

export function eveningHour(rhythm) {
  const r = String(rhythm || '').toLowerCase().replace(/ё/g, 'е');
  if (r.includes('жаворон') || r.includes('утр') || r.includes('рано')) return 21;
  return 22;
}

const EVENING_PHRASES = [
  '{name}, ну что, как прошёл день? Рассказывай, я запишу.',
  'Вечер, {name}. Что сегодня было главным?',
  '{name}, я тут. Если хочешь, подведём итоги: просто расскажи, как день, или скажи /summary.',
  'Как ты там, {name}? День закончился - самое время выговориться.',
  '{name}, чем сегодня жил? Хоть пару строк, я всё сохраню.',
  'Ну что, {name}, день к концу. Что запомнилось?',
];

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDay = (iso) => {
  const d = new Date(iso);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}${new Date(iso).getHours() || new Date(iso).getMinutes() ? '' : ''}`;
};

// События пользователя на сегодня + просроченные долги.
export function todayEvents(store, chatId, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const end = start + DAY_MS;
  const open = store.list({ status: 'open', chatId });
  const lines = [];
  for (const e of open) {
    if (!e.due) continue;
    const t = Date.parse(e.due);
    if (t >= start && t < end) {
      const kind = e.type === 'debt' ? 'долг' : e.type === 'meeting' ? 'встреча' : 'задача';
      lines.push(`- сегодня (${kind}): ${e.title || e.counterparty || ''}${e.amount ? `, ${e.amount} руб` : ''}${e.hasTime ? `, ${new Date(e.due).getHours()}:${pad(new Date(e.due).getMinutes())}` : ''}`);
    } else if (e.type === 'debt' && t < start) {
      lines.push(`- просрочен долг: ${e.counterparty || e.title}${e.amount ? `, ${e.amount} руб` : ''} (был до ${fmtDay(e.due)})`);
    }
  }
  return lines;
}

export function startScheduler(store, bot, log = console, intervalMs = 300000) {
  let busy = false;
  const tick = async () => {
    if (busy) return; // тик с ИИ-вызовами может пережить интервал - не перекрываемся
    busy = true;
    try {
      await runTick();
    } finally {
      busy = false;
    }
  };

  const runTick = async () => {
    const now = new Date();
    const today = dayKey(now);
    const hour = now.getHours();

    // --- Пинги пользователям бота ---
    if (bot && aiEnabled()) {
      for (const [chatId, user] of Object.entries(store.data.users)) {
        if (!user || user.step) continue;
        try {
          if (hour === morningHour(user.rhythm) && user.lastMorningPing !== today) {
            store.setUser(chatId, { lastMorningPing: today }); // маркер ДО await - защита от двойного пинга
            const events = todayEvents(store, chatId, now);
            if (events.length) {
              const text = await aiMorningPing(user, events, now).catch(() => null);
              if (text) {
                await bot.sendText(chatId, text);
                store.pushHistory('assistant', text, chatId);
              }
            }
          }

          if (hour === eveningHour(user.rhythm) && user.lastEveningPing !== today) {
            store.setUser(chatId, { lastEveningPing: today }); // маркер ДО await
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            const wroteToday = store.rawForDay(chatId, start, start + DAY_MS).length > 0;
            if (wroteToday) {
              const phrase = EVENING_PHRASES[Math.floor(Math.random() * EVENING_PHRASES.length)].replaceAll(
                '{name}',
                user.name || 'дружище'
              );
              await bot.sendText(chatId, phrase);
              store.pushHistory('assistant', phrase, chatId);
            }
          }
        } catch (e) {
          log.error('[scheduler] ping', chatId, e.message);
        }
      }
    }

    // --- Ночные работы: консолидация, Obsidian, бэкап ---
    if (hour === 4 && store.data.meta.lastNight !== today) {
      store.data.meta.lastNight = today;
      store.save();
      try {
        if (aiEnabled()) {
          for (const chatId of Object.keys(store.data.users)) {
            const old = store.data.facts.filter(
              (f) => f.chatId === chatId && Date.now() - Date.parse(f.ts) > 7 * DAY_MS
            );
            if (old.length < 25) continue; // консолидируем только заметные объёмы
            const { facts, personas } = await aiConsolidate(old.slice(0, 120), store.getPersonas(chatId));
            if (facts.length) {
              store.replaceOldFacts(chatId, 7 * DAY_MS, facts);
              store.setPersonas(chatId, { ...store.getPersonas(chatId), ...personas });
              log.log(`[scheduler] консолидация ${chatId}: ${old.length} -> ${facts.length} фактов`);
            }
          }
        }
      } catch (e) {
        log.error('[scheduler] consolidate', e.message);
      }
      try {
        const out = join(dirname(store.file), 'obsidian');
        exportVault(store, out);
        const backupPath = store.backup();
        log.log(`[scheduler] ночь: obsidian обновлён, бэкап ${backupPath}`);
      } catch (e) {
        log.error('[scheduler] night', e.message);
      }
    }
  };

  const interval = setInterval(tick, intervalMs);
  return {
    tick,
    stop() {
      clearInterval(interval);
    },
  };
}
