// Расчёт нормы питания по фитнес-профилю: калории, БЖУ, вода.
// Чистые функции без сети и ИИ - цифры должны быть стабильными и проверяемыми.
//
// Методика (общепринятая, для здорового взрослого):
//  - базовый обмен BMR по формуле Миффлина-Сан Жеора (1990);
//  - TDEE = BMR × коэффициент активности (берём по числу тренировок в неделю);
//  - под цель: похудение -18%, набор массы +12%, тонус - поддержание;
//  - белок 1.6-2.2 г/кг, жиры ~0.9 г/кг, остальное - углеводы;
//  - вода 32 мл/кг + 400 мл за тренировочный день.
// Это ориентир, а не медицинское предписание - так и подписываем в UI.

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Коэффициент активности по количеству тренировочных дней в неделю.
function activityFactor(daysPerWeek = 0) {
  if (daysPerWeek <= 0) return 1.2; // сидячий образ жизни
  if (daysPerWeek <= 2) return 1.375;
  if (daysPerWeek <= 4) return 1.55;
  if (daysPerWeek <= 6) return 1.725;
  return 1.9;
}

const GOAL_FACTOR = { похудение: 0.82, масса: 1.12, тонус: 1.0 };
// Белок г/кг: на сушке выше (сохранить мышцы), на массе - рост.
const PROTEIN_PER_KG = { похудение: 2.0, масса: 1.8, тонус: 1.6 };

/**
 * Норма на день по профилю фитнеса.
 * @param {{weight?:number,height?:number,age?:number,sex?:string,goal?:string,days?:number[]}} f
 * @returns {null|{kcal:number,protein:number,fat:number,carbs:number,water:number,
 *                 bmr:number,tdee:number,trainingDay:boolean,meals:number[]}}
 *          null - если не хватает данных (нужны вес и рост).
 */
export function dailyNorm(f, isTrainingDay = false) {
  const weight = Number(f?.weight);
  const height = Number(f?.height);
  if (!Number.isFinite(weight) || !Number.isFinite(height) || weight <= 0 || height <= 0) return null;

  const age = Number.isFinite(Number(f?.age)) ? Number(f.age) : 30;
  const female = f?.sex === 'ж';
  const bmr = Math.round(10 * weight + 6.25 * height - 5 * age + (female ? -161 : 5));

  const daysPerWeek = Array.isArray(f?.days) ? f.days.length : 0;
  const tdee = Math.round(bmr * activityFactor(daysPerWeek));

  const goal = GOAL_FACTOR[f?.goal] != null ? f.goal : 'тонус';
  const kcal = Math.round((tdee * GOAL_FACTOR[goal]) / 10) * 10;

  const protein = Math.round(weight * PROTEIN_PER_KG[goal]);
  const fat = Math.round(weight * 0.9);
  // Углеводы - остаток калорий (белок и углеводы по 4 ккал/г, жир 9 ккал/г).
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));

  const water = Math.round((weight * 32 + (isTrainingDay ? 400 : 0)) / 50) * 50;

  return {
    kcal, protein, fat, carbs, water, bmr, tdee,
    trainingDay: isTrainingDay,
    // Ориентир по приёмам пищи: завтрак 30%, обед 35%, ужин 25%, перекус 10%.
    meals: [0.3, 0.35, 0.25, 0.1].map((p) => Math.round((kcal * p) / 10) * 10),
  };
}

// Ключ дня в поясе пользователя - трекер обнуляется в его полночь, не в UTC.
export function dayKey(off = 180, now = new Date()) {
  const d = new Date(now.getTime() + off * 60000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Дневной трекер (вода/калории) с авто-сбросом при смене даты.
export function todayLog(fitness, off = 180, now = new Date()) {
  const key = dayKey(off, now);
  const log = fitness?.log;
  if (!log || log.date !== key) return { date: key, water: 0, kcal: 0, items: [] };
  return { date: key, water: log.water || 0, kcal: log.kcal || 0, items: Array.isArray(log.items) ? log.items : [] };
}

// «250», «поел 600 ккал», «омлет 350» -> { kcal, title }. null - не разобрали.
export function parseMeal(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const m = s.match(/(\d{2,4})/);
  if (!m) return null;
  const kcal = clamp(parseInt(m[1], 10), 1, 5000);
  const title = s.replace(m[1], ' ').replace(/ккал|калори[йи]|кал\b/gi, ' ').replace(/\s{2,}/g, ' ').trim();
  return { kcal, title: title.slice(0, 40) || 'приём пищи' };
}

// «500», «стакан», «бутылка», «0.5 л», «2 стакана» -> мл. null - не разобрали.
export function parseWater(text) {
  const s = String(text || '').toLowerCase().replace(/ё/g, 'е').trim();
  if (!s) return null;
  const glasses = s.match(/(\d+)?\s*стакан/);
  if (glasses) return clamp((parseInt(glasses[1] || '1', 10) || 1) * 250, 50, 5000);
  const bottle = s.match(/(\d+)?\s*бутыл/);
  if (bottle) return clamp((parseInt(bottle[1] || '1', 10) || 1) * 500, 50, 5000);
  const liters = s.match(/(\d+(?:[.,]\d+)?)\s*л(?![а-я])/);
  if (liters) return clamp(Math.round(parseFloat(liters[1].replace(',', '.')) * 1000), 50, 5000);
  const ml = s.match(/(\d{2,4})/);
  if (ml) return clamp(parseInt(ml[1], 10), 50, 5000);
  return null;
}

// Полоска прогресса из 10 сегментов: ▰▰▰▱▱▱▱▱▱▱
export function bar(value, target, width = 10) {
  if (!target || target <= 0) return '▱'.repeat(width);
  const filled = clamp(Math.round((value / target) * width), 0, width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}
