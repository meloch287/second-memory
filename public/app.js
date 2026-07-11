// Клиент «Второй памяти»: чат, панель категорий, голосовые сообщения
// с транскрибацией (MediaRecorder + Web Speech API).
// Доступность — по чек-листам a11y-команды: live-регионы, roving tabindex,
// двойное фокус-кольцо на синем пузыре, тексты объявлений на русском.

const form = document.getElementById('composer');
const input = document.getElementById('message-input');
const log = document.getElementById('chat-log');
const statusEl = document.getElementById('chat-status');
const hintEl = document.getElementById('form-hint');
const micBtn = document.getElementById('mic-toggle');
const sendBtn = form.querySelector('.btn-send');
const recPanel = document.getElementById('recording-panel');
const recTimerEl = document.getElementById('rec-timer');
const recCanvas = document.getElementById('rec-waveform');
const recCancel = document.getElementById('rec-cancel');
const recSend = document.getElementById('rec-send');
const micErrorEl = document.getElementById('mic-error');

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const MAX_REC_SEC = 120;

let pending = false;
let recState = null;
let currentAudio = null;
let vmCounter = 0;
let motionOff = false; // ручной тумблер «меньше движения» (в дополнение к OS-настройке)
let webSettings = { name: 'Вторая память', voiceReplies: false, voice: 'alloy', audio: false };

