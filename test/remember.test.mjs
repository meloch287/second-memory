// Явное «запомни ...»: записывается сразу, дословно, без фонового worker'а.
// Реальный случай: длинная идея со словом «запомни» осталась только сырьём,
// потому что провайдер фоновых задач лежал - на вопрос «ты записал?» ответить
// было нечего.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRemember, rememberEcho } from '../src/remember.mjs';

test('длинная идея записывается дословно', () => {
  const idea = 'запомни идеи\n\n1) внедрить в толика команду copy: пишешь человека и ссылку, толик парсит страницы и транскрибирует видео';
  const got = parseRemember(idea);
  assert.match(got, /^идеи/);
  assert.match(got, /команду copy/);
  assert.match(got, /транскрибирует видео/, 'текст не обрезается на полуслове');
});

test('обращение к боту перед просьбой не мешает', () => {
  assert.equal(parseRemember('Толик, запомни: я люблю кофе без сахара'), 'я люблю кофе без сахара');
  assert.equal(parseRemember('толян запиши - купить молоко'), 'купить молоко');
});

test('синонимы: запиши, заметь, сохрани, запомните', () => {
  assert.equal(parseRemember('заметь, что дедлайн в пятницу'), 'что дедлайн в пятницу');
  assert.equal(parseRemember('сохрани пароль от роутера admin1234'), 'пароль от роутера admin1234');
  assert.equal(parseRemember('запомните: встреча перенесена'), 'встреча перенесена');
});

test('просьба без содержания - не заметка', () => {
  for (const s of ['запомни', 'запомни это', 'запомни меня', 'запомни идею', 'запиши', 'запомни, пожалуйста']) {
    assert.equal(parseRemember(s), null, s);
  }
});

test('прошедшее время - это не просьба («я запомнил твой совет»)', () => {
  assert.equal(parseRemember('я запомнил твой совет'), null);
  assert.equal(parseRemember('запомнил, спасибо'), null);
  assert.equal(parseRemember('записал уже всё'), null);
});

test('обычная болтовня не перехватывается', () => {
  for (const s of ['привет как дела', 'что там по календарю', '', null, 'напомни завтра в 18 оплатить']) {
    assert.equal(parseRemember(s), null, String(s));
  }
});

test('кириллическая граница слова: «запомнить» - не команда', () => {
  // \b в JS не знает кириллицы, поэтому граница закрыта lookahead'ом
  assert.equal(parseRemember('запомнить бы это всё'), null);
  assert.equal(parseRemember('запомним на будущее'), null);
});

test('заметка обрезается по лимиту хранилища', () => {
  const long = 'запомни ' + 'а'.repeat(3000);
  assert.equal(parseRemember(long).length, 1500);
});

test('эхо показывает суть, а не заголовок в одно слово', () => {
  const body = parseRemember('запомни идеи\n\n1) команда copy для клонирования личности');
  assert.match(rememberEcho(body), /команда copy/);
  assert.ok(rememberEcho(body).length <= 111);
});

test('эхо короткой заметки - она сама', () => {
  assert.equal(rememberEcho('я люблю кофе без сахара'), 'я люблю кофе без сахара');
});
