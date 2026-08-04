// supabase/functions/telegram-auth/verify.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { createHmac } from 'node:crypto';
import { verifyInitData } from './verify.ts';

// Независимая (от Web Crypto в verify.ts) реализация того же документированного алгоритма —
// через node:crypto, чтобы тест не был тавтологией "implementation проверяет сама себя".
function buildInitData(fields: Record<string, string>, botToken: string): string {
  const pairs = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  const dataCheckString = pairs.join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const BOT_TOKEN = 'test-bot-token-123';

Deno.test('валидная подпись и свежий auth_date -> принято, user распарсен', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const user = JSON.stringify({ id: 42, first_name: 'Тест', username: 'testuser' });
  const initData = buildInitData({ auth_date: String(nowSec), query_id: 'AAA', user }, BOT_TOKEN);
  const result = await verifyInitData(initData, BOT_TOKEN);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.user.id, 42);
    assertEquals(result.user.first_name, 'Тест');
    assertEquals(result.user.username, 'testuser');
  }
});

Deno.test('подделанное поле после подписи -> отклонено', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const user = JSON.stringify({ id: 42, first_name: 'Тест' });
  const initData = buildInitData({ auth_date: String(nowSec), query_id: 'AAA', user }, BOT_TOKEN);
  const params = new URLSearchParams(initData);
  params.set('query_id', 'TAMPERED');
  const result = await verifyInitData(params.toString(), BOT_TOKEN);
  assertEquals(result.ok, false);
});

Deno.test('устаревший auth_date -> отклонено даже с верной подписью', async () => {
  const oldSec = Math.floor(Date.now() / 1000) - 999999;
  const user = JSON.stringify({ id: 42, first_name: 'Тест' });
  const initData = buildInitData({ auth_date: String(oldSec), query_id: 'AAA', user }, BOT_TOKEN);
  const result = await verifyInitData(initData, BOT_TOKEN, 86400);
  assertEquals(result.ok, false);
});

Deno.test('неверный bot token -> отклонено', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const user = JSON.stringify({ id: 42, first_name: 'Тест' });
  const initData = buildInitData({ auth_date: String(nowSec), query_id: 'AAA', user }, BOT_TOKEN);
  const result = await verifyInitData(initData, 'different-token');
  assertEquals(result.ok, false);
});

Deno.test('нет поля hash -> отклонено', async () => {
  const result = await verifyInitData('auth_date=123&query_id=AAA', BOT_TOKEN);
  assertEquals(result.ok, false);
});
