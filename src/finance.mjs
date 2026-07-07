// Финансовая сводка по долгам пользователя: сколько должны тебе, сколько
// должен ты, чистый баланс, крупнейший должник, просрочка.

import { money, pad } from './format.mjs';
const fmtDay = (iso, off = 180) => {
  const d = new Date(new Date(iso).getTime() + off * 60000);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
};

// Сводка трат за текущий месяц по категориям (№7).
export function expensesReport(store, chatId, offsetMin = 180, now = Date.now()) {
  if (!chatId) return 'Пока трат нет.';
  const w = new Date(now + offsetMin * 60000);
  const monthStart = Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), 1) - offsetMin * 60000;
  const exp = store
    .list({ type: 'expense', chatId })
    .filter((e) => Date.parse(e.createdAt) >= monthStart);
  if (!exp.length) return 'В этом месяце трат пока не записано. Скажи «потратил 500 на кофе» - учту.';

  const byCat = new Map();
  let total = 0;
  for (const e of exp) {
    const cat = e.category || e.title || 'Разное';
    byCat.set(cat, (byCat.get(cat) || 0) + (e.amount || 0));
    total += e.amount || 0;
  }
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const lines = [`💸 Траты за ${months[w.getUTCMonth()]}: ${money(total)}`, ''];
  for (const [cat, sum] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${cat}: ${money(sum)}`);
  }
  return lines.join('\n');
}

export function balanceReport(store, chatId, offsetMin = 180, now = Date.now()) {
  if (!chatId) return 'Долгов нет.'; // без chatId не агрегируем всех
  const debts = store.list({ type: 'debt', status: 'open', chatId });
  const inD = debts.filter((d) => d.direction !== 'out');
  const outD = debts.filter((d) => d.direction === 'out');
  const sum = (arr) => arr.reduce((s, d) => s + (d.amount || 0), 0);
  const owedToMe = sum(inD);
  const iOwe = sum(outD);

  if (!debts.length) return 'Долгов нет - ни тебе, ни ты. Красота 🙂';

  const lines = ['💰 Баланс по долгам:', ''];
  lines.push(`Тебе должны: ${money(owedToMe)} (${inD.length})`);
  lines.push(`Ты должен: ${money(iOwe)} (${outD.length})`);
  const net = owedToMe - iOwe;
  lines.push(`Итого в твою пользу: ${net >= 0 ? '+' : ''}${money(net)}`);

  const biggest = inD.filter((d) => d.amount).sort((a, b) => b.amount - a.amount)[0];
  if (biggest && biggest.counterparty) {
    lines.push('', `Больше всех должен: ${biggest.counterparty} - ${money(biggest.amount)}`);
  }

  const overdue = debts.filter((d) => d.due && Date.parse(d.due) < now);
  if (overdue.length) {
    lines.push('', `Просрочено (${overdue.length}):`);
    for (const d of overdue.slice(0, 5)) {
      const who = d.counterparty || 'без имени';
      const dir = d.direction === 'out' ? 'ты должен' : 'должен тебе';
      lines.push(`  • ${who} (${dir}) ${d.amount != null ? money(d.amount) : ''}, срок был ${fmtDay(d.due, offsetMin)}`);
    }
  }
  return lines.join('\n');
}