function reducedMotion() {
  return motionOff || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function scrollLogToBottom() {
  log.scrollTo({ top: log.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

function announce(text) {
  statusEl.textContent = '';
  statusEl.textContent = text;
}

function fmtClock(sec) {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

/* ---- Чат ---- */

function buildMessageNode(role, text) {
  const wrap = document.createElement('div');
  wrap.className = 'message message--' + role;
  if (role === 'user') {
    // Пользователь только что сам это напечатал — не зачитывать повторно.
    wrap.setAttribute('aria-live', 'off');
  }
  const who = document.createElement('span');
  who.className = 'visually-hidden';
  who.textContent = role === 'user' ? 'Вы:' : 'Ассистент:';
  const p = document.createElement('p');
  p.textContent = text;
  wrap.append(who, p);
  return wrap;
}

function appendMessage(role, text) {
  addToLog(buildMessageNode(role, text));
}

// Восстановление ленты при загрузке страницы. Историю вставляем ТИХО: каждый
// узел с aria-live="off" (иначе live-регион #chat-log зачитал бы 40 старых
// реплик подряд). Порядок: старые -> новые -> приветствие -> живые.
function hydrateHistory(turns) {
  if (!turns || !turns.length) return;
  if (log.querySelector('.message:not(#welcome-msg)')) return; // не гидрировать повторно
  const frag = document.createDocumentFragment();
  for (const t of turns) {
    if (!t || !t.text) continue;
    const node = buildMessageNode(t.role === 'user' ? 'user' : 'assistant', t.text);
    node.setAttribute('aria-live', 'off'); // тихо для обеих ролей
    frag.appendChild(node);
  }
  // Приветствие остаётся СВЕРХУ (оно первое в разметке), история идёт под ним,
  // живые сообщения — ниже: приветствие → старые → новые → живые. Так внизу
  // ленты последний реальный обмен, а не онбординг-приветствие.
  log.appendChild(frag);
  // Мгновенно вниз, когда layout устоялся (без плавности и без кражи фокуса) —
  // чат открывается уже прокрученным к последнему сообщению. Прямое присваивание
  // scrollTop надёжнее scrollTo; rAF + таймер-подстраховка на позднюю раскладку.
  const toBottom = () => { log.scrollTop = log.scrollHeight; };
  requestAnimationFrame(toBottom);
  setTimeout(toBottom, 80);
}

function addToLog(node) {
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  log.appendChild(node);
  if (nearBottom) scrollLogToBottom();
}

// Визуальный индикатор «печатает»: три точки, декоративные (aria-hidden -
// не читаются скринридером, слова идут только через #chat-status). Точки
// вставляются в лог и убираются на любом пути завершения.
function showTyping(voice = false) {
  if (document.getElementById('typing-dots')) return;
  const el = document.createElement('div');
  el.id = 'typing-dots';
  el.setAttribute('aria-hidden', 'true');
  if (voice) {
    // «записывает голосовое»: пульсирующая дорожка (как в Telegram при записи)
    el.className = 'typing-voice';
    el.innerHTML = '<span class="rec-dot"></span>' + '<span></span>'.repeat(6);
  } else {
    el.className = 'typing-dots';
    el.innerHTML = '<span></span><span></span><span></span>';
  }
  addToLog(el);
}
function hideTyping() {
  const dots = document.getElementById('typing-dots');
  if (dots) dots.remove(); // идемпотентно, без removeChild
}

// Общий путь доставки текста «мозгу»: печать, ответ ассистента, панель.
async function deliver(text) {
  pending = true;
  let announced = false;
  const voice = voiceReplyOn();
  const typingTimer = setTimeout(() => {
    showTyping(voice);
    if (!announced) { announce(voice ? 'Ассистент записывает голосовое…' : 'Ассистент печатает…'); announced = true; }
  }, voice ? 250 : 700);
  const cleanup = () => {
    clearTimeout(typingTimer);
    hideTyping();
    statusEl.textContent = '';
  };
  try {
    const res = await fetch('/api/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.cleared) {
      cleanup();
      clearChatLog();
    } else if (voiceReplyOn() && (data.reply || '').trim()) {
      // голос включён -> ответ приходит голосовым сообщением (как в Telegram).
      // Индикатор «записывает голосовое» держим ДО появления пузыря: озвучка
      // (TTS + декод) идёт после JSON и занимает ещё ~1-2с - без этого была
      // пустая пауза между исчезновением анимации и появлением голосового.
      try {
        await speakAssistantReply(data.reply);
        cleanup();
      } catch {
        cleanup();
        if (data.ai) appendSummaryMessage(data.reply || '…', data.rag);
        else appendMessage('assistant', data.reply || '…');
      }
    } else {
      cleanup(); // текстовый ответ - убираем индикатор перед вставкой
      if (data.ai) appendSummaryMessage(data.reply || '…', data.rag);
      else appendMessage('assistant', data.reply || '…');
    }
    setTimeout(refreshStats, 50);
  } catch {
    cleanup();
    appendMessage('assistant', 'Нет ответа от сервера. Попробуйте ещё раз.');
  } finally {
    pending = false;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (pending || recState) return;

  const text = input.value.trim();
  if (!text) {
    input.setAttribute('aria-invalid', 'true');
    hintEl.textContent = 'Введите сообщение перед отправкой.';
    input.focus();
    return;
  }

  appendMessage('user', text);
  input.value = '';
  input.focus();
  deliver(text);
});

// Enter в поле - отправить (Shift+Enter не трогаем; IME-композицию не рвём).
// Явно, чтобы не зависеть от неявной отправки формы в разных браузерах.
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener('input', () => {
  if (input.value.trim()) {
    input.removeAttribute('aria-invalid');
    hintEl.textContent = '';
  }
});

function sendCanned(msg) {
  input.value = msg;
  input.focus();
  form.requestSubmit();
}

document.querySelectorAll('.chip[data-msg]').forEach((chip) => {
  chip.addEventListener('click', () => sendCanned(chip.dataset.msg));
});

// Мини-шкала «опора на память»: значение несёт текст, полоска декоративна.
function relianceFooter(rag) {
  const footer = document.createElement('div');
  footer.className = 'memory-reliance';
  const bar = document.createElement('span');
  bar.className = 'bar';
  bar.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('span');
  fill.className = 'bar-fill';
  fill.style.width = Math.max(0, Math.min(100, rag.score)) + '%';
  bar.appendChild(fill);
  const label = document.createElement('span');
  label.className = 'reliance-text';
  label.textContent = `Опора на память: ${rag.score}%${rag.label ? ' - ' + rag.label : ''}`;
  footer.append(bar, label);
  return footer;
}

// Длинные ответы ИИ — настоящими абзацами (навигация скринридера по <p>),
// без автозачитывания всего текста: короткий анонс через #chat-status.
// Всё сообщение собирается до вставки в лог — одно объявление, не два.
function appendSummaryMessage(text, rag) {
  const wrap = document.createElement('div');
  wrap.className = 'message message--assistant';
  wrap.setAttribute('aria-live', 'off');
  const who = document.createElement('span');
  who.className = 'visually-hidden';
  who.textContent = 'Ассистент:';
  wrap.append(who);
  const body = document.createElement('div');
  body.className = 'summary-body';
  text.split(/\n{2,}/).filter(Boolean).forEach((para) => {
    const p = document.createElement('p');
    p.textContent = para;
    body.append(p);
  });
  wrap.append(body);
  if (rag && typeof rag.score === 'number') wrap.append(relianceFooter(rag));
  addToLog(wrap);
  announce('Получен ответ ИИ');
}

/* ---- Меню и очистка чата ---- */

const menuTrigger = document.getElementById('menu-trigger');
const menuPopover = document.getElementById('menu-popover');
const clearItem = document.getElementById('menu-clear-chat');
const confirmBox = document.getElementById('clear-chat-confirm-box');
const confirmYes = document.getElementById('clear-chat-confirm');
const confirmNo = document.getElementById('clear-chat-cancel');

function resetConfirm() {
  confirmBox.hidden = true;
  clearItem.hidden = false;
}

function openMenu() {
  menuPopover.hidden = false;
  menuTrigger.setAttribute('aria-expanded', 'true');
  menuPopover.querySelector('.menu-item').focus();
}

function closeMenu(focusTrigger) {
  resetConfirm();
  menuPopover.hidden = true;
  menuTrigger.setAttribute('aria-expanded', 'false');
  if (focusTrigger) menuTrigger.focus();
}

menuTrigger.addEventListener('click', () => {
  if (menuPopover.hidden) openMenu();
  else closeMenu(true);
});

menuPopover.querySelectorAll('.menu-item[data-msg]').forEach((item) => {
  item.addEventListener('click', () => {
    closeMenu(false);
    sendCanned(item.dataset.msg);
  });
});

clearItem.addEventListener('click', () => {
  clearItem.hidden = true;
  confirmBox.hidden = false;
  confirmNo.focus();
  announce('Подтвердите: очистить историю чата?');
});

confirmNo.addEventListener('click', () => {
  resetConfirm();
  clearItem.focus();
});

confirmYes.addEventListener('click', () => {
  closeMenu(false);
  clearChatLog();
  fetch('/api/history/clear', { method: 'POST' }).catch(() => {
    announce('Не удалось очистить контекст на сервере. Попробуйте ещё раз.');
  });
});

function clearChatLog() {
  log.querySelectorAll('.message').forEach((m) => {
    if (m.id !== 'welcome-msg') m.remove();
  });
  input.focus();
  announce('Чат очищен');
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || menuPopover.hidden) return;
  e.preventDefault();
  if (!confirmBox.hidden) {
    // первый Escape отменяет только подтверждение, второй закроет меню
    resetConfirm();
    clearItem.focus();
  } else {
    closeMenu(true);
  }
});

document.addEventListener('pointerdown', (e) => {
  if (menuPopover.hidden) return;
  if (menuPopover.contains(e.target) || menuTrigger.contains(e.target)) return;
  const focusable = e.target.closest && e.target.closest('button, a, input, [tabindex]');
  closeMenu(!focusable);
});

/* ---- Панель «Память»: шкала наполненности для RAG ---- */

const METER_LABELS = {
  empty: 'пусто',
  low: 'мало данных',
  ok: 'немного данных',
  good: 'достаточно данных',
};

// Обновление тихое: метр вне live-регионов, только атрибуты и ширина.
async function refreshStats() {
  let s;
  try {
    s = await fetch('/api/memory-stats').then((r) => r.json());
  } catch {
    return; // панель просто не обновится, чат продолжает работать
  }
  const meter = document.getElementById('memory-meter');
  // aria-значение метра ставим ОДИН раз к финалу (не по кадрам) - анимируется
  // только визуальная ширина через CSS-переход
  meter.setAttribute('aria-valuenow', String(s.score));
  meter.setAttribute('aria-valuetext', `${s.score} процентов, ${METER_LABELS[s.level] || ''}`.trim());
  document.getElementById('meter-fill').style.width = s.score + '%';
  document.getElementById('memory-status').textContent = s.label;
  setCounters(s.counts.entries, s.counts.facts, s.counts.days);
}

// Плавный count-up чисел. #memory-counters - обычный <p> (не live-регион),
// поэтому промежуточные значения скринридер не читает. При reduced-motion -
// сразу финал (rAF невидим для CSS @media, проверяем в JS).
let countRaf = 0;
let lastCounts = null; // предыдущие значения - анимируем ОТ них, а не от нуля
function setCounters(entries, facts, days) {
  const el = document.getElementById('memory-counters');
  const finalText = `Записей: ${entries} · Фактов: ${facts} · Дней: ${days}`;
  cancelAnimationFrame(countRaf);
  const from = lastCounts;
  lastCounts = { entries, facts, days };
  // без анимации: reduced-motion, первый показ, либо значения не изменились
  // (иначе панель мигала «0 → N» на каждом обновлении - выглядело как стирание)
  if (reducedMotion() || !from || (from.entries === entries && from.facts === facts && from.days === days)) {
    el.textContent = finalText;
    return;
  }
  const DURATION = 500;
  const start = performance.now();
  const lerp = (a, b, t) => Math.round(a + (b - a) * t);
  const tick = (now) => {
    const t = Math.min(1, (now - start) / DURATION);
    el.textContent = `Записей: ${lerp(from.entries, entries, t)} · Фактов: ${lerp(from.facts, facts, t)} · Дней: ${lerp(from.days, days, t)}`;
    if (t < 1) countRaf = requestAnimationFrame(tick);
    else el.textContent = finalText;
  };
  countRaf = requestAnimationFrame(tick);
}

/* ---- Запись голосового сообщения ---- */

function setMicError(msg) {
  micErrorEl.textContent = msg;
  micErrorEl.hidden = false;
  micBtn.setAttribute('data-error', 'true');
  micBtn.focus();
}

function clearMicError() {
  micErrorEl.hidden = true;
  micErrorEl.textContent = '';
  micBtn.removeAttribute('data-error');
}

function setComposerMode(recording) {
  input.hidden = recording;
  micBtn.hidden = recording;
  sendBtn.hidden = recording;
  recPanel.hidden = !recording;
}

async function startRecording() {
  if (recState || pending) return;
  clearMicError();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
      setMicError('Доступ к микрофону запрещён. Разрешите доступ к микрофону в настройках браузера для этого сайта и повторите попытку.');
    } else if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') {
      setMicError('Микрофон не найден. Подключите микрофон и повторите попытку.');
    } else {
      setMicError('Не удалось включить микрофон. Попробуйте ещё раз или напишите сообщение текстом.');
    }
    return;
  }

  const mr = new MediaRecorder(stream);
  const chunks = [];
  mr.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  audioCtx.createMediaStreamSource(stream).connect(analyser);
  const timeData = new Uint8Array(analyser.fftSize);

  // Распознавание идёт параллельно записи — из него получается расшифровка.
  const box = { text: '', ended: !SR, onended: null };
  let recognition = null;
  if (SR) {
    recognition = new SR();
    recognition.lang = 'ru-RU';
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) {
          const t = ev.results[i][0].transcript.trim();
          if (t) box.text += (box.text ? ' ' : '') + t;
        }
      }
    };
    recognition.onerror = () => {};
    recognition.onend = () => {
      box.ended = true;
      if (box.onended) box.onended();
    };
    try {
      recognition.start();
    } catch {
      box.ended = true;
    }
  }

  const state = {
    mr, stream, chunks, audioCtx, analyser, timeData, recognition, box,
    peaks: [], startTs: Date.now(), raf: 0, timerInt: 0, maxTimer: 0, stopping: false,
  };
  recState = state;

  const ctx2d = recCanvas.getContext('2d');
  const drawLive = () => {
    analyser.getByteTimeDomainData(timeData);
    let sum = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128;
      sum += v * v;
    }
    state.peaks.push(Math.sqrt(sum / timeData.length));

    const W = recCanvas.width;
    const H = recCanvas.height;
    ctx2d.clearRect(0, 0, W, H);
    ctx2d.fillStyle = '#B3261E';
    const barW = 3;
    const gap = 2;
    const count = Math.floor(W / (barW + gap));
    const recent = state.peaks.slice(-count);
    recent.forEach((p, i) => {
      const h = Math.max(2, Math.min(1, p * 3) * H);
      ctx2d.fillRect(i * (barW + gap), (H - h) / 2, barW, h);
    });
    state.raf = requestAnimationFrame(drawLive);
  };

  setComposerMode(true);
  recTimerEl.textContent = '0:00';
  recCancel.focus();
  announce(SR
    ? 'Идёт запись голосового сообщения'
    : 'Идёт запись голосового сообщения. Расшифровка недоступна в этом браузере.');

  mr.start();
  drawLive();
  state.timerInt = setInterval(() => {
    recTimerEl.textContent = fmtClock((Date.now() - state.startTs) / 1000);
  }, 250);
  state.maxTimer = setTimeout(() => stopRecording(true, true), MAX_REC_SEC * 1000);
}

