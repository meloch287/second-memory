// Клиент «Второй памяти»: чат, панель категорий, голосовые сообщения
// с транскрибацией (MediaRecorder + Web Speech API).
// Доступность — по чек-листам a11y-команды: live-регионы, roving tabindex,
// двойное фокус-кольцо на синем пузыре, тексты объявлений на русском.

const form = document.getElementById('composer');
const input = document.getElementById('message-input');
const statusEl = document.getElementById('chat-status');
const hintEl = document.getElementById('form-hint');
const sendBtn = form.querySelector('.btn-send');

let pending = false;
let recState = null;
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

/* ---- Старт ---- */

(async function boot() {
  const ok = await loadSettings();
  if (ok) showApp(false);
  else showLogin();
})();
