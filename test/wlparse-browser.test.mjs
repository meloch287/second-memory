// Браузерный фолбэк разбора вишлист-ссылки (Playwright). Тестируем БЕЗ реального
// playwright: launcher инъектируется фейком. Плюс проверяем graceful-degradation,
// когда playwright не установлен (дефолтный путь на локалке/в CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProductBrowser } from '../src/wlparse-browser.mjs';

// Фейковый браузер в форме Playwright (newContext -> newPage -> goto/url/content).
function fakeBrowser({ finalUrl, html = '', status = 200, gotoThrows = false, contentThrows = false, domPrice = null } = {}) {
  let closed = false;
  return {
    _closed: () => closed,
    async newContext() {
      return {
        async newPage() {
          return {
            async goto() { if (gotoThrows) throw new Error('nav boom'); return { status: () => status }; },
            async waitForTimeout() {},
            url: () => finalUrl,
            async content() { if (contentThrows) throw new Error('read boom'); return html; },
            async evaluate() { return domPrice; }, // имитируем цену из DOM
          };
        },
        async close() {},
      };
    },
    async close() { closed = true; },
  };
}
const launcher = (cfg) => () => Promise.resolve(fakeBrowser(cfg));

test('browser: рендер карточки -> title/photos из og', async () => {
  const url = 'https://market.yandex.ru/product--naushniki-sony/12345';
  const html = `<html><head>
    <meta property="og:title" content="Наушники Sony WH-1000XM5">
    <meta property="og:description" content="Беспроводные с шумоподавлением">
    <meta property="og:image" content="https://avatars.mds.yandex.net/get-mpic/1/a.jpg">
    <script type="application/ld+json">{"@type":"Product","name":"Наушники Sony WH-1000XM5","offers":{"price":"29990"}}</script>
    </head><body></body></html>`;
  const r = await parseProductBrowser(url, { launch: launcher({ finalUrl: url, html }) });
  assert.equal(r.ok, true);
  assert.equal(r.url, url);
  assert.match(r.title, /Sony WH-1000XM5/);
  assert.equal(r.source, 'market.yandex.ru');
  assert.ok(r.photos.length >= 1, 'фото со страницы');
  assert.equal(r.price, 29990);
});

test('browser: цена из DOM подставляется, когда её нет в og/JSON-LD', async () => {
  const url = 'https://market.yandex.ru/product--naushniki/12345';
  const html = `<html><head>
    <meta property="og:title" content="Наушники Sony">
    <meta property="og:image" content="https://avatars.mds.yandex.net/x.jpg">
    </head></html>`;
  const r = await parseProductBrowser(url, { launch: launcher({ finalUrl: url, html, domPrice: 29990 }) });
  assert.equal(r.ok, true);
  assert.equal(r.price, 29990, 'цена взята из DOM');
});

test('browser: капча в финальном URL -> ok:false (не решаем)', async () => {
  const url = 'https://market.yandex.ru/product--x/1';
  const r = await parseProductBrowser(url, {
    launch: launcher({ finalUrl: 'https://market.yandex.ru/showcaptcha?cc=1&retpath=x', html: '<html></html>' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'challenge');
});

test('browser: страница-заглушка «Нет такой страницы» -> ok:false not_found', async () => {
  const url = 'https://market.yandex.ru/product--x/9999999';
  const html = '<html><head><title>Нет такой страницы - Яндекс Маркет</title></head></html>';
  const r = await parseProductBrowser(url, { launch: launcher({ finalUrl: url, html }) });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_found');
});

test('browser: ошибка навигации -> ok:false, без throw', async () => {
  const r = await parseProductBrowser('https://shop.example.com/x', { launch: launcher({ gotoThrows: true }) });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'nav_error');
});

test('browser: пустой url -> bad_url', async () => {
  const r = await parseProductBrowser('', { launch: launcher({}) });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad_url');
});

test('browser: launcher падает (нет playwright) -> ok:false browser_unavailable', async () => {
  const r = await parseProductBrowser('https://shop.example.com/x', {
    launch: () => Promise.reject(new Error('Cannot find package playwright')),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'browser_unavailable');
});

test('browser: дефолтный путь без установленного playwright не бросает', async () => {
  // На локалке/в CI playwright не установлен (проект zero-dependency) - должен
  // тихо вернуть ok:false, а не уронить процесс.
  const r = await parseProductBrowser('https://shop.example.com/x');
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, 'string');
});
