// Календарь в ЛК: месячная сетка (как в Apple), день-вью со списком дел,
// подключение к Apple Календарю (живая подписка-фид, тумблером), выгрузка .ics,
// и добавление события голосом/текстом по ключевому слову «календарь» с
// переспросом («…в 16:00, верно? Да/Нет»). Отдельный модуль (LK не > 700 строк);
// делегируется из telegram-lk через lk:cal* и текстовый ввод (cal_* pending).

import { randomUUID } from 'node:crypto';
import { esc } from './telegram-helpers.mjs';
import { pe, peButton } from './premium-emoji.mjs';
import { parseMessage } from './parser.mjs';
import { userOffset, fmtUser, resolveWallDate, wall } from './tz.mjs';

const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

// Ключевое слово «календар» (кириллица: границы через lookaround, не \b).
const CAL_KW = /(?<![а-яё])календар/i;
// «Открыть» календарь, а не добавить событие.
const CAL_OPEN = /^(?:мой\s+|открой\s+|покажи\s+|показать\s+)?календар[а-яё]*\s*[?!.]*$/i;
// ВОПРОС про календарь («что там у меня по календарю?», «какие события») -
// не добавление: на такое спрашиваем, показать сетку или рассказать словами.
const CAL_QUERY =
  /(?:^|[^а-яё])(что|чего|чё|какие|какая|какое|когда|сколько|есть\s+ли|напомни\s+что|покажи|показать|глянь|глянуть|посмотреть|расскажи|подскажи|планы|расписание|занят|свободен)(?![а-яё])/i;