async function stopRecording(send, autoLimit = false) {
  const s = recState;
  if (!s || s.stopping) return;
  s.stopping = true;

  cancelAnimationFrame(s.raf);
  clearInterval(s.timerInt);
  clearTimeout(s.maxTimer);

  const durationSec = Math.max(1, Math.round((Date.now() - s.startTs) / 1000));
  const stopped = new Promise((resolve) => {
    s.mr.onstop = resolve;
  });
  if (s.mr.state !== 'inactive') s.mr.stop();
  if (s.recognition) {
    try { s.recognition.stop(); } catch { s.box.ended = true; }
  }
  await stopped;
  s.stream.getTracks().forEach((t) => t.stop());
  s.audioCtx.close().catch(() => {});

  // Даём распознаванию до 1,5 с на финальный результат.
  if (!s.box.ended) {
    await new Promise((resolve) => {
      s.box.onended = resolve;
      setTimeout(resolve, 1500);
    });
  }

  const blob = new Blob(s.chunks, { type: s.mr.mimeType || 'audio/webm' });
  const { peaks } = s;
  const transcript = s.box.text.trim();
  recState = null;
  setComposerMode(false);

  if (!send) {
    announce('Запись отменена');
    micBtn.focus();
    return;
  }
  if (autoLimit) announce('Достигнут лимит длительности. Запись остановлена и отправлена.');

  // Браузерный SpeechRecognition не дал текста (не-Chromium) — распознаём на сервере.
  let finalText = transcript;
  if (!finalText && blob.size > 1200) finalText = await serverTranscribe(blob);

  appendVoiceMessage(blob, durationSec, peaks, finalText);
  input.focus();
  if (finalText) await deliver(finalText);
}

