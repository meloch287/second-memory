// Личный тренер (кнопка «Фитнес» в ЛК): профиль (вес/рост/возраст/пол/цель/
// уровень), дни тренировок и AI-программа на каждый выбранный день. Работает
// кнопками И текстом (голос = транскрипт идёт тем же consumeInput). Отдельный
// модуль, чтобы telegram-lk.mjs не перевалил за 700 строк; интегрируется в LK
// делегированием колбэков lk:fit* и текстового ввода (fit_* pending).

import { esc } from './telegram-helpers.mjs';
import { pe, peButton } from './premium-emoji.mjs';
import { dailyNorm, todayLog, dayKey, parseMeal, parseWater, bar } from './nutrition.mjs';
import { userOffset } from './tz.mjs';
import { persistentPending } from './pending.mjs';

const DAYS = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const DAY_FULL = ['', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const GOALS = [['похудение', 'Похудение'], ['масса', 'Набор массы'], ['тонус', 'Тонус']];
const LEVELS = [['новичок', 'Новичок'], ['средний', 'Средний'], ['продвинутый', 'Продвинутый']];

export function createFitnessHandler(deps) {
  const { store, send, api, render, withTyping, aiFitnessProgram, log } = deps;
  // Сценарий переживает рестарт: в памяти процесса он терялся при каждом деплое
  // (бот спрашивал ссылку, человек присылал - а бот уже забыл, чего ждал).
  const pending = persistentPending(store, 'fitness');

  const goalLabel = (g) => (GOALS.find((x) => x[0] === g) || [null, 'не задана'])[1];
  const levelLabel = (l) => (LEVELS.find((x) => x[0] === l) || [null, 'не задан'])[1];
  const profileReady = (f) => !!(f && f.weight && f.height && f.goal);
  const selectedDays = (f) => (Array.isArray(f?.days) ? [...f.days].sort((a, b) => a - b) : []);
  const planDays = (f) => (f?.plan && typeof f.plan === 'object' ? Object.keys(f.plan).map(Number).sort((a, b) => a - b) : []);

  /* ---- Тексты и клавиатуры ---- */

  function homeText(chatId) {
    const f = store.getFitness(chatId);
    const days = selectedDays(f);
    const lines = [`${pe('muscle')} <b>Личный тренер</b>`, ''];
    if (f && (f.weight || f.height || f.goal)) {
      const body = [f.weight ? `${f.weight} кг` : null, f.height ? `${f.height} см` : null, f.age ? `${f.age} лет` : null]
        .filter(Boolean)
        .join(' · ');
      if (body) lines.push(`${pe('star')} ${body}`);
      lines.push(`${pe('target')} ${goalLabel(f?.goal)} · ${levelLabel(f?.level)}`);
    } else {
      lines.push(`${pe('star')} Профиль не заполнен — начни с него 👇`);
    }
    lines.push(`${pe('days')} Дни: ${days.length ? days.map((d) => DAYS[d]).join(', ') : 'не выбраны'}`);
    lines.push(`${pe('pen')} План: ${planDays(f).length ? `готов на ${planDays(f).length} дн.` : 'не составлен'}`);
    return lines.join('\n');
  }

  function homeKb(chatId) {
    const f = store.getFitness(chatId);
    const rows = [[
      peButton('pen', 'Профиль', { callback_data: 'lk:fit:prof' }),
      peButton('days', 'Дни', { callback_data: 'lk:fit:days' }),
    ]];
    const second = [];
    if (profileReady(f) && selectedDays(f).length) second.push(peButton('bolt', 'Составить план', { callback_data: 'lk:fit:gen' }));
    if (planDays(f).length) second.push(peButton('eye', 'Мой план', { callback_data: 'lk:fit:plan:0' }));
    if (second.length) rows.push(second);
    rows.push([peButton('food', 'Питание', { callback_data: 'lk:fit:food' })]);
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

  // Разбор сохранённого дня плана: первая строка - фокус, дальше упражнения.
  // Нужно, чтобы при пересоставлении сохранить те же группы мышц, а упражнения
  // попросить ДРУГИЕ (иначе модель выдаёт ровно тот же список).
  function planBrief(f) {
    return planDays(f).map((d) => {
      const lines = String(f.plan[d] || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const focus = (lines[0] || '').replace(/^фокус\s*:?\s*/i, '').slice(0, 60);
      const exercises = lines
        .filter((l) => /^[-•]/.test(l))
        .map((l) => l.replace(/^[-•]\s*/, '').replace(/\s*[—-]\s*\d+[xх×].*$/i, '').trim())
        .filter(Boolean)
        .slice(0, 8);
      return { day: DAY_FULL[d], focus, exercises };
    });
  }

  async function generate(chatId, messageId, user, { force = false } = {}) {
    const existing = store.getFitness(chatId);
    // План уже есть - не перетираем молча, спрашиваем.
    if (!force && planDays(existing).length) {
      await render(
        chatId,
        messageId,
        `${pe('bolt')} <b>План уже есть</b> — на ${planDays(existing).length} дн.\n\nПересоставить? Группы мышц по дням оставлю те же, а упражнения подберу другие.`,
        [
          [{ text: '🔄 Да, пересоставить', callback_data: 'lk:fit:gen:yes' }],
          [{ text: '👁️ Оставить текущий', callback_data: 'lk:fit:plan:0' }],
          [{ text: '‹ Назад', callback_data: 'lk:fit' }],
        ],
      );
      return;
    }
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
      const previous = force ? planBrief(f) : [];
      raw = await withTyping(chatId, () => aiFitnessProgram(f, days.map((d) => DAY_FULL[d]), { previous }));
    } catch (e) {
      log?.error?.('[fit] generate', e?.message);
    }
    const plan = splitProgram(raw, days);
    if (!Object.keys(plan).length) {
      await render(chatId, messageId, 'Не получилось составить план, попробуй ещё раз чуть позже.',
        [[{ text: '⚡ Ещё раз', callback_data: 'lk:fit:gen:yes' }], [{ text: '‹ Назад', callback_data: 'lk:fit' }]]);
      return;
    }
    store.setFitness(chatId, { plan });
    await send(chatId, force
      ? `Готово! Пересоставил план на ${Object.keys(plan).length} дн. - те же группы, новые упражнения 💪`
      : `Готово! Составил план на ${Object.keys(plan).length} дн. 💪`);
    await showPlan(chatId, null, 0);
  }

  /* ---- Питание: норма по профилю + дневной трекер ---- */

  const isTrainingToday = (f, off) => {
    const jsDow = new Date(Date.now() + off * 60000).getUTCDay();
    return selectedDays(f).includes(jsDow === 0 ? 7 : jsDow);
  };

  function foodText(chatId, user) {
    const f = store.getFitness(chatId);
    const off = userOffset(user);
    const norm = dailyNorm(f, isTrainingToday(f, off));
    if (!norm) {
      return `${pe('food')} <b>Питание</b>\n\nЧтобы посчитать норму, нужен профиль: вес и рост (возраст и пол уточнят цифры).`;
    }
    const log = todayLog(f, off);
    const kcalLeft = Math.max(0, norm.kcal - log.kcal);
    const waterLeft = Math.max(0, norm.water - log.water);
    const lines = [
      `${pe('food')} <b>Питание на сегодня</b>`,
      '',
      `${pe('target')} Норма: <b>${norm.kcal}</b> ккал${norm.trainingDay ? ' (тренировочный день)' : ''}`,
      `Б ${norm.protein} г · Ж ${norm.fat} г · У ${norm.carbs} г`,
      '',
      `🍽 Съедено: <b>${log.kcal}</b> / ${norm.kcal} ккал`,
      `${bar(log.kcal, norm.kcal)} ${kcalLeft ? `осталось ${kcalLeft}` : 'норма закрыта 👍'}`,
      '',
      `💦 Вода: <b>${(log.water / 1000).toFixed(1)}</b> / ${(norm.water / 1000).toFixed(1)} л`,
      `${bar(log.water, norm.water)} ${waterLeft ? `осталось ${waterLeft} мл` : 'норма закрыта 👍'}`,
    ];
    if (log.items.length) {
      lines.push('', 'Сегодня ел:', ...log.items.slice(-6).map((i) => `• ${esc(i.title)} — ${i.kcal} ккал`));
    }
    lines.push('', `<i>Ориентир по формуле Миффлина-Сан Жеора: обмен ${norm.bmr}, расход ${norm.tdee} ккал.</i>`);
    return lines.join('\n');
  }

  function foodKb() {
    return [
      [{ text: '＋ Еда', callback_data: 'lk:fit:food:meal' }, { text: '💦 +250', callback_data: 'lk:fit:food:w:250' }, { text: '💦 +500', callback_data: 'lk:fit:food:w:500' }],
      [{ text: '🍽 Разбивка по приёмам', callback_data: 'lk:fit:food:split' }, { text: '♻️ Сбросить день', callback_data: 'lk:fit:food:reset' }],
      [{ text: '‹ Назад', callback_data: 'lk:fit' }],
    ];
  }

  // Обновить дневной трекер (вода/еда) с авто-сбросом при смене даты.
  function bumpLog(chatId, user, patch) {
    const off = userOffset(user);
    const f = store.getFitness(chatId);
    const log = todayLog(f, off);
    const next = {
      date: dayKey(off),
      water: log.water + (patch.water || 0),
      kcal: log.kcal + (patch.kcal || 0),
      items: patch.item ? [...log.items, patch.item].slice(-20) : log.items,
    };
    store.setFitness(chatId, { log: next });
    return next;
  }

  async function showFood(chatId, messageId, user) {
    pending.delete(String(chatId));
    return render(chatId, messageId, foodText(chatId, user), foodKb());
  }

  function splitText(chatId, user) {
    const f = store.getFitness(chatId);
    const norm = dailyNorm(f, isTrainingToday(f, userOffset(user)));
    if (!norm) return 'Сначала заполни профиль (вес и рост).';
    const names = ['Завтрак', 'Обед', 'Ужин', 'Перекус'];
    return [
      `🍽 <b>Разбивка ${norm.kcal} ккал</b>`,
      '',
      ...norm.meals.map((k, i) => `${names[i]}: <b>${k}</b> ккал`),
      '',
      `Белок за день: ${norm.protein} г (примерно ${Math.round(norm.protein / 4)} г на приём).`,
    ].join('\n');
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
    if (data === 'lk:fit:gen:yes') { pending.delete(id); await generate(chatId, messageId, user, { force: true }); return true; }
    if (data === 'lk:fit:nop') return true;

    /* ---- Питание ---- */
    if (data === 'lk:fit:food') { await showFood(chatId, messageId, user); return true; }
    if (data === 'lk:fit:food:split') {
      pending.delete(id);
      await render(chatId, messageId, splitText(chatId, user), [[{ text: '‹ Назад', callback_data: 'lk:fit:food' }]]);
      return true;
    }
    if ((m = data.match(/^lk:fit:food:w:(\d+)$/))) {
      bumpLog(chatId, user, { water: Number(m[1]) });
      await showFood(chatId, messageId, user);
      return true;
    }
    if (data === 'lk:fit:food:meal') {
      pending.set(id, { mode: 'fit_meal' });
      await render(chatId, messageId, 'Что съел? Напиши калории и (по желанию) название: «омлет 350» или просто «600».', [
        [{ text: '‹ Назад', callback_data: 'lk:fit:food' }],
      ]);
      return true;
    }
    if (data === 'lk:fit:food:reset') {
      store.setFitness(chatId, { log: { date: dayKey(userOffset(user)), water: 0, kcal: 0, items: [] } });
      await showFood(chatId, messageId, user);
      return true;
    }

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

    // Приём пищи: «омлет 350», «600», «выпил 500 мл» (воду тоже ловим тут).
    if (p.mode === 'fit_meal') {
      const t = String(text);
      const isWater = /(вод|выпил|стакан|бутыл|попил)/i.test(t.replace(/ё/g, 'е'));
      if (isWater) {
        const ml = parseWater(t);
        if (!ml) { await send(chatId, 'Не понял сколько. Напиши «500», «стакан» или «0.5 л».'); return true; }
        pending.delete(id);
        bumpLog(chatId, user, { water: ml });
        await send(chatId, `Записал ${ml} мл воды 💦`);
        await showFood(chatId, null, user);
        return true;
      }
      const meal = parseMeal(t);
      if (!meal) { await send(chatId, 'Не понял калории. Напиши, например «омлет 350» или просто «600».'); return true; }
      pending.delete(id);
      bumpLog(chatId, user, { kcal: meal.kcal, item: meal });
      await send(chatId, `Записал: ${esc(meal.title)} — ${meal.kcal} ккал 🍽`);
      await showFood(chatId, null, user);
      return true;
    }

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

  // Запись еды и воды СЛОВАМИ, без кнопок. Живой баг: Лизе бот писал «записал
  // тебе рафаэлки в калории», а дневник оставался пустым - записи из разговора
  // не существовало вовсе. Теперь фраза реально попадает в трекер.
  function logFoodText(chatId, user, text) {
    const f = store.getFitness(chatId);
    const off = userOffset(user);
    const norm = dailyNorm(f, isTrainingToday(f, off));
    if (!norm) return { kind: 'no_profile' }; // без веса и роста норму не посчитать
    if (/вод|литр|стакан|попил|выпил|бутыл/i.test(text)) {
      const water = parseWater(text);
      if (!water) return { kind: 'need_amount' };
      return { kind: 'water', added: water, log: bumpLog(chatId, user, { water }), norm };
    }
    const meal = parseMeal(text);
    if (!meal) return { kind: 'need_kcal' }; // еда названа, но без цифр
    return { kind: 'meal', added: meal, log: bumpLog(chatId, user, { kcal: meal.kcal, item: meal }), norm };
  }

  return { onCallback, consumeInput, pendingInput, clearPending, logFoodText };
}
