import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import {
  ensureAuth, verifyPassword, setPassword, makeSession, validSession,
  parseCookies, getWebSettings, setWebSettings, getLogin,
} from '../src/webauth.mjs';

delete process.env.SM_ENCRYPTION_KEY;
const freshStore = () => new Store(join(mkdtempSync(join(tmpdir(), 'sm-wa-')), 'memory.json'));

test('пароль: установка, проверка, смена', () => {
  const s = freshStore();
  ensureAuth(s, 'first-pass');
  assert.ok(verifyPassword(s, 'first-pass'), 'верный пароль проходит');
  assert.ok(!verifyPassword(s, 'wrong'), 'неверный не проходит');
  assert.ok(!verifyPassword(s, ''), 'пустой не проходит');
  setPassword(s, 'second-pass');
  assert.ok(!verifyPassword(s, 'first-pass'), 'старый больше не проходит');
  assert.ok(verifyPassword(s, 'second-pass'), 'новый проходит');
  // ensureAuth не перетирает уже заданный пароль
  ensureAuth(s, 'third-pass');
  assert.ok(verifyPassword(s, 'second-pass'), 'ensureAuth не сбрасывает существующий');
});

test('пароль: без WEB_PASSWORD генерируется случайный (не статический change-me)', () => {
  const s = freshStore();
  const r = ensureAuth(s); // env пуст
  assert.equal(r.generated, true, 'помечен как сгенерированный');
  assert.ok(r.password && r.password.length >= 10, 'вернул сам пароль для показа в логе');
  assert.ok(verifyPassword(s, r.password), 'сгенерированный пароль подходит');
  assert.ok(!verifyPassword(s, 'change-me'), 'старый статический дефолт НЕ работает');
  assert.equal(s.data.meta.web.mustChangePass, true, 'помечено к смене');

  // с заданным env-паролем — ничего не генерим, пароль не отдаём
  const s2 = freshStore();
  const r2 = ensureAuth(s2, 'from-env');
  assert.equal(r2.generated, false);
  assert.equal(r2.password, null);
  assert.ok(verifyPassword(s2, 'from-env'));
});

test('сессия: подпись валидна, подделка отклоняется', () => {
  const s = freshStore();
  ensureAuth(s, 'p');
  const tok = makeSession(s);
  assert.ok(validSession(s, tok), 'свежая сессия валидна');
  assert.ok(!validSession(s, tok + 'x'), 'испорченная подпись невалидна');
  assert.ok(!validSession(s, ''), 'пустая невалидна');
  assert.ok(!validSession(s, 'abc.def'), 'мусор невалиден');
  // подпись другим секретом не проходит
  const s2 = freshStore();
  ensureAuth(s2, 'p');
  assert.ok(!validSession(s2, tok), 'сессия из другого стора невалидна (свой секрет)');
});

test('parseCookies', () => {
  assert.deepEqual(parseCookies('sm_session=abc.def; other=1'), { sm_session: 'abc.def', other: '1' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
});

test('настройки веба: дефолты, валидация, только известные голоса', () => {
  const s = freshStore();
  const def = getWebSettings(s);
  assert.equal(def.name, 'Вторая память');
  assert.equal(def.voice, 'alloy');
  assert.equal(def.voiceReplies, false);
  assert.ok(Array.isArray(def.voices) && def.voices.length === 6);

  setWebSettings(s, { name: 'Джарвис', voiceReplies: true, voice: 'nova' });
  const c = getWebSettings(s);
  assert.equal(c.name, 'Джарвис');
  assert.equal(c.voiceReplies, true);
  assert.equal(c.voice, 'nova');

  setWebSettings(s, { voice: 'несуществующий' });
  assert.equal(getWebSettings(s).voice, 'nova', 'неизвестный голос игнорируется');

  setWebSettings(s, { name: '   ' });
  assert.equal(getWebSettings(s).name, 'Вторая память', 'пустое имя -> дефолт');

  setWebSettings(s, { login: 'boss' });
  assert.equal(getLogin(s), 'boss');
});
