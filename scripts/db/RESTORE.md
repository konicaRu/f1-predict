# Восстановление из резервной копии

Копия делается командой `node scripts/db/backup.js` и лежит в
`C:/claude_code_projects/f1_predict_backups/<дата>_<время>_MSK/`:

- `<схема.таблица>.json` — все строки таблицы как есть;
- `manifest.json` — сколько строк, sha256, коммит git со схемой, порядок восстановления;
- этот файл.

Схемы в копии нет — её воспроизводят миграции `supabase/migrations/` из коммита в `manifest.json`.
Копия лежит вне репозитория намеренно: репо публичное, а в копии личные данные и хеши паролей.

## Сценарий А: испорчена одна или несколько таблиц (самый вероятный)

Сначала посмотреть, что изменится. Команда ничего не трогает:

```bash
node scripts/db/restore.js "C:/claude_code_projects/f1_predict_backups/<папка>" public.predictions
```

Выведет: сколько строк в копии и сейчас, сколько вернётся и сколько уйдёт. Если всё верно, то же самое с `--apply`:

```bash
node scripts/db/restore.js "C:/claude_code_projects/f1_predict_backups/<папка>" public.predictions --apply
```

Что делает `--apply`, одним сообщением на сервер (целиком или никак):

1. Выключает пользовательские триггеры, чтобы не было лавины уведомлений и шуток в Telegram.
2. Удаляет текущие строки.
3. Заливает строки из копии.
4. Выставляет счётчики id.
5. Включает триггеры.
6. Сверяет результат с копией построчно.

Внешние ключи при этом работают. Если таблицу нельзя очистить, потому что на неё ссылаются
другие (например, `public.races` ← `predictions`/`results`/`race_driver_pool`), транзакция откатится
целиком, ничего не изменив. Тогда передать зависимые таблицы тем же вызовом, порядок скрипт
выстроит сам: `... public.races public.race_driver_pool public.predictions public.results --apply`.

## Сценарий Б: проект Supabase потерян целиком

1. Новый проект Supabase; в `.env` новый `SUPABASE_DB_URL`.
2. Поправить адрес проекта, зашитый в миграциях `0023_admin_notify.sql` и `0028_watchdog.sql`.
3. `cd scripts/db && node runner.js rebuild` — накатывает все миграции (схема, RLS, функции, pg_cron).
4. Залить все таблицы одним вызовом:
   `node scripts/db/restore.js "<папка>" auth.users auth.identities public.users public.drivers public.races public.race_driver_pool public.predictions public.results public.result_changes public.invite_codes public.telegram_links public.app_settings public.keepalive public.prediction_jokes --apply`
   (очередь уведомлений, пульс и инциденты сторожа восстанавливать незачем; `cron.job` создаст миграция 0028).
5. Заново: секреты Edge Functions (`TELEGRAM_*`, `GEMINI_API_KEY`), `supabase functions deploy` для
   `admin-notify`, `telegram-auth`, `watchdog`; секреты GitHub (`SUPABASE_*`).

## Проверка, что копия годная

`backup.js` сам проверяет каждую таблицу тем же путём, каким пойдёт восстановление: строки из JSON
собираются по типу таблицы и сравниваются с живой построчно в обе стороны. Итоговая строка
`КОПИЯ ГОДНА` означает: ни одной строки не потеряно и не искажено. В таблицах сторожа
(`job_runs`, `watchdog_incidents`) пара строк разницы ожидаема: сторож пишет туда каждые 15 минут.
