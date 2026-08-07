// Реестр возможностей (Толик знает про КАЖДУЮ фичу), живое состояние фич в
// контексте (календарь/вишлист/фитнес) и личные предпочтения общения.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { CAPABILITIES, capabilitiesLine, featureState, stylePref, parseStylePref, parseDontDo, captureStylePref } from '../src/capabilities.mjs';
import { friendSystem } from '../src/ai.mjs';

delete process.env.SM_ENCRYPTION_KEY;
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'sm-cap-')), 'm.json');
const MSK = 180;

test('реестр: все ключевые фичи на месте и попадают в промпт', () => {
  const keys = CAPABILITIES.map((c) => c.key);
  for (const k of ['voice', 'media', 'reminders', 'debts', 'expenses', 'wishlist', 'calendar', 'fitness', 'memory', 'lk']) {
    assert.ok(keys.includes(k), `фича ${k} должна быть в реестре`);
  }
  const line = capabilitiesLine();
  assert.match(line, /ВИШЛИСТ/i);
  assert.match(line, /КАЛЕНДАРЬ/i);
  assert.match(line, /ТРЕНЕР/i);
  assert.match(line, /голосов/i);
  assert.match(line, /не отрицай/i, 'бот не должен отрицать свои способности');
});

test('реестр синхронизирован с docs/FEATURES.md (каждый ключ описан)', () => {
  const md = readFileSync(new URL('../docs/FEATURES.md', import.meta.url), 'utf8');
  for (const c of CAPABILITIES) {
    assert.ok(md.includes('`' + c.key + '`'), `docs/FEATURES.md должен описывать фичу ${c.key}`);
  }
});

test('friendSystem включает реестр возможностей', () => {
  const sys = friendSystem({ name: 'Макс', botName: 'Толик' });
  assert.match(sys, /ВИШЛИСТ/i);
  assert.match(sys, /КАЛЕНДАРЬ/i);
  assert.match(sys, /ТРЕНЕР/i);
});

test('featureState: пустой стор -> пусто (не мусорим контекст)', () => {
  const s = new Store(tmpFile());
  assert.deepEqual(featureState(s, '1', MSK, new Date()), []);
});

test('featureState: вишлист попадает в контекст с ценой', () => {
  const s = new Store(tmpFile());
  s.addWish('1', { title: 'Робот-пылесос', price: 18990, photos: ['http://x/1.jpg'] });
  s.addWish('1', { title: 'Кепка' });
  const txt = featureState(s, '1', MSK, new Date()).join('\n');
  assert.match(txt, /ВИШЛИСТ/);
  assert.match(txt, /Робот-пылесос/);
  assert.match(txt, /18990/);
  assert.match(txt, /Кепка/);
});

test('featureState: календарь показывает будущие события', () => {
  const s = new Store(tmpFile());
  const due = new Date(Date.now() + 86400000).toISOString();
  s.add({ chatId: '1', type: 'meeting', title: 'Встреча с Аней', due, hasTime: true, calendar: true });
  const txt = featureState(s, '1', MSK, new Date()).join('\n');
  assert.match(txt, /КАЛЕНДАРЬ/);
  assert.match(txt, /Встреча с Аней/);
});

test('featureState: фитнес - сегодня тренировочный день, план на сегодня', () => {
  const s = new Store(tmpFile());
  const now = new Date('2026-08-05T09:00:00.000Z'); // среда (МСК 12:00)
  s.setFitness('1', { weight: 80, height: 180, goal: 'масса', level: 'средний', days: [1, 3, 5], plan: { 3: 'Разминка\n- Присед 4x8' } });
  const txt = featureState(s, '1', MSK, now).join('\n');
  assert.match(txt, /ФИТНЕС/);
  assert.match(txt, /тренировочные дни: Пн, Ср, Пт/);
  assert.match(txt, /СЕГОДНЯ \(среда\) тренировочный день/);
  assert.match(txt, /Присед/, 'план на сегодня в контексте');
});

