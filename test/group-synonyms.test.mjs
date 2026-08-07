// Позвать человека по имени: синонимы глагола, уменьшительные и падежи.
// Живой баг из «Банды»: «Позови Сережу» → «Не знаю, кто тут Сережа», хотя
// Сергей сидит в реестре; «Позови ты» → «Не знаю, кто тут Ты».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMember } from '../src/parser.mjs';
import { canonStem, sameName } from '../src/nicknames.mjs';
import { looksLikeName } from '../src/group.mjs';
import { parseCallRequest } from '../src/callparse.mjs';

const BANDA = {
  750201677: { name: 'Аня', username: 'meloch287', aliases: ['Мама'], callName: 'Мама' },
  1057399602: { name: 'Саня', username: 'qk1nlyNTG' },
  5986736818: { name: 'Сергей', username: 'Jjjoopes' },
};

test('уменьшительные находят человека: Сережа = Серёга = Сергей', () => {
  for (const q of ['Сережу', 'Серёгу', 'сережа', 'Серёже', 'Сергея', 'серый', 'Серж']) {
    assert.equal(findMember(BANDA, q)?.name, 'Сергей', q);
  }
});

test('Саша, Саня, Шура и «Саш» - один и тот же человек', () => {
  for (const q of ['Саша', 'Сашу', 'Саш', 'саню', 'Шура', 'Санёк']) {
    assert.equal(findMember(BANDA, q)?.name, 'Саня', q);
  }
});

test('псевдоним и @ник по-прежнему работают', () => {
  assert.equal(findMember(BANDA, 'маму')?.name, 'Аня');
  assert.equal(findMember(BANDA, '@Jjjoopes')?.name, 'Сергей');
});

test('чужое имя не подставляет случайного участника', () => {
  assert.equal(findMember(BANDA, 'Никиту'), null);
  assert.equal(findMember(BANDA, 'Оля'), null);
});

test('словарь уменьшительных сводит формы к одному канону', () => {
  assert.ok(sameName('Серёжа', 'Сергей'));
  assert.ok(sameName('саню', 'Александр'));
  assert.ok(!sameName('Сергей', 'Саша'));
  assert.equal(canonStem('Димон'), canonStem('Дмитрий'));
});

test('«Я починил» - не представление, «Я Саша» - представление', () => {
  assert.equal(looksLikeName('починил'), false);
  assert.equal(looksLikeName('Починил'), false);
  assert.equal(looksLikeName('устал'), false);
  assert.equal(looksLikeName('Приду'), false);
  assert.equal(looksLikeName('Саша'), true);
  assert.equal(looksLikeName('Серёга'), true);
  assert.equal(looksLikeName('мама'), true);
});

/* --- Разбор просьбы позвать: порядок слов и хвост-поручение --- */

test('имя перед глаголом: «Маму позови сообщи ей об этом»', () => {
  const r = parseCallRequest('Маму позови сообщи ей об этом');
  assert.equal(r.who, 'Маму');
  assert.equal(r.relay, null, 'пустое «сообщи ей об этом» - не поручение');
  assert.equal(findMember(BANDA, r.who)?.name, 'Аня');
});

test('поручение после имени доезжает целиком', () => {
  const r = parseCallRequest('Серёгу дёрни и скажи что я опоздаю');
  assert.equal(findMember(BANDA, r.who)?.name, 'Сергей');
  assert.equal(r.relay, 'я опоздаю');
});

test('местоимение вместо имени не ищется в реестре', () => {
  const r = parseCallRequest('позови ты');
  assert.equal(r.who, null);
  assert.equal(r.pronoun, 'ты');
});

test('«позови всех» остаётся отдельной веткой', () => {
  assert.equal(parseCallRequest('тегни всех').who, '*');
  assert.equal(parseCallRequest('созови народ').who, '*');
});

test('обычная болтовня не считается просьбой позвать', () => {
  for (const s of ['привет как дела', 'позвонил маме вчера', 'зовут меня Саша']) {
    assert.equal(parseCallRequest(s), null, s);
  }
});

test('@ник в любом порядке', () => {
  assert.equal(parseCallRequest('позови @meloch287').who, 'meloch287');
  assert.equal(parseCallRequest('@Jjjoopes позови').who, 'Jjjoopes');
});

test('длинное слово поверх короткого имени - не тот человек', () => {
  assert.equal(findMember(BANDA, 'санитара'), null);
  assert.equal(findMember(BANDA, 'сервер'), null);
});
