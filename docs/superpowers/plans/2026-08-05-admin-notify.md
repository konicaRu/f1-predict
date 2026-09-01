# Admin-уведомления в Telegram — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Владелец лиги получает в личку с ботом Telegram-уведомления о трёх событиях —
новая регистрация, новый прогноз (в т.ч. от GridBot), результат гонки занесён — мгновенно в
дневные часы (10:00–22:00 МСК) и одной пачкой утром за ночь, без опроса БД по расписанию.

**Architecture:** Postgres-триггеры (`AFTER INSERT`/`AFTER UPDATE`) на `users`/`predictions`/
`results` асинхронно (`pg_net`) шлют событие в новую Edge Function `admin-notify`. Она строит
текст и либо сразу шлёт в Telegram (день), либо кладёт в таблицу-очередь `admin_notification_queue`
(ночь). Раз в сутки (10:05 МСК) новый режим `adminflush` в уже существующем `notify.js`
разгружает очередь через уже существующий cron-workflow.

**Tech Stack:** Postgres-миграция (`pg_net`), Supabase Edge Function (Deno + `@supabase/server`,
тот же паттерн, что `telegram-auth`), Node (`scripts/telegram/`, существующий).

**Дизайн:** `docs/superpowers/specs/2026-08-05-admin-notify-design.md`

**Перед Task 1:** это план для проекта на ветке `main` (в отличие от предыдущей фичи
Telegram Mini App, которая на момент написания этого плана ещё не влита с ветки
`telegram-mini-app` и уже заняла номера миграций `0021`/`0022`). Перед тем как создавать файл
миграции в Task 1, выполнить `ls supabase/migrations | tail -5` — если `0021`/`0022` уже реально
существуют в `main` (ветка успела влиться), следующий свободный номер и так `0023`, ничего не
менять. Если станет больше занятых номеров к моменту исполнения — increment `0023` до
следующего свободного и **везде** в этом плане (SQL-комментарий, имя файла, команда `applyfile`)
использовать этот же новый номер вместо `0023`.

---

### Task 1: Миграция `0023_admin_notify.sql` — очередь, триггеры, `pg_net`

**Files:**
- Create: `supabase/migrations/0023_admin_notify.sql`

- [ ] **Step 1: Написать миграцию**

```sql
-- 0023_admin_notify.sql — событийные admin-уведомления в Telegram (спека
-- docs/superpowers/specs/2026-08-05-admin-notify-design.md). AFTER-триггеры на регистрацию/
-- прогноз/результат асинхронно (pg_net, без блокировки записи) шлют событие в Edge Function
-- admin-notify, которая решает — слать сразу в Telegram или положить в очередь на утро.
create extension if not exists pg_net;

create table public.admin_notification_queue (
  id bigint generated always as identity primary key,
  text text not null,
  created_at timestamptz not null default now()
);
alter table public.admin_notification_queue enable row level security;  -- без политик: только service-role
revoke all on public.admin_notification_queue from anon, authenticated;

create or replace function public.notify_admin_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_type text;
  v_payload jsonb;
begin
  if tg_table_name = 'users' then
    v_event_type := 'registration';
    v_payload := jsonb_build_object(
      'display_name', new.display_name,
      'telegram_username', new.telegram_username
    );
  elsif tg_table_name = 'predictions' then
    v_event_type := 'prediction';
    v_payload := jsonb_build_object('user_id', new.user_id, 'race_id', new.race_id);
  elsif tg_table_name = 'results' then
    v_event_type := 'result';
    v_payload := jsonb_build_object('race_id', new.race_id);
  else
    return new;
  end if;

  perform net.http_post(
    url := 'https://kolrwuhjjsclqalapfzt.supabase.co/functions/v1/admin-notify',
    body := jsonb_build_object('event_type', v_event_type, 'payload', v_payload),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_np2Ps_SprPC0hf9YdGEoSg_DL3UxlJA',
      'Authorization', 'Bearer sb_publishable_np2Ps_SprPC0hf9YdGEoSg_DL3UxlJA'
    )
  );
  return new;
end;
$$;

create trigger notify_admin_on_registration
  after insert on public.users
  for each row execute function public.notify_admin_event();

create trigger notify_admin_on_prediction
  after insert on public.predictions
  for each row execute function public.notify_admin_event();

create trigger notify_admin_on_result
  after insert or update on public.results
  for each row execute function public.notify_admin_event();
```

