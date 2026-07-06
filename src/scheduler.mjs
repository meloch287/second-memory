// Планировщик «живого друга»:
//  - точные напоминания по времени (в момент срока);
//  - повторяющиеся напоминания (каждый день / неделю / месяц);
//  - утренний план и вечернее «как день» + вопрос о просроченном;
//  - ночная консолидация памяти + Obsidian + бэкап.
// Всё считается в часовом поясе пользователя (tz.mjs).

import { join, dirname } from 'node:path';
import { aiEnabled, aiMorningPing, aiConsolidate, aiCheckin } from './ai.mjs';
import { exportVault } from './obsidian.mjs';
import { wall, userDayBounds, userOffset, fmtUser } from './tz.mjs';
import { todayWeather, weatherLine } from './weather.mjs';

const DEFAULT_LEAD = 15; // напоминать за 15 минут по умолчанию

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

// dayKey в часовом поясе пользователя (для дедупа пингов/повторов).
function userDayKey(user, now) {
  const w = wall(user, now);
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
}

// События пользователя на сегодня + просроченные долги (для утреннего плана).
export function todayEvents(store, chatId, now = new Date()) {
  const user = store.getUser(chatId);
  const off = userOffset(user);
  const { start, end } = userDayBounds(user, now);
  const open = store.list({ status: 'open', chatId });
  const lines = [];
  for (const e of open) {
    if (!e.due) continue;
    const t = Date.parse(e.due);
    if (t >= start && t < end) {
      const kind = e.type === 'debt' ? 'долг' : e.type === 'meeting' ? 'встреча' : 'задача';
      lines.push(`- сегодня (${kind}): ${e.title || e.counterparty || ''}${e.amount ? `, ${e.amount} руб` : ''}${e.hasTime ? `, ${fmtUser(e.due, off, true).slice(-5)}` : ''}`);
    } else if (e.type === 'debt' && t < start) {
      lines.push(`- просрочен долг: ${e.counterparty || e.title}${e.amount ? `, ${e.amount} руб` : ''} (был до ${fmtUser(e.due, off, false)})`);
    }
  }
  return lines;
}

// Должно ли повторяющееся правило сработать в текущую минуту юзера.
export function recurringDue(rule, wallNow, lastFired, dayKey) {
  if (lastFired === dayKey) return false;
  if (wallNow.getUTCHours() !== rule.hour || wallNow.getUTCMinutes() !== rule.min) {
    // допускаем окно в 4 минуты, чтобы не проскочить между тиками
    const cur = wallNow.getUTCHours() * 60 + wallNow.getUTCMinutes();
    const target = rule.hour * 60 + rule.min;
    if (cur < target || cur > target + 4) return false;
  }
  if (rule.kind === 'daily') return true;
  if (rule.kind === 'weekly') return wallNow.getUTCDay() === rule.weekday;
  if (rule.kind === 'monthly') return wallNow.getUTCDate() === rule.day;
  return false;
}

