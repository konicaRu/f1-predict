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

Deno.test('buildMessage: registration — экранирует HTML в display_name', () => {
  const text = buildMessage({ event_type: 'registration', display_name: '<b>Дима</b> & co' });
  assertEquals(text, '🆕 Новый участник: &lt;b&gt;Дима&lt;/b&gt; &amp; co');
});

Deno.test('buildMessage: prediction — экранирует HTML в display_name и race_name', () => {
  const text = buildMessage({
    event_type: 'prediction',
    display_name: '<script>Дима</script>',
    race_name: 'Belgian & Dutch Grand Prix',
  });
  assertEquals(
    text,
    '📝 &lt;script&gt;Дима&lt;/script&gt; поставил прогноз на Belgian &amp; Dutch Grand Prix',
  );
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

Deno.test('buildMessage: pool_change — добавлен в состав', () => {
  const text = buildMessage({
    event_type: 'pool_change',
    race_name: 'Italian Grand Prix',
    driver_code: 'TSU',
    driver_name: 'Yuki Tsunoda',
    action: 'added',
  });
  assertEquals(text, '🔄 Italian Grand Prix: Yuki Tsunoda (TSU) добавлен в состав.');
});

Deno.test('buildMessage: pool_change — не участвует, с причиной', () => {
  const text = buildMessage({
    event_type: 'pool_change',
    race_name: 'Italian Grand Prix',
    driver_code: 'HAD',
    driver_name: 'Isack Hadjar',
    action: 'out',
    reason: 'Травма запястья',
  });
  assertEquals(text, '🔄 Italian Grand Prix: Isack Hadjar (HAD) отмечен как не участвует — Травма запястья.');
});

Deno.test('buildMessage: pool_change — не участвует, без причины', () => {
  const text = buildMessage({
    event_type: 'pool_change',
    race_name: 'Italian Grand Prix',
    driver_code: 'HAD',
    driver_name: 'Isack Hadjar',
    action: 'out',
  });
  assertEquals(text, '🔄 Italian Grand Prix: Isack Hadjar (HAD) отмечен как не участвует.');
});

Deno.test('buildMessage: pool_change — экранирует HTML в причине', () => {
  const text = buildMessage({
    event_type: 'pool_change',
    race_name: 'Italian Grand Prix',
    driver_code: 'HAD',
    driver_name: 'Isack Hadjar',
    action: 'out',
    reason: '<b>травма</b>',
  });
  assertEquals(text, '🔄 Italian Grand Prix: Isack Hadjar (HAD) отмечен как не участвует — &lt;b&gt;травма&lt;/b&gt;.');
});
