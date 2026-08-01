// Store: счётчик запросов (bumpRequests), статистика личного кабинета (getStats)
// и вишлист (addWish/listWish/wishById/updateWish/removeWish) + очистка при
// wipeMemory/clearChatData.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';

delete process.env.SM_ENCRYPTION_KEY;
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'sm-wishlist-')), 'm.json');

// --- bumpRequests ---

test('bumpRequests: увеличивает счётчик и переживает перезагрузку', () => {
  const file = tmpFile();
  const s = new Store(file);
  assert.equal(s.bumpRequests('1'), 1);
  assert.equal(s.bumpRequests('1'), 2);
  assert.equal(s.bumpRequests('1'), 3);
  s.flush();
  const b = new Store(file);
  assert.equal(b.getUser('1')?.requests, 3);
});

test('bumpRequests: безопасен без профиля пользователя (создаёт минимальный)', () => {
  const s = new Store(tmpFile());
  assert.equal(s.getUser('9'), null);
  s.bumpRequests('9');
  assert.equal(s.getUser('9')?.requests, 1);
});

// --- setUser: createdAt на первом создании ---

test('setUser: на первом создании профиля проставляет createdAt, дальше не трогает', () => {
  const s = new Store(tmpFile());
  assert.equal(s.getUser('1'), null);
  const before = Date.now();
  s.setUser('1', { name: 'Саня' });
  const u = s.getUser('1');
  assert.ok(u.createdAt, 'createdAt проставлен');
  assert.ok(Date.parse(u.createdAt) >= before - 1000);
  const firstCreatedAt = u.createdAt;
  s.setUser('1', { name: 'Саша' });
  assert.equal(s.getUser('1').createdAt, firstCreatedAt, 'повторный setUser не затирает createdAt');
});

// --- getStats ---

test('getStats: считает запросы/факты/долги/задачи/встречи/вишлист изолированно по чатам', () => {
  const s = new Store(tmpFile());
  s.bumpRequests('1');
  s.bumpRequests('1');
  s.add({ chatId: '1', type: 'debt', counterparty: 'Дима', amount: 100, direction: 'in' });
  s.add({ chatId: '1', type: 'debt', counterparty: 'Он', amount: 50, direction: 'out', status: 'closed' });
  s.add({ chatId: '1', type: 'task', title: 'дело1' });
  s.add({ chatId: '1', type: 'task', title: 'дело2', status: 'done' });
  s.add({ chatId: '1', type: 'meeting', title: 'встреча' });
  s.addFacts([{ chatId: '1', text: 'ф1' }, { chatId: '1', text: 'ф2' }]);
  s.addWish('1', { title: 'подарок1' });
  s.addWish('1', { title: 'подарок2' });

  // чужой чат не должен влиять
  s.bumpRequests('2');
  s.add({ chatId: '2', type: 'debt', counterparty: 'Кто-то', amount: 10, direction: 'in' });
  s.addFacts([{ chatId: '2', text: 'чужой факт' }]);
  s.addWish('2', { title: 'чужой подарок' });

  const stats = s.getStats('1');
  assert.equal(stats.requests, 2);
  assert.equal(stats.facts, 2);
  assert.equal(stats.openDebts, 1);
  assert.equal(stats.openTasks, 1);
  assert.equal(stats.openMeetings, 1);
  assert.equal(stats.wishlist, 2);
  assert.equal(typeof stats.days, 'number');
  assert.ok(stats.days >= 0);

  const other = s.getStats('2');
  assert.equal(other.requests, 1);
  assert.equal(other.facts, 1);
  assert.equal(other.openDebts, 1);
  assert.equal(other.openTasks, 0);
  assert.equal(other.wishlist, 1);
});

test('getStats: для совсем неизвестного чата — все нули', () => {
  const s = new Store(tmpFile());
  const stats = s.getStats('ghost');
  assert.deepEqual(stats, { requests: 0, facts: 0, openDebts: 0, openTasks: 0, openMeetings: 0, wishlist: 0, days: 0 });
});

