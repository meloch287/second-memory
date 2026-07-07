// Общие форматтеры: рубли и двузначные числа. Дублировались в 7 файлах.

export const RUB = new Intl.NumberFormat('ru-RU');
export const money = (v) => `${RUB.format(v)} ₽`;
export const pad = (n) => String(n).padStart(2, '0');
