// Разбор товарной ссылки для вишлиста: best-effort, устойчиво к антибот-блокировкам.
// Отдельный модуль - не трогает parser/brain/scheduler, которые правит другой агент параллельно.
//
// Экспортируемая функция никогда не бросает исключение: любая сетевая/парсинг-ошибка
// превращается в { ok:false, url, error }, чтобы вызывающий код мог спокойно упасть
// на ручной ввод карточки вишлиста.

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MAX_PHOTOS = 10;

/**
 * Разобрать товарную страницу по ссылке.
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok:true,url:string,title:?string,description:?string,photos:string[],price:?number,source:?string}
 *                   |{ok:false,url:string,error:string}>}
 */
export async function parseProduct(url, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false, url: typeof url === 'string' ? url : '', error: 'bad_url' };
  }

  // Wildberries: сайт/API режут дата-центровый IP (403 Angie), а статический
  // basket-CDN (wbbasket.ru) открыт и доступен с РФ-IP напрямую. Пробуем его
  // раньше общего пути. Не WB / basket не нашёлся -> null -> идём дальше.
  const wb = await parseWildberries(url, fetchImpl, timeoutMs);
  if (wb) return wb;

  let res;
  try {
    res = await fetchWithTimeout(fetchImpl, url, timeoutMs);
  } catch {
    // Таймаут, DNS-ошибка, сеть недоступна и т.п. - никогда не бросаем наружу.
    return { ok: false, url, error: 'network_error' };
  }
  if (!res || typeof res !== 'object') {
    return { ok: false, url, error: 'network_error' };
  }

  const finalUrl = typeof res.url === 'string' && res.url ? res.url : url;

  // Я.Маркет вместо товара отдаёт капчу; настоящий адрес товара лежит base64-строкой
  // в query-параметре retpath капча-урла. Проверяем это раньше всего остального -
  // капча-страница всё равно не содержит полезной разметки товара.
  const captcha = extractRetpathSlug(finalUrl) || extractRetpathSlug(url);
  if (captcha) {
    return {
      ok: true,
      url,
      title: captcha.title,
      description: null,
      photos: [],
      price: null,
      source: hostnameOf(captcha.target) || hostnameOf(finalUrl) || hostnameOf(url),
    };
  }

  if (!res.ok) {
    // Ozon /t/... короткие ссылки: обычный GET с дата-центрового/локального IP часто
    // получает 403 без тела, но редирект (301) с полным слагом товара всё же долетает -
    // цепляемся за него вместо того, чтобы объявлять полный провал.
    const redirectTarget = pickRedirectTarget(res, url);
    const slug = redirectTarget ? titleFromSlug(redirectTarget) : null;
    if (slug) {
      return {
        ok: true,
        url,
        title: slug,
        description: null,
        photos: [],
        price: null,
        source: hostnameOf(redirectTarget) || hostnameOf(finalUrl),
      };
    }
    return { ok: false, url, error: 'blocked' };
  }

  let html;
  try {
    html = await res.text();
  } catch {
    return { ok: false, url, error: 'read_error' };
  }
  if (typeof html !== 'string' || !html.trim()) {
    return { ok: false, url, error: 'empty_body' };
  }

  const extracted = extractFromHtml(html, finalUrl);
  if (!extracted.title && !extracted.description && extracted.photos.length === 0) {
    // Пустая выдача даже при 200: возможно это всё-таки "мягкий" антибот-заглушка.
    // Последний шанс - слаг из финального (возможно, редиректнутого) урла.
    const redirectTarget = pickRedirectTarget(res, url);
    const slug = redirectTarget ? titleFromSlug(redirectTarget) : titleFromSlug(finalUrl);
    if (slug) {
      return {
        ok: true,
        url,
        title: slug,
        description: null,
        photos: [],
        price: null,
        source: hostnameOf(redirectTarget) || hostnameOf(finalUrl),
      };
    }
    return { ok: false, url, error: 'no_data' };
  }

  return {
    ok: true,
    url,
    title: extracted.title || null,
    description: extracted.description || null,
    photos: extracted.photos,
    price: extracted.price ?? null,
    source: hostnameOf(finalUrl) || hostnameOf(url),
  };
}