test('getStats: days считает по самому раннему сырому сообщению, если профиля/createdAt нет', () => {
  const s = new Store(tmpFile());
  const oldTs = new Date(Date.now() - 3 * 86400000 - 3600000).toISOString(); // ~3 дня назад
  s.data.raw.push({ id: ++s.data.seq, chatId: '5', text: 'старое', ts: oldTs, processed: false });
  s.data.raw.push({ id: ++s.data.seq, chatId: '5', text: 'новое', ts: new Date().toISOString(), processed: false });
  const stats = s.getStats('5');
  assert.equal(stats.days, 3);
});

test('getStats: days считает по самой ранней записи (entry), если нет ни профиля, ни сырья', () => {
  const s = new Store(tmpFile());
  const e = s.add({ chatId: '6', type: 'task', title: 'дело' });
  e.createdAt = new Date(Date.now() - 5 * 86400000 - 3600000).toISOString();
  const stats = s.getStats('6');
  assert.equal(stats.days, 5);
});

// --- Вишлист: CRUD ---

test('вишлист: add -> list -> update -> get -> remove, персистентность и изоляция по чатам', () => {
  const file = tmpFile();
  const s = new Store(file);
  const item = s.addWish('1', { title: 'Кружка', desc: 'синяя', url: 'http://x', price: 500 });
  assert.equal(item.chatId, '1');
  assert.equal(item.title, 'Кружка');
  assert.deepEqual(item.photos, []);
  assert.equal(item.giftedBy, null);
  assert.ok(item.id);
  assert.ok(item.createdAt);

  s.addWish('2', { title: 'чужое' });

  assert.equal(s.listWish('1').length, 1);
  assert.equal(s.listWish('2').length, 1);

  const updated = s.updateWish(item.id, { price: 700, giftedBy: 'Аня' });
  assert.equal(updated.price, 700);
  assert.equal(updated.giftedBy, 'Аня');
  assert.equal(updated.title, 'Кружка', 'остальные поля не тронуты');

  assert.equal(s.wishById(item.id).price, 700);
  assert.equal(s.wishById(999999), null);

  s.flush();
  const b = new Store(file);
  assert.equal(b.wishById(item.id)?.price, 700, 'переживает перезагрузку');
  assert.equal(b.listWish('1').length, 1);
  assert.equal(b.listWish('2').length, 1, 'чужой чат не задет');

  const removed = s.removeWish(item.id);
  assert.equal(removed.id, item.id);
  assert.equal(s.wishById(item.id), null);
  assert.equal(s.listWish('1').length, 0);
  assert.equal(s.listWish('2').length, 1, 'чужой чат не задет удалением');
  assert.equal(s.removeWish(999999), null);
});

test('вишлист: сохраняет порядок вставки', () => {
  const s = new Store(tmpFile());
  s.addWish('1', { title: 'первое' });
  s.addWish('1', { title: 'второе' });
  s.addWish('1', { title: 'третье' });
  const list = s.listWish('1');
  assert.deepEqual(list.map((w) => w.title), ['первое', 'второе', 'третье']);
});

// --- Очистка вишлиста вместе с остальной памятью чата ---

test('wipeMemory: тоже стирает вишлист чата, чужой не трогает', () => {
  const s = new Store(tmpFile());
  s.addWish('1', { title: 'моё' });
  s.addWish('2', { title: 'чужое' });
  s.wipeMemory('1');
  assert.equal(s.listWish('1').length, 0);
  assert.equal(s.listWish('2').length, 1);
});

test('clearChatData: тоже стирает вишлист чата, чужой не трогает', () => {
  const s = new Store(tmpFile());
  s.addWish('1', { title: 'моё' });
  s.addWish('2', { title: 'чужое' });
  s.clearChatData('1');
  assert.equal(s.listWish('1').length, 0);
  assert.equal(s.listWish('2').length, 1);
});
