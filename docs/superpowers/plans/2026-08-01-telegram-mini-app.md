# Telegram Mini App — голосование в чате — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать участникам лиги (и новым — по инвайт-коду) голосовать через Telegram Mini App,
открывающий существующий сайт внутри Telegram, с настоящей Supabase-сессией и без единой правки
в экране прогноза.

**Architecture:** Новая Edge Function `telegram-auth` проверяет подписанные Telegram-данные
(`initData`, HMAC бот-токеном) и обменивает их на настоящую Supabase-сессию (через
`admin.generateLink` + `verifyOtp` — без пароля, без анонимной Supabase-аутентификации: аккаунт
получает синтетический email вида `tg<id>@telegram.f1predict.local`, о котором пользователь никогда
не узнаёт и не вводит). Дальше весь существующий фронтенд (`AuthContext`, `ProtectedRoute`,
`Predict.tsx`, RLS) работает без изменений — это и есть смысл архитектуры: ноль форков UI.
Новая таблица `telegram_links` хранит связь `telegram_user_id → user_id` отдельно от
`public.users` (та появляется только после ввода инвайт-кода).

**Tech Stack:** Supabase Edge Function (Deno + `@supabase/server`), новая таблица + RLS (Postgres,
cloud-direct раннер, как везде в проекте), React/`AuthContext` (фронтенд), `scripts/telegram/`
(Node, существующий бот).

**Дизайн:** `docs/superpowers/specs/2026-08-01-telegram-mini-app-design.md`

---

### Task 1: Ручная проверка риска блокировки (не блокирует план, но дешёвая и идёт первой)

**Файлы:** нет — чисто ручная проверка.

Сайт на GitHub Pages сейчас недоступен из РФ без VPN (см. `siteLink()` в
`scripts/telegram/notify.js`). Telegram Mini App — это загрузка того же URL внутри WebView
Telegram, а не отдельная инфраструктура; есть риск, что блокировка сработает и там же. Дешевле
узнать сейчас, чем после Task 10.

- [x] **Step 1: Отправить тестовое сообщение с inline-кнопкой `web_app` на текущий сайт**

> **Открытие по ходу:** `web_app`-кнопки — platform-ограничение Telegram Bot API, работают
> только в личке с ботом (`BUTTON_TYPE_INVALID` при попытке поставить в группу). Тест поэтому
> выполнен в личном чате с ботом, а не в общем чате лиги — это же ограничение значит, что реальный
> вход в Mini App тоже должен идти через личку с ботом (например, deep link `t.me/<bot>?startapp=`
> из напоминания в группе, которое несёт обычную `url`-кнопку, а не `web_app`), не напрямую из
> группового сообщения. Учесть при реализации Task 5+ (кнопка «Поставить прогноз» в напоминаниях).

Взять `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` из корневого `.env` (те же, что использует
`scripts/telegram/`), выполнить один раз (PowerShell):

```powershell
$env:BOT_TOKEN = (Select-String -Path .env -Pattern '^TELEGRAM_BOT_TOKEN=(.+)$').Matches[0].Groups[1].Value
$env:CHAT_ID = (Select-String -Path .env -Pattern '^TELEGRAM_CHAT_ID=(.+)$').Matches[0].Groups[1].Value
$body = @{
  chat_id = $env:CHAT_ID
  text = 'Тест: проверка блокировки GitHub Pages внутри Telegram WebView'
  reply_markup = @{ inline_keyboard = @(@(@{ text = 'Открыть сайт'; web_app = @{ url = 'https://konicaru.github.io/f1-predict/' } })) }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "https://api.telegram.org/bot$env:BOT_TOKEN/sendMessage" -Method Post -ContentType 'application/json' -Body $body
```

- [x] **Step 2: С телефона в РФ, нажать кнопку «Открыть сайт» в чате**

**Результат (2026-08-03): ТЕСТ НЕ ПОКАЗАТЕЛЕН.** Кнопка открыла гостевой Календарь внутри
Telegram WebView без ошибок (скриншот), НО у пользователя лично Telegram сам по себе не работает
без VPN — то есть в момент теста VPN был включён на уровне системы/сети, а не только для
Telegram. Это значит, что сайт открылся бы точно так же и в обычном браузере при том же VPN —
тест не изолирует специфичное поведение именно Mini App WebView (проксирует ли Telegram трафик
изнутри себя, в обход системного VPN, или нет — по-прежнему неизвестно).