/**
 * Разбор УЖЕ отрендеренного HTML (напр. из headless-браузера): та же извлекалка
 * og/JSON-LD/фото/цены, что и в fetch-пути - чтобы был один путь разбора.
 * @param {string} html   полный HTML отрендеренной страницы
 * @param {string} finalUrl фактический адрес (для абсолютных фото и слаг-фолбэка)
 */
export function parseRenderedHtml(html, finalUrl) {
  if (typeof html !== 'string' || !html.trim()) {
    return { ok: false, url: finalUrl || '', error: 'empty_body' };
  }
  const extracted = extractFromHtml(html, finalUrl);
  if (!extracted.title && !extracted.description && extracted.photos.length === 0) {
    const slug = titleFromSlug(finalUrl);
    if (slug) {
      return { ok: true, url: finalUrl, title: slug, description: null, photos: [], price: null, source: hostnameOf(finalUrl) };
    }
    return { ok: false, url: finalUrl, error: 'no_data' };
  }
  return {
    ok: true,
    url: finalUrl,
    title: extracted.title || null,
    description: extracted.description || null,
    photos: extracted.photos,
    price: extracted.price ?? null,
    source: hostnameOf(finalUrl),
  };
}

// ---- сеть -------------------------------------------------------------

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': DEFAULT_UA,
        'accept-language': 'ru,ru-RU;q=0.9,en;q=0.8',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        // Только то, что умеет разжать undici. Иначе (напр. Я.Маркет с zstd)
        // res.text() отдаёт mojibake, и в вишлист улетает битый заголовок.
        'accept-encoding': 'gzip, deflate, br',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function pickRedirectTarget(res, originalUrl) {
  if (!res) return null;
  const loc = safeHeaderGet(res, 'location');
  if (loc && loc !== originalUrl) return loc;
  if (res.url && res.url !== originalUrl && (res.redirected || isRedirectStatus(res.status))) {
    return res.url;
  }
  return null;
}

function safeHeaderGet(res, name) {
  try {
    return res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null;
  } catch {
    return null;
  }
}

function isRedirectStatus(status) {
  return typeof status === 'number' && status >= 300 && status < 400;
}

// ---- Wildberries basket-CDN ------------------------------------------

// Артикул (nm) из ссылки WB: /catalog/<nm>/detail.aspx либо ?card=/?nm=.
function wbArticleFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)wildberries\.ru$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/catalog\/(\d{3,})\//i);
    if (m) return m[1];
    const q = u.searchParams.get('card') || u.searchParams.get('nm');
    return q && /^\d{3,}$/.test(q) ? q : null;
  } catch {
    return null;
  }
}

// Карточка WB из статического basket-CDN. Хост basket-NN зависит от vol и меняется
// по мере роста WB, поэтому перебираем, пока card.json не отдаст 200. Возвращает
// name/description/фото (цены в card.json нет - она в закрытом card.wb.ru).
async function parseWildberries(url, fetchImpl, timeoutMs) {
  const nm = wbArticleFromUrl(url);
  if (!nm) return null;
  const n = Number(nm);
  const vol = Math.floor(n / 1e5);
  const part = Math.floor(n / 1e3);
  const per = Math.min(timeoutMs, 7000);
  for (let i = 1; i <= 24; i++) {
    const host = `basket-${String(i).padStart(2, '0')}.wbbasket.ru`;
    const base = `https://${host}/vol${vol}/part${part}/${nm}`;
    let card;
    try {
      const res = await fetchWithTimeout(fetchImpl, `${base}/info/ru/card.json`, per);
      if (!res || !res.ok || typeof res.json !== 'function') continue;
      card = await res.json();
    } catch {
      continue; // не тот basket / битый json - пробуем следующий
    }
    if (!card || typeof card !== 'object' || (!card.imt_name && !card.subj_name)) continue;
    const title = cleanText(card.imt_name) || cleanText(card.subj_name);
    const count = Math.max(1, Math.min(Number(card.media?.photo_count) || 1, MAX_PHOTOS));
    const photos = [];
    for (let p = 1; p <= count; p++) photos.push(`${base}/images/big/${p}.webp`);
    return {
      ok: true,
      url,
      title: title || null,
      description: cleanText(card.description) || null,
      photos,
      price: null,
      source: 'wildberries.ru',
    };
  }
  return null;
}

// ---- капча / короткие ссылки ------------------------------------------