Значения `apikey`/`Authorization` — publishable/anon-ключ проекта (`VITE_SUPABASE_ANON_KEY` из
`.env.local`), он публичен по дизайну (уже зашит в собранном фронтенде) — не секрет, хардкодить
в миграции безопасно, тот же принцип, что `BOT_USERNAME`/`SITE_URL` в `scripts/telegram/notify.js`.

- [ ] **Step 2: Применить к облаку**

```bash
cd scripts/db
node runner.js applyfile ../../supabase/migrations/0023_admin_notify.sql
```
Expected: `applied: 0023_admin_notify.sql (N stmts)`, без ошибок.

- [ ] **Step 3: Проверить, что `pg_net` реально включился**

```bash
node runner.js sql "select extname from pg_extension where extname = 'pg_net'"
```
Expected: одна строка `{"extname": "pg_net"}`.

- [ ] **Step 4: Проверить, что anon/authenticated не имеют доступа к новой таблице**

```bash
node runner.js sql "select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name='admin_notification_queue' and grantee in ('anon','authenticated')"
```
Expected: пустой массив `[]` — но проверить эмпирически, а не полагаться (этот класс бага
воспроизводился в проекте уже 4 раза подряд на новых таблицах, 0017-0022).

- [ ] **Step 5: Коммит**

```bash
git add supabase/migrations/0023_admin_notify.sql
git commit -m "feat(db): триггеры admin-уведомлений (pg_net) + таблица очереди admin_notification_queue"
```

---

### Task 2: Edge Function — `format.ts` (текст сообщений + граница тихих часов), TDD

**Files:**
- Create: `supabase/functions/admin-notify/format.ts`
- Test: `supabase/functions/admin-notify/format.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
// supabase/functions/admin-notify/format.test.ts
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
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
cd supabase/functions/admin-notify
deno test format.test.ts
```
Expected: FAIL — `format.ts` ещё не существует (`Module not found`).

- [ ] **Step 3: Написать `format.ts`**

```ts
// supabase/functions/admin-notify/format.ts
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
```

`hourCycle: 'h23'` указан явно — без него в некоторых окружениях `Intl.DateTimeFormat` с
`hour12: false` отдаёт `24` вместо `00` для полуночи, что сломало бы сравнение `< 10`.

- [ ] **Step 4: Запустить тест, убедиться что проходит**

```bash
deno test format.test.ts
```
Expected: `ok | 8 passed | 0 failed`.

- [ ] **Step 5: Коммит**

```bash
git add supabase/functions/admin-notify/format.ts supabase/functions/admin-notify/format.test.ts
git commit -m "feat(edge-fn): admin-notify/format.ts — текст событий + граница тихих часов (TDD, 8/8)"
```

---

### Task 3: Edge Function — `index.ts` (обработчик) + `deno.json`

**Files:**
- Create: `supabase/functions/admin-notify/index.ts`
- Create: `supabase/functions/admin-notify/deno.json`

`deno.json` создаётся сразу вместе с `index.ts` (не задним числом после ревью, как пришлось
делать в ветке `telegram-mini-app` для `telegram-auth`) — без него `deno check`/`deno test` на
файле с `npm:`-импортом резолвит `node_modules`/лок-файл от корневого `package.json` фронтенда
вместо своего.

- [ ] **Step 1: Написать `deno.json`**

```json
{
  "nodeModulesDir": "auto"
}
```

- [ ] **Step 2: Написать `index.ts`**

