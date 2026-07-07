// Курсы валют: API ЦБ РФ (без ключей), кэш на час.

const CBR_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';

const NAMES = {
  доллар: 'USD', бакс: 'USD', usd: 'USD', '$': 'USD',
  евро: 'EUR', eur: 'EUR', '€': 'EUR',
  юан: 'CNY', cny: 'CNY',
  тенге: 'KZT', kzt: 'KZT',
  лир: 'TRY', try: 'TRY',
  дирхам: 'AED', aed: 'AED',
  фунт: 'GBP', gbp: 'GBP',
  франк: 'CHF', chf: 'CHF',
  иен: 'JPY', йен: 'JPY', jpy: 'JPY',
  гривн: 'UAH', uah: 'UAH',
  белорусск: 'BYN', byn: 'BYN',
};

let cache = { at: 0, rates: null };

export async function fetchRates() {
  if (cache.rates && Date.now() - cache.at < 3600000) return cache.rates;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(CBR_URL, { signal: controller.signal });
    if (!res.ok) throw new Error('CBR HTTP ' + res.status);
    const data = await res.json();
    cache = { at: Date.now(), rates: data.Valute };
    return cache.rates;
  } finally {
    clearTimeout(timer);
  }
}

// Код валюты из русской фразы, null если не найден.
export function currencyCode(text) {
  const t = String(text).toLowerCase().replace(/ё/g, 'е');
  for (const [name, code] of Object.entries(NAMES)) {
    if (t.includes(name)) return code;
  }
  return null;
}

// Рубли за единицу валюты (Nominal бывает 10/100 - у иен, тенге).
export function rubPerUnit(rates, code) {
  const v = rates?.[code];
  if (!v) return null;
  return v.Value / v.Nominal;
}

// Ответ на «курс доллара» / «300$ в рублях».
export async function currencyReply(query) {
  const code = currencyCode(query);
  if (!code) return 'Такую валюту не знаю. Понимаю доллар, евро, юань, тенге, лиру, фунт и другие основные.';
  const rates = await fetchRates();
  const rate = rubPerUnit(rates, code);
  if (!rate) return 'Не нашёл курс у ЦБ. Попробуй позже?';
  const rateStr = rate.toFixed(2).replace('.', ',');

  const am = String(query).replace(/\s/g, '').match(/(\d+(?:[.,]\d+)?)/);
  if (am) {
    const amount = Number(am[1].replace(',', '.'));
    if (amount > 0) {
      const rub = amount * rate;
      const rubStr = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(rub);
      return `${new Intl.NumberFormat('ru-RU').format(amount)} ${code} ≈ ${rubStr} ₽ (курс ЦБ ${rateStr} ₽)`;
    }
  }
  return `${code} по ЦБ: ${rateStr} ₽`;
}
