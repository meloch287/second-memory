// Эмодзи-реакции на сообщения (№8): бот иногда «лайкает» по настроению,
// как живой участник. rand инъектится для тестов.

const FUN = /ахах|хаха|azaz|ржу|лол|lol|умора|смешно|🤣|😂/;
const WIN = /сдал[аи]? |получилось|выиграл|победил|наконец[- ]?то|ура[!)\s]|запустил[аи]?|оффер|приняли|прош[ае]л собес|сработало|готово!|сделал это/;
const WARM = /спасибо|благодар|красавчик|молодец|топ\b|круто|огонь|шикарно|обожаю|люблю/;
const SAD = /плохо|грустно|тяжело|устал|вымотал|провалил|отказали|расстроен|поругал|болит|заболел/;

// Возвращает эмодзи-реакцию или null. Вероятности - чтобы бот не лайкал всё подряд.
export function pickReaction(text, rand = Math.random) {
  const t = String(text).toLowerCase().replace(/ё/g, 'е');
  if (FUN.test(t)) return rand() < 0.5 ? '😁' : null;
  if (WIN.test(t)) return rand() < 0.5 ? (rand() < 0.5 ? '🎉' : '🔥') : null;
  if (WARM.test(t)) return rand() < 0.35 ? (rand() < 0.5 ? '❤️' : '👍') : null;
  if (SAD.test(t)) return rand() < 0.25 ? '❤️' : null; // молчаливая поддержка
  return null;
}

// Эмоция текста для подбора выученного стикера (null - нейтрально).
export function stickerMood(text, rand = Math.random) {
  const t = String(text).toLowerCase().replace(/ё/g, 'е');
  if (rand() > 0.2) return null; // стикер - редкий гость
  if (FUN.test(t)) return ['😂', '😁', '🤣'];
  if (WIN.test(t)) return ['🎉', '🔥', '👍', '🏆'];
  if (WARM.test(t)) return ['❤️', '🥰', '👍'];
  return null;
}