```ts
// supabase/functions/admin-notify/index.ts
import { withSupabase } from 'npm:@supabase/server';
import { buildMessage, isQuietHours } from './format.ts';
import type { ResolvedEvent } from './format.ts';

const ADMIN_CHAT_ID = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');

export default {
  fetch: withSupabase({ auth: 'publishable' }, async (req, ctx) => {
    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!botToken) {
      return Response.json({ error: 'TELEGRAM_BOT_TOKEN не настроен' }, { status: 500 });
    }
    if (!ADMIN_CHAT_ID) {
      return Response.json({ error: 'TELEGRAM_ADMIN_CHAT_ID не настроен' }, { status: 500 });
    }

    let body: { event_type?: string; payload?: Record<string, unknown> };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'некорректный JSON' }, { status: 400 });
    }

    const { supabaseAdmin } = ctx;
    const usersTable = supabaseAdmin.from('users') as any;
    const racesTable = supabaseAdmin.from('races') as any;
    let resolved: ResolvedEvent;

    if (body.event_type === 'registration') {
      const displayName = body.payload?.display_name;
      resolved = {
        event_type: 'registration',
        display_name: typeof displayName === 'string' ? displayName : '(без имени)',
      };
    } else if (body.event_type === 'prediction') {
      const { data: user } = await usersTable
        .select('display_name')
        .eq('id', body.payload?.user_id)
        .maybeSingle();
      const { data: race } = await racesTable
        .select('name')
        .eq('id', body.payload?.race_id)
        .maybeSingle();
      resolved = {
        event_type: 'prediction',
        display_name: user?.display_name ?? '(неизвестный участник)',
        race_name: race?.name ?? '(неизвестная гонка)',
      };
    } else if (body.event_type === 'result') {
      const { data: race } = await racesTable
        .select('name')
        .eq('id', body.payload?.race_id)
        .maybeSingle();
      resolved = { event_type: 'result', race_name: race?.name ?? '(неизвестная гонка)' };
    } else {
      return Response.json({ error: `неизвестный event_type: ${body.event_type}` }, { status: 400 });
    }

    const text = buildMessage(resolved);

    if (isQuietHours(new Date())) {
      const { error } = await (supabaseAdmin.from('admin_notification_queue') as any).insert({ text });
      if (error) {
        return Response.json({ error: `queue insert: ${error.message}` }, { status: 500 });
      }
      return Response.json({ queued: true });
    }

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text }),
    });
    const data = await res.json();
    if (!data.ok) {
      return Response.json({ error: `Telegram API error: ${JSON.stringify(data)}` }, { status: 500 });
    }
    return Response.json({ sent: true });
  }),
};
```

`usersTable`/`racesTable`/финальный `.from('admin_notification_queue')` — приведение `as any`:
у `supabaseAdmin` нет `Database`-generic (в проекте нигде нет сгенерированных типов схемы,
тот же случай, что был в `telegram-auth/index.ts`).

- [ ] **Step 3: Проверить типы (Deno check)**

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
cd supabase/functions/admin-notify
deno check index.ts
```
Expected: без ошибок (с `deno.json` на месте резолв `npm:@supabase/server` должен пройти чисто
и без `--no-check`; если всё-таки не проходит именно из-за резолва npm-пакета в первый раз — не
блокировать задачу на этом одном шаге, разобраться отдельно, если ошибка про типы кода — чинить).

- [ ] **Step 4: Коммит**

```bash
git add supabase/functions/admin-notify/index.ts supabase/functions/admin-notify/deno.json supabase/functions/admin-notify/deno.lock
git commit -m "feat(edge-fn): admin-notify/index.ts — обработчик событий, слать сразу или в очередь"
```

---

### Task 4: Деплой Edge Function + секреты + смоук

**Files:**
- Modify: `supabase/config.toml`

- [ ] **Step 1: Отключить платформенную проверку JWT**

В `supabase/config.toml`, в конец файла добавить:
```toml
[functions.admin-notify]
verify_jwt = false
```
(Как и `telegram-auth` — вызывающий это наша же БД через `pg_net`, без пользовательской сессии;
`auth: 'publishable'` внутри `withSupabase` сам решает, кого пускать, по publishable-ключу.)

- [ ] **Step 2: Задать секрет `TELEGRAM_ADMIN_CHAT_ID` и задеплоить (PowerShell)**

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
$env:SUPABASE_ACCESS_TOKEN = (Select-String -Path .env -Pattern '^SUPABASE_ACCESS_TOKEN=(.+)$').Matches[0].Groups[1].Value
supabase secrets set TELEGRAM_ADMIN_CHAT_ID=234320036 --project-ref kolrwuhjjsclqalapfzt
supabase functions deploy admin-notify --project-ref kolrwuhjjsclqalapfzt --use-api
```
`TELEGRAM_BOT_TOKEN` уже существует как секрет этого Supabase-проекта (задан при деплое
`telegram-auth`) — секреты Edge Function общие для всего проекта, а не привязаны к git-ветке,
повторно задавать не нужно. `SUPABASE_ACCESS_TOKEN` — тот же токен из `.env`, что и раньше
(генерируется один раз в Dashboard → account → Access Tokens, если ещё не заведён).
Expected: `Deployed Function admin-notify` без ошибок.