**Открытие по ходу:** для этого конкретного пользователя вопрос «неудобно включать VPN ради
голосования» Mini App НЕ решает — VPN всё равно нужен, чтобы Telegram вообще работал, значит и
сайт будет открываться тем же VPN что и в обычном браузере, никакой доп. выгоды от WebView. Но
для других друзей по лиге, у кого Telegram работает без VPN (в РФ Telegram и обычные сайты часто
блокируются по-разному, не одним и тем же способом), проверка остаётся открытым вопросом —
корректный тест требует человека, у которого Telegram открывается без VPN, с полностью
выключенным VPN на телефоне.

---

### Task 2: Миграция `0021_telegram_links.sql`

**Files:**
- Create: `supabase/migrations/0021_telegram_links.sql`

- [ ] **Step 1: Написать миграцию**

```sql
-- 0021_telegram_links.sql — связь Telegram-аккаунта с Supabase-пользователем для входа через
-- Mini App (спека docs/superpowers/specs/2026-08-01-telegram-mini-app-design.md). Отдельно от
-- public.users: связь должна существовать ещё ДО того, как появляется строка в public.users (та
-- создаётся только после redeem_invite) — иначе повторное открытие Mini App человеком, который не
-- долистал онбординг, будет распознаваться заново как новый пользователь.
create table public.telegram_links (
  telegram_user_id bigint primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.telegram_links enable row level security;  -- без политик: доступ только из Edge Function (service-role)
```

- [ ] **Step 2: Применить к облаку**

```bash
cd scripts/db
node runner.js applyfile ../../supabase/migrations/0021_telegram_links.sql
```
Expected: `applied: 0021_telegram_links.sql (2 stmts)`, без ошибок.

- [ ] **Step 3: Проверить, что anon и authenticated не имеют доступа**

```bash
node runner.js sql "select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name='telegram_links' and grantee in ('anon','authenticated')"
```
Expected: пустой массив `[]` — Supabase больше не грантит анонимный/authenticated доступ по
умолчанию на новые таблицы (см. `api.auto_expose_new_tables` в `config.toml` — тот класс проблем,
что чинили `0017`-`0020`, здесь уже не воспроизводится по умолчанию, но всё равно стоит проверить
эмпирически, а не полагаться на «должно быть так»).

- [ ] **Step 4: Коммит**

```bash
git add supabase/migrations/0021_telegram_links.sql
git commit -m "feat(db): таблица telegram_links — связь Telegram-аккаунта с пользователем"
```

---

### Task 3: Установить Deno и Supabase CLI, завести Personal Access Token

**Files:**
- Modify: `.env` (добавить `SUPABASE_ACCESS_TOKEN`, gitignored — как остальные секреты)

Deno и Supabase CLI не установлены в этом окружении (проверено `deno --version` /
`supabase --version` — обе команды не найдены). Docker для этого не нужен: `supabase functions
deploy` поддерживает деплой без Docker через API-режим (флаг `--use-api`, доступен с CLI 2.13.3+;
Docker остаётся нужен только для локального `functions serve`, который в этом проекте не
используется — тот же cloud-direct подход, что и везде).

- [ ] **Step 1: Установить Deno (PowerShell)**

```powershell
irm https://deno.land/install.ps1 | iex
```
Закрыть и открыть заново терминал (обновление PATH), затем проверить:
```powershell
deno --version
```
Expected: версия Deno выводится без ошибок.

- [ ] **Step 2: Установить Scoop, если его нет**

