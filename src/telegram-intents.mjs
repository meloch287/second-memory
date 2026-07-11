// Спец-намерения (правки, повторы, поиск, деньги, графики, календарь и т.д.) -
// самый большой роутер команд, распознанных parseMessage. Вынесено из
// telegram.mjs как отдельный кластер. Фабрика: все внешние зависимости
// (api/send/store/... и локальные хелперы telegram.mjs) приходят снаружи.

import { parseMessage } from './parser.mjs';
import { userOffset, wall, resolveWallDate, combineDayTime, fmtUser, parseTz } from './tz.mjs';
import { aiEnabled, aiSearch, aiChartSpec, aiSplit, audioEnabled } from './ai.mjs';
import { balanceReport, expensesReport, monthCategorySpent, budgetsReport } from './finance.mjs';
import { RUB } from './format.mjs';
import { renderChart, chartAvailable } from './chart.mjs';
import { currencyReply } from './currency.mjs';
import { esc } from './telegram-helpers.mjs';

export function createIntentHandler(deps) {
  const { api, send, store, log, kindOf, withTyping, sleepyText, typingLoop, sendPhoto, settingsText, upcomingEvents } = deps;

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

    // Дни рождения (№4): сохранить и показать; поздравляет scheduler
    if (p.kind === 'birthday') {
      const who = p.person || user?.name || 'Ты';
      const birthdays = { ...(store.getUser(String(chatId))?.birthdays || {}) };
      birthdays[who] = `${p.day}.${p.month}`;
      store.setUser(String(chatId), { birthdays });
      store.addFacts([{ chatId: String(chatId), text: `День рождения ${who} - ${p.day}.${String(p.month).padStart(2, '0')}`, people: [who] }]);
      await send(chatId, `Записал: др ${esc(who)} - ${p.day}.${String(p.month).padStart(2, '0')} 🎂 Поздравлю и напомню.`);
      return true;
    }
    if (p.kind === 'birthdays') {
      const birthdays = store.getUser(String(chatId))?.birthdays || {};
      const list = Object.entries(birthdays);
      if (!list.length) { await send(chatId, 'Пока ни одного др не знаю. Скажи «у Димы др 15 августа» - запомню.'); return true; }
      const lines = list
        .map(([who, dm]) => ({ who, dm, key: dm.split('.').reverse().map((x) => x.padStart(2, '0')).join('') }))
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(({ who, dm }) => `🎂 ${who}: ${dm.split('.').map((x) => x.padStart(2, '0')).join('.')}`);
      await send(chatId, esc('Дни рождения:\n' + lines.join('\n')));
      return true;
    }

    // Курсы валют (№12)
    if (p.kind === 'currency') {
      try {
        await send(chatId, esc(await currencyReply(p.request)));
      } catch (e) {
        log.error('[telegram] currency', e.message);
        await send(chatId, 'Курс сейчас не достался. Попробуй через минуту?');
      }
      return true;
    }

    if (p.kind === 'expenses') {
      await send(chatId, esc(expensesReport(store, String(chatId), userOffset(user))));
      return true;
    }

    if (p.kind === 'chart') {
      if (!aiEnabled()) { await send(chatId, 'Для графиков нужен ИИ, а ключа нет.'); return true; }
      if (!chartAvailable()) { await send(chatId, 'Рисовалка графиков не настроена на сервере (нет matplotlib).'); return true; }
      const stop = typingLoop(chatId, 'upload_photo');
      try {
        const spec = await aiChartSpec(store, String(chatId), p.request);
        if (spec.refuse) {
          await send(chatId, esc(`Пока не из чего рисовать: ${spec.refuse}. Накидай данных - и построю.`));
          return true;
        }
        const png = renderChart(spec);
        const r = await sendPhoto(chatId, png, spec.comment || spec.title || '');
        if (!r.ok) throw new Error(r.description || 'sendPhoto failed');
      } catch (e) {
        log.error('[telegram] chart', e.message);
        await send(chatId, 'График не собрался. Попробуй переформулировать?');
      } finally {
        stop();
      }
      return true;
    }

    if (p.kind === 'expense') {
      store.add({ type: 'expense', title: p.category, category: p.category, amount: p.amount, chatId: String(chatId), text: p.text, status: 'done' });
      store.addRaw(String(chatId), p.text); // пусть попадёт и в память дневника
      let note = '';
      // бюджет (№8): предупреждаем при 80%, ругаемся при перерасходе
      const budgets = store.getUser(String(chatId))?.budgets || {};
      for (const [cat, limit] of Object.entries(budgets)) {
        const c = cat.toLowerCase().replace(/ё/g, 'е');
        const pc = p.category.toLowerCase().replace(/ё/g, 'е');
        if (c === pc || c.includes(pc) || pc.includes(c)) {
          const spent = monthCategorySpent(store, String(chatId), cat, userOffset(user));
          if (spent > limit) note = `\n🔴 Бюджет «${esc(cat)}» пробит: ${RUB.format(spent)} из ${RUB.format(limit)} ₽!`;
          else if (spent >= limit * 0.8) note = `\n🟡 Уже ${RUB.format(spent)} из ${RUB.format(limit)} ₽ по «${esc(cat)}» - аккуратнее.`;
        }
      }
      await send(chatId, `Записал трату: ${esc(p.category)} - ${RUB.format(p.amount)} ₽ 💸${note}`);
      return true;
    }

    if (p.kind === 'setbudget') {
      const budgets = { ...(store.getUser(String(chatId))?.budgets || {}) };
      budgets[p.category] = p.amount;
      store.setUser(String(chatId), { budgets });
      await send(chatId, `Принял: бюджет на «${esc(p.category)}» - ${RUB.format(p.amount)} ₽ в месяц. Предупрежу на 80%.`);
      return true;
    }

    if (p.kind === 'budgets') {
      await send(chatId, esc(budgetsReport(store, String(chatId), userOffset(user))));
      return true;
    }

    if (p.kind === 'poll') {
      const r = await api('sendPoll', { chat_id: chatId, question: p.question, options: p.options.map((o) => ({ text: o })), is_anonymous: false });
      if (!r.ok) await send(chatId, 'Опрос не создался: ' + esc(r.description || 'ошибка'));
      return true;
    }

    if (p.kind === 'split') {
      if (!aiEnabled()) { await send(chatId, 'Для подсчёта складчины нужен ИИ, а ключа нет.'); return true; }
      try {
        const answer = await withTyping(chatId, () => aiSplit(store, String(chatId), p.request));
        await send(chatId, esc(answer));
      } catch (e) {
        log.error('[telegram] split', e.message);
        await send(chatId, 'Не смог посчитать. Попробуй ещё раз?');
      }
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
      // ставим флаг и пускаем текст дальше в разговор: бот сразу ответит
      // голосом на сам вопрос («запиши голосовым, что думаешь про...»)
      store.setUser(String(chatId), { voiceNext: true });
      return false;
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

  return { handleIntent };
}
