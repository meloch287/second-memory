import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProduct, parseRenderedHtml } from '../src/wlparse.mjs';

// Мок WHATWG Response - без сети, детерминированно.
function mockRes({ ok = true, status = 200, url, redirected = false, html = '', headers = {} } = {}) {
  return {
    ok,
    status,
    url,
    redirected,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => html,
  };
}

/* JSON-LD Product */
test('parseProduct: JSON-LD Product -> title/description/photos/price', async () => {
  const html = `<!doctype html><html><head>
    <script type="application/ld+json">
    {"@context":"https://schema.org/","@type":"Product",
     "name":"Наушники AirPods Pro 2",
     "description":"Беспроводные наушники с шумоподавлением",
     "image":["https://cdn.example.com/img1.jpg","https://cdn.example.com/img2.jpg"],
     "offers":{"@type":"Offer","price":"24990","priceCurrency":"RUB"}}
    </script>
    </head><body></body></html>`;
  const url = 'https://www.ozon.ru/product/airpods-pro-2-306912875/';
  const fetchImpl = async () => mockRes({ ok: true, status: 200, url, html });

  const r = await parseProduct(url, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.url, url);
  assert.equal(r.title, 'Наушники AirPods Pro 2');
  assert.equal(r.description, 'Беспроводные наушники с шумоподавлением');
  assert.deepEqual(r.photos, ['https://cdn.example.com/img1.jpg', 'https://cdn.example.com/img2.jpg']);
  assert.equal(r.price, 24990);
  assert.equal(r.source, 'ozon.ru');
});

