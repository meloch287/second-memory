// Премиум-эмодзи (custom emoji) оформления бота. ID собраны секретной командой
// /id (см. telegram-idpicker.mjs) - там же лежит инструкция, как достать новые.
//
// ВАЖНО про Telegram:
//  - в ТЕКСТЕ сообщения: тег <tg-emoji emoji-id="..">🙂</tg-emoji> (parse_mode
//    HTML). Тег обязан оборачивать РОВНО ОДИН обычный эмодзи - он же фолбэк,
//    если прав на премиум нет (вёрстка не ломается);
//  - в КНОПКАХ: отдельное поле `icon_custom_emoji_id` у InlineKeyboardButton
//    и KeyboardButton (иконка ПЕРЕД текстом). В сам `text` разметку класть
//    нельзя - уедет сырым «<tg-emoji…>» (проверено живой отправкой);
//  - право на премиум: бот с купленным на Fragment юзернеймом ЛИБО личные/
//    групповые чаты, если у владельца бота есть Telegram Premium. У нас второе -
//    подтверждено живой отправкой (в ответе API приходит entity custom_emoji).

// key -> { id, fallback } (fallback = обычный эмодзи того же смысла)
export const PREMIUM = {
  gear: { id: '5431711187811208391', fallback: '⚙️' }, // заголовок ЛК
  brain: { id: '5231271330464168765', fallback: '🧠' }, // факты
  money: { id: '5319268815152909865', fallback: '💸' }, // долги
  calendar: { id: '5321448751573795291', fallback: '📆' }, // встречи
  gift: { id: '5456174045923926926', fallback: '🎁' }, // вишлист
  // Кнопки ЛК (уезжают в icon_custom_emoji_id, fallback - в текст кнопки)
  muscle: { id: '5307575053724950740', fallback: '💪' },
  moneyBtn: { id: '5382199784075448966', fallback: '💸' },
  giftBtn: { id: '5433837978306766664', fallback: '💝' },
  calendarBtn: { id: '5283187967425268516', fallback: '📆' },
};

// Премиум-эмодзи для ТЕКСТА сообщения. Неизвестный ключ -> пустая строка,
// чтобы опечатка не роняла экран.
export function pe(key) {
  const e = PREMIUM[key];
  if (!e) return '';
  return `<tg-emoji emoji-id="${e.id}">${e.fallback}</tg-emoji>`;
}

// Обычный эмодзи того же смысла - для подписей кнопок.
export function plain(key) {
  return PREMIUM[key]?.fallback || '';
}

/**
 * Инлайн-кнопка с премиум-иконкой. Telegram рисует иконку ПЕРЕД текстом
 * (icon_custom_emoji_id), поэтому эмодзи в сам text НЕ кладём - был бы дубль.
 * Разметку (<tg-emoji>) в text класть нельзя: уедет сырым тегом.
 * @param {string} key   ключ из PREMIUM
 * @param {string} label подпись кнопки без эмодзи
 * @param {object} extra остальные поля (callback_data, style: danger|success|primary)
 */
export function peButton(key, label, extra = {}) {
  const e = PREMIUM[key];
  if (!e) return { text: label, ...extra };
  return { text: label, icon_custom_emoji_id: e.id, ...extra };
}