// Серверное распознавание (фолбэк). Пока идёт — mic-кнопка в состоянии
// «занята»: aria-busy + disabled + временный aria-label; прогресс в #chat-status.
async function serverTranscribe(blob) {
  const prevLabel = micBtn.getAttribute('aria-label') || 'Записать голосовое сообщение';
  micBtn.setAttribute('aria-busy', 'true');
  micBtn.disabled = true;
  micBtn.setAttribute('aria-label', 'Распознаю голосовое сообщение…');
  announce('Распознаю голосовое сообщение…');
  try {
    const res = await fetch('/api/transcribe', {
      method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob,
    });
    if (!res.ok) throw new Error();
    return ((await res.json()).text || '').trim();
  } catch {
    setMicError('Не удалось распознать голосовое сообщение. Можно написать текстом.');
    return '';
  } finally {
    micBtn.setAttribute('aria-busy', 'false');
    micBtn.disabled = false;
    micBtn.setAttribute('aria-label', prevLabel);
    announce(''); // прогресс сняли; дальше объявит deliver()
  }
}

micBtn.addEventListener('click', startRecording);
recSend.addEventListener('click', () => stopRecording(true));
recCancel.addEventListener('click', () => stopRecording(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && recState) {
    e.preventDefault();
    stopRecording(false);
  }
});

/* ---- Пузырь голосового сообщения ---- */

const ICON_PLAY = '<svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
// «показать текст» - три строки, как кнопка расшифровки в Telegram
const ICON_TRANSCRIBE = '<svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 6h14M5 12h14M5 18h9"/></svg>';

function resamplePeaks(peaks, buckets) {
  if (!peaks.length) return new Array(buckets).fill(0.15);
  const out = [];
  const step = peaks.length / buckets;
  for (let i = 0; i < buckets; i++) {
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    let sum = 0;
    for (let j = from; j < to; j++) sum += peaks[j];
    out.push(sum / (to - from));
  }
  const max = Math.max(...out, 0.05);
  return out.map((v) => Math.max(0.12, v / max));
}

function drawStaticWave(canvas, bars, progress, dark = false) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const barW = 3;
  const gap = (W - bars.length * barW) / (bars.length - 1);
  const on = dark ? '#26221B' : '#FFFFFF';
  const off = dark ? 'rgba(38,34,27,0.35)' : 'rgba(255,255,255,0.45)';
  bars.forEach((v, i) => {
    const played = i / bars.length < progress;
    ctx.fillStyle = played ? on : off;
    const h = Math.max(3, v * H);
    ctx.fillRect(i * (barW + gap), (H - h) / 2, barW, h);
  });
}

