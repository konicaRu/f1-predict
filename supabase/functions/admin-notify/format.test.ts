import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildMessage, isQuietHours } from './format.ts';

Deno.test('buildMessage: registration', () => {
  const text = buildMessage({ event_type: 'registration', display_name: 'Дима' });
  assertEquals(text, '🆕 Новый участник: Дима');
});

Deno.test('buildMessage: prediction', () => {
  const text = buildMessage({
    event_type: 'prediction',
    display_name: 'Дима',
    race_name: 'Belgian Grand Prix',
  });
  assertEquals(text, '📝 Дима поставил прогноз на Belgian Grand Prix');
});

Deno.test('buildMessage: result', () => {
  const text = buildMessage({ event_type: 'result', race_name: 'Belgian Grand Prix' });
  assertEquals(text, '🏁 Результат гонки Belgian Grand Prix занесён в систему');
});

Deno.test('isQuietHours: 09:59 МСК (06:59 UTC) -> тихо', () => {
  assertEquals(isQuietHours(new Date('2026-08-06T06:59:00Z')), true);
});

Deno.test('isQuietHours: 10:00 МСК (07:00 UTC) -> не тихо', () => {
  assertEquals(isQuietHours(new Date('2026-08-06T07:00:00Z')), false);
});

Deno.test('isQuietHours: 21:59 МСК (18:59 UTC) -> не тихо', () => {
  assertEquals(isQuietHours(new Date('2026-08-06T18:59:00Z')), false);
});

Deno.test('isQuietHours: 22:00 МСК (19:00 UTC) -> тихо', () => {
  assertEquals(isQuietHours(new Date('2026-08-06T19:00:00Z')), true);
});

Deno.test('isQuietHours: 00:00 МСК (21:00 UTC предыдущего дня) -> тихо', () => {
  assertEquals(isQuietHours(new Date('2026-08-05T21:00:00Z')), true);
});
