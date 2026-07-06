import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { handleMessage } from '../src/brain.mjs';

const NOW = new Date(2026, 6, 6, 9, 0); // понедельник, 6 июля 2026

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'second-memory-'));
  return new Store(join(dir, 'memory.json'));
}

test('сценарий: долги записываются и отгружаются одним запросом', async () => {
  const s = freshStore();

  const r1 = await handleMessage(s, 'Иванов должен 50 000 до 20 июля', NOW);
  assert.match(r1.reply, /Записал долг №1/);
  assert.match(r1.reply, /Иванов/);

  const r2 = await handleMessage(s, 'я должен Петрову 15к до пятницы', NOW);
  assert.match(r2.reply, /вы должны/);

  const r3 = await handleMessage(s, 'отгрузи все долговые обязательства заказчиков', NOW);
  assert.match(r3.reply, /Открытые долги \(2\)/);
  assert.match(r3.reply, /Иванов/);
  assert.match(r3.reply, /Петрову/);

  const r4 = await handleMessage(s, 'сколько мне должны', NOW);
  assert.match(r4.reply, /Вам должны/);
  assert.match(r4.reply, /50/);
});

test('сценарий: встреча попадает в сводку на завтра', async () => {
  const s = freshStore();
  await handleMessage(s, 'запиши встречу с Сергеем завтра в 15:00', NOW);
  const r = await handleMessage(s, 'что у меня завтра', NOW);
  assert.match(r.reply, /Сводка на 07\.07\.2026/);
  assert.match(r.reply, /Встреча с Сергеем/);
  assert.match(r.reply, /15:00/);
});

test('сценарий: «готово N» закрывает запись, она уходит из списков', async () => {
  const s = freshStore();
  await handleMessage(s, 'напомни оплатить хостинг через 3 дня', NOW);
  const done = await handleMessage(s, 'готово 1', NOW);
  assert.match(done.reply, /закрыта/);
  const list = await handleMessage(s, 'покажи задачи', NOW);
  assert.match(list.reply, /ничего не найдено/);
});

test('сценарий: просроченный долг помечается в выдаче', async () => {
  const s = freshStore();
  await handleMessage(s, 'Смирнов должен 30 000 до 1 июля', NOW); // уже в прошлом
  const r = await handleMessage(s, 'покажи долги', NOW);
  assert.match(r.reply, /ПРОСРОЧЕН/);
});

test('сценарий: заметка сохраняется и видна в списке заметок', async () => {
  const s = freshStore();
  await handleMessage(s, 'клиент Альфа просил расширить договор', NOW);
  const r = await handleMessage(s, 'покажи заметки', NOW);
  assert.match(r.reply, /Альфа/);
});

test('сценарий: удаление записи', async () => {
  const s = freshStore();
  await handleMessage(s, 'запиши встречу с Олегом завтра в 12:00', NOW);
  const r = await handleMessage(s, 'удали 1', NOW);
  assert.match(r.reply, /Удалил/);
  assert.equal(s.list({ status: 'open' }).length, 0);
});

test('пустое сообщение — вежливая подсказка', async () => {
  const s = freshStore();
  const r = await handleMessage(s, '   ', NOW);
  assert.match(r.reply, /Напишите/);
});

test('саммари без AI_API_KEY — понятная подсказка про настройку', async () => {
  delete process.env.AI_API_KEY;
  const s = freshStore();
  const r = await handleMessage(s, 'саммари', NOW);
  assert.match(r.reply, /не настроено/);
});

test('шкала памяти: пустая база даёт 0, записи наполняют', async () => {
  const { memoryStats, questionCoverage } = await import('../src/ragmeter.mjs');
  const s = freshStore();
  assert.equal(memoryStats(s).score, 0);
  assert.equal(memoryStats(s).level, 'empty');
  assert.equal(questionCoverage(s, 'кто мне должен?').score, 0);

  await handleMessage(s, 'Ромашка должна 120 000 до конца месяца', NOW);
  await handleMessage(s, 'встреча с командой завтра в 15:00', NOW);
  const stats = memoryStats(s);
  assert.ok(stats.score > 0, 'score должен вырасти');
  const cov = questionCoverage(s, 'сколько должна Ромашка?');
  assert.ok(cov.matched >= 1, 'вопрос про Ромашку должен найти совпадение');
  assert.ok(cov.score > 0);

  // падеж не должен ломать совпадение
  const covCase = questionCoverage(s, 'что известно про Ромашку?');
  assert.ok(covCase.matched >= 1, 'винительный падеж должен матчиться по основе');
});

test('онбординг: встречный вопрос не принимается за ответ', async () => {
  const { isConfusedReply } = await import('../src/telegram.mjs');
  assert.equal(isConfusedReply('Это что значит?'), true);
  assert.equal(isConfusedReply('что значит жаворонок'), true);
  assert.equal(isConfusedReply('в смысле'), true);
  assert.equal(isConfusedReply('не понял'), true);
  assert.equal(isConfusedReply('Саня'), false);
  assert.equal(isConfusedReply('сова'), false);
  assert.equal(isConfusedReply('Работа'), false);
});

test('mp3 и другие аудиоформаты Telegram корректно маппятся', async () => {
  const { audioFormatFromMime } = await import('../src/ai.mjs');
  assert.equal(audioFormatFromMime('audio/mpeg'), 'mp3');
  assert.equal(audioFormatFromMime('audio/mp3'), 'mp3');
  assert.equal(audioFormatFromMime('audio/ogg'), 'ogg');
  assert.equal(audioFormatFromMime('audio/x-wav'), 'wav');
  assert.equal(audioFormatFromMime('audio/mp4'), 'aac');
  assert.equal(audioFormatFromMime(''), 'ogg');
});

test('/reset бота: clearChatData стирает ВСЁ по пользователю, чужое не трогает', async () => {
  const { captureEntry } = await import('../src/brain.mjs');
  const s = freshStore();
  s.setUser('42', { botName: 'Барни', name: 'Саша', step: null });
  s.addRaw('42', 'сырая заметка');
  s.addFacts([{ chatId: '42', text: 'факт', people: [], tags: [] }]);
  s.pushHistory('user', 'привет', '42');
  captureEntry(s, 'Петров должен 30 000 до пятницы', NOW, '42'); // запись бота
  await handleMessage(s, 'Ромашка должна 120 000 до конца месяца', NOW); // веб-запись
  assert.equal(s.list({ type: 'debt' }).length, 2);

  s.clearChatData('42');
  assert.equal(s.getUser('42'), null);
  assert.equal(s.data.raw.filter((r) => r.chatId === '42').length, 0);
  assert.equal(s.data.facts.filter((f) => f.chatId === '42').length, 0);
  assert.equal(s.recentHistory(50, '42').length, 0);
  const debts = s.list({ type: 'debt' });
  assert.equal(debts.length, 1, 'долг юзера 42 стёрт полностью');
  assert.equal(debts[0].counterparty, 'Ромашка', 'веб-запись осталась');
  assert.equal(s.recentHistory(50, 'web').length, 2, 'веб-история не тронута');
});

test('история диалога копится и очищается командой «очистить чат»', async () => {
  const s = freshStore();
  await handleMessage(s, 'Иванов должен 50 000 до 20 июля', NOW);
  assert.equal(s.recentHistory().length, 2); // вопрос + ответ
  const r = await handleMessage(s, 'очистить чат', NOW);
  assert.equal(r.cleared, true);
  assert.equal(s.recentHistory().length, 0);
});
