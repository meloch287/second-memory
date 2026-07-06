// Telegram-бот: та же «вторая память», но в чате Telegram.
// Включается переменной TELEGRAM_BOT_TOKEN, работает через long polling.
// Понимает голосовые: скачивает файл и транскрибирует через ИИ (см. ai.mjs).

import { handleMessage } from './brain.mjs';
import { aiEnabled, aiTranscribe } from './ai.mjs';

const KEYBOARD = {
  keyboard: [
    [{ text: '📋 Сводка' }, { text: '💰 Все долги' }],
    [{ text: '📅 Что завтра' }, { text: '🧠 ИИ-саммари' }],
    [{ text: '❓ Помощь' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const COMMANDS = [
  { command: 'summary', description: 'ИИ-саммари по всей базе' },
  { command: 'debts', description: 'Все открытые долги' },
  { command: 'today', description: 'Сводка на сегодня' },
  { command: 'clear', description: 'Очистить историю чата' },
  { command: 'help', description: 'Примеры команд' },
];

const SLASH_MAP = {
  '/summary': 'саммари',
  '/debts': 'покажи все долги',
  '/today': 'что у меня сегодня',
  '/clear': 'очистить чат',
  '/help': 'помощь',
  '/start': 'помощь',
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Первая строка ответа — жирным, остальное как есть.
function toHtml(text) {
  const nl = text.indexOf('\n');
  if (nl < 0) return esc(text);
  return `<b>${esc(text.slice(0, nl))}</b>\n${esc(text.slice(nl + 1))}`;
}

export function startTelegramBot(store, token, log = console) {
  if (!token) return null;

  const api = async (method, params) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    return res.json();
  };

  const send = (chat_id, text) =>
    api('sendMessage', {
      chat_id,
      text: toHtml(String(text).slice(0, 4000)),
      parse_mode: 'HTML',
      reply_markup: KEYBOARD,
    });

  async function transcribeVoice(fileId) {
    const info = await api('getFile', { file_id: fileId });
    if (!info.ok) throw new Error('getFile failed');
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
    if (!res.ok) throw new Error('file download failed');
    const b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
    return aiTranscribe(b64, 'ogg');
  }

  async function onMessage(msg) {
    const chatId = msg.chat.id;

    if (msg.voice || msg.audio) {
      if (!aiEnabled()) {
        await send(chatId, 'Расшифровка голосовых не настроена (нет AI_API_KEY). Напишите текстом, пожалуйста.');
        return;
      }
      const voice = msg.voice || msg.audio;
      if ((voice.duration || 0) > 180) {
        await send(chatId, 'Голосовое длиннее трёх минут — не осилю. Скажите короче или напишите текстом.');
        return;
      }
      const transcript = await transcribeVoice(voice.file_id);
      if (!transcript) {
        await send(chatId, 'Не расслышал речь в голосовом. Попробуйте ещё раз.');
        return;
      }
      const out = await handleMessage(store, transcript);
      await send(chatId, `🎙 «${transcript}»\n\n${out.reply}`);
      return;
    }

    if (typeof msg.text !== 'string') return;
    let text = msg.text.trim();
    if (SLASH_MAP[text.split(' ')[0]]) text = SLASH_MAP[text.split(' ')[0]];
    // кнопки клавиатуры приходят с эмодзи в начале — срезаем
    text = text.replace(/^[^\p{L}\p{N}/]+\s*/u, '');
    if (!text) return;
    const out = await handleMessage(store, text);
    await send(chatId, out.reply);
  }

  let running = true;
  let offset = 0;

  (async () => {
    log.log('[telegram] бот запущен (long polling)');
    api('setMyCommands', { commands: COMMANDS }).catch(() => {});
    while (running) {
      try {
        const res = await api('getUpdates', { offset, timeout: 25 });
        if (!res.ok) throw new Error(res.description || 'getUpdates failed');
        for (const update of res.result) {
          offset = update.update_id + 1;
          // Ошибка одного update не должна ронять обработку остальных в пачке
          try {
            if (update.message) await onMessage(update.message);
          } catch (e) {
            log.error('[telegram] update', update.update_id, e.message);
          }
        }
      } catch (e) {
        log.error('[telegram]', e.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();

  return {
    stop() {
      running = false;
    },
  };
}
