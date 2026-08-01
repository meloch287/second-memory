// Личный кабинет (Settings) + CRUD долгов через текст и инлайн-кнопки (U3a-ui).
// Фабрика в духе createMediaHandlers/createIntentHandler: все внешние
// зависимости приходят снаружи (telegram.mjs), ничего не импортирует из них.
//
// Многошаговые сценарии (добавить/изменить долг) держат состояние в Map
// pending: chatId -> { mode: 'add' | 'edit', id? }. Живёт в памяти процесса -
// это ок, апдейты одного чата уже сериализует очередь bota (chatQueues).
// Голос как ввод не разбираем тут: consumeInput получает уже готовый текст,
// так что расшифрованное голосовое тоже подошло бы, если его туда завести -
// но по ТЗ голос лишь бонус, обязателен только текст+кнопки.

import { extractAmount } from './dates.mjs';
import { resolveWallDate, userOffset, fmtUser } from './tz.mjs';
import { captureEntry, entryConfirmation } from './brain.mjs';
import { money } from './format.mjs';
import { esc } from './telegram-helpers.mjs';

const KIND_WORD = { debt: 'долг', meeting: 'встреча', task: 'задача', note: 'заметка' };

const BACK_HOME_KB = [[{ text: '‹ Назад', callback_data: 'lk:home' }]];
const BACK_DEBTS_KB = [[{ text: '‹ Назад', callback_data: 'lk:debts' }]];

