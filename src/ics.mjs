// Генерация .ics (iCalendar) из записей пользователя - встречи и задачи
// со временем. Без зависимостей.

const pad = (n) => String(n).padStart(2, '0');

function toIcsUtc(iso) {
  const d = new Date(iso);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`
  );
}

function escapeIcs(s) {
  return String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
}

// Отрезает от строки кусок не длиннее limit БАЙТ (utf-8), не разрывая символ:
// кириллица - 2 байта на букву, счёт по символам ломал RFC-лимит.
function takeBytes(s, limit) {
  let bytes = 0;
  let i = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > limit) break;
    bytes += b;
    i += ch.length;
  }
  return [s.slice(0, i), s.slice(i)];
}

function fold(line) {
  // RFC 5545: строки длиннее 75 октетов складываются (считаем октеты!)
  if (Buffer.byteLength(line, 'utf8') <= 74) return line;
  const parts = [];
  let [head, rest] = takeBytes(line, 74);
  parts.push(head);
  while (rest) {
    const [h, r] = takeBytes(rest, 73);
    parts.push(' ' + h);
    rest = r;
  }
  return parts.join('\r\n');
}

// entries: массив записей с due (ISO) и title. stampIso - момент генерации.
export function buildIcs(entries, stampIso) {
  const stamp = toIcsUtc(stampIso);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Вторая память//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  let n = 0;
  for (const e of entries) {
    if (!e.due) continue;
    const start = new Date(e.due);
    const end = new Date(start.getTime() + 60 * 60000); // час по умолчанию
    const kind = e.type === 'meeting' ? 'Встреча' : e.type === 'debt' ? 'Долг' : 'Задача';
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:sm-${e.id || ++n}-${stamp}@vtoraya-pamyat`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART:${toIcsUtc(e.due)}`);
    lines.push(`DTEND:${toIcsUtc(end.toISOString())}`);
    lines.push(fold(`SUMMARY:${escapeIcs(e.title || e.counterparty || kind)}`));
    if (e.amount != null) lines.push(fold(`DESCRIPTION:${escapeIcs(kind)}: ${e.amount} руб`));
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
