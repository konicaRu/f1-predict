-- 0015_users_display_name_unique.sql — display_name уникален.
-- Найдено финальным ревью ветки ai-player: gridBotUserId() в scripts/ai-player/predict.js ищет
-- аккаунт GridBot по display_name (не по хардкод-UUID, сознательно — см. 0014_gridbot_user.sql).
-- Без unique-ограничения любой authenticated игрок мог бы переименовать себя в "GridBot"
-- (grant update (display_name...) to authenticated, RLS проверяет только id = auth.uid()) и
-- select ... where display_name = 'GridBot' стал бы неоднозначным — savePrediction() тихо
-- перезаписал бы прогноз реального игрока прогнозом ИИ. Дублей на момент миграции нет (проверено).
alter table public.users add constraint users_display_name_key unique (display_name);
