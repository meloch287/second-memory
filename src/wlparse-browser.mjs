// Разбор товарной ссылки РЕАЛЬНЫМ браузером (Playwright) - фолбэк, когда быстрый
// zero-dep fetch из wlparse.mjs упёрся в антибот/JS-рендер (напр. Я.Маркет отдаёт
// капчу обычному fetch, но реальному браузеру - настоящую карточку).
//
// ВАЖНО про архитектуру:
//   - playwright импортируется ЛЕНИВО (dynamic import внутри функции). Если пакета
//     нет (локалка/тесты/локальный dev - проект zero-dependency), функция просто
//     вернёт { ok:false }, ничего не ломая. Ставится только на проде.
//   - launcher инъектируется (opts.launch) -> тесты гоняют фейковый браузер без
//     установленного playwright, как и остальной код тут (createLkHandler и пр.).
//   - НИКОГДА не бросает наружу: любая ошибка -> { ok:false, url, error }.
//   - НЕ обходит защиту: без стелс-патчей/прокси/решения капчи. Упёрлись в капчу
//     или страницу-заглушку - честно возвращаем ok:false, ЛК уходит на ручной ввод.
//     (Ozon/WB режут по IP дата-центра и в браузере - там тоже будет ok:false.)

import { parseRenderedHtml } from './wlparse.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// URL капчи/челленджа - решать не будем, это обход защиты.
const CHALLENGE_URL = /showcaptcha|\/captcha|captcha\?|\/checkcaptcha/i;
// Заголовки страниц-заглушек антибота / 404 - не товар.
const DEAD_TITLE =
  /нет такой страницы|похоже, нет соединения|доступ ограничен|страница не найдена|ничего не найдено|are you a robot|проверка безопасности|captcha/i;

let _browserP = null;

async function defaultLaunch() {
  // Нет playwright -> import бросит -> вызывающий получит ok:false. Так и задумано.
  const { chromium } = await import('playwright');
  return chromium.launch({
    headless: true,
    // --no-proxy-server ОБЯЗАТЕЛЕН: сервис в проде стартует с HTTPS_PROXY (xray,
    // европейский выход) для Telegram, а Chromium на Linux наследует https_proxy
    // из окружения. Маркетплейсы пробиваются только прямым соединением с RU-IP
    // сервера (как в ручной пробе) - поэтому Chromium гоним в обход прокси.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
  });
}

// Синглтон-браузер (только для дефолтного лаунчера в проде): держим один процесс
// chromium и переиспользуем контексты - запуск браузера ~1с, на каждый парс дорого.
function cachedBrowser() {
  if (!_browserP) {
    _browserP = defaultLaunch()
      .then((b) => {
        if (typeof b.on === 'function') b.on('disconnected', () => { _browserP = null; });
        registerShutdown();
        return b;
      })
      .catch((e) => {
        _browserP = null;
        throw e;
      });
  }
  return _browserP;
}

let _shutdownHooked = false;
function registerShutdown() {
  if (_shutdownHooked) return;
  _shutdownHooked = true;
  for (const sig of ['SIGINT', 'SIGTERM', 'exit']) {
    try { process.once(sig, () => { closeBrowser(); }); } catch {}
  }
}

export async function closeBrowser() {
  const p = _browserP;
  _browserP = null;
  if (!p) return;
  try {
    const b = await p;
    await b.close();
  } catch {}
}

/**
 * Распарсить товар реальным браузером. Никогда не бросает.
 * @param {string} url
 * @param {{launch?: () => Promise<any>, timeoutMs?: number}} [opts]
 *   launch - фабрика браузера (по умолчанию ленивый playwright-синглтон).
 * @returns {Promise<object>} тот же shape, что parseProduct (ok:true|false).
 */
export async function parseProductBrowser(url, { launch, timeoutMs = 22000 } = {}) {
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false, url: typeof url === 'string' ? url : '', error: 'bad_url' };
  }

  const useCache = !launch; // прод-путь (дефолтный лаунчер) кэшируем; тестовый - нет.
  let browser;
  try {
    browser = useCache ? await cachedBrowser() : await launch();
  } catch {
    // playwright не установлен либо браузер не поднялся - тихо уходим на ручной ввод.
    return { ok: false, url, error: 'browser_unavailable' };
  }

  let ctx;
  try {
    ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1366, height: 900 }, userAgent: UA });
    const page = await ctx.newPage();
    let resp = null;
    try {
      resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch {
      return { ok: false, url, error: 'nav_error' };
    }
    // Дать SPA дорисовать карточку (og/JSON-LD подставляются скриптами).
    try { await page.waitForTimeout(2500); } catch {}

    const finalUrl = typeof page.url === 'function' ? page.url() : url;
    if (CHALLENGE_URL.test(finalUrl)) {
      return { ok: false, url, error: 'challenge' };
    }

    let html = '';
    try { html = await page.content(); } catch { return { ok: false, url, error: 'read_error' }; }

    const parsed = parseRenderedHtml(html, finalUrl);
    if (!parsed.ok) return { ok: false, url, error: parsed.error || 'no_data' };
    if (DEAD_TITLE.test(parsed.title || '')) {
      return { ok: false, url, error: 'not_found' };
    }
    return { ...parsed, url };
  } catch {
    return { ok: false, url, error: 'browser_error' };
  } finally {
    try { await ctx?.close(); } catch {}
    if (!useCache) {
      try { await browser?.close?.(); } catch {}
    }
  }
}
