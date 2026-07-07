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

function appendMessage(role, text) {
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
  addToLog(wrap);
}

function addToLog(node) {
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  log.appendChild(node);
  if (nearBottom) scrollLogToBottom();
}

// Визуальный индикатор «печатает»: три точки, декоративные (aria-hidden -
// не читаются скринридером, слова идут только через #chat-status). Точки
// вставляются в лог и убираются на любом пути завершения.
function showTyping() {
  if (document.getElementById('typing-dots')) return;
  const dots = document.createElement('div');
  dots.id = 'typing-dots';
  dots.className = 'typing-dots';
  dots.setAttribute('aria-hidden', 'true');
  dots.innerHTML = '<span></span><span></span><span></span>';
  addToLog(dots);
}
function hideTyping() {
  const dots = document.getElementById('typing-dots');
  if (dots) dots.remove(); // идемпотентно, без removeChild
}

// Общий путь доставки текста «мозгу»: печать, ответ ассистента, панель.
async function deliver(text) {
  pending = true;
  let announced = false;
  const typingTimer = setTimeout(() => {
    showTyping();
    if (!announced) { announce('Ассистент печатает…'); announced = true; }
  }, 700);
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
    cleanup(); // убираем точки и статус ДО вставки ответа - он и объявляется
    if (data.cleared) {
      clearChatLog();
    } else if (data.ai) {
      appendSummaryMessage(data.reply || '…', data.rag);
      maybeSpeak(data.reply);
    } else {
      appendMessage('assistant', data.reply || '…');
      maybeSpeak(data.reply);
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

  appendVoiceMessage(blob, durationSec, peaks, transcript);
  input.focus();
  if (transcript) await deliver(transcript);
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

function drawStaticWave(canvas, bars, progress) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const barW = 3;
  const gap = (W - bars.length * barW) / (bars.length - 1);
  bars.forEach((v, i) => {
    const played = i / bars.length < progress;
    ctx.fillStyle = played ? '#FFFFFF' : 'rgba(255,255,255,0.45)';
    const h = Math.max(3, v * H);
    ctx.fillRect(i * (barW + gap), (H - h) / 2, barW, h);
  });
}

function appendVoiceMessage(blob, durationSec, peaks, transcript) {
  const id = ++vmCounter;
  const clock = fmtClock(durationSec);

  const wrap = document.createElement('div');
  wrap.className = 'message message--user';
  wrap.setAttribute('aria-live', 'off');

  const who = document.createElement('span');
  who.className = 'visually-hidden';
  who.textContent = 'Вы:';

  const vm = document.createElement('div');
  vm.className = 'voice-message';

  const player = document.createElement('div');
  player.className = 'voice-player';
  player.setAttribute('role', 'group');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'voice-msg__play';
  btn.id = `voice-play-vm-${id}`;
  btn.tabIndex = -1; // roving tabindex: вход в лог — через сам лог
  btn.setAttribute('aria-label', `Воспроизвести голосовое сообщение, ${clock}`);
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

  const tLabel = document.createElement('span');
  tLabel.className = 'visually-hidden';
  tLabel.textContent = 'Расшифровка:';

  const tText = document.createElement('p');
  tText.className = 'voice-transcript';
  tText.id = `voice-transcript-vm-${id}`;
  tText.textContent =
    transcript ||
    (SR
      ? 'Расшифровка пуста: речь не распознана.'
      : 'Расшифровка недоступна: браузер не поддерживает распознавание речи');

  vm.append(player, tLabel, tText);
  wrap.append(who, vm);
  addToLog(wrap);

  const bars = resamplePeaks(peaks, 30);
  drawStaticWave(canvas, bars, 0);

  const audio = new Audio(URL.createObjectURL(blob));
  let playing = false;

  const setPlaying = (on) => {
    playing = on;
    btn.innerHTML = on ? ICON_PAUSE : ICON_PLAY;
    btn.setAttribute(
      'aria-label',
      on ? `Пауза, голосовое сообщение, ${clock}` : `Воспроизвести голосовое сообщение, ${clock}`
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
        drawStaticWave(canvas, bars, 0);
      },
    };
    audio.play();
    setPlaying(true);
  });

  audio.addEventListener('timeupdate', () => {
    drawStaticWave(canvas, bars, Math.min(1, audio.currentTime / durationSec));
  });
  audio.addEventListener('ended', () => {
    setPlaying(false);
    drawStaticWave(canvas, bars, 0);
    announce('Воспроизведение завершено');
  });
}

/* ---- Roving tabindex для плееров в логе ---- */

log.addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const players = [...log.querySelectorAll('.voice-msg__play')];
  if (!players.length) return;
  const idx = players.indexOf(document.activeElement);
  let target = null;
  if (e.key === 'ArrowDown') target = idx < 0 ? players[0] : players[Math.min(idx + 1, players.length - 1)];
  else if (e.key === 'ArrowUp') target = idx < 0 ? players[players.length - 1] : players[Math.max(idx - 1, 0)];
  else if (e.key === 'Home') target = players[0];
  else target = players[players.length - 1];
  if (target && target !== document.activeElement) {
    e.preventDefault();
    players.forEach((p) => (p.tabIndex = -1));
    target.tabIndex = 0;
    target.focus();
  }
});

/* ---- Озвучка ответов (если включено в настройках) ---- */

async function maybeSpeak(text) {
  if (!webSettings.voiceReplies || !webSettings.audio || !text) return;
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: String(text).slice(0, 1500) }),
    });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const a = new Audio(url);
    a.addEventListener('ended', () => URL.revokeObjectURL(url));
    a.play().catch(() => URL.revokeObjectURL(url));
  } catch { /* без озвучки, текст уже показан */ }
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
  refreshStats();
  if (fromLogin) input.focus({ preventScroll: true });
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
  if (!webSettings.audio) { voiceToggle.disabled = true; voiceToggle.checked = false; }
}

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