/* JSON-LD внутри @graph + один объект-изображение вместо строки */
test('parseProduct: JSON-LD @graph и image как объект с url', async () => {
  const html = `<html><head>
    <script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[
      {"@type":"BreadcrumbList","itemListElement":[]},
      {"@type":"Product","name":"Кружка керамическая","image":{"@type":"ImageObject","url":"https://cdn.example.com/mug.jpg"},
       "offers":{"@type":"Offer","price":990}}
    ]}
    </script>
    </head></html>`;
  const url = 'https://shop.example.com/goods/mug-42';
  const fetchImpl = async () => mockRes({ ok: true, status: 200, url, html });

  const r = await parseProduct(url, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Кружка керамическая');
  assert.deepEqual(r.photos, ['https://cdn.example.com/mug.jpg']);
  assert.equal(r.price, 990);
});

/* OG-теги без JSON-LD, несколько og:image, относительная картинка */
test('parseProduct: только OG-теги, несколько og:image собраны и нормализованы', async () => {
  const html = `<html><head>
    <meta property="og:title" content="Кроссовки Nike Air Max">
    <meta property="og:description" content="Стильные кроссовки для города">
    <meta property="og:image" content="/images/shoe1.jpg">
    <meta property="og:image" content="https://cdn.example.com/shoe2.jpg">
    <meta property="product:price:amount" content="8 990">
    </head><body></body></html>`;
  const url = 'https://www.wildberries.ru/catalog/12345/detail.aspx';
  const fetchImpl = async () => mockRes({ ok: true, status: 200, url, html });

  const r = await parseProduct(url, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Кроссовки Nike Air Max');
  assert.equal(r.description, 'Стильные кроссовки для города');
  assert.deepEqual(r.photos, ['https://www.wildberries.ru/images/shoe1.jpg', 'https://cdn.example.com/shoe2.jpg']);
  assert.equal(r.price, 8990);
  assert.equal(r.source, 'wildberries.ru');
});

/* twitter:* как последний фолбэк, когда нет ни JSON-LD, ни OG */
test('parseProduct: фолбэк на twitter:title/description/image', async () => {
  const html = `<html><head>
    <title>Игнорируем - это title тега</title>
    <meta name="twitter:title" content="Часы наручные">
    <meta name="twitter:description" content="Механические часы">
    <meta name="twitter:image" content="https://cdn.example.com/watch.jpg">
    </head></html>`;
  const url = 'https://shop.example.com/watch-1';
  const fetchImpl = async () => mockRes({ ok: true, status: 200, url, html });

  const r = await parseProduct(url, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Часы наручные');
  assert.equal(r.description, 'Механические часы');
  assert.deepEqual(r.photos, ['https://cdn.example.com/watch.jpg']);
});

/* Ozon /t/... короткая ссылка: 403 без тела, но редирект донёс слаг */
test('parseProduct: редирект с полным слагом при заблокированном теле (Ozon /t/...)', async () => {
  const shortUrl = 'https://ozon.ru/t/AbCdEf12';
  const redirectedUrl = 'https://www.ozon.ru/product/naushniki-besprovodnye-airpods-pro-2-belyy-306912875/?asdf';
  const fetchImpl = async () =>
    mockRes({ ok: false, status: 403, url: redirectedUrl, redirected: true, html: '' });

  const r = await parseProduct(shortUrl, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.url, shortUrl, 'эхо исходного url, не редиректнутого');
  assert.equal(r.title, 'Naushniki besprovodnye airpods pro 2 belyy');
  assert.equal(r.source, 'ozon.ru');
  assert.equal(r.price, null);
  assert.deepEqual(r.photos, []);
});

/* Я.Маркет капча: retpath = base64(реальный url товара) */
test('parseProduct: капча Я.Маркета с retpath -> декодируем слаг', async () => {
  const originalUrl = 'https://market.yandex.ru/product--naushniki-apple-airpods-pro-2/1234567890';
  const retpathB64 = Buffer.from(originalUrl, 'utf8').toString('base64');
  const captchaUrl = `https://yandex.ru/showcaptcha?retpath=${encodeURIComponent(retpathB64)}&t=abc`;
  const fetchImpl = async () =>
    mockRes({ ok: true, status: 200, url: captchaUrl, redirected: true, html: '<html>капча, без товара</html>' });

  const r = await parseProduct(originalUrl, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.url, originalUrl);
  assert.equal(r.title, 'Naushniki apple airpods pro 2');
  assert.equal(r.source, 'market.yandex.ru');
});

/* Сеть падает (throw) - никогда не бросаем наружу */
test('parseProduct: fetchImpl бросает исключение -> ok:false, без throw', async () => {
  const url = 'https://unreachable.example.com/item';
  const fetchImpl = async () => {
    throw new Error('getaddrinfo ENOTFOUND unreachable.example.com');
  };

  const r = await parseProduct(url, { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.url, url);
  assert.equal(typeof r.error, 'string');
});

/* Всё заблокировано: не 200, редиректа/слага нет - честный blocked, без throw */
test('parseProduct: 403 без редиректа и без retpath -> ok:false error blocked', async () => {
  const url = 'https://strict-shop.example.com/item/1';
  const fetchImpl = async () => mockRes({ ok: false, status: 403, url, redirected: false, html: '' });

  const r = await parseProduct(url, { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.url, url);
  assert.equal(r.error, 'blocked');
});

/* AbortController должен реально сработать по таймауту, а не просто игнорироваться */
test('parseProduct: fetchImpl игнорирует url и подвисает дольше timeoutMs -> ok:false', async () => {
  const url = 'https://slow.example.com/item';
  const fetchImpl = (u, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });

  const r = await parseProduct(url, { fetchImpl, timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.url, url);
});

/* Дедупликация и лимит на ~10 фото */
test('parseProduct: фото дедуплицируются и ограничены сверху', async () => {
  const imgs = Array.from({ length: 15 }, (_, i) => `<meta property="og:image" content="https://cdn.example.com/p${i % 8}.jpg">`);
  const html = `<html><head><meta property="og:title" content="Много фото">${imgs.join('\n')}</head></html>`;
  const url = 'https://shop.example.com/many-photos';
  const fetchImpl = async () => mockRes({ ok: true, status: 200, url, html });

  const r = await parseProduct(url, { fetchImpl });
  assert.equal(r.ok, true);
  assert.ok(r.photos.length <= 10, 'не больше ~10 фото');
  assert.equal(new Set(r.photos).size, r.photos.length, 'без дублей');
});

/* Пустой/битый url - никогда не бросаем наружу */
test('parseProduct: пустой url -> ok:false, без throw', async () => {
  const r = await parseProduct('', {});
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, 'string');
});


/* Битое (недекодированное) тело - напр. Я.Маркет с zstd: res.text() отдаёт
   mojibake. В вишлист НЕ должен улетать мусорный заголовок - лучше слаг из URL
   либо ok:false, но без символов-замен U+FFFD в title/description. */
test('parseProduct: mojibake-тело -> без битого заголовка (слаг или ok:false)', async () => {
  const garbled = 'List�����';
  const html = `<html><head><title>${garbled}</title></head><body>���</body></html>`;
  const url = 'https://market.yandex.ru/product--besprovodnye-naushniki/123456789';
  const fetchImpl = async () => mockRes({ ok: true, status: 200, url, html });

  const r = await parseProduct(url, { fetchImpl });
  if (r.ok) {
    assert.ok(!/\uFFFD/.test(r.title || ''), 'в title не должно быть символа-замены');
    assert.ok(!/[\u0000-\u0008\u000E-\u001F]/.test(r.title || ''), 'в title не должно быть управляющих байтов');
    assert.match(r.title, /naushniki/i, 'деградация на осмысленный слаг из URL');
  } else {
    assert.equal(typeof r.error, 'string');
  }
});

/* Битый og:title (раньше брался сырым, мимо cleanText) - тоже отклоняется. */
test('parseProduct: битый og:title отклоняется, падаем на слаг', async () => {
  const html = `<html><head><meta property="og:title" content="����"></head></html>`;
  const url = 'https://www.ozon.ru/product/robot-pylesos-xiaomi-229809575/';
  const fetchImpl = async () => mockRes({ ok: true, status: 200, url, html });

  const r = await parseProduct(url, { fetchImpl });
  assert.equal(r.ok, true);
  assert.ok(!/\uFFFD/.test(r.title || ''));
  assert.match(r.title, /robot|pylesos|xiaomi/i, 'слаг из URL как запасной заголовок');
});

/* Реальный Я.Маркет: showcaptcha с retpath = base64(product-url) + подпись «,,_<hex>».
   Хвост-подпись раньше приклеивался к URL при base64-декоде -> слаг «List<мусор>».
   Теперь отрезаем -> чистый осмысленный слаг товара. */
test('parseProduct: Я.Маркет retpath с подписью -> чистый слаг товара', async () => {
  const productUrl = 'https://market.yandex.ru/product--besprovodnye-naushniki-airdots/123456789';
  const b64 = Buffer.from(productUrl).toString('base64');
  const captchaUrl = `https://market.yandex.ru/showcaptcha?cc=1&retpath=${encodeURIComponent(b64)}%2C%2C_517b839729ce658c00e3f86b25a6c81a&t=2%252F17&u=915`;
  const fetchImpl = async () =>
    mockRes({ ok: true, status: 200, url: captchaUrl, redirected: true, html: '<html><head><title>Вы не робот?</title></head></html>' });

  const r = await parseProduct('https://market.yandex.ru/product--besprovodnye-naushniki-airdots/123456789', { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'market.yandex.ru');
  assert.match(r.title, /naushniki/i, 'слаг товара, а не мусор');
  assert.ok([...r.title].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0xfffd), 'без управляющих/битых символов');
});

/* parseRenderedHtml: разбор уже отрендеренного HTML (путь Playwright) */
test('parseRenderedHtml: og/JSON-LD из готового HTML', async () => {
  const html = `<html><head>
    <meta property="og:title" content="Кофеварка De'Longhi">
    <meta property="og:image" content="https://cdn.example.com/coffee.jpg">
    <script type="application/ld+json">{"@type":"Product","name":"Кофеварка De'Longhi","offers":{"price":"15990"}}</script>
    </head></html>`;
  const r = parseRenderedHtml(html, 'https://market.yandex.ru/product--kofevarka/55');
  assert.equal(r.ok, true);
  assert.match(r.title, /De'Longhi/);
  assert.equal(r.price, 15990);
  assert.ok(r.photos.length >= 1);
  assert.equal(r.source, 'market.yandex.ru');
});

test('parseRenderedHtml: пустой HTML -> ok:false', () => {
  const r = parseRenderedHtml('', 'https://x/y');
  assert.equal(r.ok, false);
});

test('parseRenderedHtml: нет метаданных -> слаг из URL', () => {
  const r = parseRenderedHtml('<html><body>no meta</body></html>', 'https://shop.example.com/besprovodnaya-kolonka');
  assert.equal(r.ok, true);
  assert.match(r.title, /kolonka/i);
});

/* Чистка маркетингового хвоста заголовка (Я.Маркет og:title) */
test('parseRenderedHtml: срезает "– купить на … , undefined" из og:title', () => {
  const html = `<html><head>
    <meta property="og:title" content="Наушники Sony WH-1000XM5 81524961|779938 – купить на Яндекс Маркете, undefined">
    <meta property="og:image" content="https://avatars.mds.yandex.net/x.jpg">
    </head></html>`;
  const r = parseRenderedHtml(html, 'https://market.yandex.ru/product--naushniki/1');
  assert.equal(r.ok, true);
  assert.ok(!/купить|undefined/i.test(r.title), 'хвост срезан: ' + r.title);
  assert.match(r.title, /Sony WH-1000XM5/);
});

test('tidyProductTitle: обычный заголовок со словом «купить» в середине не рушится целиком', () => {
  // "купить" как часть названия без разделителя-тире не срезаем
  const html = `<html><head><meta property="og:title" content="Планшет для записей купить-продай"></head></html>`;
  const r = parseRenderedHtml(html, 'https://shop.example.com/x');
  assert.equal(r.ok, true);
  assert.match(r.title, /Планшет/);
});

/* Wildberries: карточка из basket-CDN (обходит 403 Angie сайта/API), фото webp */
test('parseProduct: WB basket-CDN -> title/description/photos, source wildberries.ru', async () => {
  const card = {
    imt_name: 'Кроссовки COPTER',
    subj_name: 'Кроссовки',
    description: 'Кроссовки со светящейся подошвой',
    media: { photo_count: 3 },
  };
  // basket-01 отдаёт 404, basket-02 - карточку: проверяем перебор хостов.
  const fetchImpl = async (u) => {
    if (/basket-02\.wbbasket\.ru\/.*\/info\/ru\/card\.json$/.test(u)) {
      return { ok: true, status: 200, url: u, json: async () => card, text: async () => JSON.stringify(card), headers: { get: () => null } };
    }
    return { ok: false, status: 404, url: u, json: async () => ({}), text: async () => '', headers: { get: () => null } };
  };
  const url = 'https://www.wildberries.ru/catalog/11853913/detail.aspx';
  const r = await parseProduct(url, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'wildberries.ru');
  assert.equal(r.title, 'Кроссовки COPTER');
  assert.match(r.description, /светящейся/);
  assert.equal(r.photos.length, 3);
  assert.match(r.photos[0], /basket-02\.wbbasket\.ru\/vol118\/part11853\/11853913\/images\/big\/1\.webp/);
});

test('parseProduct: WB артикул из ?card= тоже работает', async () => {
  const card = { imt_name: 'Термос', media: { photo_count: 1 } };
  const fetchImpl = async (u) => (/\/info\/ru\/card\.json$/.test(u)
    ? { ok: true, status: 200, url: u, json: async () => card, headers: { get: () => null } }
    : { ok: false, status: 404, url: u, json: async () => ({}), headers: { get: () => null } });
  const r = await parseProduct('https://www.wildberries.ru/product?card=123456', { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Термос');
});

test('parseProduct: не-WB ссылка не трогает basket-путь (идёт общий разбор)', async () => {
  const html = '<html><head><meta property="og:title" content="Обычный товар"></head></html>';
  let basketHit = false;
  const fetchImpl = async (u) => {
    if (/wbbasket\.ru/.test(u)) basketHit = true;
    return mockRes({ ok: true, status: 200, url: 'https://shop.example.com/x', html });
  };
  const r = await parseProduct('https://shop.example.com/x', { fetchImpl });
  assert.equal(basketHit, false, 'для не-WB basket не запрашивается');
  assert.equal(r.title, 'Обычный товар');
});
