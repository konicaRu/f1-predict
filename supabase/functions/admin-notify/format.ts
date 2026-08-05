export type ResolvedEvent =
  | { event_type: 'registration'; display_name: string }
  | { event_type: 'prediction'; display_name: string; race_name: string }
  | { event_type: 'result'; race_name: string };

export function buildMessage(event: ResolvedEvent): string {
  switch (event.event_type) {
    case 'registration':
      return `🆕 Новый участник: ${event.display_name}`;
    case 'prediction':
      return `📝 ${event.display_name} поставил прогноз на ${event.race_name}`;
    case 'result':
      return `🏁 Результат гонки ${event.race_name} занесён в систему`;
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
