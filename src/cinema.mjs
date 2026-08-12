// Афиша кино по городу - НАСТОЯЩАЯ, со страницы расписания afisha.ru.
//
// Живой случай, из-за которого это появилось: Аня спросила, что идёт в кино.
// Бот ответил «щас поищу», потом «сайтам нужно время загрузиться», три с
// половиной часа тянул, а в итоге выдал выдуманный список («я специально
// смотрел, что в прокате»). Поиска у него не было вовсе.
//
// Теперь либо реальные данные, либо честное «не смог» - но не выдумка.
// Ходим тем же headless-Chromium, что и вишлист: своих зависимостей не тянем.

const CITY_SLUG = {
  москва: 'msk',
  мск: 'msk',
  питер: 'spb',
  'санкт-петербург': 'spb',
  спб: 'spb',
  екатеринбург: 'ekb',
  'нижний новгород': 'nn',
  'ростов-на-дону': 'rostov',
};

// Город -> слаг в урле. Для большинства городов afisha.ru использует
// транслитерацию названия, поэтому общий случай транслитерируем сами.
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function citySlug(city) {
  const c = String(city || '').trim().toLowerCase().replace(/ё/g, 'е');
  if (!c) return null;
  if (CITY_SLUG[c]) return CITY_SLUG[c];
  return [...c].map((ch) => (ch === ' ' || ch === '-' ? '-' : TRANSLIT[ch] ?? (/[a-z0-9]/.test(ch) ? ch : ''))).join('') || null;
}

export const scheduleUrl = (city) => {
  const slug = citySlug(city);
  return slug ? `https://www.afisha.ru/${slug}/schedule_cinema/` : null;
};

// Строка карточки: «Холоп 3 2026, Приключение 7.6» -> разбираем на части.
export function parseCard(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s || s.length < 3) return null;
  const m = s.match(/^(.{2,80}?)\s+((?:19|20)\d{2}),\s*([А-ЯЁа-яё-]+)(?:\s+([\d.]+))?/);
  if (!m) return null;
  const [, title, year, genre, rating] = m;
  if (/^(?:фильмотека|кино|билеты|подборк)/i.test(title)) return null;
  return {
    title: title.trim(),
    year: Number(year),
    genre: genre.toLowerCase(),
    rating: rating ? Number(rating) : null,
  };
}

// Что идёт в кино в этом городе. launcher инъектируется в тестах.
export async function cinemaToday(city, { launcher = null, limit = 10 } = {}) {
  const url = scheduleUrl(city);
  if (!url) return null;
  const launch =
    launcher ||
    (async () => {
      const { chromium } = await import('playwright');
      // --no-proxy-server обязателен: сервис стартует с HTTPS_PROXY (европейский
      // выход), а российские сайты должны браться прямым РФ-адресом.
      return chromium.launch({ headless: true, args: ['--no-proxy-server', '--no-sandbox'] });
    });

  let browser;
  try {
    browser = await launch();
    const page = await browser.newPage({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
      locale: 'ru-RU',
    });
    // networkidle тут не дожидается никогда - на странице живут баннеры
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!res || res.status() >= 400) return null;
    await page.waitForTimeout(5000);
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('a[href*="/movie/"]')].map((a) => (a.innerText || '').replace(/\s+/g, ' ').trim())
    );
    const seen = new Set();
    const films = [];
    for (const c of cards) {
      const f = parseCard(c);
      if (!f || seen.has(f.title.toLowerCase())) continue;
      seen.add(f.title.toLowerCase());
      films.push(f);
      if (films.length >= limit) break;
    }
    return films.length ? { city, url, films } : null;
  } catch {
    return null;
  } finally {
    try { await browser?.close(); } catch {}
  }
}

