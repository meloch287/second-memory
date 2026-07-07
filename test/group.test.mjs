import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { parseGroupCmd, findMember } from '../src/parser.mjs';

const norm = (s) => s.toLowerCase().replace(/ё/g, 'е').trim();
const freshStore = () => new Store(join(mkdtempSync(join(tmpdir(), 'sm-grp-')), 'm.json'));

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

test('findMember: уменьшительные и падежи (Серёгу->Сергей, андрюху->Андрей)', () => {
  const m = { 1: { name: 'Мама' }, 2: { name: 'Сергей', username: 'serg' }, 3: { name: 'Андрей' }, 4: { name: 'Батя' }, 5: { name: 'Сестра' } };
  for (const q of ['маму', 'маме', 'мамой']) assert.equal(findMember(m, q)?.name, 'Мама', q);
  for (const q of ['серегу', 'серёгу', 'сереге', 'сергея']) assert.equal(findMember(m, q)?.name, 'Сергей', q);
  for (const q of ['андрюху', 'андрея']) assert.equal(findMember(m, q)?.name, 'Андрей', q);
  assert.equal(findMember(m, 'батю')?.name, 'Батя');
  for (const q of ['сестру', 'сестре', 'сестрёнку']) assert.equal(findMember(m, q)?.name, 'Сестра', q);
  assert.equal(findMember(m, 'Петю'), null, 'чужих не выдумывает');
});

test('группа: «это мама» реплаем регистрирует, «тегни маму» тегает', async () => {
  const { createGroupHandler } = await import('../src/group.mjs');
  const sent = [];
  const store = freshStore();
  const { groupFlow } = createGroupHandler({
    api: async (m) => (m === 'getMe' ? { result: { username: 'bot', id: 42 } } : { ok: true }),
    send: async (c, t) => { sent.push(t); return { ok: true }; }, esc: (s) => s, store,
    log: { error() {}, info() {} }, withTyping: (c, fn) => fn(), handleIntent: async () => false,
    sendSummary: async () => {}, askReset: async () => {}, readDoc: async () => null,
    downloadBase64: async () => '', sleepyText: () => '...', maybeReact: () => {}, deliver: async () => {},
  });
  const chat = { id: -7, type: 'supergroup', title: 'T' };
  const me = { id: 1, first_name: 'Саня' };
  // реплай на человека id999 со словом «это мама»
  await groupFlow({ chat, from: me, text: 'это мама', message_id: 2, reply_to_message: { message_id: 1, from: { id: 999, first_name: 'Аня', is_bot: false } } });
  assert.equal(store.getUser('-7').members['999'].name, 'Мама', 'зарегистрировал как Мама');
  // тег по падежу
  await groupFlow({ chat, from: me, text: '@bot тегни маму', message_id: 3 });
  const last = sent[sent.length - 1] || '';
  assert.match(last, /999/, 'тегает человека 999');
  assert.doesNotMatch(last, /не видел|кто это|черкн/i, 'не спрашивает кто это');
  // ложное «это круто» реплаем не переименовывает
  await groupFlow({ chat, from: me, text: 'это круто', message_id: 4, reply_to_message: { message_id: 1, from: { id: 888, first_name: 'Z', is_bot: false } } });
  assert.notEqual(store.getUser('-7').members['888']?.name, 'Круто', 'прилагательное не стало именем');
});

test('extractIdentityPairs: несколько пар за раз, защита от не-имён', async () => {
  const { extractIdentityPairs } = await import('../src/group.mjs');
  const p = extractIdentityPairs('@meloch287 это мама запомни\n@Jjoopes это сергей');
  assert.deepEqual(p, [{ un: 'meloch287', name: 'Мама' }, { un: 'Jjoopes', name: 'Сергей' }]);
  assert.deepEqual(extractIdentityPairs('Никита это @pxpusk'), [{ un: 'pxpusk', name: 'Никита' }]);
  assert.deepEqual(extractIdentityPairs('@serg - Сергей'), [{ un: 'serg', name: 'Сергей' }]);
  assert.deepEqual(extractIdentityPairs('@jjoopes это видео'), [], 'не-имя не связывается');
  assert.deepEqual(extractIdentityPairs('@jjoopes привет всем'), [], 'без связки не срабатывает');
  assert.deepEqual(extractIdentityPairs('глянь это @jjoopes'), [], 'глагол не имя');
});

