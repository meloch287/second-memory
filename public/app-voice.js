// Подсистема голосовых сообщений «Второй памяти»: запись, транскрибация,
// пузырь голосового сообщения и голосовой ответ ассистента. Классический
// скрипт (не модуль) — грузится раньше app.js, элементы/функции общие
// через глобальную область видимости document/window.

const log = document.getElementById('chat-log');
const micBtn = document.getElementById('mic-toggle');
const recPanel = document.getElementById('recording-panel');
const recTimerEl = document.getElementById('rec-timer');
const recCanvas = document.getElementById('rec-waveform');
const recCancel = document.getElementById('rec-cancel');
const recSend = document.getElementById('rec-send');
const micErrorEl = document.getElementById('mic-error');

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const MAX_REC_SEC = 120;

let currentAudio = null;
let vmCounter = 0;

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
