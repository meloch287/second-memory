import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../src/parser.mjs';
import { pickReaction, stickerMood } from '../src/reactions.mjs';
import { currencyCode, rubPerUnit } from '../src/currency.mjs';

delete process.env.SM_ENCRYPTION_KEY;
const NOW = new Date('2026-07-07T09:00:00.000Z');

/* №4 Дни рождения */
test('parser: дни рождения', () => {
  const b = parseMessage('у Димы др 15 августа', NOW);
  assert.equal(b.kind, 'birthday');
  assert.equal(b.person, 'Димы');
  assert.equal(b.day, 15);
  assert.equal(b.month, 8);
  const mine = parseMessage('мой день рождения 1 января', NOW);
  assert.equal(mine.kind, 'birthday');
  assert.equal(mine.person, null, 'свой др - person null');
  assert.equal(parseMessage('дни рождения', NOW).kind, 'birthdays');
  // встреча с датой не путается с др
  assert.equal(parseMessage('у меня встреча 15 августа', NOW).kind, 'entry');
});

/* №12 Валюты */
test('parser + currency: код валюты и пересчёт', () => {
  assert.equal(parseMessage('курс доллара', NOW).kind, 'currency');
  assert.equal(parseMessage('300 долларов в рублях', NOW).kind, 'currency');
  assert.equal(currencyCode('курс евро'), 'EUR');
  assert.equal(currencyCode('300$ в рублях'), 'USD');
  assert.equal(currencyCode('сколько юаней'), 'CNY');
  assert.equal(currencyCode('курс тугрика'), null);
  // Nominal: 100 иен за N рублей
  const rates = { JPY: { Value: 52.3, Nominal: 100 }, USD: { Value: 78, Nominal: 1 } };
  assert.equal(rubPerUnit(rates, 'JPY'), 0.523);
  assert.equal(rubPerUnit(rates, 'USD'), 78);
});

/* №8 Реакции */
test('pickReaction: настроение и вероятность', () => {
  const always = () => 0; // rand=0 -> реакция точно есть
  const never = () => 0.99;
  assert.equal(pickReaction('ахахах ну ты дал', always), '😁');
  assert.ok(['🎉', '🔥'].includes(pickReaction('я сдал экзамен наконец-то!', always)));
  assert.equal(pickReaction('спасибо, красавчик', always), '❤️');
  assert.equal(pickReaction('мне плохо и грустно', always), '❤️');
  assert.equal(pickReaction('обычное сообщение про дела', always), null, 'нейтральное - без реакции');
  assert.equal(pickReaction('ахахах', never), null, 'вероятность отсекает');
});

test('stickerMood: редкий и по эмоции', () => {
  const always = () => 0;
  assert.ok(stickerMood('ахаха ржу', always).includes('😂'));
  assert.equal(stickerMood('обычный текст', always), null);
  assert.equal(stickerMood('ахаха', () => 0.9), null, '80% случаев - без стикера');
});

/* Расширенный парсинг времени (баг «не напомнил в 4») */
test('время: форматы 16 00 / 16.00 / к 4 / словом', async () => {
  const { captureEntry } = await import('../src/brain.mjs');
  const { Store } = await import('../src/store.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const s = new Store(join(mkdtempSync(join(tmpdir(), 'sm-time-')), 'm.json'));
  const now = new Date('2026-07-07T09:00:00Z');
  const cases = [
    ['напомни в 16 00 позвонить', 13],
    ['напомни в 16.00 позвонить', 13],
    ['напомни позвонить к 4', 13], // 04:00 прошло в 09:00 -> 16:00
    ['напомни в четыре позвонить', 13],
    ['напомни к пяти позвонить', 14],
    ['напомни в полдень обед', 9],
    ['напомни в 16:00 зал', 13],
  ];
  for (const [t, hourZ] of cases) {
    const e = captureEntry(s, t, now, '1', 180);
    assert.ok(e && e.hasTime, `${t}: время должно извлечься`);
    assert.equal(new Date(e.due).getUTCHours(), hourZ, `${t}: час UTC`);
  }
});
