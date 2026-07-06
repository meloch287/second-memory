// Финансовая сводка по долгам пользователя: сколько должны тебе, сколько
// должен ты, чистый баланс, крупнейший должник, просрочка.

const RUB = new Intl.NumberFormat('ru-RU');
const money = (v) => `${RUB.format(v)} ₽`;
const pad = (n) => String(n).padStart(2, '0');
const fmtDay = (iso, off = 180) => {
  const d = new Date(new Date(iso).getTime() + off * 60000);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
};

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