function appendVoiceMessage(blob, durationSec, peaks, transcript, role = 'user') {
  const id = ++vmCounter;
  const clock = fmtClock(durationSec);
  const isAsst = role === 'assistant';
  const noun = isAsst ? 'голосовой ответ' : 'голосовое сообщение';

  const wrap = document.createElement('div');
  wrap.className = `message message--${isAsst ? 'assistant' : 'user'}`;
  wrap.setAttribute('aria-live', 'off');

  const who = document.createElement('span');
  who.className = 'visually-hidden';
  who.textContent = isAsst ? 'Ассистент:' : 'Вы:';

  const vm = document.createElement('div');
  vm.className = isAsst ? 'voice-message voice-message--assistant' : 'voice-message';

  const player = document.createElement('div');
  player.className = 'voice-player';
  player.setAttribute('role', 'group');
  player.setAttribute('aria-label', `${isAsst ? 'Голосовой ответ' : 'Голосовое сообщение'}, ${clock}`);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'voice-msg__play';
  btn.id = `voice-play-vm-${id}`;
  btn.tabIndex = -1; // roving tabindex: вход в лог — через сам лог
  btn.setAttribute('aria-label', `Воспроизвести ${noun}, ${clock}`);
  btn.innerHTML = ICON_PLAY;

  const canvas = document.createElement('canvas');
  canvas.className = 'voice-waveform';
  canvas.width = 140;
  canvas.height = 32;
  canvas.setAttribute('aria-hidden', 'true');

  const dur = document.createElement('span');
  dur.className = 'voice-duration';
  dur.setAttribute('aria-hidden', 'true');
  dur.textContent = clock;

  player.append(btn, canvas, dur);

  // Расшифровка скрыта по умолчанию (как в Telegram - только войс). Кнопка «A»
  // раскрывает её по запросу. Если расшифровки нет - кнопки и текста нет вовсе.
  const hasTranscript = !!(transcript && transcript.trim());
  if (hasTranscript) {
    const transcriptId = `voice-transcript-vm-${id}`;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'voice-msg__transcribe-toggle';
    toggle.tabIndex = -1; // roving tabindex: как и play, доступна стрелками в логе
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', transcriptId);
    toggle.setAttribute('aria-label', isAsst ? 'Текст ответа' : 'Расшифровка голосового сообщения');
    toggle.innerHTML = ICON_TRANSCRIBE;
    player.append(toggle);

    const tLabel = document.createElement('span');
    tLabel.className = 'visually-hidden';
    tLabel.textContent = 'Расшифровка:';

    const tText = document.createElement('p');
    tText.className = 'voice-transcript';
    tText.id = transcriptId;
    tText.hidden = true; // hidden = убрано и визуально, и из дерева доступности
    tText.textContent = transcript.trim();

    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      tText.hidden = expanded; // было развёрнуто -> скрываем, и наоборот
    });

    vm.append(player, tLabel, tText);
  } else {
    vm.append(player);
  }

  wrap.append(who, vm);
  addToLog(wrap);

  const bars = resamplePeaks(peaks, 30);
  drawStaticWave(canvas, bars, 0, isAsst);

  const audio = new Audio(URL.createObjectURL(blob));
  let playing = false;
  // если длительность не получили при декоде (напр. TTS-ответ) - возьмём из плеера
  if (!durationSec) {
    audio.addEventListener('loadedmetadata', () => {
      if (isFinite(audio.duration) && audio.duration > 0) {
        durationSec = audio.duration;
        dur.textContent = fmtClock(durationSec);
      }
    });
  }

  const setPlaying = (on) => {
    playing = on;
    btn.innerHTML = on ? ICON_PAUSE : ICON_PLAY;
    btn.setAttribute(
      'aria-label',
      on ? `Пауза, ${noun}, ${clock}` : `Воспроизвести ${noun}, ${clock}`
    );
  };

  btn.addEventListener('click', () => {
    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }
    if (currentAudio && currentAudio.audio !== audio) currentAudio.stop();
    currentAudio = {
      audio,
      stop() {
        audio.pause();
        audio.currentTime = 0;
        setPlaying(false);
        drawStaticWave(canvas, bars, 0, isAsst);
      },
    };
    audio.play();
    setPlaying(true);
  });

  audio.addEventListener('timeupdate', () => {
    drawStaticWave(canvas, bars, Math.min(1, audio.currentTime / (durationSec || audio.duration || 1)), isAsst);
  });
  audio.addEventListener('ended', () => {
    setPlaying(false);
    drawStaticWave(canvas, bars, 0, isAsst);
    announce('Воспроизведение завершено');
  });
}

/* ---- Roving tabindex для плееров в логе ---- */

// 2D-roving: ↑/↓ переходят между голосовыми (всегда на кнопку play), ←/→
// переключают play↔«показать расшифровку» внутри одного сообщения. Во всём
// логе ровно один элемент имеет tabindex=0. Home/End - первое/последнее сообщение.
log.addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const rows = [...log.querySelectorAll('.voice-message')]
    .map((el) => ({ play: el.querySelector('.voice-msg__play'), toggle: el.querySelector('.voice-msg__transcribe-toggle') }))
    .filter((r) => r.play);
  if (!rows.length) return;
  const active = document.activeElement;
  const ri = rows.findIndex((r) => r.play === active || r.toggle === active);
  const inToggle = ri >= 0 && rows[ri].toggle === active;
  let target = null;
  if (e.key === 'ArrowDown') target = rows[ri < 0 ? 0 : Math.min(ri + 1, rows.length - 1)].play;
  else if (e.key === 'ArrowUp') target = rows[ri < 0 ? rows.length - 1 : Math.max(ri - 1, 0)].play;
  else if (e.key === 'Home') target = rows[0].play;
  else if (e.key === 'End') target = rows[rows.length - 1].play;
  else if (e.key === 'ArrowRight') { if (ri >= 0 && !inToggle && rows[ri].toggle) target = rows[ri].toggle; }
  else if (e.key === 'ArrowLeft') { if (inToggle) target = rows[ri].play; }
  if (target && target !== active) {
    e.preventDefault();
    for (const r of rows) { r.play.tabIndex = -1; if (r.toggle) r.toggle.tabIndex = -1; }
    target.tabIndex = 0;
    target.focus();
  }
});

/* ---- Голосовой ответ ассистента (как в Telegram: войс-пузырь, а не текст) ---- */

const voiceReplyOn = () => webSettings.voiceReplies && webSettings.audio;

// Пики громкости из PCM для рисованной волны.
function computePeaks(data, n) {
  const block = Math.floor(data.length / n) || 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = 0; j < block; j++) { const v = Math.abs(data[i * block + j] || 0); if (v > m) m = v; }
    out.push(m);
  }
  const max = Math.max(...out, 0.01);
  return out.map((v) => v / max);
}

