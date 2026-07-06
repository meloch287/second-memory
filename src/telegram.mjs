// Опциональный Telegram-бот: та же «вторая память», но в чате Telegram.
// Включается переменной окружения TELEGRAM_BOT_TOKEN, работает через long polling.

import { handleMessage } from './brain.mjs';

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

  let running = true;
  let offset = 0;

  (async () => {
    log.log('[telegram] бот запущен (long polling)');
    while (running) {
      try {
        const res = await api('getUpdates', { offset, timeout: 25 });
        if (!res.ok) throw new Error(res.description || 'getUpdates failed');
        for (const update of res.result) {
          offset = update.update_id + 1;
          // Ошибка одного update не должна ронять обработку остальных в пачке
          try {
            const msg = update.message;
            if (!msg) continue;
            if (msg.voice || msg.audio) {
              await api('sendMessage', {
                chat_id: msg.chat.id,
                text: 'Голосовые я пока понимаю только в веб-версии (там есть транскрибация). Здесь напишите текстом, пожалуйста.',
              });
              continue;
            }
            if (typeof msg.text !== 'string') continue;
            const out = handleMessage(store, msg.text);
            await api('sendMessage', { chat_id: msg.chat.id, text: out.reply });
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
