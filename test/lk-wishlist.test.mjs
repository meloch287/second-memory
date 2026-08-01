// Личный кабинет (U3c-ui): вишлист - список, добавление по ссылке/вручную,
// фото-галерея, точечное редактирование, удаление. Тот же спай-бот приём,
// что и в lk-debts.test.mjs - текст+callback, голос не проверяем.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createLkHandler } from '../src/telegram-lk.mjs';

delete process.env.SM_ENCRYPTION_KEY;

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'sm-lk-wish-')), 'm.json');

// Фейковый бот: send/sendButtons копят текстовые сообщения, api() ловит
// editMessageText, sendPhoto (карточка товара с фото) и answerCallbackQuery.
// parseProduct - опциональная инъекция (фейк вместо реального похода в сеть).
function fakeBot(store, { parseProduct } = {}) {
  const sent = []; // { chatId, text, extra, order }
  const edits = []; // { chatId, messageId, text, reply_markup, order }
  const photos = []; // { chatId, photo, caption, reply_markup, order }
  let msgSeq = 1000;
  let order = 0;

  const send = async (chatId, text, extra = {}) => {
    const message_id = msgSeq++;
    sent.push({ chatId: String(chatId), text, extra, message_id, order: order++ });
    return { ok: true, result: { message_id } };
  };
  const sendButtons = async (chatId, text, inline_keyboard) => send(chatId, text, { reply_markup: { inline_keyboard } });
  const api = async (method, params) => {
    if (method === 'editMessageText') {
      edits.push({ chatId: String(params.chat_id), messageId: params.message_id, text: params.text, reply_markup: params.reply_markup, order: order++ });
      return { ok: true, result: { message_id: params.message_id } };
    }
    if (method === 'sendPhoto') {
      const message_id = msgSeq++;
      photos.push({ chatId: String(params.chat_id), photo: params.photo, caption: params.caption, reply_markup: params.reply_markup, order: order++ });
      return { ok: true, result: { message_id } };
    }
    if (method === 'answerCallbackQuery') return { ok: true };
    return { ok: true };
  };

  const lk = createLkHandler({ store, send, sendButtons, api, botNameOf: () => 'Толик', log: { error() {}, log() {} }, parseProduct });
  return { lk, sent, edits, photos };
}

// Последний рендер (текст/правка/фото) для чата - что реально видит юзер.
function lastRender(bot, chatId) {
  const all = [
    ...bot.sent.filter((s) => s.chatId === String(chatId)).map((s) => ({ text: s.text, kb: s.extra?.reply_markup?.inline_keyboard, at: s.order, kind: 'text' })),
    ...bot.edits.filter((e) => e.chatId === String(chatId)).map((e) => ({ text: e.text, kb: e.reply_markup?.inline_keyboard, at: e.order, kind: 'edit' })),
    ...bot.photos.filter((p) => p.chatId === String(chatId)).map((p) => ({ text: p.caption, kb: p.reply_markup?.inline_keyboard, at: p.order, kind: 'photo', photo: p.photo })),
  ];
  return all.sort((a, b) => a.at - b.at).at(-1);
}

const cbq = (chatId, messageId, id = 'cb1') => ({ id, message: { message_id: messageId, chat: { id: Number(chatId) } } });

test('lk:wish пустой список -> «Вишлист пуст», кнопки Добавить/Назад', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  await bot.lk.onCallback('1', 'lk:wish', cbq('1', 10), s.getUser('1'));
  const r = lastRender(bot, '1');
  assert.match(r.text, /Вишлист пуст/);
  assert.ok(r.kb.flat().some((b) => b.callback_data === 'lk:wish:add'));
  assert.ok(r.kb.flat().some((b) => b.callback_data === 'lk:home'));
  assert.ok(!r.kb.flat().some((b) => b.callback_data === 'lk:wish:view:0'), 'кнопки просмотра фото нет для пустого списка');
});

