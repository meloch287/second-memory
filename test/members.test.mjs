// Реестр участников группы: псевдонимы должны доезжать до модели, иначе
// «мама» и «Аня» (один человек) считаются двумя разными людьми.
// Живой баг из «Банды»: /summary рассказывал про несуществующего человека.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { membersList, membersBlock, membersRule, canonicalName } from '../src/members.mjs';

const BANDA = {
  isGroup: true,
  name: 'Банда',
  members: {
    750201677: { name: 'Аня', username: 'meloch287', aliases: ['Мама'] },
    1057399602: { name: 'Саша', username: 'qk1nlyNTG' },
    5986736818: { name: 'Сергей', username: 'Jjjoopes' },
    'u:ghost': { name: '⁠', username: null }, // невидимое имя без ника
  },
};

test('membersBlock: псевдоним едет вместе с именем и ником', () => {
  const b = membersBlock(BANDA);
  assert.match(b, /Аня \(@meloch287, он же: Мама\)/);
  assert.match(b, /Сергей \(@Jjjoopes\)/);
});

test('membersBlock: участник с невидимым именем и без ника не попадает в список', () => {
  assert.ok(!membersBlock(BANDA).includes('⁠'));
  assert.equal(membersList(BANDA).length, 3);
});

test('участник без имени, но с ником показывается как @ник без дубля скобок', () => {
  const u = { isGroup: true, members: { 1: { name: '  ', username: 'nonamer' } } };
  assert.equal(membersBlock(u), '@nonamer');
});

test('membersRule: прямо перечисляет, кто кому равен', () => {
  const r = membersRule(BANDA);
  assert.match(r, /Аня = Мама = @meloch287/);
  assert.match(r, /ОДИН ЧЕЛОВЕК/);
  assert.match(r, /не выдумывай/i);
});

test('membersRule: без псевдонимов - только общее правило, без пустого перечисления', () => {
  const u = { isGroup: true, members: { 1: { name: 'Оля', username: 'olya' } } };
  const r = membersRule(u);
  assert.ok(!r.includes('Одно и то же лицо'));
  assert.match(r, /ОДИН ЧЕЛОВЕК/);
});

test('canonicalName: псевдоним, падеж и @ник сводятся к имени', () => {
  assert.equal(canonicalName(BANDA, 'Мама'), 'Аня');
  assert.equal(canonicalName(BANDA, 'маму'), 'Аня');
  assert.equal(canonicalName(BANDA, 'маме'), 'Аня');
  assert.equal(canonicalName(BANDA, '@meloch287'), 'Аня');
  assert.equal(canonicalName(BANDA, 'Аню'), 'Аня');
  assert.equal(canonicalName(BANDA, 'Сергея'), 'Сергей');
  assert.equal(canonicalName(BANDA, 'Никита'), null);
  assert.equal(canonicalName(BANDA, ''), null);
});

test('не-группа и группа без участников: пусто, а не падение', () => {
  assert.deepEqual(membersList({ name: 'Саша' }), []);
  assert.equal(membersBlock({ name: 'Саша' }), null);
  assert.equal(membersRule({ isGroup: true, members: {} }), null);
  assert.equal(canonicalName({ isGroup: true }, 'кто-то'), null);
});

test('дубль имени в псевдонимах не задваивается', () => {
  const u = { isGroup: true, members: { 1: { name: 'Аня', username: 'a', aliases: ['аня', 'Мама', 'Мама'] } } };
  assert.equal(membersBlock(u), 'Аня (@a, он же: Мама)');
});

test('псевдоним, совпадающий с @ником, - не псевдоним (мусор от схлопывания заглушки)', () => {
  const u = { isGroup: true, members: { 1: { name: 'Сергей', username: 'Jjjoopes', aliases: ['Jjjoopes'] } } };
  assert.equal(membersBlock(u), 'Сергей (@Jjjoopes)');
  assert.ok(!membersRule(u).includes('Одно и то же лицо'));
});