function extractRetpathSlug(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string' || !pageUrl.includes('retpath=')) return null;
  let u;
  try {
    u = new URL(pageUrl);
  } catch {
    return null;
  }
  const retpath = u.searchParams.get('retpath');
  if (!retpath) return null;

  // Я.Маркет добавляет к base64 хвост-подпись «,,_<hex>» - его нельзя скармливать
  // декодеру, иначе лишние байты приклеиваются к URL и слаг превращается в мусор.
  // Берём только ведущий кусок из алфавита base64/base64url.
  const b64 = (retpath.match(/^[A-Za-z0-9+/\-_]+={0,2}/) || [])[0] || retpath;
  let target = cleanDecodedUrl(base64Decode(b64));
  if (!target || !/^https?:\/\//i.test(target)) {
    // Иногда retpath - обычный url-encoded адрес, а не base64.
    try {
      target = cleanDecodedUrl(decodeURIComponent(retpath));
    } catch {
      target = null;
    }
  }
  if (!target || !/^https?:\/\//i.test(target)) return null;

  const title = titleFromSlug(target);
  return title ? { title, target } : null;
}

// URL всегда ASCII (не-ASCII в нём процент-кодирован). Обрезаем на первом
// не-печатном/не-ASCII байте - так отсекается мусор от неверно декодированного
// base64-хвоста, не трогая нормальные адреса.
function cleanDecodedUrl(s) {
  if (!s) return null;
  const cut = s.replace(/[^\x20-\x7E].*$/s, '').trim();
  return cut || null;
}

function base64Decode(str) {
  try {
    return Buffer.from(str, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function titleFromSlug(rawUrl) {
  try {
    const { pathname } = new URL(rawUrl);
    const segments = pathname.split('/').filter(Boolean).map(decodeSegment);
    if (!segments.length) return null;
    let slug = segments[segments.length - 1];
    // Я.Маркет и подобные выносят числовой ID товара в отдельный сегмент пути -
    // в этом случае содержательный слаг лежит на сегмент выше.
    if (/^\d+$/.test(slug) && segments.length > 1) {
      slug = segments[segments.length - 2];
    }
    slug = slug.replace(/^product-*/i, ''); // префикс вида "product--" (Я.Маркет)
    slug = slug.replace(/-\d{5,}$/, ''); // числовой SKU/ID, приклеенный в хвосте (Ozon)
    slug = slug.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!slug) return null;
    return slug.charAt(0).toUpperCase() + slug.slice(1);
  } catch {
    return null;
  }
}

function decodeSegment(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function hostnameOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '');
  } catch {
    return null;
  }
}

// ---- разбор HTML --------------------------------------------------------

function extractFromHtml(html, baseUrl) {
  const product = productFromJsonLd(html);
  const ldTitle = cleanText(product?.name);
  const ldDesc = cleanText(product?.description);
  const ldImages = imagesFromJsonLd(product);
  const ldPrice = priceFromJsonLd(product);

  const ogTitle = firstMeta(html, ['property'], 'og:title');
  const ogDesc = firstMeta(html, ['property'], 'og:description');
  const ogImages = [
    ...metaContents(html, ['property'], 'og:image'),
    ...metaContents(html, ['property'], 'og:image:secure_url'),
  ];
  const ogPriceRaw = firstMeta(html, ['property'], 'product:price:amount');

  const twTitle = firstMeta(html, ['name', 'property'], 'twitter:title');
  const twDesc = firstMeta(html, ['name', 'property'], 'twitter:description');
  const twImages = metaContents(html, ['name', 'property'], 'twitter:image');

  // Все кандидаты гоним через cleanText: og/twitter брались сырыми, поэтому
  // битый (недекодированный) заголовок мог просочиться в вишлист.
  const title = tidyProductTitle(ldTitle || cleanText(ogTitle) || cleanText(twTitle) || cleanText(plainTitleTag(html)));
  const description =
    ldDesc || cleanText(ogDesc) || cleanText(twDesc) || cleanText(firstMeta(html, ['name'], 'description'));
  const price = ldPrice ?? numericPrice(ogPriceRaw);
  const photos = normalizePhotos([...ldImages, ...ogImages, ...twImages], baseUrl);

  return { title, description, photos, price };
}

// ---- JSON-LD -------------------------------------------------------------

function parseJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // Некоторые магазины кладут в один блок битый/составной JSON - пропускаем, best-effort.
    }
  }
  return blocks;
}