export function createLkHandler(deps) {
  const { store, send, sendButtons, api, log } = deps;

  // chatId(string) -> { mode: 'add' } | { mode: 'edit', id }
  const pending = new Map();

  /* ---- Тексты и клавиатуры ---- */

  function homeKb() {
    return [
      [{ text: '🏋️ Фитнес', callback_data: 'lk:fit' }],
      [{ text: '💸 Долги', callback_data: 'lk:debts' }, { text: '🎁 Вишлист', callback_data: 'lk:wish' }],
    ];
  }

  function homeText(chatId) {
    const s = store.getStats(String(chatId));
    return [
      '⚙️ Личный кабинет',
      '',
      `📊 Запросов Толику: ${s.requests}`,
      `🧠 Фактов помню: ${s.facts}`,
      `💸 Открытых долгов: ${s.openDebts}`,
      `✅ Задач: ${s.openTasks}`,
      `📅 Встреч: ${s.openMeetings}`,
      `🎁 Вишлист: ${s.wishlist}`,
      `📆 Со мной дней: ${s.days}`,
    ].join('\n');
  }

  // «Иванов должен вам 50 000, срок 20.07.2026» / «Вы должны Пете 5 000, срок ...»
  function debtLine(d, off) {
    const sum = d.amount != null ? money(d.amount) : 'сумма не указана';
    const who =
      d.direction === 'out'
        ? `Вы должны${d.counterparty ? ' ' + esc(d.counterparty) : ''}`
        : d.counterparty
          ? `${esc(d.counterparty)} должен вам`
          : 'Вам должны';
    const due = d.due ? `, срок ${esc(fmtUser(d.due, off, false))}` : '';
    return `№${d.id} — ${who} ${sum}${due}`;
  }

  function debtsText(debts, off) {
    if (!debts.length) return '💸 Долги\n\nДолгов нет.';
    return ['💸 Долги', '', ...debts.map((d) => debtLine(d, off))].join('\n');
  }

  function debtsKb(debts) {
    const rows = debts.map((d) => [
      { text: `✏️ №${d.id}`, callback_data: `lk:debt:edit:${d.id}` },
      { text: `🗑 №${d.id}`, callback_data: `lk:debt:del:${d.id}` },
    ]);
    rows.push([{ text: '➕ Добавить долг', callback_data: 'lk:debt:add' }]);
    rows.push([{ text: '‹ Назад', callback_data: 'lk:home' }]);
    return rows;
  }

  function editDebtKb(id) {
    return [
      [{ text: '✅ Погашен', callback_data: `lk:debt:done:${id}` }],
      [{ text: '✏️ Изменить сумму/срок', callback_data: `lk:debt:amount:${id}` }],
      [{ text: '‹ Назад', callback_data: 'lk:debts' }],
    ];
  }

  function delConfirmKb(id) {
    return [[
      { text: 'Да, удалить', callback_data: `lk:debt:delyes:${id}` },
      { text: 'Отмена', callback_data: `lk:debt:delno:${id}` },
    ]];
  }

  /* ---- Доставка: правим текущее сообщение, иначе шлём новое ---- */

  async function render(chatId, messageId, text, inline_keyboard) {
    if (messageId) {
      const r = await api('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: inline_keyboard ? { inline_keyboard } : undefined,
      }).catch((e) => {
        log?.error?.('[lk] editMessageText', e?.message);
        return null;
      });
      if (r && r.ok) return r;
    }
    return send(chatId, text, inline_keyboard ? { reply_markup: { inline_keyboard } } : {});
  }

  function ownedDebt(chatId, id) {
    const e = store.byId(id);
    return e && e.type === 'debt' && String(e.chatId || 'web') === String(chatId) ? e : null;
  }

  async function showDebts(chatId, messageId, user) {
    const debts = store.list({ type: 'debt', status: 'open', chatId: String(chatId) });
    const off = userOffset(user);
    return render(chatId, messageId, debtsText(debts, off), debtsKb(debts));
  }

  /* ---- Точки входа фабрики ---- */

  async function openSettings(chatId, _user) {
    pending.delete(String(chatId));
    return sendButtons(chatId, homeText(chatId), homeKb());
  }

  function pendingInput(chatId) {
    return pending.has(String(chatId));
  }

  async function onCallback(chatId, data, cbq, user) {
    if (!data || !data.startsWith('lk:')) return false;
    const messageId = cbq?.message?.message_id;
    const id = String(chatId);

    if (data === 'lk:home') {
      pending.delete(id);
      await render(chatId, messageId, homeText(chatId), homeKb());
      return true;
    }
    if (data === 'lk:fit') {
      pending.delete(id);
      await render(chatId, messageId, '🏋️ Личный тренер — в разработке, включим в следующей фазе.', BACK_HOME_KB);
      return true;
    }
    if (data === 'lk:wish') {
      pending.delete(id);
      await render(chatId, messageId, '🎁 Вишлист скоро будет здесь — этот раздел ещё не готов.', BACK_HOME_KB);
      return true;
    }
    if (data === 'lk:debts') {
      pending.delete(id);
      await showDebts(chatId, messageId, user);
      return true;
    }
    if (data === 'lk:debt:add') {
      pending.set(id, { mode: 'add' });
      await render(
        chatId,
        messageId,
        'Опиши долг текстом или голосом — например: «Иванов должен 50000 до 20 июля» или «я должен Пете 5000 через неделю».',
        BACK_DEBTS_KB
      );
      return true;
    }

    let m;
    if ((m = data.match(/^lk:debt:edit:(\d+)$/))) {
      const e = ownedDebt(chatId, Number(m[1]));
      if (!e) { await showDebts(chatId, messageId, user); return true; }
      const off = userOffset(user);
      await render(chatId, messageId, `Долг ${debtLine(e, off)}\n\nЧто сделать?`, editDebtKb(e.id));
      return true;
    }
    if ((m = data.match(/^lk:debt:done:(\d+)$/))) {
      const e = ownedDebt(chatId, Number(m[1]));
      if (e) store.setStatus(e.id, 'done');
      pending.delete(id);
      await showDebts(chatId, messageId, user);
      return true;
    }
    if ((m = data.match(/^lk:debt:amount:(\d+)$/))) {
      const e = ownedDebt(chatId, Number(m[1]));
      if (!e) { await showDebts(chatId, messageId, user); return true; }
      pending.set(id, { mode: 'edit', id: e.id });
      await render(chatId, messageId, 'Пришли новую сумму и/или срок — например: «70000 до 25 июля» или просто «80000».', BACK_DEBTS_KB);
      return true;
    }
    if ((m = data.match(/^lk:debt:del:(\d+)$/))) {
      const e = ownedDebt(chatId, Number(m[1]));
      if (!e) { await showDebts(chatId, messageId, user); return true; }
      await render(chatId, messageId, `Удалить долг №${e.id} «${esc(e.counterparty || e.title || '')}»?`, delConfirmKb(e.id));
      return true;
    }
    if ((m = data.match(/^lk:debt:delyes:(\d+)$/))) {
      const e = ownedDebt(chatId, Number(m[1]));
      if (e) store.remove(e.id);
      pending.delete(id);
      await showDebts(chatId, messageId, user);
      return true;
    }
    if (/^lk:debt:delno:\d+$/.test(data)) {
      await showDebts(chatId, messageId, user);
      return true;
    }

    return true; // префикс lk: узнали, конкретное действие - нет: молча гасим клик
  }

  /* ---- Многошаговые сценарии: следующее сообщение после кнопки ---- */

  async function consumeInput(chatId, user, text) {
    const id = String(chatId);
    const p = pending.get(id);
    if (!p) return false;

    if (p.mode === 'add') {
      pending.delete(id);
      const off = userOffset(user);
      const captured = captureEntry(store, text, new Date(), id, off);
      if (!captured) {
        // ничего не распознали (болтовня/заметка) - даём попробовать ещё раз
        pending.set(id, p);
        await send(chatId, 'Не понял, это долг? Опиши ещё раз, например: «Иванов должен 50000 до 20 июля».');
        return true;
      }
      if (captured.type === 'debt') {
        await send(chatId, esc(entryConfirmation(captured, off)));
      } else {
        // captureEntry уже сохранил запись (встречу/задачу) - не долг, но и не теряем
        await send(chatId, esc(`Похоже, это не долг — записал как ${KIND_WORD[captured.type] || 'запись'}. ${entryConfirmation(captured, off)}`));
      }
      await showDebts(chatId, null, user);
      return true;
    }

    if (p.mode === 'edit') {
      pending.delete(id);
      const e = ownedDebt(chatId, p.id);
      if (!e) { await send(chatId, 'Этот долг уже не найден - возможно, удалён.'); return true; }
      const off = userOffset(user);
      const r = resolveWallDate(off, text, new Date());
      const { amount } = extractAmount(text);
      if (amount == null && !r.due) {
        pending.set(id, p);
        await send(chatId, 'Не понял сумму или срок. Пришли, например: «70000 до 25 июля» или просто «80000».');
        return true;
      }
      const patch = {};
      if (amount != null) patch.amount = amount;
      if (r.due) { patch.due = r.due; patch.hasTime = r.hasTime; patch.reminded = false; }
      store.patch(e.id, patch);
      await send(chatId, `Обновил долг №${e.id}.`);
      await showDebts(chatId, null, user);
      return true;
    }

    pending.delete(id);
    return false;
  }

  return { openSettings, onCallback, pendingInput, consumeInput };
}