```powershell
Get-Command scoop -ErrorAction SilentlyContinue
```
Если пусто — установить:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
irm get.scoop.sh | iex
```

- [ ] **Step 3: Установить Supabase CLI через Scoop**

```powershell
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
supabase --version
```
Expected: версия CLI выводится без ошибок. (npm-установка на Windows официально не
поддерживается — проблемы с PATH/правами, поэтому именно Scoop.)

- [ ] **Step 4: Ручной шаг пользователя — Personal Access Token**

В Supabase Dashboard → account → Access Tokens → **Generate new token**, скопировать токен
(вида `sbp_...`). Добавить в корневой `.env` (файл уже в `.gitignore`, как `SUPABASE_DB_URL`):
```
SUPABASE_ACCESS_TOKEN=sbp_...
```
CLI читает эту переменную окружения напрямую — отдельный `supabase login` не нужен, если она
установлена перед каждой командой (см. Task 6).

- [ ] **Step 5: Коммит**

Не коммитим ничего в этой задаче — `.env` не отслеживается git (`git status` должен остаться
чистым после Step 4).

---

### Task 4: Edge Function — `verify.ts` (проверка подписи Telegram `initData`), TDD

**Files:**
- Create: `supabase/functions/telegram-auth/verify.ts`
- Test: `supabase/functions/telegram-auth/verify.test.ts`

Алгоритм проверки — официальный, из доки Telegram (`core.telegram.org/bots/webapps`):
1. Взять все поля `initData` кроме `hash`, отсортировать по ключу, склеить как `key=value` через
   `\n` — это `data-check-string`.
2. `secret_key = HMAC_SHA256(bot_token, key="WebAppData")`.
3. `computed_hash = HMAC_SHA256(data_check_string, key=secret_key)`, сравнить с полем `hash`.
4. Дополнительно проверить свежесть `auth_date` (защита от повторного использования старых данных).

- [ ] **Step 1: Написать падающий тест**

```ts
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
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

```bash
cd supabase/functions/telegram-auth
deno test --allow-none verify.test.ts
```
Expected: FAIL — `verify.ts` ещё не существует (`Module not found`).

- [ ] **Step 3: Написать `verify.ts`**

```ts
// supabase/functions/telegram-auth/verify.ts
export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export type VerifyResult =
  | { ok: true; user: TelegramUser }
  | { ok: false; reason: string };

export async function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 86400,
): Promise<VerifyResult> {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no hash field' };
  params.delete('hash');

  const pairs = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);
  const dataCheckString = pairs.join('\n');

  const encoder = new TextEncoder();
  const secretKeyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const secretKeyBytes = await crypto.subtle.sign('HMAC', secretKeyMaterial, encoder.encode(botToken));

  const hmacKey = await crypto.subtle.importKey(
    'raw',
    secretKeyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(dataCheckString));
  const computedHash = [...new Uint8Array(signatureBytes)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (computedHash !== hash) return { ok: false, reason: 'signature mismatch' };

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) {
    return { ok: false, reason: 'stale auth_date' };
  }

  const userRaw = params.get('user');
  if (!userRaw) return { ok: false, reason: 'no user field' };
  let user: TelegramUser;
  try {
    user = JSON.parse(userRaw) as TelegramUser;
  } catch {
    return { ok: false, reason: 'user field not valid JSON' };
  }
  if (typeof user.id !== 'number') return { ok: false, reason: 'user.id missing' };

  return { ok: true, user };
}
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

```bash
deno test --allow-none verify.test.ts
```
Expected: `ok | 5 passed | 0 failed`.

- [ ] **Step 5: Коммит**

```bash
git add supabase/functions/telegram-auth/verify.ts supabase/functions/telegram-auth/verify.test.ts
git commit -m "feat(edge-fn): verify.ts — проверка подписи Telegram initData (TDD, 5/5)"
```

---

### Task 5: Edge Function — `index.ts` (обмен initData на Supabase-сессию)

**Files:**
- Create: `supabase/functions/telegram-auth/index.ts`

Использует `@supabase/server` (`withSupabase`) — текущий рекомендуемый способ писать Edge
Functions в Supabase: `ctx.supabaseAdmin` даёт service-role доступ (создание пользователя, магик-
линк), `ctx.supabase` — обычный клиент без прав (нужен именно он для `verifyOtp`, по
задокументированному паттерну «сгенерировать magic link от имени admin → сразу проверить его же
обычным клиентом» — сам magic link никуда не отправляется, это чисто механизм обмена).

- [ ] **Step 1: Написать `index.ts`**

```ts
// supabase/functions/telegram-auth/index.ts
import { withSupabase } from 'npm:@supabase/server';
import { verifyInitData } from './verify.ts';

function syntheticEmail(telegramId: number): string {
  return `tg${telegramId}@telegram.f1predict.local`;
}

