// Медиа-кластер: скачивание файлов из Telegram, отправка фото/войсов/документов,
// расшифровка аудио и видео (ffmpeg), описание картинок, чтение документов.
// Фабрика: все внешние зависимости приходят из telegram.mjs (тот же приём,
// что уже используется в group.mjs).

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioEnabled, aiTranscribe, aiDescribeImage, aiSummarizeDoc, aiSummarizeText, aiExtractReceipt } from './ai.mjs';
import { extractDocxText } from './docx.mjs';
import { RUB } from './format.mjs';
import { esc, hasFfmpeg } from './telegram-helpers.mjs';

export function createMediaHandlers(deps) {
  const { token, api, activeThread, store, send, log, withTyping, friendFlow, handleIntent, onboardingStep } = deps;

  async function downloadBase64(file_id) {
    const info = await api('getFile', { file_id });
    if (!info.ok) throw new Error('getFile failed');
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
    if (!res.ok) throw new Error('file download failed');
    return Buffer.from(await res.arrayBuffer()).toString('base64');
  }

  // Фото (сжатое, как обычная картинка, не документ)
  async function sendPhoto(chat_id, pngBuffer, caption) {
    const form = new FormData();
    form.append('chat_id', String(chat_id));
    const th = activeThread.get(String(chat_id));
    if (th) form.append('message_thread_id', String(th));
    form.append('photo', new Blob([pngBuffer], { type: 'image/png' }), 'chart.png');
    if (caption) form.append('caption', String(caption).slice(0, 1000));
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    return res.json();
  }

  // Отправка голосового: multipart, JSON тут не работает.
  async function sendVoice(chat_id, oggBuffer, caption) {
    const form = new FormData();
    form.append('chat_id', String(chat_id));
    const _th = activeThread.get(String(chat_id));
    if (_th) form.append('message_thread_id', String(_th));
    form.append('voice', new Blob([oggBuffer], { type: 'audio/ogg' }), 'reply.ogg');
    if (caption) form.append('caption', String(caption).slice(0, 1000));
    const res = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, { method: 'POST', body: form });
    return res.json();
  }

  async function sendDocumentText(chatId, content, filename, mime, caption) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    const _th = activeThread.get(String(chatId));
    if (_th) form.append('message_thread_id', String(_th));
    form.append('document', new Blob([content], { type: mime }), filename);
    if (caption) form.append('caption', caption);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
    return res.json();
  }

  // Скачивание и понимание документа (PDF/DOCX/текст) -> краткая суть или null.
  async function readDoc(doc, mime, name) {
    const b64 = await downloadBase64(doc.file_id);
    if (mime === 'application/pdf') return aiSummarizeDoc(b64, mime, name);
    if (name.toLowerCase().endsWith('.docx')) {
      const text = extractDocxText(Buffer.from(b64, 'base64'));
      if (!text) throw new Error('docx: пустой текст');
      return aiSummarizeText(text, name);
    }
    if (mime.startsWith('text/')) return aiSummarizeText(Buffer.from(b64, 'base64').toString('utf8'), name);
    return null;
  }

  // Видео/кружок -> звуковая дорожка -> расшифровка (ffmpeg).
  async function videoTranscript(fileId) {
    const b64 = await downloadBase64(fileId);
    const stamp = Date.now();
    const inFile = join(tmpdir(), `vid-${stamp}.mp4`);
    const outFile = join(tmpdir(), `vid-${stamp}.ogg`);
    try {
      writeFileSync(inFile, Buffer.from(b64, 'base64'));
      const r = spawnSync('ffmpeg', ['-y', '-i', inFile, '-vn', '-acodec', 'libopus', '-b:a', '32k', outFile], {
        stdio: 'ignore',
        timeout: 60000,
      });
      if (r.status !== 0) throw new Error('ffmpeg failed');
      return aiTranscribe(readFileSync(outFile).toString('base64'), 'ogg');
    } finally {
      rmSync(inFile, { force: true });
      rmSync(outFile, { force: true });
    }
  }

  // Длинное аудио режем ffmpeg на куски по 150 сек и расшифровываем по частям.
  async function transcribeLong(b64, format) {
    if (!hasFfmpeg) return null;
    const stamp = Date.now();
    const inFile = join(tmpdir(), `long-${stamp}.${format === 'mp3' ? 'mp3' : 'ogg'}`);
    const outPat = join(tmpdir(), `long-${stamp}-%03d.ogg`);
    const parts = [];
    try {
      writeFileSync(inFile, Buffer.from(b64, 'base64'));
      const r = spawnSync('ffmpeg', ['-y', '-i', inFile, '-f', 'segment', '-segment_time', '150', '-c:a', 'libopus', '-b:a', '32k', outPat], {
        stdio: 'ignore',
        timeout: 120000,
      });
      if (r.status !== 0) return null;
      for (let i = 0; i < 20; i++) {
        const f = join(tmpdir(), `long-${stamp}-${String(i).padStart(3, '0')}.ogg`);
        if (!existsSync(f)) break;
        parts.push(f);
      }
      const texts = [];
      for (const f of parts) {
        const t = await aiTranscribe(readFileSync(f).toString('base64'), 'ogg').catch(() => null);
        if (t) texts.push(t);
      }
      return texts.join(' ').trim() || null;
    } finally {
      rmSync(inFile, { force: true });
      for (const f of parts) rmSync(f, { force: true });
    }
  }

  // Аудио любого вида: голосовое, mp3, аудиофайл документом.
  async function audioFlow(chatId, user, fileId, format, durationSec) {
    if (!audioEnabled()) {
      return send(chatId, 'Голосовые пока не разбираю: нет ключа для расшифровки. Напиши текстом, я всё пойму.');
    }
    const long = (durationSec || 0) > 170;
    if (long && !hasFfmpeg) {
      return send(chatId, 'Запись длинновата, а без ffmpeg на сервере длинное не осилю. Скажи покороче?');
    }
    if ((durationSec || 0) > 20 * 60) {
      return send(chatId, 'Ого, больше двадцати минут - это уже подкаст 🙂 Давай частями?');
    }
    const transcript = await withTyping(chatId, async () => {
      const b64 = await downloadBase64(fileId);
      return long ? transcribeLong(b64, format) : aiTranscribe(b64, format);
    });
    if (!transcript) {
      return send(chatId, 'Я честно слушал, но не расслышал. Скажи ещё раз?');
    }
    if (user?.step) return onboardingStep(chatId, user, transcript);
    // Голосовые команды работают как текстовые: сперва интенты
    // («отвечай голосом», «траты», «забудь», «напомни...»), потом разговор.
    if (await handleIntent(String(chatId), user, transcript)) return;
    return friendFlow(String(chatId), transcript);
  }

  // Картинка (фото, статичный стикер, превью гифки): сначала пробуем распознать
  // чек и записать трату (№8), иначе описываем и запоминаем.
  async function imageFlow(chatId, fileId, label, caption, mime = 'image/jpeg', tryReceipt = false) {
    if (!audioEnabled()) {
      return send(chatId, 'Картинки пока не разглядываю: нет ключа мультимодального ИИ. Расскажи словами?');
    }
    let b64;
    try {
      b64 = await withTyping(chatId, () => downloadBase64(fileId));
    } catch (e) {
      log.error('[telegram] image dl', e.message);
      return send(chatId, 'Не смог скачать картинку. Попробуй ещё раз?');
    }

    if (tryReceipt) {
      const rec = await withTyping(chatId, () => aiExtractReceipt(b64, mime)).catch(() => null);
      if (rec) {
        store.add({ type: 'expense', title: rec.category, category: rec.category, amount: rec.amount, counterparty: rec.merchant, chatId: String(chatId), text: `Чек: ${rec.merchant || rec.category}`, status: 'done' });
        store.addRaw(String(chatId), `Потратил ${rec.amount} на ${rec.category}${rec.merchant ? ` (${rec.merchant})` : ''}`);
        return send(chatId, `Чек распознал: ${esc(rec.category)}${rec.merchant ? ` (${esc(rec.merchant)})` : ''} - ${RUB.format(rec.amount)} ₽. Записал в траты 💸`);
      }
    }

    let description;
    try {
      description = await withTyping(chatId, () => aiDescribeImage(b64, mime, caption || ''));
    } catch (e) {
      log.error('[telegram] image', e.message);
      return send(chatId, 'Разглядывал-разглядывал, но так и не понял, что там. Расскажешь словами?');
    }
    const text = `${label}: ${description}${caption ? `. Моя подпись: ${caption}` : ''}`;
    return friendFlow(String(chatId), text);
  }

  return { downloadBase64, sendPhoto, sendVoice, sendDocumentText, readDoc, videoTranscript, transcribeLong, audioFlow, imageFlow };
}
