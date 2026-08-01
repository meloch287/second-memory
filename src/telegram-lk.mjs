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
import { parseProduct as parseProductLive } from './wlparse.mjs';

const KIND_WORD = { debt: 'долг', meeting: 'встреча', task: 'задача', note: 'заметка' };

const BACK_HOME_KB = [[{ text: '‹ Назад', callback_data: 'lk:home' }]];
const BACK_DEBTS_KB = [[{ text: '‹ Назад', callback_data: 'lk:debts' }]];
const BACK_WISH_KB = [[{ text: '‹ Назад', callback_data: 'lk:wish' }]];

export function createLkHandler(deps) {
  // parseProduct - переопределяемая зависимость (тесты подсовывают фейк вместо
  // реального сетевого похода в wlparse.mjs); в проде telegram.mjs передаёт ту
  // же функцию явно, а дефолт здесь - просто страховка.
  const { store, send, sendButtons, api, log, parseProduct = parseProductLive } = deps;

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

  /* ---- Вишлист: тексты и клавиатуры (U3c-ui) ---- */

  function wishLine(w, i) {
    const price = w.price != null ? ` — ${money(w.price)}` : '';
    return `${i + 1}. ${esc(w.title || '(без названия)')}${price}`;
  }

  function wishText(items) {
    if (!items.length) return '🎁 Вишлист\n\nВишлист пуст.';
    return [`🎁 Вишлист (${items.length})`, '', ...items.map(wishLine)].join('\n');
  }

  // Кнопка "посмотреть фото" открывает галерею по всем товарам (даже без фото -
  // там просто покажется текстовая карточка), поэтому висит всегда, когда список не пуст.
  function wishKb(items) {
    const rows = [];
    if (items.length) rows.push([{ text: '👁 Посмотреть фото', callback_data: 'lk:wish:view:0' }]);
    items.forEach((w, i) => {
      rows.push([
        { text: `✏️ ${i + 1}`, callback_data: `lk:wish:edit:${w.id}` },
        { text: `🗑 ${i + 1}`, callback_data: `lk:wish:del:${w.id}` },
      ]);
    });
    rows.push([{ text: '➕ Добавить', callback_data: 'lk:wish:add' }]);
    rows.push([{ text: '‹ Назад', callback_data: 'lk:home' }]);
    return rows;
  }

  const ADD_CHOICE_KB = [
    [
      { text: '🔗 По ссылке', callback_data: 'lk:wish:add:url' },
      { text: '✍️ Вручную', callback_data: 'lk:wish:add:manual' },
    ],
    [{ text: '‹ Отмена', callback_data: 'lk:wish' }],
  ];

  function editWishKb(id) {
    return [
      [{ text: '✏️ Название', callback_data: `lk:wish:edit:title:${id}` }],
      [{ text: '📝 Описание', callback_data: `lk:wish:edit:desc:${id}` }],
      [{ text: '🔗 Ссылка', callback_data: `lk:wish:edit:url:${id}` }],
      [{ text: '‹ Назад', callback_data: 'lk:wish' }],
    ];
  }

  function editWishText(w) {
    const price = w.price != null ? ` — ${money(w.price)}` : '';
    return `${esc(w.title || '(без названия)')}${price}\n\nЧто изменить?`;
  }

  function delWishConfirmKb(id) {
    return [[
      { text: 'Да, удалить', callback_data: `lk:wish:delyes:${id}` },
      { text: 'Отмена', callback_data: `lk:wish:delno:${id}` },
    ]];
  }

  function galleryCaption(idx, total, w) {
    const lines = [`${idx + 1}/${total} — ${esc(w.title || '(без названия)')}`];
    if (w.desc) lines.push('', esc(w.desc));
    if (w.url) lines.push(esc(w.url));
    return lines.join('\n');
  }

  // Клампим соседей на границах (0 и total-1) - крайние стрелки просто
  // перерисовывают тот же индекс вместо ошибки/перехода "за край".
  function galleryKb(idx, total) {
    const prev = Math.max(0, idx - 1);
    const next = Math.min(total - 1, idx + 1);
    return [
      [
        { text: '‹', callback_data: `lk:wish:view:${prev}` },
        { text: `${idx + 1}/${total}`, callback_data: 'lk:wish:nop' },
        { text: '›', callback_data: `lk:wish:view:${next}` },
      ],
      [{ text: '‹ Назад к списку', callback_data: 'lk:wish' }],
    ];
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

  function ownedWish(chatId, id) {
    const w = store.wishById(id);
    return w && String(w.chatId) === String(chatId) ? w : null;
  }

  async function showWish(chatId, messageId) {
    const items = store.listWish(String(chatId));
    return render(chatId, messageId, wishText(items), wishKb(items));
  }

  // Галерею всегда шлём новым сообщением (не редактируем предыдущее) - фото/текст
  // сообщения телеграм не редактируются друг в друга во всех клиентах одинаково,
  // а свежее сообщение на каждый шаг навигации проще и надёжнее.
  async function showWishGallery(chatId, index) {
    const items = store.listWish(String(chatId));
    if (!items.length) {
      return render(chatId, null, wishText(items), wishKb(items));
    }
    const total = items.length;
    const idx = Math.max(0, Math.min(index, total - 1));
    const w = items[idx];
    const caption = galleryCaption(idx, total, w);
    const kb = galleryKb(idx, total);

    if (Array.isArray(w.photos) && w.photos.length) {
      const r = await api('sendPhoto', {
        chat_id: chatId,
        photo: w.photos[0],
        caption,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: kb },
      }).catch((e) => {
        log?.error?.('[lk] sendPhoto', e?.message);
        return null;
      });
      if (r && r.ok) return r;
      // Фото не долетело (битая/недоступная ссылка) - не роняем галерею, покажем текстом.
    }
    return send(chatId, caption, { reply_markup: { inline_keyboard: kb } });
  }

  /* ---- Точки входа фабрики ---- */

  async function openSettings(chatId, _user) {
    pending.delete(String(chatId));
    return sendButtons(chatId, homeText(chatId), homeKb());
  }

  function pendingInput(chatId) {
    return pending.has(String(chatId));
  }

  // Сброс незавершённого сценария извне (например, /reset): pending не должен
  // пережить стирание памяти и перехватить первое сообщение нового знакомства.
  function clearPending(chatId) {
    pending.delete(String(chatId));
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
      await showWish(chatId, messageId);
      return true;
    }
    if (data === 'lk:wish:add') {
      pending.delete(id);
      await render(chatId, messageId, 'Добавить по ссылке или вручную?', ADD_CHOICE_KB);
      return true;
    }
    if (data === 'lk:wish:add:url') {
      pending.set(id, { mode: 'wish_add_url' });
      await render(chatId, messageId, 'Пришли ссылку на товар — сам всё заполню.', BACK_WISH_KB);
      return true;
    }
    if (data === 'lk:wish:add:manual') {
      pending.set(id, { mode: 'wish_manual_title' });
      await render(chatId, messageId, 'Как называется товар?', BACK_WISH_KB);
      return true;
    }
    if (data === 'lk:wish:nop') {
      return true; // средняя кнопка "N/M" в галерее - клик гасится роутером централизованно, тут делать нечего
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

    if ((m = data.match(/^lk:wish:edit:(title|desc|url):(\d+)$/))) {
      const field = m[1];
      const w = ownedWish(chatId, Number(m[2]));
      if (!w) { await showWish(chatId, messageId); return true; }
      pending.set(id, { mode: `wish_edit_${field}`, id: w.id });
      const ask =
        field === 'title' ? 'Пришли новое название.'
        : field === 'desc' ? 'Пришли новое описание (или «-», чтобы очистить).'
        : 'Пришли новую ссылку (или «-», чтобы очистить).';
      await render(chatId, messageId, ask, BACK_WISH_KB);
      return true;
    }
    if ((m = data.match(/^lk:wish:edit:(\d+)$/))) {
      const w = ownedWish(chatId, Number(m[1]));
      if (!w) { await showWish(chatId, messageId); return true; }
      await render(chatId, messageId, editWishText(w), editWishKb(w.id));
      return true;
    }
    if ((m = data.match(/^lk:wish:del:(\d+)$/))) {
      const w = ownedWish(chatId, Number(m[1]));
      if (!w) { await showWish(chatId, messageId); return true; }
      await render(chatId, messageId, `Удалить из вишлиста «${esc(w.title || '')}»?`, delWishConfirmKb(w.id));
      return true;
    }
    if ((m = data.match(/^lk:wish:delyes:(\d+)$/))) {
      const w = ownedWish(chatId, Number(m[1]));
      if (w) store.removeWish(w.id);
      pending.delete(id);
      await showWish(chatId, messageId);
      return true;
    }
    if (/^lk:wish:delno:\d+$/.test(data)) {
      await showWish(chatId, messageId);
      return true;
    }
    if ((m = data.match(/^lk:wish:view:(-?\d+)$/))) {
      await showWishGallery(chatId, Number(m[1]));
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

    /* ---- Вишлист: добавление по ссылке ---- */

    if (p.mode === 'wish_add_url') {
      const url = text.trim();
      // «Отмена» словом - выходим из сценария к списку (кнопка «Назад» и так есть)
      const low = url.toLowerCase().replace(/ё/g, 'е').replace(/[.!…]+$/, '');
      if (low === 'отмена' || low === 'cancel' || low === '/cancel') {
        pending.delete(id);
        await showWish(chatId, null);
        return true;
      }
      // Не ссылка (нет http/https и не домен-с-точкой) - не сохраняем мусорную
      // карточку с болтовнёй в заголовке; pending остаётся, ждём нормальный URL.
      const looksLikeUrl = /^https?:\/\/\S+$/i.test(url) || (!/\s/.test(url) && /\.[\p{L}\d-]{2,}/u.test(url));
      if (!looksLikeUrl) {
        await send(chatId, 'Это не похоже на ссылку — пришли URL или нажми Отмена.');
        return true;
      }
      pending.delete(id);
      let r = null;
      try {
        r = await parseProduct(url);
      } catch (e) {
        // parseProduct по контракту сам не бросает, но лишняя страховка не помешает -
        // при любом сюрпризе просто падаем на "пустую" карточку с url в заголовке.
        log?.error?.('[lk] parseProduct threw', e?.message);
      }
      const item = store.addWish(id, {
        title: (r && r.title) || url,
        desc: (r && r.description) || '',
        url: (r && r.url) || url,
        photos: (r && r.photos) || [],
        price: r && r.price != null ? r.price : null,
      });
      const k = item.photos.length;
      const photoNote = k === 0
        ? 'Фото не подтянулись, можно добавить вручную позже.'
        : `Фото: ${k}.`;
      await send(chatId, `Добавил: ${esc(item.title)}. ${photoNote}`);
      await showWish(chatId, null);
      return true;
    }

    /* ---- Вишлист: добавление вручную (пошагово) ---- */

    if (p.mode === 'wish_manual_title') {
      const title = text.trim();
      if (!title) {
        pending.set(id, p);
        await send(chatId, 'Название не должно быть пустым. Как называется товар?');
        return true;
      }
      pending.set(id, { mode: 'wish_manual_desc', partial: { title } });
      await send(chatId, 'Добавь описание (или пришли «-», чтобы пропустить).');
      return true;
    }

    if (p.mode === 'wish_manual_desc') {
      const t = text.trim();
      const desc = t === '-' ? '' : t;
      pending.set(id, { mode: 'wish_manual_url', partial: { ...p.partial, desc } });
      await send(chatId, 'Пришли ссылку на товар (или «-», чтобы пропустить).');
      return true;
    }

    if (p.mode === 'wish_manual_url') {
      pending.delete(id);
      const t = text.trim();
      const url = t === '-' ? '' : t;
      const item = store.addWish(id, { ...p.partial, url, photos: [], price: null });
      await send(chatId, `Добавил в вишлист: ${esc(item.title)}.`);
      await showWish(chatId, null);
      return true;
    }

    /* ---- Вишлист: точечное редактирование поля ---- */

    if (p.mode === 'wish_edit_title' || p.mode === 'wish_edit_desc' || p.mode === 'wish_edit_url') {
      pending.delete(id);
      const w = ownedWish(chatId, p.id);
      if (!w) { await send(chatId, 'Этот товар уже не найден - возможно, удалён.'); return true; }
      const field = p.mode === 'wish_edit_title' ? 'title' : p.mode === 'wish_edit_desc' ? 'desc' : 'url';
      const t = text.trim();
      const value = field !== 'title' && t === '-' ? '' : t;
      if (field === 'title' && !value) {
        pending.set(id, p);
        await send(chatId, 'Название не должно быть пустым. Пришли новое название.');
        return true;
      }
      store.updateWish(w.id, { [field]: value });
      await send(chatId, 'Обновил.');
      await showWish(chatId, null);
      return true;
    }

    pending.delete(id);
    return false;
  }

  return { openSettings, onCallback, pendingInput, consumeInput, clearPending };
}