test('featureState: фитнес - сегодня НЕ тренировочный, подсказывает ближайший', () => {
  const s = new Store(tmpFile());
  const now = new Date('2026-08-04T09:00:00.000Z'); // вторник
  s.setFitness('1', { weight: 80, days: [1, 3, 5], plan: { 3: 'x' } });
  const txt = featureState(s, '1', MSK, now).join('\n');
  assert.match(txt, /НЕ тренировочный день/);
  assert.match(txt, /ближайшая тренировка: среда/);
});

/* ---- Предпочтения общения ---- */

test('«называй меня братан» -> addressAs', () => {
  assert.deepEqual(parseStylePref('называй меня братан'), { addressAs: 'Братан', noName: false });
  assert.deepEqual(parseStylePref('зови меня Босс'), { addressAs: 'Босс', noName: false });
});

test('«не называй меня по имени» -> noName', () => {
  assert.deepEqual(parseStylePref('не называй меня по имени'), { noName: true, addressAs: null });
});

test('мат ВЫКЛЮЧЕН по умолчанию, включается явной просьбой', () => {
  assert.equal(parseStylePref('привет'), null, 'обычное сообщение стиль не трогает');
  // включение (формулировка из /help)
  assert.equal(parseStylePref('Толян включи мат')?.talkStyle, 'mat');
  assert.equal(parseStylePref('можешь материться')?.talkStyle, 'mat');
  assert.equal(parseStylePref('общайся матом')?.talkStyle, 'mat');
  assert.equal(parseStylePref('вруби мат')?.talkStyle, 'mat');
  // выключение обратно в дефолт
  assert.equal(parseStylePref('не общайся матом')?.talkStyle, null);
  assert.equal(parseStylePref('выключи мат')?.talkStyle, null);
  assert.equal(parseStylePref('не матерись больше')?.talkStyle, null);
  // официальный тон
  assert.equal(parseStylePref('давай общайся официально')?.talkStyle, 'official');
  assert.equal(parseStylePref('перейдем на вы')?.talkStyle, 'official');
});

test('обычная болтовня не меняет настройки', () => {
  assert.equal(parseStylePref('привет как дела'), null);
  assert.equal(parseStylePref('сегодня официальная встреча в офисе'), null);
});

test('«не делай X» копится списком, без дублей', () => {
  const a = parseDontDo('не надо задавать встречные вопросы');
  assert.ok(a[0].includes('задавать встречные вопросы'));
  const b = parseDontDo('перестань использовать смайлики', a);
  assert.equal(b.length, 2);
  assert.equal(parseDontDo('не надо задавать встречные вопросы', b), null, 'дубль не добавляется');
});

test('captureStylePref сохраняет в профиль и подтверждает', () => {
  const s = new Store(tmpFile());
  s.setUser('1', { name: 'Макс' });
  const reply = captureStylePref(s, '1', 'называй меня братан');
  assert.match(reply, /Братан/);
  assert.equal(s.getUser('1').addressAs, 'Братан');
  captureStylePref(s, '1', 'и общайся официально');
  assert.equal(s.getUser('1').talkStyle, 'official');
});

test('stylePref -> инструкции в системный промпт', () => {
  assert.match(stylePref({ addressAs: 'Братан' }), /Братан/);
  assert.match(stylePref({ talkStyle: 'official' }), /ОФИЦИАЛЬНО/);
  assert.match(stylePref({ talkStyle: 'mat' }), /разрешил мат/i);
  assert.match(stylePref({ noName: true }), /НЕ обращаться/i);
  assert.match(stylePref({ dontDo: ['задавать встречные вопросы'] }), /НЕ делать/i);
  assert.equal(stylePref({}), '');
});

test('friendSystem учитывает предпочтения юзера', () => {
  const sys = friendSystem({ name: 'Макс', botName: 'Толик', addressAs: 'Братан', talkStyle: 'official' });
  assert.match(sys, /Братан/);
  assert.match(sys, /ОФИЦИАЛЬНО/);
});