export default {
  fetch: withSupabase({ auth: 'publishable' }, async (req, ctx) => {
    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!botToken) {
      return Response.json({ error: 'TELEGRAM_BOT_TOKEN не настроен' }, { status: 500 });
    }

    let initData: string;
    try {
      const body = await req.json();
      initData = body.initData;
      if (typeof initData !== 'string' || !initData) throw new Error('empty');
    } catch {
      return Response.json({ error: 'initData обязателен' }, { status: 400 });
    }

    const verified = await verifyInitData(initData, botToken);
    if (!verified.ok) {
      return Response.json({ error: `initData невалиден: ${verified.reason}` }, { status: 401 });
    }

    const { supabaseAdmin, supabase } = ctx;
    const email = syntheticEmail(verified.user.id);

    let magicLink = await supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email });
    if (magicLink.error) {
      const created = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: {
          telegram_id: verified.user.id,
          telegram_first_name: verified.user.first_name,
          telegram_username: verified.user.username ?? null,
        },
      });
      if (created.error || !created.data.user) {
        return Response.json({ error: `не удалось создать аккаунт: ${created.error?.message}` }, { status: 500 });
      }
      magicLink = await supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email });
      if (magicLink.error) {
        return Response.json({ error: `не удалось выпустить сессию: ${magicLink.error.message}` }, { status: 500 });
      }
    }

    const hashedToken = magicLink.data.properties?.hashed_token;
    if (!hashedToken) {
      return Response.json({ error: 'magic link без hashed_token' }, { status: 500 });
    }

    const verifiedOtp = await supabase.auth.verifyOtp({ token_hash: hashedToken, type: 'email' });
    if (verifiedOtp.error || !verifiedOtp.data.session) {
      return Response.json({ error: `verifyOtp: ${verifiedOtp.error?.message}` }, { status: 500 });
    }

    const userId = verifiedOtp.data.session.user.id;
    await supabaseAdmin.from('telegram_links').upsert(
      { telegram_user_id: verified.user.id, user_id: userId },
      { onConflict: 'telegram_user_id' },
    );

    return Response.json({
      access_token: verifiedOtp.data.session.access_token,
      refresh_token: verifiedOtp.data.session.refresh_token,
    });
  }),
};
```

- [ ] **Step 2: Проверить типы (Deno check)**

```bash
cd supabase/functions/telegram-auth
deno check index.ts
```
Expected: без ошибок. Если `npm:@supabase/server` не резолвится локально без сети/деплоя — это
ожидаемо для `npm:`-специфаеров при первом запуске (Deno кэширует при первом использовании);
исправить в Task 6 (там первый реальный деплой всё равно потянет кэш). Не блокировать эту задачу
на этом одном шаге, если ошибка именно про резолв npm-пакета, а не про типы вашего кода.

- [ ] **Step 3: Коммит**

```bash
git add supabase/functions/telegram-auth/index.ts
git commit -m "feat(edge-fn): telegram-auth — обмен initData на Supabase-сессию"
```

---

### Task 6: Конфиг + деплой Edge Function + секреты + смоук

**Files:**
- Modify: `supabase/config.toml`

- [ ] **Step 1: Отключить платформенную проверку JWT для этой функции**

В `supabase/config.toml`, в конец файла добавить:
```toml
[functions.telegram-auth]
verify_jwt = false
```
(Нужно, потому что вызывающий — человек без сессии вообще, а `auth: 'publishable'` внутри
`withSupabase` сам решает, кого пускать, по publishable-ключу, а не по JWT пользователя.)

- [ ] **Step 2: Задать переменные окружения и задеплоить (PowerShell)**

```powershell
$env:SUPABASE_ACCESS_TOKEN = (Select-String -Path .env -Pattern '^SUPABASE_ACCESS_TOKEN=(.+)$').Matches[0].Groups[1].Value
$env:TG_BOT_TOKEN = (Select-String -Path .env -Pattern '^TELEGRAM_BOT_TOKEN=(.+)$').Matches[0].Groups[1].Value
supabase secrets set TELEGRAM_BOT_TOKEN=$env:TG_BOT_TOKEN --project-ref kolrwuhjjsclqalapfzt
supabase functions deploy telegram-auth --project-ref kolrwuhjjsclqalapfzt --use-api
```
Expected: `Deployed Function telegram-auth` без ошибок. `--use-api` обходит требование Docker
(доступно с Supabase CLI 2.13.3+; если версия старше — CLI и так падает в API-режим сам, если
Docker недоступен, но флаг ставим явно, не полагаемся на автофоллбэк молча).

- [ ] **Step 3: Ручной смоук — вызвать функцию напрямую (без валидного initData, проверяем что не падает 500 на инфраструктуре)**

```powershell
$env:ANON_KEY = (Select-String -Path .env.local -Pattern 'VITE_SUPABASE_ANON_KEY=(.+)').Matches[0].Groups[1].Value
$env:PROJECT_URL = (Select-String -Path .env.local -Pattern 'VITE_SUPABASE_URL=(.+)').Matches[0].Groups[1].Value
Invoke-RestMethod -Uri "$env:PROJECT_URL/functions/v1/telegram-auth" -Method Post `
  -Headers @{ apikey = $env:ANON_KEY; Authorization = "Bearer $env:ANON_KEY" } `
  -ContentType 'application/json' -Body '{"initData":"auth_date=1&hash=deadbeef"}'
