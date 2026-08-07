// Незавершённые сценарии ЛК (ввод суммы долга, ссылки на товар, веса в тренере,
// подтверждения события) переживают перезапуск бота.
//
// Раньше это был обычный Map в памяти процесса: любой деплой или рестарт стирал
// состояние у ВСЕХ разом. Со стороны человека это выглядит как поломка - бот
// спросил «пришли ссылку», он присылает, а в ответ болтовня, потому что бот уже
// не помнит, чего ждал.
//
// Интерфейс намеренно повторяет Map (get/set/has/delete), чтобы вызывающий код
// не менялся.

const TTL_MS = 24 * 60 * 60 * 1000; // брошенный сценарий не висит вечно

export function persistentPending(store, ns) {
  const box = () => {
    if (!store.data.meta.pending || typeof store.data.meta.pending !== 'object') store.data.meta.pending = {};
    if (!store.data.meta.pending[ns] || typeof store.data.meta.pending[ns] !== 'object') store.data.meta.pending[ns] = {};
    return store.data.meta.pending[ns];
  };

  // Протухшее убираем лениво - при первом же обращении к чату.
  const alive = (rec) => rec && typeof rec === 'object' && Date.now() - (rec.ts || 0) < TTL_MS;

  return {
    get(chatId) {
      const b = box();
      const rec = b[String(chatId)];
      if (!alive(rec)) {
        if (rec) { delete b[String(chatId)]; store.save(); }
        return undefined;
      }
      return rec.value;
    },
    has(chatId) {
      return this.get(chatId) !== undefined;
    },
    set(chatId, value) {
      box()[String(chatId)] = { ts: Date.now(), value };
      store.save();
      return this;
    },
    delete(chatId) {
      const b = box();
      const had = String(chatId) in b;
      if (had) { delete b[String(chatId)]; store.save(); }
      return had;
    },
  };
}