test('lk:wish список: заголовок с count, строки товаров, кнопка просмотра фото + ряды на каждый товар', async () => {
  const s = new Store(tmpFile());
  const a = s.addWish('1', { title: 'Товар A', price: 1000 });
  const b = s.addWish('1', { title: 'Товар B' });
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', 'lk:wish', cbq('1', 11), s.getUser('1'));
  const r = lastRender(bot, '1');
  assert.match(r.text, /Вишлист \(2\)/);
  assert.match(r.text, /1\. Товар A — 1\s000\s₽/);
  assert.match(r.text, /2\. Товар B/);

  const flat = r.kb.flat();
  assert.ok(flat.some((btn) => btn.callback_data === 'lk:wish:view:0'));
  assert.ok(flat.some((btn) => btn.callback_data === `lk:wish:edit:${a.id}`));
  assert.ok(flat.some((btn) => btn.callback_data === `lk:wish:del:${a.id}`));
  assert.ok(flat.some((btn) => btn.callback_data === `lk:wish:edit:${b.id}`));
  assert.ok(flat.some((btn) => btn.callback_data === `lk:wish:del:${b.id}`));
  assert.ok(flat.some((btn) => btn.callback_data === 'lk:wish:add'));
  assert.ok(flat.some((btn) => btn.callback_data === 'lk:home'));
});

test('lk:wish:add:manual -> название/описание/ссылка пошагово -> сохраняет и обновляет список', async () => {
  const file = tmpFile();
  const s = new Store(file);
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', 'lk:wish:add', cbq('1', 20), s.getUser('1'));
  const choiceR = lastRender(bot, '1');
  assert.match(choiceR.text, /ссылке или вручную/i);
  assert.ok(choiceR.kb.flat().some((b) => b.callback_data === 'lk:wish:add:url'));
  assert.ok(choiceR.kb.flat().some((b) => b.callback_data === 'lk:wish:add:manual'));

  await bot.lk.onCallback('1', 'lk:wish:add:manual', cbq('1', 21), s.getUser('1'));
  assert.equal(bot.lk.pendingInput('1'), true, 'взведён шаг названия');

  assert.equal(await bot.lk.consumeInput('1', s.getUser('1'), 'Кружка синяя'), true);
  assert.equal(bot.lk.pendingInput('1'), true, 'после названия ждём описание');

  assert.equal(await bot.lk.consumeInput('1', s.getUser('1'), 'Керамическая, 350мл'), true);
  assert.equal(bot.lk.pendingInput('1'), true, 'после описания ждём ссылку');

  assert.equal(await bot.lk.consumeInput('1', s.getUser('1'), 'https://example.com/mug'), true);
  assert.equal(bot.lk.pendingInput('1'), false, 'после ссылки сценарий завершён');

  const items = s.listWish('1');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Кружка синяя');
  assert.equal(items[0].desc, 'Керамическая, 350мл');
  assert.equal(items[0].url, 'https://example.com/mug');
  assert.match(lastRender(bot, '1').text, /Кружка синяя/, 'список сразу отражает добавленное');

  s.flush();
  const reloaded = new Store(file);
  assert.equal(reloaded.listWish('1').length, 1, 'персистентность (U4)');
});

test('lk:wish:add:manual с пропуском описания/ссылки ("-")', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', 'lk:wish:add:manual', cbq('1', 25), s.getUser('1'));
  await bot.lk.consumeInput('1', s.getUser('1'), 'Просто вещь');
  await bot.lk.consumeInput('1', s.getUser('1'), '-');
  await bot.lk.consumeInput('1', s.getUser('1'), '-');

  const items = s.listWish('1');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Просто вещь');
  assert.equal(items[0].desc, '');
  assert.equal(items[0].url, '');
});

test('lk:wish:add:manual: пустое название не сбрасывает шаг, можно повторить', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', 'lk:wish:add:manual', cbq('1', 26), s.getUser('1'));
  assert.equal(await bot.lk.consumeInput('1', s.getUser('1'), '   '), true);
  assert.equal(bot.lk.pendingInput('1'), true, 'пустое название не принято, шаг остался');
  assert.equal(s.listWish('1').length, 0);

  await bot.lk.consumeInput('1', s.getUser('1'), 'Теперь ок');
  await bot.lk.consumeInput('1', s.getUser('1'), '-');
  await bot.lk.consumeInput('1', s.getUser('1'), '-');
  assert.equal(s.listWish('1').length, 1);
});