/* ---- Официальный тон реально переключает базовую персону ---- */
test('toneBlock: три режима - дефолт без мата, mat по просьбе, official', async () => {
  const { toneBlock } = await import('../src/capabilities.mjs');

  const def = toneBlock({});
  assert.match(def, /БЕЗ МАТА/, 'по умолчанию не матерится');
  assert.match(def, /НЕ ставь точку в конце/, 'живость сохраняется');
  assert.match(def, /НИКАКИХ вводных/);
  assert.match(def, /НИКАКИХ сложноподчинённых/);
  assert.match(def, /живой пацан/i, 'не как бот');

  const mat = toneBlock({ talkStyle: 'mat' });
  assert.match(mat, /МАТ ВКЛЮЧЁН/);
  assert.ok(!/БЕЗ МАТА/.test(mat), 'дефолтный запрет убран');
  assert.match(mat, /НЕ ставь точку в конце/, 'механика речи та же');

  // старое значение из ранее сохранённых профилей = дефолт
  assert.match(toneBlock({ talkStyle: 'clean' }), /БЕЗ МАТА/, 'обратная совместимость');

  const off = toneBlock({ talkStyle: 'official' });
  assert.match(off, /ОФИЦИАЛЬНО/);
  assert.match(off, /«вы»/);
  assert.ok(!/МАТ ВКЛЮЧЁН/.test(off), 'в официальном тоне мата нет');
});

test('friendSystem: official не содержит противоречивого «на ты, неформально»', () => {
  const sys = friendSystem({ name: 'Макс', botName: 'Толик', talkStyle: 'official' });
  assert.match(sys, /ОФИЦИАЛЬНО/);
  assert.ok(!/Общайся на «ты», тепло, неформально/.test(sys), 'конфликтующая инструкция убрана');
});

test('«не называй меня по имени» снимает и прозвище', () => {
  const p = parseStylePref('не называй меня по имени');
  assert.equal(p.noName, true);
  assert.equal(p.addressAs, null, 'прозвище тоже снимается');
});

test('captureStylePref: братан -> потом noName сбрасывает обращение', () => {
  const s = new Store(tmpFile());
  s.setUser('1', { name: 'Макс' });
  captureStylePref(s, '1', 'называй меня братан');
  assert.equal(s.getUser('1').addressAs, 'Братан');
  captureStylePref(s, '1', 'не называй меня по имени');
  assert.equal(s.getUser('1').noName, true);
  assert.equal(s.getUser('1').addressAs, null);
  assert.match(stylePref(s.getUser('1')), /НЕ обращаться/i);
});

test('questionHabit: запрет на вопросы отменяет привычку переспрашивать', async () => {
  const { questionHabit } = await import('../src/capabilities.mjs');
  assert.match(questionHabit({}), /Иногда задавай один короткий встречный вопрос/);
  const banned = questionHabit({ dontDo: ['задавать мне встречные вопросы'] });
  assert.match(banned, /НЕ задавай встречных вопросов/);
  assert.ok(!/Иногда задавай/.test(banned));
});

test('friendSystem: при запрете вопросов нет инструкции их задавать', () => {
  const sys = friendSystem({ name: 'Макс', dontDo: ['задавать встречные вопросы'] });
  assert.match(sys, /НЕ задавай встречных вопросов/);
  assert.match(sys, /ЖЁСТКОЕ ПРАВИЛО/);
  assert.ok(!/Иногда задавай один короткий встречный вопрос/.test(sys));
});

test('stripTrailingQuestion: срезает вопрос-хвост только при запрете', async () => {
  const { stripTrailingQuestion } = await import('../src/capabilities.mjs');
  const banned = { dontDo: ['задавать мне встречные вопросы'] };
  const reply = 'Отпуск - отличная тема. Сразу мечты начинаются. А ты куда-нибудь присмотрел?';
  const out = stripTrailingQuestion(reply, banned);
  assert.ok(!out.includes('?'), 'вопрос срезан: ' + out);
  assert.match(out, /мечты начинаются/, 'содержательная часть цела');
  // без запрета - не трогаем
  assert.equal(stripTrailingQuestion(reply, {}), reply);
  // единственное предложение-вопрос не режем в пустоту
  assert.equal(stripTrailingQuestion('А что случилось?', banned), 'А что случилось?');
  // несколько вопросов подряд в конце
  const multi = 'Понял тебя. Ты как? Что нового?';
  assert.equal(stripTrailingQuestion(multi, banned), 'Понял тебя.');
});