function findProduct(node, depth = 0) {
  if (!node || depth > 4) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProduct(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  if (types.some((t) => typeof t === 'string' && t.toLowerCase() === 'product')) {
    return node;
  }
  if (node['@graph']) {
    const found = findProduct(node['@graph'], depth + 1);
    if (found) return found;
  }
  return null;
}

function productFromJsonLd(html) {
  for (const block of parseJsonLd(html)) {
    const product = findProduct(block);
    if (product) return product;
  }
  return null;
}

function imagesFromJsonLd(product) {
  if (!product || !product.image) return [];
  const img = Array.isArray(product.image) ? product.image : [product.image];
  return img.map((it) => (typeof it === 'string' ? it : it?.url || it?.contentUrl)).filter(Boolean);
}

function priceFromJsonLd(product) {
  if (!product || !product.offers) return null;
  const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
  const raw = offers?.price ?? offers?.priceSpecification?.price ?? offers?.lowPrice;
  return numericPrice(raw);
}

// ---- meta / og / twitter --------------------------------------------------

function metaContents(html, attrNames, keyValue) {
  const out = [];
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const keyMatch = attrNames
      .map((attr) => tag.match(new RegExp(attr + '\\s*=\\s*["\']([^"\']+)["\']', 'i')))
      .find(Boolean);
    if (!keyMatch || keyMatch[1].toLowerCase() !== keyValue.toLowerCase()) continue;
    const contentMatch = tag.match(/content\s*=\s*["']([^"']*)["']/i);
    if (contentMatch) out.push(decodeHtmlEntities(contentMatch[1]).trim());
  }
  return out.filter(Boolean);
}

function firstMeta(html, attrNames, keyValue) {
  return metaContents(html, attrNames, keyValue)[0] || null;
}

function plainTitleTag(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeHtmlEntities(m[1]) : null;
}

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Срезаем маркетинговые/шаблонные хвосты из заголовка товара:
// «… – купить на Яндекс Маркете, undefined», «… | OZON» и т.п. Если срезали всё -
// возвращаем исходное (перестраховка от слишком жадного шаблона).
function tidyProductTitle(s) {
  if (!s) return s;
  let t = String(s);
  // NB: \b с кириллицей в JS не работает - границы слова тут не используем.
  t = t.replace(/,?\s*undefined\s*$/i, ''); // битый JS-шаблон Я.Маркета: "…, undefined"
  t = t.replace(/\s*[–—-]\s*купить\s.*$/iu, ''); // "… – купить на … Маркете" (дефис перед словом)
  t = t.replace(/\s*[|–—]\s*(Яндекс\s*Маркет|OZON|Ozon|Wildberries|AliExpress|АлиЭкспресс).*$/iu, '');
  t = t.trim();
  return t || s;
}

function cleanText(v) {
  if (v == null) return null;
  const s = decodeHtmlEntities(String(v)).replace(/\s+/g, ' ').trim();
  if (!s || looksGarbled(s)) return null;
  return s;
}

// Признак «текст не декодировался» - символы-замены U+FFFD или управляющие байты
// (появляются, когда тело пришло в незнакомой компрессии/кодировке и read() выдал
// мусор). Такой заголовок нельзя показывать - лучше упасть на слаг из URL.
function looksGarbled(s) {
  let bad = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // U+FFFD (символ-замена при неудачном декоде) или управляющий байт,
    // кроме \t \n \r - в нормальном заголовке товара их не бывает.
    if (c === 0xfffd || (c < 0x20 && c !== 9 && c !== 10 && c !== 13)) bad++;
  }
  if (!bad) return false;
  return bad >= 2 || bad / s.length > 0.05;
}

function numericPrice(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const cleaned = String(raw).replace(/[^\d.,]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ---- фото ------------------------------------------------------------

function normalizePhotos(urls, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const raw of urls) {
    if (!raw) continue;
    let abs;
    try {
      abs = new URL(raw, baseUrl).toString();
    } catch {
      continue;
    }
    abs = abs.replace(/^http:\/\//i, 'https://'); // форсим https
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
    if (out.length >= MAX_PHOTOS) break;
  }
  return out;
}