test('lk:wish:add:url -> parseProduct заполняет карточку с фото (инъекция фейка)', async () => {
  const s = new Store(tmpFile());
  const fakeParseProduct = async (url) => ({
    ok: true,
    url,
    title: 'Наушники Beats',
    description: 'Беспроводные, чёрные',
    photos: ['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg'],
    price: 12990,
    source: 'example.com',
  });
  const bot = fakeBot(s, { parseProduct: fakeParseProduct });

  await bot.lk.onCallback('1', 'lk:wish:add:url', cbq('1', 30), s.getUser('1'));
  assert.match(lastRender(bot, '1').text, /ссылку/i);
  assert.equal(bot.lk.pendingInput('1'), true);

  const handled = await bot.lk.consumeInput('1', s.getUser('1'), 'https://shop.example.com/product/123');
  assert.equal(handled, true);
  assert.equal(bot.lk.pendingInput('1'), false);

  const items = s.listWish('1');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Наушники Beats');
  assert.equal(items[0].desc, 'Беспроводные, чёрные');
  assert.deepEqual(items[0].photos, ['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg']);
  assert.equal(items[0].price, 12990);

  const confirm = bot.sent.filter((m) => m.chatId === '1').find((m) => /Добавил/.test(m.text));
  assert.match(confirm.text, /Фото: 2/);
  assert.match(lastRender(bot, '1').text, /Наушники Beats/, 'список обновлён без перезапуска');
});

test('lk:wish:add:url -> parseProduct без данных (ok:false) не бросает, сохраняет карточку-заглушку', async () => {
  const s = new Store(tmpFile());
  const fakeParseProduct = async (url) => ({ ok: false, url, error: 'blocked' });
  const bot = fakeBot(s, { parseProduct: fakeParseProduct });

  await bot.lk.onCallback('1', 'lk:wish:add:url', cbq('1', 31), s.getUser('1'));
  const handled = await bot.lk.consumeInput('1', s.getUser('1'), 'https://shop.example.com/x');
  assert.equal(handled, true);

  const items = s.listWish('1');
  assert.equal(items.length, 1);
  assert.equal(items[0].photos.length, 0);
  assert.equal(items[0].title, 'https://shop.example.com/x', 'заголовок падает на саму ссылку');

  const confirm = bot.sent.filter((m) => m.chatId === '1').find((m) => /Добавил/.test(m.text));
  assert.match(confirm.text, /фото не подтянулись/i);
});

test('lk:wish:add:url -> parseProduct бросает исключение - тоже не роняет сценарий', async () => {
  const s = new Store(tmpFile());
  const throwingParseProduct = async () => { throw new Error('boom'); };
  const bot = fakeBot(s, { parseProduct: throwingParseProduct });

  await bot.lk.onCallback('1', 'lk:wish:add:url', cbq('1', 32), s.getUser('1'));
  const handled = await bot.lk.consumeInput('1', s.getUser('1'), 'https://shop.example.com/y');
  assert.equal(handled, true);
  assert.equal(s.listWish('1').length, 1, 'даже при исключении карточка сохранена (best-effort)');
});

test('lk:wish:add:url -> болтовня вместо ссылки НЕ сохраняется, pending остаётся', async () => {
  const s = new Store(tmpFile());
  const neverCalled = async () => { throw new Error('parseProduct не должен вызываться для не-ссылки'); };
  const bot = fakeBot(s, { parseProduct: neverCalled });

  await bot.lk.onCallback('1', 'lk:wish:add:url', cbq('1', 33), s.getUser('1'));
  const handled = await bot.lk.consumeInput('1', s.getUser('1'), 'просто думаю о подарке маме');
  assert.equal(handled, true, 'сообщение перехвачено ЛК');
  assert.equal(s.listWish('1').length, 0, 'мусорная карточка с болтовнёй в заголовке НЕ создана');
  assert.equal(bot.lk.pendingInput('1'), true, 'режим ожидания остаётся - можно прислать нормальный URL');
  assert.match(lastRender(bot, '1').text, /не похоже на ссылку/i);

});

test('lk:wish:add:url -> «отмена»/«cancel»/«/cancel» выходит к списку без сохранения', async () => {
  for (const word of ['отмена', 'Отмена.', 'cancel', '/cancel']) {
    const s = new Store(tmpFile());
    const bot = fakeBot(s);
    await bot.lk.onCallback('1', 'lk:wish:add:url', cbq('1', 34), s.getUser('1'));
    const handled = await bot.lk.consumeInput('1', s.getUser('1'), word);
    assert.equal(handled, true, `«${word}» перехвачено ЛК`);
    assert.equal(bot.lk.pendingInput('1'), false, `«${word}» снимает режим ожидания`);
    assert.equal(s.listWish('1').length, 0, `«${word}» ничего не сохраняет`);
    assert.match(lastRender(bot, '1').text, /Вишлист/, 'вернулись к списку вишлиста');
  }
});