test('stripTrailingQuestion: режет вопросы и в середине ответа', async () => {
  const { stripTrailingQuestion } = await import('../src/capabilities.mjs');
  const banned = { dontDo: ['задавать мне встречные вопросы'] };
  const mid = 'О, привет! Ну как, не спится? Погода влияет на настроение сильно. Солнце бодрит.';
  const out = stripTrailingQuestion(mid, banned);
  assert.ok(!out.includes('?'), 'вопрос из середины убран: ' + out);
  assert.match(out, /Погода влияет/);
  assert.match(out, /Солнце бодрит/, 'текст после вопроса сохранён');
});

/* ---- Премиум-эмодзи оформления ---- */
test('peButton: премиум-иконка кнопки через icon_custom_emoji_id, без дубля в тексте', async () => {
  const { peButton, pe, PREMIUM } = await import('../src/premium-emoji.mjs');
  const b = peButton('muscle', 'Фитнес', { callback_data: 'lk:fit' });
  assert.equal(b.text, 'Фитнес', 'эмодзи в text не дублируем - иконку рисует Telegram');
  assert.equal(b.icon_custom_emoji_id, PREMIUM.muscle.id);
  assert.equal(b.callback_data, 'lk:fit');
  assert.ok(!/tg-emoji/.test(b.text), 'разметки в тексте кнопки быть не должно - уедет сырым тегом');
  // неизвестный ключ не роняет экран
  assert.deepEqual(peButton('нетТакого', 'Ок', { callback_data: 'x' }), { text: 'Ок', callback_data: 'x' });
  // а в ТЕКСТЕ сообщения - именно тег
  assert.match(pe('gear'), /^<tg-emoji emoji-id="\d+">⚙️<\/tg-emoji>$/);
});

/* ---- Группа: подтянута к личке + защита от путаницы людей ---- */
test('groupPersona: знает фичи, стиль и правила «кто есть кто»', async () => {
  const { groupPersona } = await import('../src/capabilities.mjs');
  const g = groupPersona({ isGroup: true, name: 'Тусовка', botName: 'Толик' }, 'STYLEFMT');
  // раньше группа жила своей жизнью и не получала обновлений лички
  assert.match(g, /ВИШЛИСТ/i, 'реестр возможностей подтянут');
  assert.match(g, /КАЛЕНДАРЬ/i);
  assert.match(g, /БЕЗ МАТА/, 'тот же стиль, что в личке');
  assert.match(g, /НЕ ставь точку в конце/);
  // защита от путаницы людей
  assert.match(g, /НЕ приписывай одному человеку/);
  assert.match(g, /НЕ выдумывай участников/);
  assert.match(g, /НЕ называй имя вообще/);
  assert.match(g, /Отвечай ТОМУ, кто написал последним/);
  assert.match(g, /не сочиняй/, 'конкретику только из памяти');
  assert.match(g, /STYLEFMT$/, 'styleFmt приходит параметром (без цикла импортов)');
});

test('groupPersona: официальный тон в группе тоже работает', async () => {
  const { groupPersona } = await import('../src/capabilities.mjs');
  const g = groupPersona({ isGroup: true, name: 'Работа', talkStyle: 'official' }, '');
  assert.match(g, /ОФИЦИАЛЬНО/);
  assert.ok(!/МАТ ВКЛЮЧЁН/.test(g), 'в официальной группе мата нет');
});

test('friendSystem(isGroup) отдаёт групповую персону', () => {
  const g = friendSystem({ isGroup: true, name: 'Чат', botName: 'Толик' });
  assert.match(g, /участник группы «Чат»/);
  assert.match(g, /НЕ приписывай одному человеку/);
});
