// Разбор просьбы «позови такого-то [и передай ему то-то]».
//
// Живые баги из «Банды»:
//   «Маму позови сообщи ей об этом» -> бот искал участника с именем
//   «Сообщи ей об этом» (имя стоит ПЕРЕД глаголом, а хвост - поручение);
//   «Позови ты» -> искал участника «Ты».
// Раньше это был один regexp прямо в group.mjs, который забирал ВЕСЬ хвост
// как имя. Теперь разбор отдельный и покрыт тестами.

// Глаголы вызова. «зови» отдельно от «позови», чтобы ловить обе формы.
const CALL = '(?:т[еэ]гни+|т[еэ]гай|пингани|пингуй|позови|призови|зови|дерни|дёрни|свистни|крикни|кликни|разбуди|подними)';

// Глаголы поручения: то, что идёт ПОСЛЕ имени и адресовано боту.
const RELAY = '(?:скажи|передай|напиши|сообщи|спроси|уточни|попроси|намекни|объясни)';

const RE_CALL_FIRST = new RegExp(`(?:^|[\\s,!])${CALL}\\s+@?(.+)$`, 'i');
// «Маму позови», «Серёгу, дёрни» - имя впереди глагола
const RE_NAME_FIRST = new RegExp(`(?:^|[\\s,!])@?([А-Яа-яЁёA-Za-z][А-Яа-яЁёA-Za-z0-9_]{1,31})[,\\s]+${CALL}(?![а-яё])(.*)$`, 'i');
const RE_RELAY_HEAD = new RegExp(`^(?:и\\s+)?${RELAY}(?![а-яё])`, 'i');
const RE_ALL = new RegExp(`(?:^|[\\s,!])(?:${CALL}|собери|созови)\\s+(?:всех|всем|народ|пацанов|ребят|тут\\s+всех)|^@?все\\s+сюда`, 'i');

// Местоимения и обрывки: именем быть не могут.
export const NOT_A_NAME = /^(?:ты|вы|я|мы|он|она|они|нас|вас|их|кто|кого|кого[- ]нибудь|кого[- ]то|сюда|туда|тут|там|сам|сама|уже|быстро|давай|плиз|пожалуйста|его|её|ее)$/i;

const clean = (s) => String(s || '').replace(/^[\s,:-]+/, '').replace(/[,!?.\s]+$/, '').trim();

// Хвост-поручение: «и скажи что опоздаю» -> «опоздаю». Пустая отговорка
// вроде «сообщи ей об этом» смысла не несёт - её отбрасываем.
function relayBody(tail) {
  const t = clean(tail);
  if (!t || !RE_RELAY_HEAD.test(t)) return null;
  // NB: \b не знает кириллицы - границы через lookahead, и чистим на каждом шаге
  let body = clean(t.replace(RE_RELAY_HEAD, ''));
  body = clean(body.replace(/^(?:ему|ей|им|их)(?![а-яё])/i, ''));
  body = clean(body.replace(/^(?:что|чтобы|про|об|о)(?![а-яё])/i, ''));
  // «об этом», «это», «ей» - ничего не сообщают, зовём просто по имени
  if (!body || /^(?:это|этом|том|то же|тоже|там|этого)$/i.test(body) || body.length < 3) return null;
  return body;
}

// { who, relay } или null, если это вообще не просьба позвать.
// who === '*' - зовут всех.
export function parseCallRequest(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (RE_ALL.test(raw)) return { who: '*', relay: null };

  let cand = null;
  let tail = '';
  const m1 = raw.match(RE_CALL_FIRST);
  if (m1) {
    const rest = clean(m1[1]);
    const [head, ...others] = rest.split(/\s+/);
    // «позови сообщи ей» - после глагола сразу поручение, значит имя было раньше
    if (!RE_RELAY_HEAD.test(rest)) {
      cand = head;
      tail = others.join(' ');
    }
  }
  if (!cand) {
    const m2 = raw.match(RE_NAME_FIRST);
    if (m2) {
      cand = clean(m2[1]);
      tail = clean(m2[2]);
    }
  }
  if (!cand && m1) {
    // остаётся случай «позови и передай...» - имени нет вовсе
    return { who: null, relay: null };
  }
  if (!cand) return null;

  cand = cand.replace(/^@/, '').replace(/[,!?.]+$/, '');
  if (!cand) return { who: null, relay: null };
  if (NOT_A_NAME.test(cand)) return { who: null, relay: null, pronoun: cand.toLowerCase() };
  return { who: cand, relay: relayBody(tail) };
}
