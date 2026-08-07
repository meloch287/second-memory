// Аудиофайлы (mp3, m4a, wav, audio-документы): не расшифровываем молча, а
// спрашиваем, что с ними сделать - дать текст целиком или краткое саммари.
// Голосовые (voice) и кружки идут прежним путём: там выбор не нужен.
//
// file_id длиннее лимита callback_data (64 байта), поэтому держим карточку в
// памяти процесса под коротким ключом. Ключ живёт час - дальше кнопка честно
// сообщает, что запись протухла (перезалить проще, чем хранить вечно).

import { esc } from './telegram-helpers.mjs';

const TTL_MS = 60 * 60 * 1000;

export function createAudioChoice(deps) {
  const { send, withTyping, transcribe, summarize, onTranscript, log } = deps;
  const pending = new Map(); // key -> { fileId, format, duration, title, chatId, ts }
  let seq = 0;

  const gc = () => {
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.ts > TTL_MS) pending.delete(k);
  };

  // Показать карточку с выбором. Возвращает true - сообщение обработано.
  async function ask(chatId, { fileId, format, duration, title }) {
    gc();
    const key = String(++seq);
    pending.set(key, { fileId, format, duration, title, chatId: String(chatId), ts: Date.now() });
    const mins = duration ? ` · ${Math.max(1, Math.round(duration / 60))} мин` : '';
    await send(chatId, `🎧 ${esc(title || 'Аудио')}${mins}\n\nЧто с ним сделать?`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 Транскрипция', callback_data: `aud:tr:${key}` },
            { text: '🧾 Саммари', callback_data: `aud:sm:${key}` },
          ],
          [{ text: '✖️ Ничего', callback_data: `aud:no:${key}` }],
        ],
      },
    });
    return true;
  }

  async function onCallback(chatId, data) {
    const m = String(data || '').match(/^aud:(tr|sm|no):(\d+)$/);
    if (!m) return false;
    const [, what, key] = m;
    const card = pending.get(key);
    if (!card) {
      await send(chatId, 'Эта запись уже протухла, скинь ещё раз');
      return true;
    }
    if (what === 'no') {
      pending.delete(key);
      await send(chatId, 'лан, не трогаю');
      return true;
    }

    const text = await withTyping(chatId, () => transcribe(card)).catch((e) => {
      log?.error?.('[audio] transcribe', e?.message);
      return null;
    });
    if (!text) {
      await send(chatId, 'Не смог разобрать запись, попробуй перезалить');
      return true;
    }
    pending.delete(key);

    if (what === 'tr') {
      // длинную расшифровку режем на части - в одно сообщение Telegram не влезет
      const chunks = String(text).match(/[\s\S]{1,3500}/g) || [];
      for (const c of chunks) await send(chatId, esc(c));
    } else {
      const sum = await withTyping(chatId, () => summarize(text, card.title)).catch((e) => {
        log?.error?.('[audio] summarize', e?.message);
        return null;
      });
      await send(chatId, sum ? esc(sum) : 'Расшифровал, но саммари не вышло. Вот текст:\n\n' + esc(String(text).slice(0, 3500)));
    }
    // запись всё равно попадает в память бота - как обычный рассказ
    await onTranscript?.(chatId, text, card);
    return true;
  }

  return { ask, onCallback };
}

// mp3/m4a/wav/ogg-файл или audio-документ - да; голосовое и кружок - нет.
export function isAudioFile(msg) {
  if (!msg || msg.voice || msg.video_note) return false;
  if (msg.audio) return true;
  const mime = String(msg.document?.mime_type || '');
  const name = String(msg.document?.file_name || '');
  return Boolean(msg.document) && (mime.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|opus|aac|flac|wma)$/i.test(name));
}

// Что показать в карточке и чем расшифровывать.
export function audioInfo(msg) {
  if (msg.audio) {
    return {
      fileId: msg.audio.file_id,
      mime: msg.audio.mime_type,
      duration: msg.audio.duration || 0,
      title: msg.audio.file_name || [msg.audio.performer, msg.audio.title].filter(Boolean).join(' - ') || 'Аудио',
    };
  }
  const d = msg.document;
  return { fileId: d.file_id, mime: d.mime_type, duration: 0, title: d.file_name || 'Аудио' };
}
