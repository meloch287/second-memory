// stripBotVocative: убирает обращение именем бота, но НЕ ломает предложения,
// где имя бота - подлежащее («Толик обожает кофе»), и снимает префикс «Толик:».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripBotVocative } from '../src/ai.mjs';

test('срезает вокатив-обращение', () => {
  assert.equal(stripBotVocative('Держи, Толик!', 'Толик'), 'Держи!');
  assert.equal(stripBotVocative('Толик, погнали', 'Толик'), 'Погнали');
});

test('НЕ ломает имя-подлежащее', () => {
  assert.equal(stripBotVocative('О, Толик обожает кофе!', 'Толик'), 'О, Толик обожает кофе!');
  assert.match(stripBotVocative('Меня зовут Толик', 'Толик'), /Меня зовут Толик/);
});

test('снимает префикс «Толик:» из групповой разметки', () => {
  assert.equal(stripBotVocative('Толик: Ну чего скучаешь', 'Толик'), 'Ну чего скучаешь');
});
