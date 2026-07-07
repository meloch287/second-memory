import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { parseTgExport, importIntoStore } from '../src/importchat.mjs';

delete process.env.SM_ENCRYPTION_KEY;
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'sm-imp-')), 'memory.json');

const EXPORT = {
  name: 'Наша группа',
  type: 'private_supergroup',
  id: 123,
  messages: [
    { id: 1, type: 'service', date: '2025-01-01T10:00:00', actor: 'Саша', action: 'create_group' },
    { id: 2, type: 'message', date: '2025-01-01T10:05:00', from: 'Саша', from_id: 'user111222333', text: 'скидываемся на сервер по 1000' },
    { id: 3, type: 'message', date: '2025-01-02T11:00:00', from: 'Nikita', from_id: 'user482961058', text: [{ type: 'bold', text: 'я скинул' }, ' вчера'] },
    { id: 4, type: 'message', date: '2025-01-03T12:00:00', from: 'Дима', from_id: 'user777', text: '', photo: 'photo.jpg' },
    { id: 5, type: 'message', date: '2025-01-04T13:00:00', from: 'Дима', from_id: 'user777', text: 'созвон каждый понедельник в 10' },
  ],
};

test('parseTgExport: сообщения, склейка кусков, скип service и пустых', () => {
  const p = parseTgExport(Buffer.from(JSON.stringify(EXPORT)));
  assert.equal(p.messages.length, 3, 'service и фото без текста пропущены');
  assert.equal(p.messages[0].author, 'Саша');
  assert.equal(p.messages[0].authorId, '111222333');
  assert.equal(p.messages[1].text, 'я скинул вчера', 'массив кусков склеен');
  assert.ok(p.messages[0].ts.startsWith('2025-01-01'), 'дата из экспорта');
});

test('parseTgExport: не-экспорт возвращает null', () => {
  assert.equal(parseTgExport(Buffer.from('{"foo": 1}')), null);
  assert.equal(parseTgExport(Buffer.from('не json вообще')), null);
  assert.equal(parseTgExport(Buffer.from(JSON.stringify({ messages: [] }))), null);
});

test('importIntoStore: raw одной пачкой, участники в реестр, живое не вытесняется', () => {
  const s = new Store(tmpFile());
  const G = '-100999';
  s.setUser(G, { isGroup: true, name: 'Группа', members: { 482961058: { name: 'Никита', username: 'pxpusk' } } });
  s.addRaw(G, 'Саня: живое сообщение после добавления бота');

  const p = parseTgExport(Buffer.from(JSON.stringify(EXPORT)));
  const r = importIntoStore(s, G, p);
  assert.equal(r.count, 3);
  assert.equal(r.first, '2025-01-01');
  assert.equal(r.last, '2025-01-04');

  const raws = s.data.raw.filter((x) => x.chatId === G);
  assert.equal(raws.length, 4, '3 импортированных + 1 живое');
  assert.ok(raws[raws.length - 1].text.includes('живое'), 'живое в конце (импорт вставлен в начало)');
  assert.match(raws[0].text, /^Саша: скидываемся/, 'автор в тексте');
  assert.equal(raws[0].processed, false, 'воркер переварит импорт');

  const m = s.getUser(G).members;
  assert.equal(m['111222333'].name, 'Саша', 'новый участник добавлен');
  assert.equal(m['777'].name, 'Дима');
  assert.equal(m['482961058'].username, 'pxpusk', 'существующий не перетёрт');
});
