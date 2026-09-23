export type ResolvedEvent =
  | { event_type: 'registration'; display_name: string }
  | { event_type: 'prediction'; display_name: string; race_name: string; joke?: string }
  | { event_type: 'result'; race_name: string }
  | {
      event_type: 'pool_change';
      race_name: string;
      driver_code: string;
      driver_name: string;
      action: 'added' | 'out';
      reason?: string;
    };

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildMessage(event: ResolvedEvent): string {
  switch (event.event_type) {
    case 'registration':
      return `🆕 Новый участник: ${escapeHtml(event.display_name)}`;
    case 'prediction': {
      const head = `📝 ${escapeHtml(event.display_name)} поставил прогноз на ${escapeHtml(event.race_name)}`;
      // Шутка идёт одним блоком с уведомлением, а не отдельным сообщением: админ пересылает
      // это в общий чат штатным «Переслать», и пересылать удобнее что-то одно.
      return event.joke ? `${head}\n\n${escapeHtml(event.joke)}` : head;
    }
    case 'result':
      return `🏁 Результат гонки ${escapeHtml(event.race_name)} занесён в систему`;
    case 'pool_change': {
      const driver = `${escapeHtml(event.driver_name)} (${escapeHtml(event.driver_code)})`;
      const reason = event.reason ? ` — ${escapeHtml(event.reason)}` : '';
      if (event.action === 'added') {
        return `🔄 ${escapeHtml(event.race_name)}: ${driver} добавлен в состав${reason}.`;
      }
      return `🔄 ${escapeHtml(event.race_name)}: ${driver} отмечен как не участвует${reason}.`;
    }
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