test('группа: одно сообщение с двумя «@ник это Имя» -> оба в реестр -> тегаются', async () => {
  const { createGroupHandler } = await import('../src/group.mjs');
  const sent = [];
  const store = freshStore();
  const { groupFlow } = createGroupHandler({
    api: async (m) => (m === 'getMe' ? { result: { username: 'bot', id: 42 } } : { ok: true }),
    send: async (c, t) => { sent.push(t); return { ok: true }; }, esc: (s) => s, store,
    log: { error() {}, info() {} }, withTyping: (c, fn) => fn(), handleIntent: async () => false,
    sendSummary: async () => {}, askReset: async () => {}, readDoc: async () => null,
    downloadBase64: async () => '', sleepyText: () => '...', maybeReact: () => {}, deliver: async () => {},
  });
  const chat = { id: -9, type: 'supergroup', title: 'Банда' };
  const me = { id: 1, first_name: 'Саня' };
  await groupFlow({ chat, from: { id: 50, first_name: 'Аня', username: 'meloch287' }, text: 'привет', message_id: 1 });
  await groupFlow({ chat, from: { id: 51, first_name: 'Серёга', username: 'Jjoopes' }, text: 'хай', message_id: 2 });
  await groupFlow({ chat, from: me, text: '@bot @meloch287 это мама запомни\n@Jjoopes это сергей', message_id: 3 });
  assert.equal(store.getUser('-9').members['50'].name, 'Мама');
  assert.equal(store.getUser('-9').members['51'].name, 'Сергей');
  sent.length = 0;
  await groupFlow({ chat, from: me, text: '@bot тегни маму', message_id: 4 });
  assert.match(sent[sent.length - 1], /meloch287/, 'тегает маму (Аню)');
  await groupFlow({ chat, from: me, text: '@bot тегни сергея', message_id: 5 });
  assert.match(sent[sent.length - 1], /Jjoopes/, 'тегает сергея по падежу');
});

test('parseGroupCmd: богатые синонимы и падежи', async () => {
  const { parseGroupCmd } = await import('../src/parser.mjs');
  const n = (s) => s.replace(/ё/g, 'е').trim();
  const cmd = (s) => parseGroupCmd(n(s))?.cmd;
  for (const s of ['закрепи', 'закрепить', 'запинь', 'прикрепи это', 'зафиксируй', 'повесь наверх']) assert.equal(cmd(s), 'pin', s);
  for (const s of ['открепи', 'сними закреп', 'убери закреп', 'анпин']) assert.equal(cmd(s), 'unpin', s);
  for (const s of ['переименуй в Банда', 'назови чат Стройка', 'смени название на Х', 'поменяй имя группы на Y', 'обзови нас Легенды']) assert.equal(cmd(s), 'title', s);
  for (const s of ['описание: дела', 'смени описание на важное', 'опиши группу тут стройка']) assert.equal(cmd(s), 'desc', s);
  for (const s of ['дай ссылку', 'создай инвайт', 'скинь приглашение', 'ссылка', 'пришли мне ссылку']) assert.equal(cmd(s), 'invite', s);
  for (const s of ['кикни', 'выгони', 'выпни', 'исключи', 'удали из группы', 'убери из чата']) assert.equal(cmd(s), 'kick', s);
  for (const s of ['забань', 'в бан', 'заблокируй', 'блокни']) assert.equal(cmd(s), 'ban', s);
  for (const s of ['размуть', 'сними мут', 'верни голос']) assert.equal(cmd(s), 'unmute', s);
  for (const s of ['удали', 'снеси сообщение', 'сотри', 'убери его']) assert.equal(cmd(s), 'del', s);
  for (const s of ['сделай админом', 'назначь админом', 'повысь', 'повысь до админа', 'в админы']) assert.equal(cmd(s), 'promote', s);
  for (const s of ['сними админа', 'разжалуй', 'понизь', 'лиши админки', 'забери права']) assert.equal(cmd(s), 'demote', s);
  // мут с длительностью и без числа
  assert.equal(parseGroupCmd('замуть на неделю').minutes, 10080);
  assert.equal(parseGroupCmd('замуть на 3 дня').minutes, 4320);
  assert.equal(parseGroupCmd('заткни на 15 мин').minutes, 15);
  assert.equal(parseGroupCmd('замуть').minutes, 60);
  // сохранение регистра названия (парсер регистронезависим)
  assert.equal(parseGroupCmd('Переименуй в Стройка2026').arg, 'Стройка2026');
  // не команды
  for (const s of ['привет', 'что решили?', 'напомни завтра', 'тегни маму', 'замути музыку']) assert.equal(parseGroupCmd(n(s)), null, s);
});

