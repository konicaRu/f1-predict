-- 0028_watchdog.sql — сторож: пульс автоматики + журнал инцидентов + pg_cron-запуск проверок.
--
-- Зачем: 2026-10-08 GitHub Actions не запускался ~4 часа подряд (5-й такой случай, см. MEMORY.md),
-- уведомления о прогнозах зависли в очереди, а узнали мы об этом от участников, не от системы.
-- Правило с этого дня: если что-то в нашем алгоритме не сработало — админ получает сообщение.
--
-- Устройство (две инфраструктуры следят друг за другом):
--   * GitHub Actions в конце каждого прогона пишет строку в job_runs («пульс»).
--   * pg_cron внутри Supabase раз в 15 минут дёргает Edge Function `watchdog`: она проверяет
--     пульс и бизнес-инварианты (GridBot поставил прогноз, результат занесён, анонс ушёл...),
--     ведёт watchdog_incidents и шлёт админу одно сообщение на инцидент + напоминания + «восстановилось».
--   * Обратное направление: notify.js проверяет, что сам сторож отмечался недавно (job='watchdog').

-- Пульс. Одна строка на прогон; errors — фатальная ошибка (ok=false) или проглоченные
-- предупреждения best-effort-подшагов (ok=true). Чистится сторожем старше 30 дней.
create table public.job_runs (
  id      bigint generated always as identity primary key,
  job     text        not null,  -- 'notify:<mode>', 'autoresults', 'admin-notify', 'watchdog'
  ran_at  timestamptz not null default now(),
  ok      boolean     not null,
  errors  text[]      not null default '{}',
  -- Ключ прогона от клиента: q() в scripts/*/lib.js ретраит обрыв соединения, а вставка к тому
  -- моменту могла уже пройти — живьём 2026-10-08 каждый локальный прогон давал две строки
  -- ("Connection terminated unexpectedly" через 19 с после успешного INSERT). С ключом повтор
  -- упирается в on conflict do nothing. Edge Functions пишут без ключа (null уникальность не нарушает).
  run_key uuid        unique
);
create index job_runs_job_ran_idx on public.job_runs (job, ran_at desc);

-- Инциденты. Открытый инцидент по ключу — максимум один (частичный уникальный индекс);
-- закрытые остаются историей и чистятся сторожем старше 30 дней.
create table public.watchdog_incidents (
  id                     bigint generated always as identity primary key,
  key                    text        not null,
  details                text        not null,
  opened_at              timestamptz not null default now(),
  last_seen_at           timestamptz not null default now(),
  notified_at            timestamptz,  -- последнее сообщение об этом инциденте (null — ещё не сообщали)
  resolved_at            timestamptz,
  resolution_notified_at timestamptz   -- когда сообщили «восстановилось» (или помечено без сообщения)
);
create unique index watchdog_incidents_open_key on public.watchdog_incidents (key) where resolved_at is null;

-- Обе таблицы чисто служебные (конвенция admin_notification_queue/prediction_jokes):
-- RLS без политик, доступ только service-role.
alter table public.job_runs enable row level security;
alter table public.watchdog_incidents enable row level security;
revoke all on public.job_runs from anon, authenticated;
revoke all on public.watchdog_incidents from anon, authenticated;

-- pg_cron впервые в проекте (проверен живьём 2026-10-08: пробное задание исполнялось точно
-- по минутам). Расширение ставится тут идемпотентно на случай пересборки БД.
create extension if not exists pg_cron;

-- Таймаут 60 с: у pg_net по умолчанию 5 с, а сторож с Telegram-отправкой может работать дольше —
-- обрыв со стороны pg_net не убивает функцию, но засоряет net._http_response ложными таймаутами.
-- cron.schedule с тем же именем обновляет существующее задание — миграцию можно накатывать повторно.
select cron.schedule(
  'watchdog',
  '*/15 * * * *',
  $cron$
  select net.http_post(
    url := 'https://kolrwuhjjsclqalapfzt.supabase.co/functions/v1/watchdog',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_np2Ps_SprPC0hf9YdGEoSg_DL3UxlJA',
      'Authorization', 'Bearer sb_publishable_np2Ps_SprPC0hf9YdGEoSg_DL3UxlJA'
    ),
    timeout_milliseconds := 60000
  );
  $cron$
);