// Озвучить ответ и добавить его как ГОЛОСОВОЕ сообщение ассистента (play + текст
// под ≡). Бросает при любой ошибке - вызывающий откатится на текст.
async function speakAssistantReply(text) {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: String(text).slice(0, 1500) }),
  });
  if (!res.ok) throw new Error('tts ' + res.status);
  const blob = await res.blob();
  let durationSec = 0;
  let peaks = new Array(30).fill(0.4);
  try {
    const buf = await blob.arrayBuffer();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const ab = await ac.decodeAudioData(buf);
    durationSec = ab.duration;
    peaks = computePeaks(ab.getChannelData(0), 60);
    ac.close().catch(() => {});
  } catch { /* не декодировали - оставим плоскую волну, длительность возьмём из плеера */ }
  appendVoiceMessage(blob, durationSec, peaks, text, 'assistant');
}

/* ---- Имя ассистента: шапка + вкладка (тихо, без объявления) ---- */

const h1El = document.querySelector('.app-header .brand h1');
function setAssistantName(name) {
  const display = (name || '').trim() || 'Вторая память';
  webSettings.name = display;
  h1El.textContent = display;
  document.title = `${display} — персональный ассистент для дел, встреч и долгов`;
}

/* ---- Вход ---- */

const loginScreen = document.getElementById('login-screen');
const appRoot = document.querySelector('.app');
const loginForm = document.getElementById('login-form');
const loginPwd = document.getElementById('login-password');
const loginError = document.getElementById('login-error');

function showLogin() {
  appRoot.hidden = true;
  loginScreen.hidden = false;
  loginPwd.focus({ preventScroll: true });
}

function showApp(fromLogin) {
  loginScreen.hidden = true;
  appRoot.hidden = false;
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder) micBtn.hidden = false;
  applySettings();
  restoreHistory(); // вернуть ленту диалога (тихо), до живых сообщений
  refreshStats();
  startReminderPolling();
  if (fromLogin) input.focus({ preventScroll: true });
}

async function restoreHistory() {
  try {
    const res = await fetch('/api/history');
    if (!res.ok) return;
    hydrateHistory((await res.json()).turns);
  } catch { /* сеть моргнула — лента просто останется с приветствия */ }
}

function setLoginError(msg) {
  loginError.textContent = msg;
  loginError.hidden = false;
  loginPwd.setAttribute('aria-invalid', 'true');
  loginPwd.focus();
}
loginPwd.addEventListener('input', () => {
  if (loginPwd.getAttribute('aria-invalid') === 'true') {
    loginError.hidden = true;
    loginError.textContent = '';
    loginPwd.removeAttribute('aria-invalid');
  }
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!loginPwd.value) return setLoginError('Введите пароль.');
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: loginPwd.value }),
    });
    if (res.status === 401) return setLoginError('Неверный пароль. Попробуйте ещё раз.');
    if (!res.ok) throw new Error();
    await loadSettings();
    showApp(true);
  } catch {
    setLoginError('Не удалось войти. Проверьте соединение.');
  }
});

// показать/скрыть пароль
const loginPwToggle = document.getElementById('login-pw-toggle');
loginPwToggle.addEventListener('click', () => {
  const show = loginPwd.type === 'password';
  loginPwd.type = show ? 'text' : 'password';
  loginPwToggle.setAttribute('aria-pressed', String(show));
  loginPwToggle.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
});

/* ---- Настройки: модальное окно ---- */

const settingsTrigger = document.getElementById('settings-trigger');
const settingsModal = document.getElementById('settings-modal');
const settingsClose = document.getElementById('settings-close');
const settingsLogout = document.getElementById('settings-logout');
const nameInput = document.getElementById('assistant-name');
const voiceToggle = document.getElementById('voice-replies');
const voiceSelect = document.getElementById('voice-name');
const reduceToggle = document.getElementById('reduce-motion');
const loginNameInput = document.getElementById('login-name');
let lastTrigger = null;

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) return false;
    webSettings = await res.json();
    return true;
  } catch { return false; }
}

// Применить настройки к UI (шапка + поля формы).
function applySettings() {
  setAssistantName(webSettings.name);
  nameInput.value = webSettings.name === 'Вторая память' ? '' : webSettings.name;
  loginNameInput.value = webSettings.login || 'admin';
  voiceToggle.checked = !!webSettings.voiceReplies;
  voiceSelect.value = webSettings.voice || 'alloy';
  syncVoiceEnabled();
  motionOff = localStorage.getItem('sm_motion_off') === '1';
  reduceToggle.checked = motionOff;
  applyMotionPref();
  if (!webSettings.audio) { voiceToggle.disabled = true; voiceToggle.checked = false; }
  applyTgStatus();
  syncPassBanner();
}

// «Меньше движения»: раньше глушило только пару JS-эффектов. Ставим атрибут на
// <html> — CSS выключает все анимации/переходы наравне с prefers-reduced-motion.
function applyMotionPref() {
  document.documentElement.dataset.motion = motionOff ? 'reduced' : '';
}

/* ---- Баннер «смените временный пароль» ---- */
// role=status на самом баннере — единственный канал озвучки (без announce()).
// «Скрыть» прячет до конца сессии вкладки; сам флаг гаснет только при смене пароля.

const passBanner = document.getElementById('pass-banner');
const passBannerOpen = document.getElementById('pass-banner-open');
const passBannerClose = document.getElementById('pass-banner-close');

function syncPassBanner() {
  const show = !!webSettings.mustChangePass && sessionStorage.getItem('sm_pass_banner_off') !== '1';
  passBanner.hidden = !show;
}

passBannerOpen.addEventListener('click', () => openSettings()); // фокус вернётся на кнопку (lastTrigger)
passBannerClose.addEventListener('click', () => {
  sessionStorage.setItem('sm_pass_banner_off', '1');
  passBanner.hidden = true;
});