export function createCalendarHandler(deps) {
  const { store, send, sendButtons, api, render, sendIcs, publicUrl, log } = deps;
  const pending = new Map(); // chatId -> { mode:'cal_confirm', ev } | { mode:'cal_reask' } | { mode:'cal_when', title }

  const base = (publicUrl || 'https://secondmemory.103.88.241.202.sslip.io').replace(/\/+$/, '');

  /* ---- Утилиты дат в поясе пользователя ---- */

  function localParts(iso, off) {
    const d = new Date(Date.parse(iso) + off * 60000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
  }
  function todayParts(user) {
    const w = wall(user, new Date());
    return { y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate() };
  }
  // ISO-день недели 1..7 (Пн..Вс) для 1-го числа месяца.
  function firstWeekday(y, m) {
    const jsDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0=Вс..6=Сб
    return jsDow === 0 ? 7 : jsDow;
  }
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

  /* ---- Месячная сетка ---- */

  function monthText(user, y, m) {
    return `${pe('calendarBtn')} <b>${MONTHS[m]} ${y}</b>`;
  }

  function monthKb(user, y, m) {
    const off = userOffset(user);
    const t = todayParts(user);
    // дни этого месяца, где есть события
    const evDays = new Set();
    for (const e of store.calEvents(user._chatId)) {
      const p = localParts(e.due, off);
      if (p.y === y && p.m === m) evDays.add(p.d);
    }
    const prevY = m === 1 ? y - 1 : y;
    const prevM = m === 1 ? 12 : m - 1;
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    const rows = [];
    rows.push([
      { text: '‹', callback_data: `lk:cal:m:${prevY}-${prevM}` },
      { text: `${MONTHS[m]} ${y}`, callback_data: 'lk:cal:nop' },
      { text: '›', callback_data: `lk:cal:m:${nextY}-${nextM}` },
    ]);
    rows.push(WD.map((w) => ({ text: w, callback_data: 'lk:cal:nop' })));

    const total = daysInMonth(y, m);
    const lead = firstWeekday(y, m) - 1; // сколько пустых ячеек перед 1-м
    let week = [];
    for (let i = 0; i < lead; i++) week.push({ text: ' ', callback_data: 'lk:cal:nop' });
    for (let d = 1; d <= total; d++) {
      const isToday = t.y === y && t.m === m && t.d === d;
      const hasEv = evDays.has(d);
      let label = String(d);
      if (hasEv) label = '•' + label;
      if (isToday) label = '[' + label + ']';
      week.push({ text: label, callback_data: `lk:cal:d:${y}-${m}-${d}` });
      if (week.length === 7) { rows.push(week); week = []; }
    }
    if (week.length) {
      while (week.length < 7) week.push({ text: ' ', callback_data: 'lk:cal:nop' });
      rows.push(week);
    }

    rows.push([
      peButton('days', 'Сегодня', { callback_data: 'lk:cal:today' }),
      peButton('eye', 'Ближайшие', { callback_data: 'lk:cal:list' }),
    ]);
    // Всё про Apple/ics - в отдельном экране «Подключение», чтобы сетка не тонула
    // в кнопках. Галочка сразу показывает, подключена подписка или нет.
    rows.push([
      peButton('bolt', user.calConnected ? 'Подключение ✅' : 'Подключение', { callback_data: 'lk:cal:conn' }),
    ]);
    rows.push([{ text: '‹ Назад', callback_data: 'lk:home' }]);
    return rows;
  }

  function dayText(user, y, m, d) {
    const off = userOffset(user);
    const evs = store.calEvents(user._chatId)
      .filter((e) => { const p = localParts(e.due, off); return p.y === y && p.m === m && p.d === d; })
      .sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
    const head = `${pe('calendarBtn')} <b>${d} ${MONTHS[m].toLowerCase()} ${y}</b>`;
    if (!evs.length) return `${head}\n\nНа этот день ничего не запланировано.`;
    const lines = evs.map((e) => {
      const p = localParts(e.due, off);
      const time = e.hasTime ? `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}` : 'весь день';
      return `• ${time} — ${esc(e.title || e.counterparty || 'событие')}`;
    });
    return `${head}\n\n${lines.join('\n')}`;
  }
  function dayKb(y, m) {
    return [[{ text: '‹ К календарю', callback_data: `lk:cal:m:${y}-${m}` }]];
  }

  /* ---- Экраны ---- */

  function withChat(user, chatId) { return { ...(user || {}), _chatId: String(chatId) }; }

  async function showMonth(chatId, messageId, user, y, m) {
    const u = withChat(user, chatId);
    return render(chatId, messageId, monthText(u, y, m), monthKb(u, y, m));
  }
  async function showToday(chatId, messageId, user) {
    const t = todayParts(user);
    return showMonth(chatId, messageId, user, t.y, t.m);
  }
  async function showDay(chatId, messageId, user, y, m, d) {
    return render(chatId, messageId, dayText(withChat(user, chatId), y, m, d), dayKb(y, m));
  }
  async function showList(chatId, messageId, user) {
    const off = userOffset(user);
    const evs = store.calEvents(String(chatId)).sort((a, b) => Date.parse(a.due) - Date.parse(b.due)).slice(0, 15);
    const body = evs.length
      ? evs.map((e) => `• ${esc(e.title || 'событие')} — ${esc(fmtUser(e.due, off, e.hasTime))}`).join('\n')
      : 'Пока ничего в календаре. Скажи, например: «встреча с другом завтра в 16, добавь в календарь».';
    const t = todayParts(user);
    return render(chatId, messageId, `${pe('eye')} <b>Ближайшие события</b>\n\n${body}`, [[{ text: '‹ К календарю', callback_data: `lk:cal:m:${t.y}-${t.m}` }]]);
  }

  /* ---- Подключение Apple Календаря (живая подписка) ---- */

  function feedUrls(token) {
    const https = `${base}/calendar/${token}.ics`;
    const webcal = https.replace(/^https?:\/\//i, 'webcal://');
    return { https, webcal };
  }

  // Экран «Подключение»: статус подписки, инструкция и обмен .ics в одном месте.
  function connText(user) {
    const on = !!(user.calConnected && user.calToken);
    const lines = [`${pe('bolt')} <b>Подключение календаря</b>`, ''];
    if (on) {
      const { https, webcal } = feedUrls(user.calToken);
      lines.push(
        '✅ <b>Apple Календарь подключён</b> — события из бота сами приезжают в телефон.',
        '',
        `<a href="${esc(webcal)}">📲 Открыть подписку в Календаре</a>`,
        '',
        'Если ссылка не открылась, добавь вручную:',
        '1. Настройки → Приложения → Календарь → Учётные записи',
        '2. Добавить учётную запись → Другое → Подписной календарь',
        '3. Вставь адрес:',
        `<code>${esc(https)}</code>`,
        '',
        '<i>Обновляется автоматически, интервал задаёт iOS (обычно от часа). Работает и в Google Календаре: Другие календари → Добавить по URL.</i>',
      );
    } else {
      lines.push(
        'Подписка — это живая связь: добавил событие в боте, и оно само появилось в Календаре iPhone. Ничего выгружать каждый раз не нужно.',
        '',
        'Нажми «Подключить» — дам персональную ссылку и покажу, куда её вставить.',
      );
    }
    lines.push(
      '',
      `${pe('pen')} <b>Файлом (разово)</b>`,
      '<b>Выгрузить</b> — пришлю файл .ics с событиями. Нажимаешь на него в чате → «Поделиться» → «Календарь» → «Добавить все». Это снимок на сейчас: новые события в него не попадут.',
      '<b>Загрузить</b> — наоборот: кидаешь мне .ics из другого календаря, я разберу и добавлю события себе.',
      '',
      `<i>${on ? 'Подписка уже включена, так что файл нужен, только если хочешь отдать расписание куда-то ещё.' : 'Если нужно, чтобы календарь обновлялся сам — лучше подписка выше, а не файл.'}</i>`,
    );
    return lines.join('\n');
  }

  function connKb(user) {
    const on = !!(user.calConnected && user.calToken);
    return [
      [peButton('calendarBtn', on ? 'Отвязать Apple Календарь' : 'Подключить Apple Календарь', {
        callback_data: 'lk:cal:connect',
        ...(on ? { style: 'danger' } : { style: 'primary' }),
      })],
      [
        peButton('pen', 'Выгрузить .ics', { callback_data: 'lk:cal:export' }),
        peButton('food', 'Загрузить', { callback_data: 'lk:cal:import' }),
      ],
      [{ text: '‹ К календарю', callback_data: 'lk:cal' }],
    ];
  }

  async function showConn(chatId, messageId, user) {
    pending.delete(String(chatId));
    return render(chatId, messageId, connText(user), connKb(user));
  }

  // Тумблер подписки: переключаем состояние и остаёмся на экране «Подключение» -
  // там сразу видно новый статус и актуальная ссылка/инструкция.
  async function toggleConnect(chatId, messageId, user) {
    const on = !!(user.calConnected && user.calToken);
    const patch = on
      ? { calConnected: false, calToken: null }
      : { calConnected: true, calToken: user.calToken || randomUUID().replace(/-/g, '') };
    const fresh = store.setUser(String(chatId), patch);
    await showConn(chatId, messageId, fresh);
  }

  /* ---- Выгрузка / загрузка ---- */

  async function exportIcs(chatId, messageId, user) {
    const evs = store.calEvents(String(chatId));
    const t = todayParts(user);
    if (!evs.length) { await render(chatId, messageId, 'В календаре пока нет событий для выгрузки.', [[{ text: '‹ Назад', callback_data: 'lk:cal:conn' }]]); return; }
    try { await sendIcs(String(chatId), evs, 'calendar.ics'); }
    catch (e) { log?.error?.('[cal] export', e?.message); await send(chatId, 'Не смог собрать файл, попробуй ещё раз.'); }
  }

  async function importHint(chatId, messageId, user) {
    const t = todayParts(user);
    await render(chatId, messageId, `${pe('food')} <b>Загрузить календарь</b>\n\nПришли мне файл <b>.ics</b> - экспорт из Apple Календаря, Google Календаря или любого другого. Я разберу события и добавлю их к себе.\n\n<i>В Apple Календаре: Файл → Экспорт. В Google: Настройки → Импорт и экспорт → Экспорт.</i>`, [[{ text: '‹ Назад', callback_data: 'lk:cal:conn' }]]);
  }

  // Импорт .ics: вызывается из роутера, когда прислали text/calendar. Возвращает N.
  function importEvents(chatId, events) {
    let n = 0;
    for (const ev of events || []) {
      if (!ev?.due) continue;
      store.add({ chatId: String(chatId), type: 'meeting', title: ev.title || 'Событие', due: ev.due, hasTime: !!ev.hasTime, calendar: true });
      n++;
    }
    return n;
  }

  /* ---- Добавление события по ключевому слову «календарь» ---- */

  function stripCalWords(text) {
    return String(text)
      // NB: окончания разные («в календарь», «по календарю») - берём [а-яё]*,
      // иначе от «календарю» оставался огрызок «ю».
      .replace(/добав(ь|ить|)\s+в\s+календар[а-яё]*/gi, '')
      .replace(/(?<![а-яё])(?:в|по|из)\s+календар[а-яё]*/gi, '')
      .replace(/(?<![а-яё])календар[а-яё]*/gi, '')
      .replace(/(?<![а-яё])(запиши|поставь|создай|запланируй)(?![а-яё])/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  async function askConfirm(chatId, user, ev) {
    const off = userOffset(user);
    pending.set(String(chatId), { mode: 'cal_confirm', ev });
    await send(chatId, `Добавить в календарь: «${esc(ev.title)}» — ${esc(fmtUser(ev.due, off, ev.hasTime))}? Верно?`, {
      reply_markup: { inline_keyboard: [[{ text: '✅ Да', callback_data: 'lk:cal:add:yes' }, { text: '✏️ Нет', callback_data: 'lk:cal:add:no' }]] },
    });
  }

  // Убрать из строки дату/время, чтобы осталось только название события.
  function stripTimeWords(s) {
    return String(s)
      .replace(/(?<![а-яё])(сегодня|завтра|послезавтра|вчера|позавчера)(?![а-яё])/gi, '')
      .replace(/(?<![а-яё])в\s+(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)(?![а-яё])/gi, '')
      .replace(/(?<![а-яё])через\s+\d+\s+(минут[уы]?|час[аов]*|дн[яейи]*|недел[юьи])(?![а-яё])/gi, '')
      .replace(/\d{1,2}\s+(январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-яё]*/gi, '')
      .replace(/(?<![а-яё])в\s+\d{1,2}([:.]\d{2})?(?![а-яё\d])/gi, '')
      .replace(/\b\d{1,2}[:.]\d{2}\b/g, '')
      .replace(/(?<![а-яё])(в|к)\s*$/i, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s,–—-]+|[\s,–—-]+$/g, '')
      .trim();
  }

  // Разобрать «что и когда» из фразы; вернуть {title,due,hasTime} | {needWhen,title} | null.
  // Срок ВСЕГДА через resolveWallDate(off) - offset-корректно (как normalizeReminderDue);
  // parseMessage(text, new Date()) зовём только ради типа/заголовка (не из-за его due,
  // иначе двойной сдвиг пояса). now = реальный, НЕ wall.
  function parseEvent(text, user) {
    const clean = stripCalWords(text);
    if (!clean) return null;
    const now = new Date();
    const off = userOffset(user);
    const r = resolveWallDate(off, clean, now);
    const p = parseMessage(clean, now);
    const title = (p.kind === 'entry' ? (p.entry.title || p.entry.counterparty) : null) || stripTimeWords(clean) || clean.slice(0, 80);
    if (!r.due) return { needWhen: true, title: title.slice(0, 80) };
    return { title: title.slice(0, 80), due: r.due, hasTime: r.hasTime };
  }

  // Рассказать словами: короткая сводка ближайших событий (без сетки).
  function tellText(chatId, user) {
    const off = userOffset(user);
    const now = Date.now();
    const evs = store.calEvents(String(chatId))
      .filter((e) => Date.parse(e.due) >= now - 3600000)
      .sort((a, b) => Date.parse(a.due) - Date.parse(b.due))
      .slice(0, 6);
    if (!evs.length) return 'В календаре пока пусто. Скажи «встреча с другом завтра в 16, добавь в календарь» - запишу.';
    const lines = evs.map((e) => `• ${esc(e.title || 'событие')} - ${esc(fmtUser(e.due, off, e.hasTime))}`);
    return `Вот что у тебя в календаре:\n${lines.join('\n')}`;
  }

  // Вопрос про календарь: спрашиваем, показать сетку или рассказать словами.
  async function askShowOrTell(chatId, user) {
    pending.set(String(chatId), { mode: 'cal_choice' });
    await send(chatId, 'Вывести календарь или просто рассказать?', {
      reply_markup: {
        inline_keyboard: [[
          { text: '📅 Показать календарь', callback_data: 'lk:cal:show' },
          { text: '💬 Рассказать', callback_data: 'lk:cal:tell' },
        ]],
      },
    });
  }

  // Точка входа из роутера: сообщение с ключевым словом «календарь».
  async function tryAdd(chatId, user, text) {
    if (!user || user.step) return false;
    const norm = String(text).toLowerCase().replace(/ё/g, 'е');
    if (!CAL_KW.test(norm)) return false;
    // «покажи календарь» / «календарь» -> открыть сетку, не добавлять
    if (CAL_OPEN.test(String(text).trim())) { await showToday(chatId, null, user); return true; }
    // Вопрос («что там у меня по календарю?») - это НЕ добавление события:
    // предлагаем выбор - показать сетку или рассказать словами.
    if (CAL_QUERY.test(norm) || /\?\s*$/.test(String(text).trim())) {
      const probe = parseEvent(text, user);
      // если в вопросе явно есть дата+время, считаем это всё же добавлением
      if (!probe || probe.needWhen) { await askShowOrTell(chatId, user); return true; }
    }
    const ev = parseEvent(text, user);
    if (!ev) { await showToday(chatId, null, user); return true; }
    if (ev.needWhen) {
      pending.set(String(chatId), { mode: 'cal_when', title: ev.title });
      await send(chatId, `На когда добавить «${esc(ev.title)}»? Напиши дату и время, например «завтра в 16:00».`);
      return true;
    }
    await askConfirm(chatId, user, ev);
    return true;
  }

  /* ---- Точки входа фабрики ---- */

  const pendingInput = (chatId) => pending.has(String(chatId));
  const clearPending = (chatId) => pending.delete(String(chatId));

  async function onCallback(chatId, data, cbq, user) {
    if (!data || !data.startsWith('lk:cal')) return false;
    const messageId = cbq?.message?.message_id;
    const id = String(chatId);
    let m;

    if (data === 'lk:cal' || data === 'lk:cal:today') { pending.delete(id); await showToday(chatId, messageId, user); return true; }
    if (data === 'lk:cal:show') { pending.delete(id); await showToday(chatId, null, user); return true; }
    if (data === 'lk:cal:tell') { pending.delete(id); await send(chatId, tellText(chatId, user)); return true; }
    if (data === 'lk:cal:nop') return true;
    if (data === 'lk:cal:list') { pending.delete(id); await showList(chatId, messageId, user); return true; }
    if (data === 'lk:cal:conn') { await showConn(chatId, messageId, user); return true; }
    if (data === 'lk:cal:connect') { pending.delete(id); await toggleConnect(chatId, messageId, user); return true; }
    if (data === 'lk:cal:export') { pending.delete(id); await exportIcs(chatId, messageId, user); return true; }
    if (data === 'lk:cal:import') { pending.delete(id); await importHint(chatId, messageId, user); return true; }

    if ((m = data.match(/^lk:cal:m:(\d{4})-(\d{1,2})$/))) { pending.delete(id); await showMonth(chatId, messageId, user, +m[1], +m[2]); return true; }
    if ((m = data.match(/^lk:cal:d:(\d{4})-(\d{1,2})-(\d{1,2})$/))) { pending.delete(id); await showDay(chatId, messageId, user, +m[1], +m[2], +m[3]); return true; }

    if (data === 'lk:cal:add:yes') {
      const p = pending.get(id);
      pending.delete(id);
      if (!p || p.mode !== 'cal_confirm') { await showToday(chatId, messageId, user); return true; }
      store.add({ chatId: id, type: 'meeting', title: p.ev.title, due: p.ev.due, hasTime: p.ev.hasTime, calendar: true });
      const hint = user.calConnected ? ' Появится в Apple Календаре при следующем обновлении подписки.' : ' Подключи Apple Календарь, чтобы события уезжали в телефон.';
      await send(chatId, `Добавил в календарь ✅${hint}`);
      return true;
    }
    if (data === 'lk:cal:add:no') {
      pending.set(id, { mode: 'cal_reask' });
      await send(chatId, 'Ок, не добавляю. Напиши, как правильно — что и на когда (например «встреча с Аней в пятницу в 18:00»).');
      return true;
    }

    await showToday(chatId, messageId, user);
    return true;
  }

  async function consumeInput(chatId, user, text) {
    const id = String(chatId);
    const p = pending.get(id);
    if (!p) return false;

    // Ответ словами на «вывести или рассказать?» (в т.ч. голосом).
    if (p.mode === 'cal_choice') {
      const t = String(text).toLowerCase().replace(/ё/g, 'е');
      const wantShow = /(показ|выведи|вывести|открой|сетк|календар)/i.test(t);
      const wantTell = /(расскаж|словам|просто скажи|перечисл|говори)/i.test(t);
      pending.delete(id);
      if (wantTell && !wantShow) { await send(chatId, tellText(chatId, user)); return true; }
      if (wantShow) { await showToday(chatId, null, user); return true; }
      // непонятный ответ - не залипаем в сценарии, рассказываем словами
      await send(chatId, tellText(chatId, user));
      return true;
    }

    if (p.mode === 'cal_confirm') {
      // NB: \b с кириллицей в JS не работает - границы через lookahead.
      const yes = /^\s*(да|ага|верно|точно|ок|окей|yes|давай|подтверждаю|угу)(?![а-яё])/i.test(text);
      const no = /^\s*(нет|неа|no|отмена|не\s+надо|не\s+то)(?![а-яё])/i.test(text);
      if (yes) {
        pending.delete(id);
        store.add({ chatId: id, type: 'meeting', title: p.ev.title, due: p.ev.due, hasTime: p.ev.hasTime, calendar: true });
        const hint = user.calConnected ? ' Появится в Apple Календаре при обновлении подписки.' : ' Подключи Apple Календарь, чтобы уезжало в телефон.';
        await send(chatId, `Добавил в календарь ✅${hint}`);
        return true;
      }
      if (no) { pending.set(id, { mode: 'cal_reask' }); await send(chatId, 'Ок. Напиши, как правильно — что и на когда.'); return true; }
      // не да/нет - трактуем как исправление
      pending.set(id, { mode: 'cal_reask' });
      return consumeInput(chatId, user, text);
    }

    if (p.mode === 'cal_reask') {
      const ev = parseEvent(text, user);
      pending.delete(id);
      if (!ev) { await send(chatId, 'Не понял. Скажи что и на когда, например «созвон в 19:00 завтра».'); return true; }
      if (ev.needWhen) { pending.set(id, { mode: 'cal_when', title: ev.title }); await send(chatId, `На когда добавить «${esc(ev.title)}»?`); return true; }
      await askConfirm(chatId, user, ev);
      return true;
    }

    if (p.mode === 'cal_when') {
      const off = userOffset(user);
      const r = resolveWallDate(off, text, new Date());
      if (!r.due) { await send(chatId, 'Не понял дату/время. Напиши, например «завтра в 16:00» или «25 июля в 18».'); return true; }
      pending.delete(id);
      await askConfirm(chatId, user, { title: p.title, due: r.due, hasTime: r.hasTime });
      return true;
    }

    return false;
  }

  return { onCallback, consumeInput, tryAdd, pendingInput, clearPending, importEvents };
}
