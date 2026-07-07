// Утилиты времени: каунтдаун до дедлайна, признак «прошёл», дата в МСК.
export function msUntil(deadlineUtc: string, now: number = Date.now()): number {
  return new Date(deadlineUtc).getTime() - now;
}

export function isPast(deadlineUtc: string, now: number = Date.now()): boolean {
  return msUntil(deadlineUtc, now) <= 0;
}

export function formatCountdown(deadlineUtc: string, now: number = Date.now()): string {
  const ms = msUntil(deadlineUtc, now);
  if (ms <= 0) return 'дедлайн прошёл';
  const min = Math.floor(ms / 60000);
  const d = Math.floor(min / (60 * 24));
  const h = Math.floor((min % (60 * 24)) / 60);
  const m = min % 60;
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

export function formatMoscow(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}