function syncVoiceEnabled() {
  const on = voiceToggle.checked && webSettings.audio;
  if (!on && document.activeElement === voiceSelect) voiceToggle.focus();
  voiceSelect.disabled = !on;
}

function saveSettings(patch) {
  fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((r) => r.ok && r.json()).then((s) => { if (s) webSettings = { ...webSettings, ...s }; }).catch(() => {});
}

/* ---- Подключение Telegram (уведомления + общая память) ---- */

const tgConnect = document.getElementById('tg-connect');
const tgDirChoice = document.getElementById('tg-dir-choice');
const tgConnectGo = document.getElementById('tg-connect-go');
const tgUnlink = document.getElementById('tg-unlink');
const tgStatus = document.getElementById('tg-status');

function applyTgStatus() {
  if (webSettings.tgLinked) {
    tgConnect.hidden = true;
    tgDirChoice.hidden = true;
    tgConnect.setAttribute('aria-expanded', 'false');
    tgUnlink.hidden = false;
    tgStatus.textContent = 'Подключено ✓ — напоминания приходят и в Telegram, память общая.';
  } else {
    tgConnect.hidden = false;
    tgUnlink.hidden = true;
    if (tgStatus.textContent.startsWith('Подключено')) tgStatus.textContent = '';
  }
}

// «Подключить» раскрывает выбор направления памяти
tgConnect.addEventListener('click', () => {
  const willOpen = tgDirChoice.hidden;
  tgDirChoice.hidden = !willOpen;
  tgConnect.setAttribute('aria-expanded', String(willOpen));
  if (willOpen) tgDirChoice.querySelector('input[name="tg-dir"]:checked')?.focus();
});

// «Продолжить» - генерим ссылку с выбранным направлением и открываем бота
tgConnectGo.addEventListener('click', async () => {
  const dir = tgDirChoice.querySelector('input[name="tg-dir"]:checked')?.value || 'web';
  tgConnectGo.disabled = true;
  tgStatus.textContent = 'Готовлю ссылку…';
  try {
    const res = await fetch('/api/tg-link', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.url) {
      window.open(data.url, '_blank', 'noopener');
      tgDirChoice.hidden = true;
      tgConnect.setAttribute('aria-expanded', 'false');
      tgStatus.textContent = 'Открыл Telegram — нажми «Старт» (Start) у бота, чтобы подключить.';
      setTimeout(async () => { if (await loadSettings()) { applyTgStatus(); refreshStats(); } }, 7000);
    } else {
      tgStatus.textContent = data.error || 'Не удалось создать ссылку. Попробуй ещё раз.';
    }
  } catch {
    tgStatus.textContent = 'Ошибка сети. Попробуй ещё раз.';
  } finally {
    tgConnectGo.disabled = false;
  }
});

// «Отключить Telegram» - разрываем связку (данные у бота остаются)
tgUnlink.addEventListener('click', async () => {
  if (!confirm('Отключить Telegram? Веб вернётся к своей отдельной памяти. Данные в Telegram у бота останутся.')) return;
  tgUnlink.disabled = true;
  try {
    const res = await fetch('/api/tg-unlink', { method: 'POST' });
    if (res.ok) {
      await loadSettings();
      applyTgStatus();
      refreshStats();
      tgStatus.textContent = 'Telegram отключён. Веб снова на своей памяти.';
    } else {
      tgStatus.textContent = 'Не удалось отключить. Попробуй ещё раз.';
    }
  } catch {
    tgStatus.textContent = 'Ошибка сети.';
  } finally {
    tgUnlink.disabled = false;
  }
});

/* ---- Веб-напоминания: всплывашки «пора сделать X» ---- */

const reminderToasts = document.getElementById('reminder-toasts');
let reminderTimer = null;

function showReminderToast(r) {
  const label = r.type === 'meeting' ? 'Встреча' : r.type === 'debt' ? 'Долг' : 'Напоминание';
  const el = document.createElement('div');
  el.className = 'reminder-toast';
  const icon = document.createElement('span');
  icon.className = 'reminder-toast__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '🔔';
  const txt = document.createElement('span');
  txt.className = 'reminder-toast__text';
  txt.textContent = `${label}: ${r.title}`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'reminder-toast__close';
  close.setAttribute('aria-label', 'Закрыть напоминание');
  close.textContent = '✕';
  close.addEventListener('click', () => el.remove());
  el.append(icon, txt, close);
  reminderToasts.appendChild(el);
  // Не объявляем здесь: напоминание озвучивает лента чата (см. appendReminder),
  // иначе одно событие проговаривалось бы дважды.
  setTimeout(() => { if (el.isConnected) el.remove(); }, 30000);
}

// Напоминание отдельным сообщением В ЛЕНТЕ ЧАТА (остаётся в истории, как у бота).
// Своя семантика: скрытый лейбл «Напоминание.» (не «Ассистент:», ведь это не ответ),
// 🔔 декоративна (aria-hidden). Объявляется ровно один раз через #chat-log (role=log).
function appendReminder(r) {
  const label = r.type === 'meeting' ? 'Встреча' : r.type === 'debt' ? 'Долг' : 'Напоминание';
  const wrap = document.createElement('div');
  wrap.className = 'message message--assistant message--reminder';

  const who = document.createElement('span');
  who.className = 'visually-hidden';
  who.textContent = 'Напоминание.';

  const icon = document.createElement('span');
  icon.className = 'message-reminder__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '🔔';

  const p = document.createElement('p');
  p.textContent = r.type === 'meeting' || r.type === 'debt' ? `${label}: ${r.title}` : r.title;

  wrap.append(who, icon, p);
  addToLog(wrap);
}

