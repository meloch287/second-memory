// Подсистема настроек «Второй памяти»: модалка настроек (фокус-трап), смена
// имени/пароля, подключение Telegram, «меньше движения», баннер смены пароля,
// веб-напоминания и полноэкранный режим чата. Классический скрипт (не модуль).

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