test('lk:wish:add:url -> домен без схемы (ozon.ru/...) принимается как ссылка', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s, { parseProduct: async (url) => ({ ok: false, url }) });
  await bot.lk.onCallback('1', 'lk:wish:add:url', cbq('1', 35), s.getUser('1'));
  const handled = await bot.lk.consumeInput('1', s.getUser('1'), 'ozon.ru/product/123');
  assert.equal(handled, true);
  const items = s.listWish('1');
  assert.equal(items.length, 1, 'домен-с-точкой сохранился как ссылка');
  assert.equal(items[0].title, 'ozon.ru/product/123');
});

test('clearPending снимает незавершённый сценарий извне (сценарий /reset)', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  await bot.lk.onCallback('1', 'lk:wish:add:url', cbq('1', 36), s.getUser('1'));
  assert.equal(bot.lk.pendingInput('1'), true);
  bot.lk.clearPending('1');
  assert.equal(bot.lk.pendingInput('1'), false, 'pending сброшен');
  const handled = await bot.lk.consumeInput('1', s.getUser('1'), 'https://shop.example.com/z');
  assert.equal(handled, false, 'после сброса сообщения ЛК не перехватываются');
  assert.equal(s.listWish('1').length, 0);
});

test('галерея: view:0 -> view:1, подписи "1/M"/"2/M", фото уходит через api sendPhoto, без фото - текстом', async () => {
  const s = new Store(tmpFile());
  s.addWish('1', { title: 'Товар A', desc: 'Описание A', url: 'https://a.example.com', photos: ['https://img/a.jpg'] });
  s.addWish('1', { title: 'Товар B', desc: 'Описание B', url: 'https://b.example.com', photos: [] });
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', 'lk:wish:view:0', cbq('1', 40), s.getUser('1'));
  const first = lastRender(bot, '1');
  assert.equal(first.kind, 'photo', 'товар с фото уходит через sendPhoto');
  assert.match(first.text, /^1\/2 — Товар A/);
  assert.match(first.text, /Описание A/);
  assert.match(first.text, /https:\/\/a\.example\.com/);
  assert.equal(bot.photos.at(-1).photo, 'https://img/a.jpg');
  assert.ok(first.kb.flat().some((b) => b.callback_data === 'lk:wish:view:1'));
  assert.ok(first.kb.flat().some((b) => b.callback_data === 'lk:wish'));

  await bot.lk.onCallback('1', 'lk:wish:view:1', cbq('1', 41), s.getUser('1'));
  const second = lastRender(bot, '1');
  assert.equal(second.kind, 'text', 'товар без фото уходит обычным текстом');
  assert.match(second.text, /^2\/2 — Товар B/);

  // Средняя кнопка "N/M" (nop) - callback гасится, но никакого нового рендера не создаёт.
  const before = bot.sent.length + bot.edits.length + bot.photos.length;
  const handled = await bot.lk.onCallback('1', 'lk:wish:nop', cbq('1', 42), s.getUser('1'));
  assert.equal(handled, true);
  assert.equal(bot.sent.length + bot.edits.length + bot.photos.length, before, 'nop ничего не отправляет');
});

test('галерея: индексы клампятся к границам [0, M-1]', async () => {
  const s = new Store(tmpFile());
  s.addWish('1', { title: 'Единственный', photos: [] });
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', 'lk:wish:view:5', cbq('1', 43), s.getUser('1'));
  assert.match(lastRender(bot, '1').text, /^1\/1 — Единственный/);

  await bot.lk.onCallback('1', 'lk:wish:view:-3', cbq('1', 44), s.getUser('1'));
  assert.match(lastRender(bot, '1').text, /^1\/1 — Единственный/);
});

test('галерея на пустом вишлисте: «Вишлист пуст», без падения', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  await bot.lk.onCallback('1', 'lk:wish:view:0', cbq('1', 45), s.getUser('1'));
  assert.match(lastRender(bot, '1').text, /Вишлист пуст/);
});

test('удаление из вишлиста: подтверждение, persists, список обновляется', async () => {
  const file = tmpFile();
  const s = new Store(file);
  const item = s.addWish('1', { title: 'Ненужное' });
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', `lk:wish:del:${item.id}`, cbq('1', 50), s.getUser('1'));
  const confirmR = lastRender(bot, '1');
  assert.match(confirmR.text, /Удалить/);
  assert.match(confirmR.text, /Ненужное/);
  assert.ok(confirmR.kb.flat().some((b) => b.callback_data === `lk:wish:delyes:${item.id}`));
  assert.ok(confirmR.kb.flat().some((b) => b.callback_data === `lk:wish:delno:${item.id}`));

  await bot.lk.onCallback('1', `lk:wish:delyes:${item.id}`, cbq('1', 51), s.getUser('1'));
  assert.equal(s.wishById(item.id), null, 'запись удалена из стора');
  assert.match(lastRender(bot, '1').text, /Вишлист пуст/);

  s.flush();
  const reloaded = new Store(file);
  assert.equal(reloaded.wishById(item.id), null, 'удаление пережило перезагрузку');
});

