// Самообучение: бот копит уроки из реакций людей и подмешивает их в промпт.
// Дообучить веса нельзя (модель у провайдера), поэтому «обучение» - это база
// коротких правил, которая растёт от реального общения.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { isDispleased, isDirectRule, addLesson, getLessons, forgetLesson, lessonsBlock, recentOpeners, openersRule, learnFromReaction, runRetro, lessonChats } from '../src/lessons.mjs';

const fresh = () => new Store(join(mkdtempSync(join(tmpdir(), 'sm-les-')), 'm.json'));

test('недовольство ловится по реальным фразам из чатов', () => {
  for (const s of ['Плохо', 'ой даун', 'не то', 'я же просил', 'в общем сколько', 'опять двадцать пять', 'хватит', 'ты тупой', 'исправь']) {
    assert.equal(isDispleased(s), true, s);
  }
});

test('обычная речь недовольством не считается', () => {
  for (const s of ['привет как дела', 'спасибо большое', 'плохое настроение у Ани', 'запиши 105 грамм сливы', '']) {
    assert.equal(isDispleased(s), false, s);
  }
});

test('прямое правило от человека распознаётся отдельно', () => {
  assert.equal(isDirectRule('учти на будущее: не спрашивай дважды'), true);
  assert.equal(isDirectRule('больше не начинай с моего имени'), true);
  assert.equal(isDirectRule('как дела'), false);
});

test('урок сохраняется и попадает в блок для промпта', () => {
  const s = fresh();
  addLesson(s, '1', 'Не переспрашивай, если человек просит посчитать - считай сразу');
  const block = lessonsBlock(s, '1');
  assert.match(block, /ЧЕМУ ТЕБЯ УЖЕ НАУЧИЛИ/);
  assert.match(block, /Не переспрашивай/);
  assert.equal(lessonsBlock(s, '2'), null, 'уроки не текут между чатами');
});

test('повтор похожего урока поднимает вес, а не плодит дубли', () => {
  const s = fresh();
  addLesson(s, '1', 'Не начинай ответ с имени собеседника');
  addLesson(s, '1', 'Не начинай ответ с имени человека');
  const list = getLessons(s, '1');
  assert.equal(list.length, 1, 'похожие схлопнулись');
  assert.equal(list[0].hits, 2);
  assert.match(lessonsBlock(s, '1'), /говорили 2 раза/);
});

test('частые уроки идут первыми, лишние вытесняются', () => {
  const s = fresh();
  for (let i = 0; i < 20; i++) addLesson(s, '1', `Правило номер ${i} про совершенно разные вещи ${i}`);
  const list = getLessons(s, '1');
  assert.ok(list.length <= 12, `в базе ${list.length}, должно быть не больше 12`);
});

test('урок можно стереть словами', () => {
  const s = fresh();
  addLesson(s, '1', 'Не сюсюкай с Лизой про калории');
  assert.equal(forgetLesson(s, '1', 'сюсюкай'), 1);
  assert.equal(getLessons(s, '1').length, 0);
});

test('мусор не записывается', () => {
  const s = fresh();
  assert.equal(addLesson(s, '1', 'ок'), null);
  assert.equal(addLesson(s, '1', ''), null);
  assert.equal(getLessons(s, '1').length, 0);
});

test('уроки переживают перезапуск', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'sm-les-')), 'm.json');
  const a = new Store(f);
  addLesson(a, '1', 'Отвечай короче - две фразы максимум');
  a.flush();
  const b = new Store(f);
  assert.equal(getLessons(b, '1')[0].text, 'Отвечай короче - две фразы максимум');
});

test('однообразные открывашки замечаются и запрещаются', () => {
  const history = [
    { role: 'assistant', text: 'Ну что, Саня, поехали' },
    { role: 'user', text: 'ага' },
    { role: 'assistant', text: 'Ну что, дальше' },
    { role: 'user', text: 'ок' },
    { role: 'assistant', text: 'Ну что, погнали' },
  ];
  assert.deepEqual(recentOpeners(history), ['Ну что', 'Ну что', 'Ну что']);
  const rule = openersRule(history);
  assert.match(rule, /Ну что/);
  assert.match(rule, /заевшая пластинка/);
});

test('разные открывашки претензий не вызывают', () => {
  const history = [
    { role: 'assistant', text: 'Сделал, держи' },
    { role: 'assistant', text: 'Погоди секунду' },
    { role: 'assistant', text: 'Готово' },
  ];
  assert.equal(openersRule(history), null);
});

