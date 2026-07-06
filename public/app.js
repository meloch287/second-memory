// Клиент «Второй памяти»: чат + панель категорий.
// Доступность: см. чек-листы в README (live regions, фокус, клавиатура).

const form = document.getElementById('composer');
const input = document.getElementById('message-input');
const log = document.getElementById('chat-log');
const statusEl = document.getElementById('chat-status');
const hintEl = document.getElementById('form-hint');
const micBtn = document.getElementById('mic-toggle');
const aside = document.querySelector('.panel');

const RUB = new Intl.NumberFormat('ru-RU');
let pending = false;

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function scrollLogToBottom() {
  log.scrollTo({ top: log.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

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

  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  log.appendChild(wrap);
  if (nearBottom) scrollLogToBottom();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (pending) return;

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
  pending = true;

  const typingTimer = setTimeout(() => {
    statusEl.textContent = 'Ассистент печатает…';
  }, 2000);

  try {
    const res = await fetch('/api/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    clearTimeout(typingTimer);
    statusEl.textContent = '';
    appendMessage('assistant', data.reply || '…');
    // Панель обновляем отдельным тиком, чтобы не мешать объявлению ответа
    // (requestAnimationFrame не подходит: замирает в фоновых вкладках).
    setTimeout(refreshMemory, 50);
  } catch {
    clearTimeout(typingTimer);
    statusEl.textContent = '';
    appendMessage('assistant', 'Не удалось получить ответ. Проверьте, что сервер запущен, и попробуйте ещё раз.');
  } finally {
    pending = false;
  }
});

input.addEventListener('input', () => {
  if (input.value.trim()) {
    input.removeAttribute('aria-invalid');
    hintEl.textContent = '';
  }
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    input.value = chip.dataset.msg || chip.textContent.trim();
    input.focus();
    form.requestSubmit();
  });
});

/* ---- Панель «Память» ---- */

const CATEGORIES = [
  ['debt', 'Долги', 'Пока нет долгов'],
  ['meeting', 'Встречи', 'Пока нет встреч'],
  ['task', 'Задачи', 'Пока нет задач'],
  ['note', 'Заметки', 'Пока нет заметок'],
];

function fmtDue(e) {
  const d = new Date(e.due);
  const pad = (n) => String(n).padStart(2, '0');
  let s = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  if (e.hasTime) s += ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return s;
}

function itemLabel(e) {
  const parts = [`№${e.id}`];
  if (e.type === 'debt') {
    parts.push(e.counterparty || 'Без имени');
    if (e.amount != null) parts.push('— ' + RUB.format(e.amount) + ' ₽');
    if (e.direction === 'out') parts.push('(вы должны)');
  } else {
    parts.push(e.title || e.text || '');
  }
  if (e.due) parts.push('· ' + fmtDue(e));
  return parts.join(' ');
}

async function refreshMemory() {
  let entries;
  try {
    const res = await fetch('/api/entries?status=open');
    ({ entries } = await res.json());
  } catch {
    return; // панель просто не обновится, чат продолжает работать
  }

  const hadFocusInAside = aside.contains(document.activeElement);

  for (const [type, label, emptyText] of CATEGORIES) {
    const items = entries.filter((e) => e.type === type);
    document.getElementById('h-' + type).textContent = `${label} (${items.length})`;

    const ul = document.getElementById('list-' + type);
    ul.textContent = '';
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty-state';
      li.textContent = emptyText;
      ul.appendChild(li);
    } else {
      for (const e of items.slice(0, 8)) {
        const li = document.createElement('li');
        li.textContent = itemLabel(e);
        ul.appendChild(li);
      }
      if (items.length > 8) {
        const li = document.createElement('li');
        li.className = 'empty-state';
        li.textContent = `…и ещё ${items.length - 8}`;
        ul.appendChild(li);
      }
    }
  }

  if (hadFocusInAside && !aside.contains(document.activeElement)) {
    document.getElementById('memory-heading').focus();
  }
}

/* ---- Голосовой ввод (Web Speech API, если поддерживается) ---- */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  micBtn.hidden = false;
  let recognition = null;

  micBtn.addEventListener('click', () => {
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new SR();
    recognition.lang = 'ru-RU';
    recognition.interimResults = false;

    recognition.onresult = (ev) => {
      const transcript = Array.from(ev.results)
        .map((r) => r[0].transcript)
        .join(' ')
        .trim();
      if (transcript) {
        input.value = input.value ? input.value + ' ' + transcript : transcript;
      }
    };
    recognition.onend = () => {
      recognition = null;
      micBtn.setAttribute('aria-pressed', 'false');
      micBtn.setAttribute('aria-label', 'Голосовой ввод');
      statusEl.textContent = 'Диктовка выключена';
      input.focus();
    };
    recognition.onerror = () => {};

    micBtn.setAttribute('aria-pressed', 'true');
    micBtn.setAttribute('aria-label', 'Остановить голосовой ввод');
    statusEl.textContent = 'Диктовка включена';
    recognition.start();
  });
}

refreshMemory();