test('удаление из вишлиста: отмена (delno) не удаляет, возвращает к списку', async () => {
  const s = new Store(tmpFile());
  const item = s.addWish('1', { title: 'Оставить' });
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', `lk:wish:del:${item.id}`, cbq('1', 55), s.getUser('1'));
  await bot.lk.onCallback('1', `lk:wish:delno:${item.id}`, cbq('1', 56), s.getUser('1'));
  assert.ok(s.wishById(item.id), 'не удалён');
  assert.match(lastRender(bot, '1').text, /Оставить/);
});

test('удаление из вишлиста: чужой чат не может удалить (владение проверяется)', async () => {
  const s = new Store(tmpFile());
  const item = s.addWish('1', { title: 'Чьё-то' });
  const bot = fakeBot(s);
  await bot.lk.onCallback('2', `lk:wish:delyes:${item.id}`, cbq('2', 60), s.getUser('2'));
  assert.ok(s.wishById(item.id), 'чужой товар не удалён');
});

test('редактирование: подменю + название/описание/ссылка обновляются по отдельности', async () => {
  const s = new Store(tmpFile());
  const item = s.addWish('1', { title: 'Старое', desc: 'ст.описание', url: 'https://old.example.com' });
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', `lk:wish:edit:${item.id}`, cbq('1', 70), s.getUser('1'));
  const menuR = lastRender(bot, '1');
  assert.match(menuR.text, /Старое/);
  const flat = menuR.kb.flat();
  assert.ok(flat.some((b) => b.callback_data === `lk:wish:edit:title:${item.id}`));
  assert.ok(flat.some((b) => b.callback_data === `lk:wish:edit:desc:${item.id}`));
  assert.ok(flat.some((b) => b.callback_data === `lk:wish:edit:url:${item.id}`));

  await bot.lk.onCallback('1', `lk:wish:edit:title:${item.id}`, cbq('1', 71), s.getUser('1'));
  assert.equal(bot.lk.pendingInput('1'), true);
  await bot.lk.consumeInput('1', s.getUser('1'), 'Новое название');
  assert.equal(s.wishById(item.id).title, 'Новое название');
  assert.equal(bot.lk.pendingInput('1'), false);

  await bot.lk.onCallback('1', `lk:wish:edit:desc:${item.id}`, cbq('1', 72), s.getUser('1'));
  await bot.lk.consumeInput('1', s.getUser('1'), '-');
  assert.equal(s.wishById(item.id).desc, '', 'описание очищено через "-"');

  await bot.lk.onCallback('1', `lk:wish:edit:url:${item.id}`, cbq('1', 73), s.getUser('1'));
  await bot.lk.consumeInput('1', s.getUser('1'), 'https://new.example.com');
  assert.equal(s.wishById(item.id).url, 'https://new.example.com');

  assert.match(lastRender(bot, '1').text, /Новое название/, 'обновлённый список виден сразу');
});

test('редактирование: пустое новое название не сохраняется, шаг остаётся', async () => {
  const s = new Store(tmpFile());
  const item = s.addWish('1', { title: 'Держим' });
  const bot = fakeBot(s);

  await bot.lk.onCallback('1', `lk:wish:edit:title:${item.id}`, cbq('1', 80), s.getUser('1'));
  assert.equal(await bot.lk.consumeInput('1', s.getUser('1'), '  '), true);
  assert.equal(bot.lk.pendingInput('1'), true, 'пустое название отклонено, шаг не снят');
  assert.equal(s.wishById(item.id).title, 'Держим', 'старое название не тронуто');
});

test('lk:home сбрасывает незавершённый сценарий вишлиста', async () => {
  const s = new Store(tmpFile());
  const bot = fakeBot(s);
  await bot.lk.onCallback('1', 'lk:wish:add:manual', cbq('1', 90), s.getUser('1'));
  assert.equal(bot.lk.pendingInput('1'), true);
  await bot.lk.onCallback('1', 'lk:home', cbq('1', 91), s.getUser('1'));
  assert.equal(bot.lk.pendingInput('1'), false);
});