test('parseTopicCmd: создать/переименовать/закрыть/открыть/удалить', async () => {
  const { parseTopicCmd } = await import('../src/parser.mjs');
  assert.equal(parseTopicCmd('создай топик Флудилка').op, 'create');
  assert.equal(parseTopicCmd('добавь топик Задачи, Баги').op, 'create');
  assert.equal(parseTopicCmd('заведи тему Общее').op, 'create');
  assert.equal(parseTopicCmd('переименуй топик в Новое').op, 'rename');
  assert.equal(parseTopicCmd('переименуй топик в Новое').arg, 'Новое');
  assert.equal(parseTopicCmd('закрой топик').op, 'close');
  assert.equal(parseTopicCmd('открой тему').op, 'reopen');
  assert.equal(parseTopicCmd('удали топик').op, 'delete');
  assert.equal(parseTopicCmd('создай задачу купить бетон'), null); // не топик
  assert.equal(parseTopicCmd('удали'), null);
});

test('группа e2e: команды дёргают нужные методы Telegram API', async () => {
  const { createGroupHandler } = await import('../src/group.mjs');
  const store = freshStore();
  store.setUser('-100', { isGroup: true, name: 'Банда', botName: 'Помощник', tzOffset: 180, members: {} });
  let calls = [];
  const deps = {
    api: async (method) => (method === 'getMe' ? { ok: true, result: { username: 'bot', id: 42 } }
      : method === 'getChatMember' ? { ok: true, result: { status: 'administrator' } }
      : (calls.push(method), { ok: true, result: { invite_link: 'x', message_thread_id: 55 } })),
    send: async () => ({ ok: true }), esc: (s) => s, store, log: { error() {}, info() {} },
    withTyping: (c, f) => f(), handleIntent: async () => false, sendSummary: async () => {}, askReset: async () => {},
    readDoc: async () => null, downloadBase64: async () => '', sleepyText: () => '...', maybeReact: () => {}, deliver: async () => {},
  };
  const { groupFlow } = createGroupHandler(deps);
  const chat = { id: -100, type: 'supergroup', title: 'Банда', is_forum: true };
  const me = { id: 1, first_name: 'Босс' };
  let mid = 0;
  const run = async (text, reply, thread) => {
    calls = [];
    const msg = { chat, from: me, text: '@bot ' + text, message_id: ++mid };
    if (reply) msg.reply_to_message = { message_id: 5, from: { id: 9, first_name: 'Цель' } };
    if (thread) msg.message_thread_id = thread;
    await groupFlow(msg);
    return calls;
  };
  assert.ok((await run('закрепи', true)).includes('pinChatMessage'), 'pin');
  assert.ok((await run('переименуй в Проект', false)).includes('setChatTitle'), 'title');
  assert.ok((await run('дай ссылку', false)).includes('createChatInviteLink'), 'invite');
  assert.ok((await run('забань', true)).includes('banChatMember'), 'ban');
  assert.ok((await run('замуть на час', true)).includes('restrictChatMember'), 'mute');
  assert.ok((await run('удали', true)).includes('deleteMessage'), 'del');
  assert.ok((await run('сделай админом', true)).includes('promoteChatMember'), 'promote');
  assert.ok((await run('создай топик Флуд', false, 55)).includes('createForumTopic'), 'topic create');
  assert.ok((await run('переименуй топик в Новое', false, 55)).includes('editForumTopic'), 'topic rename');
  assert.ok((await run('закрой топик', false, 55)).includes('closeForumTopic'), 'topic close');
  assert.ok((await run('удали топик', false, 55)).includes('deleteForumTopic'), 'topic delete');
});
