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

function fold(line) {
  // RFC 5545: строки длиннее 75 октетов складываются
  if (line.length <= 74) return line;
  const parts = [];
  let rest = line;
  parts.push(rest.slice(0, 74));
  rest = rest.slice(74);
  while (rest.length > 73) {
    parts.push(' ' + rest.slice(0, 73));
    rest = rest.slice(73);
  }
  if (rest) parts.push(' ' + rest);
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
