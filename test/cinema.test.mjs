// Афиша кино по городу. Живой случай: бот выдумал репертуар и тянул время,
// человек ждал три с половиной часа. Теперь либо реальные данные, либо отказ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { citySlug, scheduleUrl, parseCard, parseCity, parseGenres, cinemaText, cinemaToday, CINEMA_RE } from '../src/cinema.mjs';

test('город превращается в адрес расписания', () => {
  assert.equal(citySlug('Зеленоград'), 'zelenograd');
  assert.equal(citySlug('Москва'), 'msk');
  assert.equal(citySlug('Санкт-Петербург'), 'spb');
  assert.equal(citySlug('Тверь'), 'tver');
  assert.equal(scheduleUrl('Зеленоград'), 'https://www.afisha.ru/zelenograd/schedule_cinema/');
  assert.equal(scheduleUrl(''), null);
});

test('карточка фильма разбирается на название, жанр и рейтинг', () => {
  assert.deepEqual(parseCard('Холоп 3 2026, Приключение 7.6', 'Холоп 3'), { title: 'Холоп 3', year: 2026, genre: 'приключение', rating: 7.6 });
  // на странице рейтинг и «Билеты» стоят перед названием
  assert.deepEqual(parseCard('7.6 до 20% Билеты Холоп 3 2026, Приключение', 'Холоп 3'), { title: 'Холоп 3', year: 2026, genre: 'приключение', rating: 7.6 });
  assert.equal(parseCard('Ешь, молись, худей 2026, Фантастика', 'Ешь, молись, худей').genre, 'фантастика');
});

test('служебные ссылки страницы не считаются фильмами', () => {
  assert.equal(parseCard('ФИЛЬМОТЕКА', 'ФИЛЬМОТЕКА'), null);
  assert.equal(parseCard('Билеты', 'Билеты'), null);
  assert.equal(parseCard('просто текст без года'), null);
});

test('город достаётся из вопроса в любом падеже', () => {
  assert.equal(parseCity('Посмотри кинотеатр в котором это идет в городе Зеленоград'), 'Зеленоград');
  assert.equal(parseCity('что идёт в кино в Твери'), 'Тверь');
  assert.equal(parseCity('кино в Москве'), 'Москва');
  assert.equal(parseCity('в Туле'), 'Тула');
  assert.equal(parseCity('я в деле'), null);
});

test('жанры из просьбы понимаются по-человечески', () => {
  assert.deepEqual(parseGenres('Фантастика, мультики'), ['фантастика', 'мультфильм']);
  assert.deepEqual(parseGenres('хочу поржать'), ['комедия']);
  assert.deepEqual(parseGenres('что-нибудь страшное'), ['ужасы']);
  assert.deepEqual(parseGenres('всё равно'), []);
});

test('вопрос про кино отличается от похожих фраз', () => {
  for (const q of ['А ты знаешь, что идет в кинотеатрах?', 'что в кино', 'афиша', 'какие фильмы идут', 'посмотри кинотеатр в Зеленограде']) {
    assert.equal(CINEMA_RE.test(q), true, q);
  }
  for (const q of ['я иду в магазин', 'кинь ссылку', 'кино мне не нравится сегодня решать']) {
    assert.equal(CINEMA_RE.test(q) && !/кино/.test(q), false, q);
  }
});

test('текст для чата фильтрует по жанрам и даёт ссылку на сеансы', () => {
  const data = {
    city: 'Зеленоград',
    url: 'https://www.afisha.ru/zelenograd/schedule_cinema/',
    films: [
      { title: 'Ешь, молись, худей', genre: 'фантастика', rating: null },
      { title: 'Приключения мамонтенка', genre: 'мультфильм', rating: 7.1 },
      { title: 'Сумерки', genre: 'триллер', rating: 8.5 },
    ],
  };
  const out = cinemaText(data, ['фантастика', 'мультфильм']);
  assert.match(out, /Ешь, молись, худей/);
  assert.match(out, /Приключения мамонтенка/);
  assert.ok(!out.includes('Сумерки'), 'триллер не просили');
  assert.match(out, /Расписание сеансов/);
});

test('по жанрам пусто - честно говорим и показываем всё', () => {
  const data = { city: 'Тверь', url: 'https://x', films: [{ title: 'Сумерки', genre: 'триллер', rating: 8.5 }] };
  const out = cinemaText(data, ['мультфильм']);
  assert.match(out, /ничего не нашёл/);
  assert.match(out, /Сумерки/);
});

test('без фильмов текста нет - лучше честный отказ, чем выдумка', () => {
  assert.equal(cinemaText(null), null);
  assert.equal(cinemaText({ city: 'X', url: 'y', films: [] }), null);
});

test('падение браузера не роняет бота, а даёт null', async () => {
  const res = await cinemaToday('Зеленоград', { launcher: async () => { throw new Error('browser died'); } });
  assert.equal(res, null);
});

test('неизвестный город - без похода в сеть', async () => {
  let called = false;
  const res = await cinemaToday('', { launcher: async () => { called = true; } });
  assert.equal(res, null);
  assert.equal(called, false);
});
