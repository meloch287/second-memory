// Секретная «пипетка» ID: /id включает режим, дальше любой присланный стикер
// или премиум-эмодзи отдаёт свои идентификаторы (копируются тапом).
//
// Что откуда берётся (Bot API):
//   - обычный/анимированный стикер -> message.sticker: file_id, file_unique_id,
//     type ('regular'|'mask'|'custom_emoji'), set_name, emoji, is_animated/is_video;
//   - ПРЕМИУМ-эмодзи внутри текста -> message.entities[] с type='custom_emoji'
//     и полем custom_emoji_id (сам символ вырезаем из текста по offset/length,
//     offset считается в UTF-16 code units - как раз индексы JS-строки);
//   - детали по custom_emoji_id -> метод getCustomEmojiStickers (до 200 за раз).
//
// Отправлять премиум-эмодзи бот может тегом <tg-emoji emoji-id="ID">🙂</tg-emoji>,
// причём тег обязан оборачивать РОВНО ОДИН обычный эмодзи (иначе Telegram
// проигнорирует сущность и покажет фолбэк). Показ премиума работает не у всех
// ботов (нужен купленный на Fragment юзернейм либо Premium у владельца) - на
// этот случай фолбэком остаётся обычный эмодзи внутри тега, верстка не ломается.

import { esc } from './telegram-helpers.mjs';

// Секретные алиасы: в меню команд их нет.
export const ID_CMD = /^\/(?:id|stickerid|emojiid|ids)(?:@\w+)?$/i;

export function createIdPicker(deps) {
  const { send, api, log } = deps;
  const active = new Set(); // chatId, где включён режим пипетки

  const isOn = (chatId) => active.has(String(chatId));
  const stop = (chatId) => active.delete(String(chatId));

  const DONE_KB = { inline_keyboard: [[{ text: '✅ Готово', callback_data: 'idp:off' }]] };

  async function start(chatId) {
    active.add(String(chatId));
    await send(
      chatId,
      [
        '🔍 <b>Режим пипетки включён</b>',
        '',
        'Пришли мне:',
        '• стикер - отдам его file_id и набор;',
        '• премиум-эмодзи (можно несколько в одном сообщении) - отдам custom_emoji_id.',
        '',
        'Идентификаторы приходят моноширинным текстом - жми, чтобы скопировать.',
      ].join('\n'),
      { reply_markup: DONE_KB },
    );
    return true;
  }

  async function finish(chatId) {
    stop(chatId);
    return send(chatId, 'Пипетка выключена. Включить снова - /id');
  }

  function stickerReport(s) {
    const lines = ['🎨 <b>Стикер</b>', ''];
    lines.push(`Тип: ${esc(s.type || (s.is_animated ? 'animated' : s.is_video ? 'video' : 'regular'))}`);
    if (s.emoji) lines.push(`Эмодзи: ${esc(s.emoji)}`);
    if (s.set_name) lines.push(`Набор: <code>${esc(s.set_name)}</code>`);
    lines.push('', 'file_id:', `<code>${esc(s.file_id)}</code>`);
    lines.push('', 'file_unique_id:', `<code>${esc(s.file_unique_id)}</code>`);
    if (s.custom_emoji_id) lines.push('', 'custom_emoji_id:', `<code>${esc(s.custom_emoji_id)}</code>`);
    return lines.join('\n');
  }

  // Символ эмодзи по entity: offset/length в UTF-16 code units = индексы JS-строки.
  function sliceEntity(text, e) {
    try {
      return String(text).slice(e.offset, e.offset + e.length);
    } catch {
      return '';
    }
  }

  async function emojiReport(text, entities) {
    const items = entities
      .filter((e) => e.type === 'custom_emoji' && e.custom_emoji_id)
      .map((e) => ({ id: e.custom_emoji_id, char: sliceEntity(text, e) }));
    if (!items.length) return null;

    // Детали (набор, базовый эмодзи) - одним запросом на все ID (лимит 200).
    let info = new Map();
    try {
      const r = await api('getCustomEmojiStickers', { custom_emoji_ids: items.slice(0, 200).map((i) => i.id) });
      if (r?.ok && Array.isArray(r.result)) {
        for (const st of r.result) if (st.custom_emoji_id) info.set(st.custom_emoji_id, st);
      }
    } catch (e) {
      log?.error?.('[idp] getCustomEmojiStickers', e?.message);
    }

    const lines = [`✨ <b>Премиум-эмодзи: ${items.length}</b>`, ''];
    items.forEach((it, i) => {
      const st = info.get(it.id);
      lines.push(`${i + 1}. ${esc(it.char || st?.emoji || '')}${st?.set_name ? ` · набор <code>${esc(st.set_name)}</code>` : ''}`);
      lines.push(`<code>${esc(it.id)}</code>`);
      // Готовая к вставке разметка: тег обязан оборачивать ровно один эмодзи.
      lines.push(`<code>${esc(`<tg-emoji emoji-id="${it.id}">${it.char || st?.emoji || '⭐'}</tg-emoji>`)}</code>`);
      lines.push('');
    });
    return lines.join('\n').trim();
  }

  // Перехват сообщения в режиме пипетки. true = сообщение обработано.
  async function consume(chatId, msg) {
    if (!isOn(chatId)) return false;

    if (msg.sticker) {
      await send(chatId, stickerReport(msg.sticker), { reply_markup: DONE_KB });
      return true;
    }

    const entities = msg.entities || msg.caption_entities || [];
    const text = msg.text || msg.caption || '';
    if (entities.some((e) => e.type === 'custom_emoji')) {
      const report = await emojiReport(text, entities);
      if (report) {
        await send(chatId, report, { reply_markup: DONE_KB });
        return true;
      }
    }

    // Выход по слову или команде - иначе пипетка перехватывала бы весь диалог.
    const t = String(text).trim().toLowerCase().replace(/ё/g, 'е');
    if (!t || /^(стоп|хватит|готово|выключи|отмена|off|stop|\/id\s*off|\/stop)$/.test(t)) {
      await finish(chatId);
      return true;
    }
    if (t.startsWith('/')) { stop(chatId); return false; } // команды пропускаем дальше

    await send(
      chatId,
      'Это обычный текст без премиум-эмодзи. Пришли стикер или премиум-эмодзи, либо скажи «готово».',
      { reply_markup: DONE_KB },
    );
    return true;
  }

  async function onCallback(chatId, data) {
    if (data !== 'idp:off') return false;
    await finish(chatId);
    return true;
  }

  return { start, consume, onCallback, isOn, stop };
}