// Готовый текст для чата. Жанр фильтруется по просьбе («фантастика, мультики»).
export function cinemaText(data, wantGenres = []) {
  if (!data?.films?.length) return null;
  const want = wantGenres.map((g) => String(g).toLowerCase());
  const match = (f) => !want.length || want.some((g) => f.genre.startsWith(g.slice(0, 5)));
  const picked = data.films.filter(match);
  const list = (picked.length ? picked : data.films).slice(0, 10);
  const head = picked.length || !want.length ? '' : 'По твоим жанрам ничего не нашёл, вот что вообще идёт:\n\n';
  return (
    `🎬 <b>Что идёт в кино</b> - ${data.city}\n\n` +
    head +
    list.map((f) => `• ${f.title} - ${f.genre}${f.rating ? `, ${f.rating}` : ''}`).join('\n') +
    `\n\n<a href="${data.url}">Расписание сеансов и кинотеатры</a>`
  );
}

// «фантастика и мультики» -> ['фантастика','мультфильм']
const GENRE_WORDS = [
  [/фантастик|фэнтези|sci-?fi/i, 'фантастика'],
  [/мультик|мультфильм|анимаци/i, 'мультфильм'],
  [/комеди|поржать|смешн/i, 'комедия'],
  [/ужас|хоррор|страшн/i, 'ужасы'],
  [/боевик|экшн/i, 'боевик'],
  [/драм/i, 'драма'],
  [/триллер/i, 'триллер'],
  [/детектив/i, 'детектив'],
  [/мелодрам|романтик|про любовь/i, 'мелодрама'],
  [/приключен/i, 'приключение'],
  [/докумен/i, 'документальный'],
  [/биограф/i, 'биография'],
];

export function parseGenres(text) {
  const s = String(text || '');
  return GENRE_WORDS.filter(([re]) => re.test(s)).map(([, g]) => g);
}

// Спрашивают ли про кино. «кинотеатр в Зеленограде» - тоже про это.
export const CINEMA_RE =
  /(?:что|чего|чё)\s+(?:идет|идёт|показывают|в\s+прокате)|(?:в\s+)?кино(?:театр\w*)?(?![а-яё])|афиш[аиуе](?![а-яё])|(?:какие|что за)\s+фильм/i;

// «в городе Зеленоград», «в Зеленограде», «Зеленоград» -> город.
export function parseCity(text) {
  const s = String(text || '');
  const m =
    s.match(/(?:в\s+городе|город)\s+([А-ЯЁ][А-Яа-яЁё-]{2,30})/) ||
    // NB: \b не знает кириллицы - «в Твери» иначе не находится
    s.match(/(?:^|[\s,(])в\s+([А-ЯЁ][А-Яа-яЁё-]{2,30}[еиуы])(?![а-яё])/);
  if (!m) return null;
  return nominativeCity(m[1]);
}

// Предложный падеж -> именительный: «в Твери» -> Тверь, «в Москве» -> Москва,
// «в Зеленограде» -> Зеленоград. Частые города знаем в лицо, остальные - по
// правилу: «-и» это мягкий знак, «-е» у коротких женских имён это «-а».
const CITY_FIX = {
  москве: 'Москва', питере: 'Питер', спб: 'Санкт-Петербург', туле: 'Тула', уфе: 'Уфа',
  самаре: 'Самара', перми: 'Пермь', казани: 'Казань', твери: 'Тверь', рязани: 'Рязань',
  калуге: 'Калуга', вологде: 'Вологда', костроме: 'Кострома', пензе: 'Пенза', курске: 'Курск',
  омске: 'Омск', томске: 'Томск', сочи: 'Сочи', анапе: 'Анапа', ялте: 'Ялта',
};

export function nominativeCity(word) {
  const raw = String(word || '').trim();
  if (!raw) return null;
  const low = raw.toLowerCase().replace(/ё/g, 'е');
  if (CITY_FIX[low]) return CITY_FIX[low];
  const cap = (s) => s.replace(/^(.)/, (c) => c.toUpperCase());
  if (/и$/.test(low)) return cap(low.slice(0, -1) + 'ь');
  if (/е$/.test(low)) return cap(low.length <= 5 ? low.slice(0, -1) + 'а' : low.slice(0, -1));
  return cap(low);
}