- [ ] **Step 3: Ручной смоук — вызвать функцию напрямую**

```powershell
$env:ANON_KEY = (Select-String -Path .env.local -Pattern 'VITE_SUPABASE_ANON_KEY=(.+)').Matches[0].Groups[1].Value
$env:PROJECT_URL = (Select-String -Path .env.local -Pattern 'VITE_SUPABASE_URL=(.+)').Matches[0].Groups[1].Value
Invoke-RestMethod -Uri "$env:PROJECT_URL/functions/v1/admin-notify" -Method Post `
  -Headers @{ apikey = $env:ANON_KEY; Authorization = "Bearer $env:ANON_KEY" } `
  -ContentType 'application/json' -Body '{"event_type":"registration","payload":{"display_name":"Тест Смоук"}}'
```
Expected: `{"sent":true}`, если сейчас 10:00–22:00 МСК (и сообщение реально пришло в личку с
ботом) — либо `{"queued":true}`, если сейчас тихие часы (в этом случае проверить, что строка
реально легла в таблицу: `cd scripts/db && node runner.js sql "select text from
admin_notification_queue"`, затем удалить тестовую строку: `node runner.js sql "delete from
admin_notification_queue where text like '%Тест Смоук%'"`). Если вместо этого 401/403 от самой
платформы Supabase (не от нашего кода) — `verify_jwt=false` не применился, стоп, разобраться
прежде чем переходить к Task 5.

- [ ] **Step 4: Коммит**

```bash
git add supabase/config.toml
git commit -m "chore(edge-fn): verify_jwt=false для admin-notify, задеплоено"
```

---

### Task 5: `scripts/telegram` — режим `adminflush`

**Files:**
- Modify: `scripts/telegram/lib.js`
- Modify: `scripts/telegram/notify.js`

- [ ] **Step 1: `sendTelegram` — опциональный `chatIdOverride`**

В `scripts/telegram/lib.js` функцию `sendTelegram` заменить на:
```js
async function sendTelegram(text, chatIdOverride) {
  const token = readEnv('TELEGRAM_BOT_TOKEN');
  const chatId = chatIdOverride ?? readEnv('TELEGRAM_CHAT_ID');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  return data;
}
```
(Обратно совместимо: все 4 существующих вызова `sendTelegram(text)` с одним аргументом продолжают
слать в общий `TELEGRAM_CHAT_ID`, как раньше — `chatIdOverride` для них просто `undefined`.)

- [ ] **Step 2: Режим `adminflush` в `notify.js`**

Первую строку файла:
```js
const { q, close, sendTelegram } = require('./lib');
```
заменить на:
```js
const { q, close, sendTelegram, readEnv } = require('./lib');
```

Добавить рядом с остальными функциями-режимами (`raceweek`/`deadline`/`results`/`remind`):
```js
async function adminflush() {
  const adminChatId = readEnv('TELEGRAM_ADMIN_CHAT_ID');
  const { rows } = await q('select id, text from admin_notification_queue order by created_at');
  if (rows.length === 0) {
    console.log('adminflush: очередь пуста');
    return;
  }
  for (const row of rows) {
    await sendTelegram(row.text, adminChatId);
  }
  await q('delete from admin_notification_queue where id = any($1)', [rows.map((r) => r.id)]);
  console.log(`adminflush: отправлено и удалено ${rows.length}`);
}
```

