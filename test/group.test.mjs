import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGroupCmd, findMember } from '../src/parser.mjs';

const norm = (s) => s.toLowerCase().replace(/ё/g, 'е').trim();

test('parseGroupCmd: команды управления группой', () => {
  assert.deepEqual(parseGroupCmd(norm('закрепи')), { cmd: 'pin', needsReply: true });
  assert.deepEqual(parseGroupCmd(norm('открепи')), { cmd: 'unpin' });
  assert.deepEqual(parseGroupCmd(norm('переименуй группу в Наши дела')), { cmd: 'title', arg: 'наши дела' });
  assert.deepEqual(parseGroupCmd(norm('переименуй в Проект X')), { cmd: 'title', arg: 'проект x' });
  assert.equal(parseGroupCmd(norm('описание группы: тут решаем всё')).cmd, 'desc');
  assert.deepEqual(parseGroupCmd(norm('дай ссылку')), { cmd: 'invite' });
  assert.deepEqual(parseGroupCmd(norm('кикни')), { cmd: 'kick', needsReply: true });
  assert.deepEqual(parseGroupCmd(norm('забань')), { cmd: 'ban', needsReply: true });
  assert.deepEqual(parseGroupCmd(norm('замуть')), { cmd: 'mute', minutes: 60, needsReply: true });
  assert.deepEqual(parseGroupCmd(norm('замуть на 2 часа')), { cmd: 'mute', minutes: 120, needsReply: true });
  assert.deepEqual(parseGroupCmd(norm('мут на 30 минут')), { cmd: 'mute', minutes: 30, needsReply: true });
  assert.deepEqual(parseGroupCmd(norm('размуть')), { cmd: 'unmute', needsReply: true });
  assert.deepEqual(parseGroupCmd(norm('удали это')), { cmd: 'del', needsReply: true });
  assert.deepEqual(parseGroupCmd(norm('сделай админом')), { cmd: 'promote', needsReply: true });
  assert.deepEqual(parseGroupCmd(norm('сними админа')), { cmd: 'demote', needsReply: true });
});

test('findMember: по имени с падежом и по username', () => {
  const members = {
    111: { name: 'Никита', username: 'pxpusk' },
    222: { name: 'Саша', username: null },
  };
  assert.equal(findMember(members, 'Никиту')?.id, '111', 'падеж «Никиту» находит Никиту');
  assert.equal(findMember(members, 'никита')?.id, '111');
  assert.equal(findMember(members, 'pxpusk')?.id, '111', 'по username');
  assert.equal(findMember(members, '@pxpusk')?.id, '111');
  assert.equal(findMember(members, 'Сашу')?.id, '222', 'падеж «Сашу», без username');
  assert.equal(findMember(members, 'Петя'), null, 'чужих не находит');
  assert.equal(findMember({}, 'Никита'), null);
});

test('findMember: кириллица находит латинское имя (Nikita ↔ никиту)', () => {
  const members = { 482: { name: 'Nikita', username: 'pxpusk' }, 7: { name: 'Sasha', username: null } };
  assert.equal(findMember(members, 'никиту')?.id, '482', 'кир. падеж находит лат. Nikita');
  assert.equal(findMember(members, 'Никита')?.id, '482');
  assert.equal(findMember(members, 'сашу')?.id, '7', 'кир. падеж находит лат. Sasha');
  assert.equal(findMember(members, 'петю'), null);
});

test('parseGroupCmd: обычные фразы - не команды', () => {
  assert.equal(parseGroupCmd(norm('что мы решили по бюджету?')), null);
  assert.equal(parseGroupCmd(norm('напомни завтра про созвон')), null);
  assert.equal(parseGroupCmd(norm('Дима должен за квартиру 15000')), null);
  // «удали 5» - это личный интент удаления записи, не группа: у del жёсткий конец строки
  assert.equal(parseGroupCmd(norm('удали 5')), null);
});
