import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { parseMessage, parseExpense } from '../src/parser.mjs';
import { expensesReport } from '../src/finance.mjs';

const NOW = new Date('2026-07-06T09:00:00.000Z');
function tmpFile() {
  return join(mkdtempSync(join(tmpdir(), 'sm-b3-')), 'memory.json');
}

/* №12 Шифрование */
test('шифрование: файл нечитаем без ключа, читается с ключом, миграция', () => {
  const file = tmpFile();
  process.env.SM_ENCRYPTION_KEY = 'test-secret-key';
  try {
    const s = new Store(file);
    s.add({ type: 'note', title: 'секрет', text: 'очень личное', chatId: '1' });
    const raw = readFileSync(file);
    assert.ok(raw.subarray(0, 6).toString() === 'SMENC1', 'файл начинается с маркера шифрования');
    assert.ok(!raw.toString('utf8').includes('очень личное'), 'открытого текста в файле нет');
    // перечитываем с тем же ключом
    const s2 = new Store(file);
    assert.equal(s2.list({ chatId: '1' })[0].text, 'очень личное');
  } finally {
    delete process.env.SM_ENCRYPTION_KEY;
  }
});

test('шифрование: без ключа - обычный JSON (обратная совместимость)', () => {
  const file = tmpFile();
  const s = new Store(file);
  s.add({ type: 'note', title: 'тест', chatId: '1' });
  const raw = readFileSync(file, 'utf8');
  assert.ok(raw.trimStart().startsWith('{'), 'без ключа - открытый JSON');
});

/* №2 Поправить память */
test('parser: забыть / поправить', () => {
  assert.deepEqual(parseMessage('забудь про Петрова', NOW), { kind: 'forget', target: 'Петрова' });
  assert.equal(parseMessage('это не так', NOW).kind, 'correct');
  assert.equal(parseMessage('нет, я такого не говорил', NOW).kind, 'correct');
});

test('removeFactsMatching / removeRecentFacts', () => {
  const s = new Store(tmpFile());
  s.addFacts([
    { chatId: '1', text: 'Поругался с Петровым', people: ['Петров'] },
    { chatId: '1', text: 'Купил молоко' },
    { chatId: '2', text: 'Петров чужой' },
  ]);
  const n = s.removeFactsMatching('1', 'Петров');
  assert.equal(n, 1, 'удалён один факт про Петрова у чата 1');
  assert.equal(s.data.facts.filter((f) => f.chatId === '1').length, 1);
  assert.equal(s.data.facts.filter((f) => f.chatId === '2').length, 1, 'чужой факт не тронут');
  // забыть последнее
  s.addFacts([{ chatId: '1', text: 'последняя мысль' }]);
  assert.equal(s.removeRecentFacts('1', 1), 1);
  assert.ok(!s.data.facts.some((f) => f.text === 'последняя мысль'));
});

/* №7 Траты */
test('parseExpense: сумма и категория', () => {
  const e = parseExpense('потратил 2000 на бензин', 'потратил 2000 на бензин');
  assert.equal(e.kind, 'expense');
  assert.equal(e.amount, 2000);
  assert.equal(e.category, 'Бензин');
  const e2 = parseExpense('купил кофе за 300', 'купил кофе за 300');
  assert.equal(e2.amount, 300);
  assert.match(e2.category, /кофе/i);
  assert.equal(parseExpense('встреча завтра', 'встреча завтра'), null, 'не трата');
  // женские формы: окончание не должно уползать в категорию (e2e-находка)
  const f = parseExpense('потратила 2000 на бензин', 'потратила 2000 на бензин');
  assert.equal(f.category, 'Бензин', 'без хвоста «А »');
  assert.equal(parseExpense('заплатила 1500 за маникюр', 'заплатила 1500 за маникюр').category, 'Маникюр');
});

test('parseMessage: трата не путается с записью', () => {
  assert.equal(parseMessage('потратил 500 на такси', NOW).kind, 'expense');
  assert.equal(parseMessage('я должен Пете 500', NOW).kind, 'entry'); // долг, не трата
});

test('expensesReport: сумма по категориям за месяц', () => {
  const s = new Store(tmpFile());
  const now = Date.parse('2026-07-15T12:00:00Z');
  s.add({ type: 'expense', category: 'Бензин', amount: 2000, chatId: '1', createdAt: '2026-07-05T10:00:00Z', status: 'done' });
  s.add({ type: 'expense', category: 'Кофе', amount: 300, chatId: '1', createdAt: '2026-07-10T10:00:00Z', status: 'done' });
  s.add({ type: 'expense', category: 'Старое', amount: 999, chatId: '1', createdAt: '2026-06-01T10:00:00Z', status: 'done' }); // прошлый месяц
  const r = expensesReport(s, '1', 180, now);
  assert.match(r, /Бензин/);
  assert.match(r, /Кофе/);
  assert.ok(!r.includes('Старое'), 'прошлый месяц не входит');
  assert.match(r, /2.300/, 'сумма за месяц 2300');
});

/* №9 Голос по запросу */
test('parser: голос-тумблер и разово', () => {
  assert.deepEqual(parseMessage('отвечай голосом', NOW), { kind: 'setvoice', on: true });
  assert.deepEqual(parseMessage('отвечай текстом', NOW), { kind: 'setvoice', on: false });
  assert.equal(parseMessage('ответь голосовым', NOW).kind, 'voiceonce');
  assert.equal(parseMessage('скажи это голосом', NOW).kind, 'voiceonce');
});