```
Expected: HTTP 401 с телом вида `{"error":"initData невалиден: signature mismatch"}` — это
означает, что функция реально задеплоена, отвечает, публично вызываема с anon/publishable
ключом (не требует JWT сессии), и проверка подписи реально исполняется (не падает раньше на
инфраструктурной ошибке). Если вместо этого 401/403 от самой платформы Supabase (не от нашего
кода) — значит `verify_jwt=false` не применился или `auth: 'publishable'` не принимает именно
anon-ключ проекта; в этом случае — стоп, разобраться, прежде чем переходить к Task 7 (фронтенду
не имеет смысла звонить в нерабочую функцию).

- [ ] **Step 4: Коммит**

```bash
git add supabase/config.toml
git commit -m "chore(edge-fn): verify_jwt=false для telegram-auth, задеплоено"
```

---

### Task 7: Фронтенд — bootstrap Telegram-сессии в `AuthContext` + диплинк на гонку

**Files:**
- Modify: `index.html`
- Modify: `src/auth/AuthContext.tsx`
- Create: `src/lib/telegram.ts`
- Modify: `src/auth/RootRedirect.tsx`

> **Правка после Task 1:** кнопка в напоминаниях (Task 9) — не `web_app`, а `url` на
> `t.me/<bot>?startapp=predict_<raceId>` (platform-ограничение группы, см. правку в спеке). Payload
> приходит как `start_param` в `initDataUnsafe`; эта задача добавляет его чтение и редирект.

- [ ] **Step 1: Подключить официальный Telegram Web App SDK**

В `index.html`, внутри `<head>`, добавить строки перед закрывающим `</head>`:
```html
<!-- Без Subresource Integrity намеренно: Telegram версионирует и обновляет этот файл на своей
     стороне без анонса (канонический URL в их доке содержит query-версию, напр. ?63) — захардко-
     женный SRI-хеш сломает Mini App при следующем обновлении скрипта, без понятной ошибки. -->
