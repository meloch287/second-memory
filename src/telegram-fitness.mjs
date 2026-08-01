// Личный тренер (кнопка «Фитнес» в ЛК): профиль (вес/рост/возраст/пол/цель/
// уровень), дни тренировок и AI-программа на каждый выбранный день. Работает
// кнопками И текстом (голос = транскрипт идёт тем же consumeInput). Отдельный
// модуль, чтобы telegram-lk.mjs не перевалил за 700 строк; интегрируется в LK
// делегированием колбэков lk:fit* и текстового ввода (fit_* pending).

import { esc } from './telegram-helpers.mjs';

const DAYS = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const DAY_FULL = ['', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const GOALS = [['похудение', 'Похудение'], ['масса', 'Набор массы'], ['тонус', 'Тонус']];
const LEVELS = [['новичок', 'Новичок'], ['средний', 'Средний'], ['продвинутый', 'Продвинутый']];

export function createFitnessHandler(deps) {
  const { store, send, api, render, withTyping, aiFitnessProgram, log } = deps;
  const pending = new Map(); // chatId -> { mode: 'fit_weight' | 'fit_height' | 'fit_age' }

  const goalLabel = (g) => (GOALS.find((x) => x[0] === g) || [null, 'не задана'])[1];
  const levelLabel = (l) => (LEVELS.find((x) => x[0] === l) || [null, 'не задан'])[1];
  const profileReady = (f) => !!(f && f.weight && f.height && f.goal);
  const selectedDays = (f) => (Array.isArray(f?.days) ? [...f.days].sort((a, b) => a - b) : []);
  const planDays = (f) => (f?.plan && typeof f.plan === 'object' ? Object.keys(f.plan).map(Number).sort((a, b) => a - b) : []);

  /* ---- Тексты и клавиатуры ---- */

  function homeText(chatId) {
    const f = store.getFitness(chatId);
    const days = selectedDays(f);
    const prof = f && (f.weight || f.height || f.goal)
      ? `${f.sex === 'ж' ? '👩' : '🧑'} ${f.weight || '—'} кг · ${f.height || '—'} см${f.age ? ' · ' + f.age + ' лет' : ''}\n🎯 ${goalLabel(f?.goal)} · ${levelLabel(f?.level)}`
      : 'Профиль не заполнен — начни с него 👇';
    const daysLine = days.length ? days.map((d) => DAYS[d]).join(', ') : 'не выбраны';
    const plan = planDays(f).length ? `готов на ${planDays(f).length} дн.` : 'не составлен';
    return ['🏋️ <b>Личный тренер</b>', '', prof, `📅 Дни: ${daysLine}`, `📋 План: ${plan}`].join('\n');
  }

  function homeKb(chatId) {
    const f = store.getFitness(chatId);
    const rows = [[{ text: '📋 Профиль', callback_data: 'lk:fit:prof' }, { text: '📅 Дни', callback_data: 'lk:fit:days' }]];
    if (profileReady(f) && selectedDays(f).length) rows.push([{ text: '⚡ Составить план', callback_data: 'lk:fit:gen' }]);
    if (planDays(f).length) rows.push([{ text: '👁 Мой план', callback_data: 'lk:fit:plan:0' }]);
    rows.push([{ text: '‹ Назад', callback_data: 'lk:home' }]);
    return rows;
  }

  function profText(chatId) {
    const f = store.getFitness(chatId) || {};
    return [
      '📋 <b>Профиль</b>',
      '',
      `Вес: ${f.weight ? f.weight + ' кг' : '—'}`,
      `Рост: ${f.height ? f.height + ' см' : '—'}`,
      `Возраст: ${f.age ? f.age + ' лет' : '—'}`,
      `Пол: ${f.sex === 'ж' ? 'женский' : f.sex === 'м' ? 'мужской' : '—'}`,
      `Цель: ${goalLabel(f.goal)}`,
      `Уровень: ${levelLabel(f.level)}`,
    ].join('\n');
  }
  function profKb() {
    return [
      [{ text: 'Вес', callback_data: 'lk:fit:set:weight' }, { text: 'Рост', callback_data: 'lk:fit:set:height' }, { text: 'Возраст', callback_data: 'lk:fit:set:age' }],
      [{ text: 'Пол', callback_data: 'lk:fit:sex' }, { text: 'Цель', callback_data: 'lk:fit:goal' }, { text: 'Уровень', callback_data: 'lk:fit:level' }],
      [{ text: '‹ Назад', callback_data: 'lk:fit' }],
    ];
  }

  function daysKb(chatId) {
    const sel = new Set(selectedDays(store.getFitness(chatId)));
    const btn = (d) => ({ text: `${sel.has(d) ? '✅ ' : ''}${DAYS[d]}`, callback_data: `lk:fit:day:${d}` });
    return [[1, 2, 3, 4].map(btn), [5, 6, 7].map(btn), [{ text: '‹ Готово', callback_data: 'lk:fit' }]];
  }

  function choiceKb(kind, options) {
    const rows = options.map(([val, label]) => [{ text: label, callback_data: `lk:fit:${kind}:${val}` }]);
    rows.push([{ text: '‹ Назад', callback_data: 'lk:fit:prof' }]);
    return rows;
  }

  function planCaption(f, idx) {
    const days = planDays(f);
    const d = days[idx];
    return [`🏋️ <b>${idx + 1}/${days.length} — ${DAY_FULL[d]}</b>`, '', esc(f.plan[d] || '')].join('\n');
  }
  function planKb(idx, total) {
    const prev = Math.max(0, idx - 1);
    const next = Math.min(total - 1, idx + 1);
    return [
      [
        { text: '‹', callback_data: `lk:fit:plan:${prev}` },
        { text: `${idx + 1}/${total}`, callback_data: 'lk:fit:nop' },
        { text: '›', callback_data: `lk:fit:plan:${next}` },
      ],
      [{ text: '‹ Назад', callback_data: 'lk:fit' }],
    ];
  }

  /* ---- Генерация плана ---- */

  // Режем «@@ДЕНЬ:..@@ текст» на блоки; назначаем выбранным дням по порядку.
  function splitProgram(raw, days) {
    const plan = {};
    const text = String(raw || '').trim();
    if (!text) return plan;
    const parts = text.split(/@@ДЕНЬ:.*?@@/i).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= days.length) {
      days.forEach((d, i) => { plan[d] = parts[i]; });
    } else if (parts.length) {
      plan[days[0]] = text; // формат не соблюдён - не теряем, кладём целиком в первый день
    }
    return plan;
  }

  async function generate(chatId, messageId, user) {
    const f = store.getFitness(chatId);
    if (!profileReady(f)) {
      await render(chatId, messageId, 'Сначала заполни профиль: минимум вес, рост и цель.',
        [[{ text: '📋 Профиль', callback_data: 'lk:fit:prof' }], [{ text: '‹ Назад', callback_data: 'lk:fit' }]]);
      return;
    }
    const days = selectedDays(f);
    if (!days.length) {
      await render(chatId, messageId, 'Сначала выбери дни тренировок.',
        [[{ text: '📅 Дни', callback_data: 'lk:fit:days' }], [{ text: '‹ Назад', callback_data: 'lk:fit' }]]);
      return;
    }
    let raw = '';
    try {
      raw = await withTyping(chatId, () => aiFitnessProgram(f, days.map((d) => DAY_FULL[d])));
    } catch (e) {
      log?.error?.('[fit] generate', e?.message);
    }
    const plan = splitProgram(raw, days);
    if (!Object.keys(plan).length) {
      await render(chatId, messageId, 'Не получилось составить план, попробуй ещё раз чуть позже.',
        [[{ text: '⚡ Ещё раз', callback_data: 'lk:fit:gen' }], [{ text: '‹ Назад', callback_data: 'lk:fit' }]]);
      return;
    }
    store.setFitness(chatId, { plan });
    await send(chatId, `Готово! Составил план на ${Object.keys(plan).length} дн. 💪`);
    await showPlan(chatId, null, 0);
  }

  /* ---- Экраны ---- */

  async function showFit(chatId, messageId) {
    pending.delete(String(chatId));
    return render(chatId, messageId, homeText(chatId), homeKb(chatId));
  }
  async function showPlan(chatId, messageId, index) {
    const f = store.getFitness(chatId);
    const days = planDays(f);
    if (!days.length) return showFit(chatId, messageId);
    const idx = Math.max(0, Math.min(index, days.length - 1));
    return render(chatId, messageId, planCaption(f, idx), planKb(idx, days.length));
  }

  /* ---- Точки входа ---- */

  const pendingInput = (chatId) => pending.has(String(chatId));
  const clearPending = (chatId) => pending.delete(String(chatId));

  async function onCallback(chatId, data, cbq, user) {
    if (!data || !data.startsWith('lk:fit')) return false;
    const messageId = cbq?.message?.message_id;
    const id = String(chatId);
    let m;

    if (data === 'lk:fit') { await showFit(chatId, messageId); return true; }
    if (data === 'lk:fit:prof') { pending.delete(id); await render(chatId, messageId, profText(chatId), profKb()); return true; }
    if (data === 'lk:fit:days') { pending.delete(id); await render(chatId, messageId, 'Отметь дни тренировок (жми, чтобы включить/выключить):', daysKb(chatId)); return true; }
    if (data === 'lk:fit:gen') { pending.delete(id); await generate(chatId, messageId, user); return true; }
    if (data === 'lk:fit:nop') return true;

    if ((m = data.match(/^lk:fit:plan:(\d+)$/))) { pending.delete(id); await showPlan(chatId, messageId, Number(m[1])); return true; }

    if ((m = data.match(/^lk:fit:day:(\d)$/))) {
      const d = Number(m[1]);
      const cur = new Set(selectedDays(store.getFitness(chatId)));
      cur.has(d) ? cur.delete(d) : cur.add(d);
      store.setFitness(chatId, { days: [...cur].sort((a, b) => a - b) });
      await render(chatId, messageId, 'Отметь дни тренировок (жми, чтобы включить/выключить):', daysKb(chatId));
      return true;
    }

    if ((m = data.match(/^lk:fit:set:(weight|height|age)$/))) {
      const field = m[1];
      pending.set(id, { mode: 'fit_' + field });
      const q = field === 'weight' ? 'Напиши вес в кг (число).' : field === 'height' ? 'Напиши рост в см (число).' : 'Напиши возраст (число).';
      await render(chatId, messageId, q, [[{ text: '‹ Назад', callback_data: 'lk:fit:prof' }]]);
      return true;
    }
    if (data === 'lk:fit:sex') { pending.delete(id); await render(chatId, messageId, 'Пол:', choiceKb('sex', [['м', 'Мужской'], ['ж', 'Женский']])); return true; }
    if (data === 'lk:fit:goal') { pending.delete(id); await render(chatId, messageId, 'Цель:', choiceKb('goal', GOALS)); return true; }
    if (data === 'lk:fit:level') { pending.delete(id); await render(chatId, messageId, 'Уровень:', choiceKb('level', LEVELS)); return true; }

    if ((m = data.match(/^lk:fit:sex:(м|ж)$/))) { store.setFitness(chatId, { sex: m[1] }); await render(chatId, messageId, profText(chatId), profKb()); return true; }
    if ((m = data.match(/^lk:fit:goal:(похудение|масса|тонус)$/))) { store.setFitness(chatId, { goal: m[1] }); await render(chatId, messageId, profText(chatId), profKb()); return true; }
    if ((m = data.match(/^lk:fit:level:(новичок|средний|продвинутый)$/))) { store.setFitness(chatId, { level: m[1] }); await render(chatId, messageId, profText(chatId), profKb()); return true; }

    await showFit(chatId, messageId); // неизвестный lk:fit:* - на главную тренера
    return true;
  }

  async function consumeInput(chatId, user, text) {
    const id = String(chatId);
    const p = pending.get(id);
    if (!p || !/^fit_/.test(p.mode)) return false;
    const field = p.mode.slice(4); // weight | height | age
    const num = parseInt(String(text).replace(/[^\d]/g, ''), 10);
    const ok = Number.isFinite(num) && (field === 'weight' ? num >= 30 && num <= 400 : field === 'height' ? num >= 100 && num <= 250 : num >= 8 && num <= 120);
    if (!ok) {
      await send(chatId, field === 'weight' ? 'Не понял вес. Пришли число в кг, например 80.'
        : field === 'height' ? 'Не понял рост. Пришли число в см, например 180.'
        : 'Не понял возраст. Пришли число, например 30.');
      return true;
    }
    pending.delete(id);
    store.setFitness(chatId, { [field]: num });
    await send(chatId, 'Записал 👍');
    await render(chatId, null, profText(chatId), profKb());
    return true;
  }

  return { onCallback, consumeInput, pendingInput, clearPending };
}
