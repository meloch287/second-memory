// Фото еды -> карточка «что это и сколько в нём» -> запись в дневник по кнопке.
//
// Молча в дневник не пишем: цифры с фото приблизительные, решает человек.
// Раньше бот на фото еды просто болтал, а «записал калории» говорил на словах,
// не записывая ничего.

import { macroAdvice } from './nutrition.mjs';

const SURE = {
  high: '',
  medium: '\n<i>оценка примерная</i>',
  low: '\n<i>уверенности мало, поправь если что</i>',
};

export function createFoodPhoto({ store, send, esc, log, logFoodEntry }) {
  const pending = new Map(); // chatId -> распознанное блюдо

  // true - карточку показали и обычный разбор картинки не нужен.
  async function card(chatId, food) {
    const user = store.getUser(String(chatId));
    if (!user || user.step || !food) return false;
    pending.set(String(chatId), food);
    await send(
      chatId,
      `🍽 Похоже на: <b>${esc(food.title)}</b>${food.portion ? ` (${esc(food.portion)})` : ''}\n\n` +
        `<b>${food.kcal}</b> ккал · Б ${food.protein} г · Ж ${food.fat} г · У ${food.carbs} г${SURE[food.sure] || ''}\n\n` +
        'Записать в дневник?',
      // Модель считает ВСЮ видимую порцию: у целой пиццы выходит 2500 ккал,
      // хотя человек съел кусок. Половина - самый частый случай, даём кнопкой.
      { reply_markup: { inline_keyboard: [
        [{ text: '✅ Записать', callback_data: 'food:yes' }, { text: '½ порции', callback_data: 'food:half' }],
        [{ text: '✖️ Не надо', callback_data: 'food:no' }],
      ] } },
    );
    return true;
  }

  async function onCallback(chatId, data) {
    if (!['food:yes', 'food:half', 'food:no'].includes(data)) return false;
    const food = pending.get(String(chatId));
    pending.delete(String(chatId));
    if (data === 'food:no') {
      await send(chatId, 'лан, не записываю');
      return true;
    }
    if (!food) {
      await send(chatId, 'Карточка потерялась, пришли фото ещё раз');
      return true;
    }
    const half = data === 'food:half';
    const entry = half
      ? { ...food, title: `${food.title} (половина)`, kcal: Math.round(food.kcal / 2), protein: Math.round(food.protein / 2), fat: Math.round(food.fat / 2), carbs: Math.round(food.carbs / 2) }
      : food;
    try {
      const r = logFoodEntry(String(chatId), store.getUser(String(chatId)), entry);
      if (!r || r.kind === 'no_profile') {
        await send(chatId, 'Чтобы считать, нужен профиль: вес и рост. Загляни в ЛК → Фитнес');
        return true;
      }
      const left = Math.max(0, r.norm.kcal - r.log.kcal);
      await send(
        chatId,
        `🍽 Записал: ${esc(r.added.title)} - ${r.added.kcal} ккал (Б${r.added.protein}/Ж${r.added.fat}/У${r.added.carbs})\n` +
          `Сегодня: <b>${r.log.kcal}</b> из ${r.norm.kcal} ккал${left ? `, осталось ${left}` : ' - норма закрыта 👍'}\n` +
          esc(macroAdvice(r.log, r.norm).join(' · ')),
      );
    } catch (e) {
      log?.error?.('[food] запись', e.message);
      await send(chatId, 'Не смог записать, попробуй ещё раз');
    }
    return true;
  }

  return { card, onCallback };
}