<script src="https://telegram.org/js/telegram-web-app.js"></script>
```

- [ ] **Step 2: Добавить bootstrap-обмен в `AuthContext.tsx`**

Текущий `useEffect` (строки 46-57) заменить на:
```tsx
  useEffect(() => {
    async function init() {
      const tg = (window as any).Telegram?.WebApp;
      const initData: string | undefined = tg?.initData;
      if (initData) {
        try {
          const { data, error } = await supabase.functions.invoke('telegram-auth', { body: { initData } });
          if (!error && data?.access_token && data?.refresh_token) {
            await supabase.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
          }
        } catch {
          // Обмен не удался -> просто продолжаем как обычный неавторизованный визит (см. ниже).
        }
      }
      const { data: sessionData } = await supabase.auth.getSession();
      setSession(sessionData.session);
      await loadMembership(sessionData.session);
      setLoading(false);
    }
    init();
    const { data: sub } = supabase.auth.onAuthStateChange(async (_e, s) => {
      setSession(s);
      await loadMembership(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);
```

- [ ] **Step 3: Диплинк на конкретную гонку — `src/lib/telegram.ts`**

```ts
// src/lib/telegram.ts
export function getTelegramDeepLinkRaceId(): number | null {
  const tg = (window as any).Telegram?.WebApp;
  const startParam: string | undefined = tg?.initDataUnsafe?.start_param;
  const match = startParam?.match(/^predict_(\d+)$/);
  return match ? Number(match[1]) : null;
}
```

- [ ] **Step 4: `RootRedirect.tsx` — редирект на гонку из диплинка**

Файл целиком:
```tsx
import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getTelegramDeepLinkRaceId } from '../lib/telegram';

// Корень сайта: есть сессия -> обычный кабинет участника (или конкретная гонка из диплинка
// напоминания), нет сессии -> гостевой просмотр.
export function RootRedirect() {
  const { session, loading } = useAuth();
  if (loading) return <div style={{ padding: 24, color: '#fff' }}>Загрузка…</div>;
  if (!session) return <Navigate to="/g/calendar" replace />;
  const raceId = getTelegramDeepLinkRaceId();
  return <Navigate to={raceId ? `/predict/${raceId}` : '/calendar'} replace />;
}
```
`start_param` читается заново при каждом рендере (не кэшируется) — если сессии ещё нет
(`is_member()` = false), `ProtectedRoute` уведёт на `/redeem`; после успешного `redeem_invite()`
`RedeemInvite.tsx` делает `nav('/')`, который снова попадает в `RootRedirect` и снова находит тот
же `start_param` — пользователь всё равно окажется на нужной гонке, а не на общем календаре.

- [ ] **Step 5: Проверить типы и собрать**

```bash
npm run build
```
Expected: без ошибок. (`npx tsc -b --noEmit` отдельно ломается на не связанной с этим проектом
преждевременно известной проблеме TS6310 в `tsconfig.node.json` — используем `npm run build` как
реальную проверку, как и во всех предыдущих ветках этого проекта.)

- [ ] **Step 6: Коммит**

```bash
git add index.html src/auth/AuthContext.tsx src/lib/telegram.ts src/auth/RootRedirect.tsx
git commit -m "feat(frontend): AuthContext — обмен Telegram initData на сессию + диплинк на гонку из напоминания"
```

---

### Task 8: `RedeemInvite.tsx` — подставлять имя из Telegram

**Files:**
- Modify: `src/pages/RedeemInvite.tsx`

- [ ] **Step 1: Предзаполнить поле имени из Telegram, если приложение открыто внутри Mini App**

Строку:
```tsx
  const [name, setName] = useState('');
```
заменить на:
```tsx
  const tgUser = (window as any).Telegram?.WebApp?.initDataUnsafe?.user;
  const [name, setName] = useState(tgUser?.first_name ?? tgUser?.username ?? '');
```

(`initDataUnsafe` — клиентское, непроверенное представление тех же данных, которые сервер уже
проверил в `telegram-auth`; здесь оно используется только для UX-подсказки имени, не для
авторизации — сама авторизация давно прошла к этому моменту через настоящую сессию.)

- [ ] **Step 2: Проверить типы и собрать**

```bash
npm run build
```
Expected: без ошибок.

- [ ] **Step 3: Коммит**

```bash
git add src/pages/RedeemInvite.tsx
git commit -m "feat(frontend): RedeemInvite — подставлять имя из Telegram внутри Mini App"
```

---

### Task 9: Кнопка «Поставить прогноз» в напоминаниях

**Files:**
- Modify: `scripts/telegram/lib.js`
- Modify: `scripts/telegram/notify.js`
- Test: `scripts/telegram/notify.test.js` (дополнить существующий)

- [ ] **Step 1: Добавить поддержку `reply_markup` в `sendTelegram`**

В `scripts/telegram/lib.js`, функцию `sendTelegram` заменить на:
```js
async function sendTelegram(text, replyMarkup) {
  const token = readEnv('TELEGRAM_BOT_TOKEN');
  const chatId = readEnv('TELEGRAM_CHAT_ID');
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  return data;
}
```

- [ ] **Step 2: Добавить хелпер и кнопку в `deadline()`**

> **Правка после Task 1:** `web_app`-кнопки работают только в личке с ботом, а напоминания уходят
> в общий чат лиги (группа) — там такая кнопка отклоняется с `BUTTON_TYPE_INVALID` (проверено
> эмпирически). Используем обычную `url`-кнопку на `t.me/<bot>?startapp=predict_<raceId>` —
> Telegram сам открывает по ней Mini App, payload приходит как `start_param` (см. Task 7 Step 3-4).

В `scripts/telegram/notify.js` добавить рядом с `SITE_URL`:
```js
const BOT_USERNAME = 'che_f1_predict_bot';
```
и рядом с `siteLink`:
```js
function predictButton(raceId) {
  return { inline_keyboard: [[{ text: 'Поставить прогноз', url: `https://t.me/${BOT_USERNAME}?startapp=predict_${raceId}` }]] };
}
```

В функции `deadline()` (строки 62-86) заменить вызов:
```js
    await sendTelegram(text);
    console.log(`deadline: отправлено для ${r.name}`);
```
на:
```js
    await sendTelegram(text, predictButton(r.id));
    console.log(`deadline: отправлено для ${r.name}`);
```

- [ ] **Step 3: Добавить тест `predictButton` в `notify.test.js`**

В `scripts/telegram/notify.test.js`, изменить первую строку экспорта на:
```js
const { isMskThursday, notVotedNames, podiumText, roundWinnerLine, rankStandings, predictButton } = require('./notify');
```
Добавить в конец файла (перед финальным выводом итога, если он там есть — проверить, как файл
заканчивается сейчас, и вставить перед выводом счётчика `fail`):
```js
if (!check(
  'predictButton: корректная структура inline-кнопки',
  predictButton(42),
  { inline_keyboard: [[{ text: 'Поставить прогноз', url: 'https://t.me/che_f1_predict_bot?startapp=predict_42' }]] },
)) fail++;
```

- [ ] **Step 4: Экспортировать `predictButton` из `notify.js`**

Строку:
```js
module.exports = { isMskThursday, notVotedNames, podiumText, roundWinnerLine, rankStandings };
```
заменить на:
```js
module.exports = { isMskThursday, notVotedNames, podiumText, roundWinnerLine, rankStandings, predictButton };
```

- [ ] **Step 5: Прогнать тесты**

```bash
cd scripts/telegram
node notify.test.js
```
Expected: все PASS, включая новый.

- [ ] **Step 6: Коммит**

```bash
git add scripts/telegram/lib.js scripts/telegram/notify.js scripts/telegram/notify.test.js
git commit -m "feat(telegram): кнопка «Поставить прогноз» в напоминаниях о дедлайне"
```

---

### Task 10: Ручная настройка бота + сквозной смоук

**Files:** нет — ручные шаги + чек-лист.

- [ ] **Step 1: BotFather — Menu Button**

В чате с [@BotFather](https://t.me/BotFather): `/mybots` → выбрать бота лиги → **Bot Settings**
→ **Menu Button** → **Configure Menu Button** → URL: `https://konicaru.github.io/f1-predict/` →
текст кнопки, например «Открыть лигу».

- [ ] **Step 2: Сквозной смоук — новый пользователь**

С телефона, где Telegram-аккаунт ещё не привязан ни к одному участнику лиги:
1. Нажать кнопку меню бота → открывается Mini App.
2. Должен появиться экран `/redeem` с именем, предзаполненным из Telegram.
3. Ввести реальный инвайт-код → должен попасть на Календарь.
4. Закрыть Mini App полностью и открыть заново → должен попасть на Календарь сразу, без экрана
   инвайт-кода (сессия уже привязана через `telegram_links`).

- [ ] **Step 3: Сквозной смоук — напоминание**

Вручную запустить `deadline` (или дождаться расписания), убедиться что в чате пришло сообщение с
кнопкой «Поставить прогноз», нажатие открывает Mini App сразу на `/predict/<id>` нужной гонки.

- [ ] **Step 4: Проверить, что обычный вход с сайта не сломался**

Открыть сайт в обычном браузере (не в Telegram) → `window.Telegram` не определён → бутстрап-код
в `AuthContext` просто пропускает Telegram-обмен (`tg?.initData` = `undefined`) → обычный
email/пароль вход работает как раньше.

- [ ] **Step 5: Финальная регрессия**

```bash
cd scripts/db && npm test && npm run test:rls && npm run test:security_grants && npm run test:predicted_user_ids && npm run test:gridbot && npm run test:guest_access
cd ../telegram && node notify.test.js
cd ../../supabase/functions/telegram-auth && deno test --allow-none verify.test.ts
cd ../../.. && npm run build
```
Expected: все зелёные.
