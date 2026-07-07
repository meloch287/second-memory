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

test('parser: интент графика', async () => {
  const { parseMessage } = await import('../src/parser.mjs');
  const N = new Date();
  assert.equal(parseMessage('нарисуй график трат', N).kind, 'chart');
  assert.equal(parseMessage('построй диаграмму долгов по людям', N).kind, 'chart');
  assert.equal(parseMessage('график', N).kind, 'chart');
  assert.notEqual(parseMessage('добавь встречу завтра', N).kind, 'chart');
});

test('renderChart: PNG из спецификации (если есть python+matplotlib)', async () => {
  const { renderChart, chartAvailable } = await import('../src/chart.mjs');
  if (!chartAvailable()) return; // на машинах без matplotlib тест пропускается
  const png = renderChart({ type: 'bar', title: 'Тест', labels: ['А', 'Б'], series: [{ name: 'x', values: [1, 2] }] });
  assert.ok(png.length > 5000, 'PNG не пустой');
  assert.equal(png.subarray(1, 4).toString(), 'PNG', 'сигнатура PNG');
});

test('review-фиксы: parser и findMember', async () => {
  const { parseMessage } = await import('../src/parser.mjs');
  const N = new Date('2026-07-07T09:00:00Z');
  // «удали из памяти X» - forget, не delete (была мёртвая ветка)
  assert.equal(parseMessage('удали из памяти Петрова', N).kind, 'forget');
  assert.equal(parseMessage('удали 5', N).kind, 'delete');
  // «мой баланс / мои финансы»
  assert.equal(parseMessage('мой баланс', N).kind, 'balance');
  assert.equal(parseMessage('мои финансы', N).kind, 'balance');
  // месячный повтор: «каждое 5 число»
  const rec = parseMessage('каждое 5 число оплата хостинга в 12:00', N);
  assert.equal(rec.kind, 'recurring');
  assert.equal(rec.rule.kind, 'monthly');
  assert.equal(rec.rule.day, 5);
  // мут на день
  assert.equal(parseGroupCmd('замуть на 1 день').minutes, 1440);
  // findMember: точное совпадение приоритетнее префикса
  const mm = { 1: { name: 'Сашенька', username: null }, 2: { name: 'Саша', username: null } };
  assert.equal(findMember(mm, 'Саша')?.id, '2', 'точный Саша, не Сашенька');
});

test('ics: fold считает байты utf-8, не символы', async () => {
  const { buildIcs } = await import('../src/ics.mjs');
  const ics = buildIcs(
    [{ id: 1, title: 'Очень длинное название встречи с командой по проекту автоматизации отчётности и аналитики продаж', due: '2026-07-10T12:00:00Z', hasTime: true }],
    '2026-07-07T00:00:00Z'
  );
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `строка длиннее 75 октетов: ${line.slice(0, 40)}...`);
  }
});

test('связка имени с ником в любом порядке + защита от не-имён', () => {
  const SEP = '\\s*(?:-|—|–|=|,|это|:)?\\s*(?:это\\s+)?';
  const NAME = '[А-Яа-яЁёA-Za-z]{2,20}';
  const UN = '@([A-Za-z][A-Za-z0-9_]{3,31})';
  const linkOf = (text) => {
    let link = text.match(new RegExp(`^(?:запомни[:,]?\\s*)?(${NAME})${SEP}${UN}[!.]*$`, 'i'));
    let name = link?.[1], un = link?.[2];
    if (!link) { link = text.match(new RegExp(`^(?:запомни[:,]?\\s*)?${UN}${SEP}(${NAME})[!.]*$`, 'i')); un = link?.[1]; name = link?.[2]; }
    if (link && name && un && !/^(?:это|он|она|зовут)$/i.test(name)) return { name: name[0].toUpperCase() + name.slice(1), un };
    return null;
  };
  assert.deepEqual(linkOf('Никита это @pxpusk'), { name: 'Никита', un: 'pxpusk' });
  assert.deepEqual(linkOf('@pxpusk это Никита'), { name: 'Никита', un: 'pxpusk' });
  assert.deepEqual(linkOf('@pxpusk Саша'), { name: 'Саша', un: 'pxpusk' });
  assert.deepEqual(linkOf('запомни Никита = @pxpusk'), { name: 'Никита', un: 'pxpusk' });
  assert.equal(linkOf('привет как дела'), null);
});

test('reply-identity: имя с заглавной / @ник, не «это круто»', () => {
  const rrx = /^(?:это|эт[оа]\s+же|он|она|его зовут|её зовут|ее зовут|зовут|запомни[:,]?\s*(?:это\s+)?)\s+([А-Яа-яЁёA-Za-z@][А-Яа-яЁёA-Za-z0-9_]{1,31})[!.]*$/i;
  const ok = (text, addressed = false) => {
    const rm = text.match(rrx);
    return !!(rm && (rm[1].startsWith('@') || /^[А-ЯЁA-Z]/.test(rm[1]) || addressed));
  };
  assert.ok(ok('это Саша'), 'имя с заглавной');
  assert.ok(ok('её зовут Лена'));
  assert.ok(ok('это @pxpusk'), '@ник');
  assert.ok(ok('это саша', true), 'строчное имя - только при обращении к боту');
  assert.ok(!ok('это круто'), 'прилагательное строчное - не связка');
  assert.ok(!ok('это правда'));
});

test('parseGroupCmd: обычные фразы - не команды', () => {
  assert.equal(parseGroupCmd(norm('что мы решили по бюджету?')), null);
  assert.equal(parseGroupCmd(norm('напомни завтра про созвон')), null);
  assert.equal(parseGroupCmd(norm('Дима должен за квартиру 15000')), null);
  // «удали 5» - это личный интент удаления записи, не группа: у del жёсткий конец строки
  assert.equal(parseGroupCmd(norm('удали 5')), null);
});

test('stripBotVocative: имя бота не остаётся обращением к человеку', async () => {
  const { stripBotVocative } = await import('../src/ai.mjs');
  assert.equal(stripBotVocative('Держи, Братан, работает!', 'Братан'), 'Держи, работает!');
  assert.equal(stripBotVocative('Классный вопрос, Братан.', 'Братан'), 'Классный вопрос.');
  assert.equal(stripBotVocative('Удачи, Братан!', 'Братан'), 'Удачи!');
  assert.equal(stripBotVocative('Ну, Братан, держи план', 'Братан'), 'Ну, держи план');
  assert.equal(stripBotVocative('Братан, да уже поздно, Саня.', 'Братан'), 'Да уже поздно, Саня.');
  // самоназвание не трогаем
  assert.match(stripBotVocative('Меня зовут Братан, кстати.', 'Братан'), /Меня зовут Братан/);
  // короткое/пустое имя не режем (риск ложных)
  assert.equal(stripBotVocative('привет, Кот', 'Кот'), 'привет, Кот');
  assert.equal(stripBotVocative('текст', ''), 'текст');
});