export function startScheduler(store, bot, log = console, intervalMs = 60000) {
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

    if (bot) {
      for (const [chatId, user] of Object.entries(store.data.users)) {
        if (!user || user.step) continue;
        try {
          await perUser(chatId, user, now);
        } catch (e) {
          log.error('[scheduler] user', chatId, e.message);
        }
      }
    }

    // --- Ночные работы: 4 утра по серверу, раз в сутки ---
    const serverDay = now.toISOString().slice(0, 10);
    if (now.getHours() === 4 && store.data.meta.lastNight !== serverDay) {
      store.data.meta.lastNight = serverDay;
      store.save();
      await nightJobs(now);
    }
  };

  const perUser = async (chatId, user, now) => {
    const off = userOffset(user);
    const w = wall(user, now);
    const hour = w.getUTCHours();
    const today = userDayKey(user, now);
    const quiet = hour >= 23 || hour < 7; // «тихий час»: ночью не дёргаем по делам

    // 1) Точные напоминания по времени (за lead минут до срока)
    const lead = Number.isFinite(user.remindLead) ? user.remindLead : DEFAULT_LEAD;
    for (const e of store.dueReminders(chatId, now.getTime(), lead)) {
      store.patch(e.id, { reminded: true });
      const t = fmtUser(e.due, off, true).slice(-5);
      const early = Date.parse(e.due) > now.getTime();
      const head = early ? `🔔 Через ${Math.max(1, Math.round((Date.parse(e.due) - now.getTime()) / 60000))} мин (${t})` : `🔔 Пора (${t})`;
      await bot.sendButtons(chatId, `${head}: ${e.title || e.counterparty || 'дело'}`, [
        [{ text: '✅ Сделал', callback_data: `done_${e.id}` }, { text: '⏰ +1 час', callback_data: `snooze_${e.id}_60` }],
        [{ text: 'Завтра', callback_data: `snooze_${e.id}_1440` }, { text: 'Через неделю', callback_data: `snooze_${e.id}_10080` }],
      ]);
    }

    // 2) Повторяющиеся
    for (const r of store.recurringFor(chatId)) {
      if (recurringDue(r, w, r.lastFired, today)) {
        store.markRecurringFired(r.id, today);
        await bot.sendText(chatId, `🔁 Напоминаю: ${r.title}`);
      }
    }

    if (!aiEnabled()) return;
    if (user.isGroup) return; // группам - только напоминания, без личных пингов

    // 3) Утренний план + погода (если знаем город). В тихий час не пингуем.
    if (!quiet && hour === morningHour(user.rhythm) && user.lastMorningPing !== today) {
      store.setUser(chatId, { lastMorningPing: today });
      const events = todayEvents(store, chatId, now);
      const wl = user.city ? weatherLine(await todayWeather(user.city)) : null;
      if (events.length || wl) {
        const ctx = [...events];
        if (wl) ctx.push(wl);
        const text = await aiMorningPing(user, ctx, now).catch(() => null);
        if (text) {
          await bot.sendText(chatId, text);
          store.pushHistory('assistant', text, chatId);
        }
      }
    }

    // 4) Вечер: «как день» + вопрос о просроченном (№9). В тихий час - нет.
    if (!quiet && hour === eveningHour(user.rhythm) && user.lastEveningPing !== today) {
      store.setUser(chatId, { lastEveningPing: today });
      const { start, end } = userDayBounds(user, now);
      const wroteToday = store.rawForDay(chatId, start, end).length > 0;
      if (wroteToday) {
        // Если день был тяжёлым - тёплый эмпатичный check-in вместо обычного
        const lowToday = user.lastLowMoodDay === `${w.getUTCFullYear()}-${w.getUTCMonth()}-${w.getUTCDate()}`;
        let phrase;
        if (lowToday) phrase = await aiCheckin(store, chatId, now).catch(() => null);
        if (!phrase) phrase = EVENING_PHRASES[Math.floor(Math.random() * EVENING_PHRASES.length)].replaceAll('{name}', user.name || 'дружище');
        await bot.sendText(chatId, phrase);
        store.pushHistory('assistant', phrase, chatId);
      }
      // спросить про самое старое просроченное дело - только днём/вечером
      const overdue = store.overdue(chatId, now.getTime()).filter((e) => e.type !== 'debt' || e.hasTime);
      const item = overdue[overdue.length - 1];
      if (item && hour >= 9 && hour < 22) {
        await bot.sendButtons(chatId, `Кстати, «${item.title || item.counterparty}» так и висит с ${fmtUser(item.due, off, false)}. Сделал уже?`, [
          [{ text: '✅ Да, сделал', callback_data: `done_${item.id}` }, { text: 'Ещё нет', callback_data: `keep_${item.id}` }],
        ]);
      }
    }
  };

  const nightJobs = async (now) => {
    try {
      if (aiEnabled()) {
        for (const chatId of Object.keys(store.data.users)) {
          const old = store.data.facts.filter((f) => f.chatId === chatId && now.getTime() - Date.parse(f.ts) > 7 * DAY_MS);
          if (old.length < 25) continue;
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
  };

  const interval = setInterval(tick, intervalMs);
  return {
    tick,
    stop() {
      clearInterval(interval);
    },
  };
}