В `main()` строку:
```js
  const modes = { raceweek, deadline, results, remind };
```
заменить на:
```js
  const modes = { raceweek, deadline, results, remind, adminflush };
```
и строку с сообщением об ошибке:
```js
    console.error(`ERR неизвестный режим "${mode}", ожидается raceweek|deadline|results|remind`);
```
на:
```js
    console.error(`ERR неизвестный режим "${mode}", ожидается raceweek|deadline|results|remind|adminflush`);
```

**Отступление от спеки:** спека (раздел «Тестирование») предполагала юнит-тест `adminflush` в
стиле `notify.test.js`. По факту у `adminflush` нет чистой логики для юнит-теста (в отличие от
`predictButton` в прошлой ветке) — это прямой цикл БД-чтение → отправка → БД-удаление, и весь
остальной `notify.test.js` по тому же принципу тестирует только чистые функции, а `raceweek`/
`deadline`/`results`/`remind` (тоже прямые БД-циклы) не покрыты юнит-тестами вообще, только
ручным смоуком. `adminflush` явно проверяется в Task 7 Step 4 (реальная очередь, реальная
отправка, реальная очистка) — не пропущено, просто другой вид проверки.

- [ ] **Step 3: Добавить `TELEGRAM_ADMIN_CHAT_ID` в локальный `.env`**

Дописать в корневой `.env`:
```
TELEGRAM_ADMIN_CHAT_ID=234320036
```

- [ ] **Step 4: Коммит**

```bash
git add scripts/telegram/lib.js scripts/telegram/notify.js
git commit -m "feat(telegram): режим adminflush — разгрузка ночной очереди admin-уведомлений"
```

---

### Task 6: Крон + документация

**Files:**
- Modify: `.github/workflows/telegram-notify.yml`
- Modify: `scripts/telegram/README.md`

- [ ] **Step 1: Новый крон-пункт + режим в `workflow_dispatch`**

В `.github/workflows/telegram-notify.yml`, в блок `schedule:` добавить строку (после
существующих `cron:`):
```yaml
    - cron: '5 7 * * *'    # 10:05 МСК каждый день — adminflush (разгрузка ночной очереди)
```
В `workflow_dispatch.inputs.mode.options` строку:
```yaml
        options: [raceweek, deadline, results, remind, autoresults, aiplayer]
```
заменить на:
```yaml
        options: [raceweek, deadline, results, remind, autoresults, aiplayer, adminflush]
```

В шаге «Определить режимы», в `case`, добавить перед `*)`:
```bash
              '5 7 * * *') echo "modes=adminflush" >> "$GITHUB_OUTPUT" ;;
```
(Строка `5 7 * * *` в кавычках внутри `case` сравнивается как литеральная строка, а не глоб —
проверено эмпирически (`bash -c 'case "5 7 * * 1" in "5 7 * * *") echo bad;; "5 7 * * 1") echo
ok;; esac'` → `ok`), так что этот пункт не перехватывает существующие `'5 7 * * 1'`/`'5 7 * * 4'`,
даже когда все три совпадают по времени суток в понедельник/четверг — GitHub в этом случае просто
запустит workflow дважды на одной минуте, оба раза с верным набором режимов; расход бесплатных
минут Actions на это ничтожен для такой частоты.)

- [ ] **Step 2: Передать секрет в `.env` внутри workflow**

В шаге «Записать .env для scripts/telegram, scripts/autoresults, scripts/ai-player» — блок `env:`
```yaml
        env:
          SUPABASE_DB_URL: ${{ secrets.SUPABASE_DB_URL }}
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```
заменить на:
```yaml
        env:
          SUPABASE_DB_URL: ${{ secrets.SUPABASE_DB_URL }}
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
          TELEGRAM_ADMIN_CHAT_ID: ${{ secrets.TELEGRAM_ADMIN_CHAT_ID }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```
и следующий `cat > .env <<EOF ... EOF` блок — строку
```
          TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID
```
дополнить следующей строкой:
```
          TELEGRAM_ADMIN_CHAT_ID=$TELEGRAM_ADMIN_CHAT_ID
```