async function pollReminders() {
  try {
    const res = await fetch('/api/reminders/due');
    if (!res.ok) return;
    const data = await res.json();
    // Сначала в ленту (постоянное сообщение + озвучка), затем визуальный тост.
    (data.reminders || []).forEach((r) => { appendReminder(r); showReminderToast(r); });
  } catch { /* сеть моргнула - в следующий тик */ }
}

function startReminderPolling() {
  if (reminderTimer) return;
  pollReminders();
  reminderTimer = setInterval(pollReminders, 45000);
}

/* ---- Полноэкранный чат (развернуть / свернуть) ---- */

const focusToggle = document.getElementById('focus-toggle');
const ICON_EXPAND = '<svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
const ICON_COLLAPSE = '<svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v3a2 2 0 0 1-2 2H4M15 4v3a2 2 0 0 0 2 2h3M9 20v-3a2 2 0 0 0-2-2H4M15 20v-3a2 2 0 0 1 2-2h3"/></svg>';
focusToggle.addEventListener('click', () => {
  const on = appRoot.classList.toggle('app--focus');
  focusToggle.setAttribute('aria-pressed', String(on));
  focusToggle.setAttribute('aria-label', on ? 'Свернуть чат' : 'Развернуть чат на весь экран');
  focusToggle.innerHTML = on ? ICON_COLLAPSE : ICON_EXPAND;
  announce(on ? 'Чат развёрнут на весь экран' : 'Обычный вид');
  input.focus({ preventScroll: true });
});

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function focusableIn(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.hidden && el.offsetParent !== null);
}

function openSettings() {
  lastTrigger = document.activeElement;
  appRoot.inert = true;
  settingsModal.showModal();
  (focusableIn(settingsModal)[0] || settingsModal).focus();
}
function closeSettings() {
  if (settingsModal.open) settingsModal.close();
}

settingsTrigger.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });
settingsModal.addEventListener('close', () => {
  appRoot.inert = false;
  const t = lastTrigger || settingsTrigger;
  if (t && document.contains(t)) t.focus();
  lastTrigger = null;
});
// страховочный wrap Tab поверх нативного трапа
settingsModal.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const items = focusableIn(settingsModal);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// Имя: живое обновление шапки; сохраняем при изменении (blur)
nameInput.addEventListener('input', () => setAssistantName(nameInput.value));
nameInput.addEventListener('change', () => saveSettings({ name: nameInput.value.trim() || 'Вторая память' }));

voiceToggle.addEventListener('change', () => {
  syncVoiceEnabled();
  saveSettings({ voiceReplies: voiceToggle.checked });
  announce(voiceToggle.checked ? 'Ответы голосом включены' : 'Ответы голосом выключены');
});
voiceSelect.addEventListener('change', () => saveSettings({ voice: voiceSelect.value }));

reduceToggle.addEventListener('change', () => {
  motionOff = reduceToggle.checked;
  localStorage.setItem('sm_motion_off', motionOff ? '1' : '0');
  applyMotionPref();
});

settingsLogout.addEventListener('click', async () => {
  closeSettings();
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  clearChatLog();
  showLogin();
});

/* ---- Смена входа/пароля ---- */

const pwForm = document.getElementById('pw-change-form');
const pwCurrent = document.getElementById('pw-current');
const pwNew = document.getElementById('pw-new');
const pwConfirm = document.getElementById('pw-confirm');
const pwSummary = document.getElementById('pw-validation');
const pwStatus = document.getElementById('pw-status');

function pwErr(input, msg) {
  const id = input.getAttribute('aria-describedby').split(' ').pop();
  const el = document.getElementById(id);
  el.textContent = msg; el.hidden = false;
  input.setAttribute('aria-invalid', 'true');
}
function pwClear(input) {
  const id = input.getAttribute('aria-describedby').split(' ').pop();
  const el = document.getElementById(id);
  el.textContent = ''; el.hidden = true;
  input.removeAttribute('aria-invalid');
}
[pwCurrent, pwNew, pwConfirm].forEach((el) => el.addEventListener('input', () => {
  if (el.getAttribute('aria-invalid') === 'true') pwClear(el);
}));

pwForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  [pwCurrent, pwNew, pwConfirm].forEach(pwClear);
  const errs = [];
  if (!pwCurrent.value) { pwErr(pwCurrent, 'Введите текущий пароль.'); errs.push(pwCurrent); }
  if (pwNew.value.length < 6) { pwErr(pwNew, 'Новый пароль - минимум 6 символов.'); errs.push(pwNew); }
  if (pwConfirm.value !== pwNew.value) { pwErr(pwConfirm, 'Пароли не совпадают.'); errs.push(pwConfirm); }
  if (errs.length) {
    pwSummary.textContent = 'Исправьте поля формы.'; pwSummary.hidden = false;
    errs[0].focus();
    return;
  }
  pwSummary.hidden = true; pwSummary.textContent = '';
  try {
    const res = await fetch('/api/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current: pwCurrent.value, next: pwNew.value, login: loginNameInput.value.trim() }),
    });
    if (res.status === 403) { pwErr(pwCurrent, 'Текущий пароль неверный.'); pwCurrent.focus(); return; }
    if (!res.ok) throw new Error();
    pwStatus.textContent = 'Вход обновлён.';
    pwForm.reset();
    webSettings.login = loginNameInput.value.trim() || webSettings.login;
    webSettings.mustChangePass = false; // сервер погасил флаг — прячем баннер
    syncPassBanner();
  } catch {
    pwStatus.textContent = 'Не удалось сохранить. Попробуйте ещё раз.';
  }
});

/* ---- Старт ---- */

(async function boot() {
  const ok = await loadSettings();
  if (ok) showApp(false);
  else showLogin();
})();
