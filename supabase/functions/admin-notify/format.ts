export type ResolvedEvent =
  | { event_type: 'registration'; display_name: string }
  | { event_type: 'prediction'; display_name: string; race_name: string }
  | { event_type: 'result'; race_name: string };

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildMessage(event: ResolvedEvent): string {
  switch (event.event_type) {
    case 'registration':
      return `🆕 Новый участник: ${escapeHtml(event.display_name)}`;
    case 'prediction':
      return `📝 ${escapeHtml(event.display_name)} поставил прогноз на ${escapeHtml(event.race_name)}`;
    case 'result':
      return `🏁 Результат гонки ${escapeHtml(event.race_name)} занесён в систему`;
  }
}

export function isQuietHours(date: Date): boolean {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  const mskHour = Number(formatted);
  return mskHour < 10 || mskHour >= 22;
}