test('урок заводится только по сигналу, и берётся предыдущий ответ бота', async () => {
  const s = fresh();
  s.pushHistory('user', 'сколько там калорий', '1');
  s.pushHistory('assistant', 'Лиза, ну ты прям замучила меня с этими калориями!', '1');
  const calls = [];
  const aiLesson = async (bot, user) => { calls.push({ bot, user }); return 'Считай сразу, без нытья и переспрашивания'; };

  // обычная реплика - модель не зовём вовсе
  await learnFromReaction({ store: s, aiLesson, chatId: '1', text: 'спасибо' });
  assert.equal(calls.length, 0);

  // недовольство - зовём и запоминаем
  const rec = await learnFromReaction({ store: s, aiLesson, chatId: '1', text: 'в общем сколько' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].bot, /замучила/, 'в модель ушёл именно предыдущий ответ бота');
  assert.equal(rec.source, 'из недовольства');
  assert.match(lessonsBlock(s, '1'), /Считай сразу/);
});

test('прямое правило помечается своим источником', async () => {
  const s = fresh();
  s.pushHistory('assistant', 'Саня, понял', '1');
  const rec = await learnFromReaction({
    store: s, aiLesson: async () => 'Не отвечай пустыми поддакиваниями', chatId: '1', text: 'учти на будущее: не поддакивай',
  });
  assert.equal(rec.source, 'сказано прямо');
});

test('модель вернула НЕТ - урок не заводится', async () => {
  const s = fresh();
  s.pushHistory('assistant', 'что-то', '1');
  const rec = await learnFromReaction({ store: s, aiLesson: async () => null, chatId: '1', text: 'ты тупой' });
  assert.equal(rec, null);
  assert.equal(getLessons(s, '1').length, 0);
});

test('падение модели не роняет разговор', async () => {
  const s = fresh();
  s.pushHistory('assistant', 'что-то', '1');
  const rec = await learnFromReaction({
    store: s, log: { error() {} }, aiLesson: async () => { throw new Error('AI HTTP 503'); }, chatId: '1', text: 'плохо',
  });
  assert.equal(rec, null);
});

test('без истории бота учить не на чем', async () => {
  const s = fresh();
  const rec = await learnFromReaction({ store: s, aiLesson: async () => 'урок', chatId: '1', text: 'плохо' });
  assert.equal(rec, null);
});

/* --- Ретроспектива: учимся без явных жалоб --- */

test('ретро разбирает диалог и заводит уроки', async () => {
  const s = fresh();
  for (let i = 0; i < 5; i++) {
    s.pushHistory('user', 'вопрос ' + i, '1');
    s.pushHistory('assistant', 'Ну что, ответ ' + i, '1');
  }
  const seen = [];
  const aiRetro = async (lines, known) => { seen.push({ lines, known }); return ['Не начинай каждый ответ одинаково', 'Отвечай по делу с первой фразы']; };
  const added = await runRetro({ store: s, aiRetro, chatId: '1' });
  assert.equal(added.length, 2);
  assert.ok(seen[0].lines.length >= 8, 'в модель ушёл кусок диалога');
  assert.match(lessonsBlock(s, '1'), /Не начинай каждый ответ одинаково/);
});

test('ретро не повторяется чаще раза в сутки', async () => {
  const s = fresh();
  for (let i = 0; i < 5; i++) { s.pushHistory('user', 'a', '1'); s.pushHistory('assistant', 'b', '1'); }
  let calls = 0;
  const aiRetro = async () => { calls++; return ['Правило про краткость ответов']; };
  await runRetro({ store: s, aiRetro, chatId: '1' });
  await runRetro({ store: s, aiRetro, chatId: '1' });
  assert.equal(calls, 1, 'второй запуск в тот же день модель не зовёт');
  // через сутки - можно снова
  await runRetro({ store: s, aiRetro, chatId: '1', now: Date.now() + 25 * 3600 * 1000 });
  assert.equal(calls, 2);
});

test('короткий диалог не разбираем', async () => {
  const s = fresh();
  s.pushHistory('user', 'привет', '1');
  s.pushHistory('assistant', 'ку', '1');
  let calls = 0;
  const added = await runRetro({ store: s, aiRetro: async () => { calls++; return ['x']; }, chatId: '1' });
  assert.equal(calls, 0);
  assert.deepEqual(added, []);
});

test('уже известные правила уезжают в модель, чтобы она их не дублировала', async () => {
  const s = fresh();
  addLesson(s, '1', 'Не поддакивай пустыми фразами');
  for (let i = 0; i < 5; i++) { s.pushHistory('user', 'a', '1'); s.pushHistory('assistant', 'b', '1'); }
  let known = null;
  await runRetro({ store: s, aiRetro: async (_l, k) => { known = k; return []; }, chatId: '1' });
  assert.deepEqual(known, ['Не поддакивай пустыми фразами']);
});

test('служебные ключи ретро не считаются чатами с уроками', () => {
  const s = fresh();
  addLesson(s, '1', 'Какое-то полезное правило');
  s.data.lessons[':retro:1'] = new Date().toISOString();
  assert.deepEqual(lessonChats(s), ['1']);
  assert.equal(getLessons(s, ':retro:1').length, 0);
});
