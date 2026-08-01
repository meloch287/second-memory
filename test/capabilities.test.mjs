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
  assert.deepEqual(parseStylePref('не называй меня по имени'), { noName: true });
});

test('официально / мат / обратно попроще', () => {
  assert.equal(parseStylePref('давай общайся официально')?.talkStyle, 'official');
  assert.equal(parseStylePref('перейдем на вы')?.talkStyle, 'official');
  assert.equal(parseStylePref('можешь материться')?.talkStyle, 'mat');
  assert.equal(parseStylePref('общайся матом')?.talkStyle, 'mat');
  assert.equal(parseStylePref('не матерись больше')?.talkStyle, null);
  assert.equal(parseStylePref('общайся попроще')?.talkStyle, null);
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
  assert.match(stylePref({ talkStyle: 'mat' }), /мат/i);
  assert.match(stylePref({ noName: true }), /НЕ обращаться/i);
  assert.match(stylePref({ dontDo: ['задавать встречные вопросы'] }), /НЕ делать/i);
  assert.equal(stylePref({}), '');
});

test('friendSystem учитывает предпочтения юзера', () => {
  const sys = friendSystem({ name: 'Макс', botName: 'Толик', addressAs: 'Братан', talkStyle: 'official' });
  assert.match(sys, /Братан/);
  assert.match(sys, /ОФИЦИАЛЬНО/);
});
