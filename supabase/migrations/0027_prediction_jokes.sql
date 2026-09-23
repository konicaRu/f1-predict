-- 0027_prediction_jokes.sql — история шуток-комментариев к прогнозам участников.
-- Шутку генерирует Gemini внутри Edge Function admin-notify в момент прогноза, и она клеится
-- одним блоком к admin-уведомлению «X поставил прогноз на Y».
--
-- Зачем хранить, а не просто сгенерировать и забыть: без истории Gemini из гонки в гонку
-- выдаёт одну и ту же закономерность («опять ставит ANT первым»), и шутка превращается
-- в копирку. Прошлые шутки про участника уходят в промпт как «так уже шутили, придумай другое»,
-- плюс служат материалом для программной проверки на дубль.
create table public.prediction_jokes (
  id         bigint generated always as identity primary key,
  user_id    uuid   not null references public.users(id) on delete cascade,
  race_id    bigint not null references public.races(id) on delete cascade,
  text       text   not null,
  created_at timestamptz not null default now(),
  unique (user_id, race_id)
);

-- Под выборку «последние N шуток про этого участника» в prompt-билдере.
create index prediction_jokes_user_idx on public.prediction_jokes (user_id, created_at desc);

-- Конвенция admin_notification_queue (0023): таблица чисто админская, игрокам не видна.
-- RLS включён без единой политики — значит anon/authenticated не получат ни строки даже
-- при случайном гранте; service-role (Edge Function) политики обходит.
alter table public.prediction_jokes enable row level security;
revoke all on public.prediction_jokes from anon, authenticated;
