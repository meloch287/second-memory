// Реестр участников группы: псевдонимы должны доезжать до модели, иначе
// «мама» и «Аня» (один человек) считаются двумя разными людьми.
// Живой баг из «Банды»: /summary рассказывал про несуществующего человека.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { membersList, membersBlock, membersRule, canonicalName, renameAuthors } from '../src/members.mjs';

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

/* --- Как научили - так и зовём --- */

const CALLED = {
  isGroup: true,
  name: 'Банда',
  members: {
    750201677: { name: 'Аня', username: 'meloch287', callName: 'Мама', aliases: ['Мама'] },
    1057399602: { name: 'Саня', username: 'qk1nlyNTG' },
    5986736818: { name: 'Сергей', username: 'Jjjoopes' },
  },
};

test('выученное обращение идёт первым, паспортное имя - справкой', () => {
  assert.match(membersBlock(CALLED), /^Мама \(@meloch287, по паспорту Аня\)/);
  assert.ok(!membersBlock(CALLED).includes('он же: Мама'), 'обращение не дублируется в псевдонимах');
});

test('правило прямо велит звать выученным именем', () => {
  const r = membersRule(CALLED);
  assert.match(r, /ЗОВИ ЛЮДЕЙ ТАК, КАК УКАЗАНО ПЕРВЫМ/);
  assert.match(r, /Аня -> Мама/);
  assert.match(r, /Мама = Аня = @meloch287/);
});

test('любое обозначение сводится к обращению, а не к паспортному имени', () => {
  assert.equal(canonicalName(CALLED, 'Аня'), 'Мама');
  assert.equal(canonicalName(CALLED, 'Аню'), 'Мама');
  assert.equal(canonicalName(CALLED, '@meloch287'), 'Мама');
  assert.equal(canonicalName(CALLED, 'маме'), 'Мама');
  assert.equal(canonicalName(CALLED, 'Сергея'), 'Сергей');
});

test('подписи записей переписываются на выученное обращение', () => {
  assert.equal(renameAuthors('Аня: Мальчики', CALLED), 'Мама: Мальчики');
  assert.equal(renameAuthors('аня: как дела', CALLED), 'Мама: как дела');
  assert.equal(renameAuthors('Сергей: Мама закажи Липтон', CALLED), 'Сергей: Мама закажи Липтон');
});

test('renameAuthors трогает только подпись, а не текст', () => {
  // «Аня» внутри фразы - это уже речь людей, переписывать её нельзя
  assert.equal(renameAuthors('Саня: спроси у Аня', CALLED), 'Саня: спроси у Аня');
  assert.equal(renameAuthors('Аня', CALLED), 'Аня');
  assert.equal(renameAuthors('Аня: раз\nСергей: два', CALLED), 'Мама: раз\nСергей: два');
});

test('без выученных обращений подписи не трогаются вовсе', () => {
  const u = { isGroup: true, members: { 1: { name: 'Оля', username: 'olya' } } };
  assert.equal(renameAuthors('Оля: привет', u), 'Оля: привет');
});

test('двое с похожими именами не склеиваются в одного', () => {
  const u = { isGroup: true, members: { 1: { name: 'Лена' }, 2: { name: 'Лёня' } } };
  assert.equal(canonicalName(u, 'Лёня'), 'Лёня', 'точное имя не должно уступать основе соседа');
  assert.equal(canonicalName(u, 'Лена'), 'Лена');
  assert.equal(canonicalName(u, 'Лену'), null, 'неоднозначность честнее склейки');
});

test('однозначные падежи по-прежнему узнаются', () => {
  const u = { isGroup: true, members: { 1: { name: 'Сергей', username: 'Jjjoopes' }, 2: { name: 'Антон' } } };
  assert.equal(canonicalName(u, 'Сергея'), 'Сергей');
  assert.equal(canonicalName(u, 'Антона'), 'Антон');
});

/* --- Знакомые по общим чатам --- */

test('человек знает соседей по общей группе, но не их переписку', async () => {
  const { Store } = await import('../src/store.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { sharedPeople, sharedPeopleLine } = await import('../src/members.mjs');

  const s = new Store(join(mkdtempSync(join(tmpdir(), 'sm-shared-')), 'm.json'));
  s.setUser('-100', { isGroup: true, name: 'Банда', members: { 1: { name: 'Аня', username: 'anya' }, 2: { name: 'Саня', username: 'sanya' } } });
  s.setUser('1', { name: 'Аня' });

  const list = sharedPeople(s, '1');
  assert.deepEqual(list.map((p) => p.name), ['Саня'], 'себя в знакомые не пишем');
  const line = sharedPeopleLine(s, '1');
  assert.match(line, /Саня \(@sanya\) - Банда/);
  assert.match(line, /В ДРУГИХ чатах - не рассказывай|в ДРУГИХ чатах - не рассказывай/);
});

test('кто не состоит в группе - знакомых не получает', async () => {
  const { Store } = await import('../src/store.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { sharedPeopleLine } = await import('../src/members.mjs');

  const s = new Store(join(mkdtempSync(join(tmpdir(), 'sm-shared2-')), 'm.json'));
  s.setUser('-100', { isGroup: true, name: 'Банда', members: { 1: { name: 'Аня' } } });
  assert.equal(sharedPeopleLine(s, '999'), null);
});

test('выученное обращение работает и в списке знакомых', async () => {
  const { Store } = await import('../src/store.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { sharedPeople } = await import('../src/members.mjs');

  const s = new Store(join(mkdtempSync(join(tmpdir(), 'sm-shared3-')), 'm.json'));
  s.setUser('-100', { isGroup: true, name: 'Банда', members: { 1: { name: 'Саня' }, 2: { name: 'Аня', callName: 'Мама' } } });
  assert.deepEqual(sharedPeople(s, '1').map((p) => p.name), ['Мама']);
});