- [ ] **Step 3: Ручной шаг пользователя — секрет в GitHub**

В GitHub-репозитории: **Settings → Secrets and variables → Actions → New repository secret**,
имя `TELEGRAM_ADMIN_CHAT_ID`, значение `234320036`.

- [ ] **Step 4: Документация**

В `scripts/telegram/README.md`, в раздел «Разовая настройка» (список секретов), после пункта
про `SUPABASE_DB_URL` добавить:
```markdown
   - `TELEGRAM_ADMIN_CHAT_ID` — личный Telegram chat_id владельца лиги (не общий чат!) — куда
     идут admin-уведомления о новых регистрациях/прогнозах/результатах. Узнать: написать боту в
     личку любое сообщение, начинающееся с `/`, затем открыть в браузере
     `https://api.telegram.org/bot<TOKEN>/getUpdates` и найти `"chat":{"id": ..., "type":
     "private", ...}` — это положительное число (в отличие от group id, который отрицательный).
```

- [ ] **Step 5: Коммит**

```bash
git add .github/workflows/telegram-notify.yml scripts/telegram/README.md
git commit -m "chore(telegram): крон adminflush (10:05 МСК ежедневно) + документация секрета"
```

---

### Task 7: Сквозной ручной смоук

**Files:** нет — только ручная проверка.

- [ ] **Step 1: Проверить путь `results`-триггера (безопасно, без фейковых данных)**

```bash
cd scripts/db
node runner.js sql "select positions from results where race_id = 12"
```
Скопировать выведенный массив `positions`, затем повторно вызвать `set_race_result` теми же
позициями (безобидный no-op по данным, но `UPDATE`-триггер всё равно сработает):
```bash
node runner.js sql "select set_race_result(12, '<вставленный массив positions как JSON>'::jsonb)"
```
Ожидание: в личку с ботом (в дневные часы) пришло `🏁 Результат гонки Hungarian Grand Prix
занесён в систему`, либо (в тихие часы) строка появилась в `admin_notification_queue`.

- [ ] **Step 2: Проверить путь `prediction`-триггера своим настоящим аккаунтом**

Зайти на сайт под своим (админским) аккаунтом → «Прогноз» → изменить и сохранить прогноз на
любую открытую гонку (реальное действие через уже существующий UI, не фейковые данные).
Ожидание: пришло `📝 <ваше имя> поставил прогноз на <гонку>` (дневные часы) или строка легла в
очередь (тихие часы).

- [ ] **Step 3: Проверить путь `registration`-триггера**

Самый безопасный вариант — дождаться следующей настоящей регистрации нового участника лиги и
свериться постфактум (низкая частота события уже принята как риск в спеке). Если нужна проверка
прямо сейчас — завести одноразовый тестовый инвайт-код (`insert into invite_codes(code, active)
values ('TEST-ADMIN-NOTIFY', true)`), зарегистрироваться под тестовым email через `/signup`,
проверить уведомление, затем удалить тестового пользователя (`delete from auth.users where
email = '<тестовый email>'` — каскадно удалит и строку в `public.users`) и деактивировать
инвайт-код (`update invite_codes set active = false where code = 'TEST-ADMIN-NOTIFY'`).

- [ ] **Step 4: Проверить разгрузку очереди**

Если в ходе Step 1-3 что-то легло в `admin_notification_queue` (тихие часы), выполнить вручную:
```bash
cd scripts/telegram
node notify.js adminflush
```
Ожидание: сообщения пришли в личку, `select count(*) from admin_notification_queue` — 0.

---

### Task 8: Финальная регрессия

**Files:** нет.

- [ ] **Step 1: Прогнать все существующие наборы тестов**

```bash
cd scripts/db && npm test && npm run test:rls && npm run test:security_grants && npm run test:predicted_user_ids && npm run test:gridbot && npm run test:guest_access
cd ../telegram && node notify.test.js
cd ../../supabase/functions/admin-notify && deno test format.test.ts
cd ../../.. && npm run build
```
Expected: все зелёные, включая `npm run build` (эта фича не трогает фронтенд, но полная
регрессия — по той же дисциплине, что в предыдущих ветках проекта).
