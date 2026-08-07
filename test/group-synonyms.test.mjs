// Позвать человека по имени: синонимы глагола, уменьшительные и падежи.
// Живой баг из «Банды»: «Позови Сережу» → «Не знаю, кто тут Сережа», хотя
// Сергей сидит в реестре; «Позови ты» → «Не знаю, кто тут Ты».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMember } from '../src/parser.mjs';
import { canonStem, sameName } from '../src/nicknames.mjs';
import { looksLikeName } from '../src/group.mjs';

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
