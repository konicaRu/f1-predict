# Фаза 2c — Админка (дизайн)

Дата: 2026-07-14
Статус: согласован, готов к плану
Сверено с `docs/constitution.md` (§2 безопасность в БД, §3 журнал результата, §5 процесс/ревью, §6 YAGNI).

## 1. Цель

Дать администратору два инструмента:
- **Открыть гонку** — кнопка поверх готовой RPC `open_race()` (снимок пула + `status='open'`), чтобы открывать гонки для прогнозов из UI, а не dev-бутстрапом.
- **Занести/править результат** — ручной ввод фактического топ-10 гонки (tap-to-assign из пула), после чего гонка становится `resulted` + `scored=true`, и очки считаются автоматически (view `scores`). Правки журналируются в `result_changes`.

**Вне 2c:** двухфазный АВТО-забор результата из Jolpica (provisional→final) и автосинк пилотов — Фаза 4. Витрина зачёта/результатов для игроков — Фаза 3. Тут только админ-инструменты.

## 2. Контекст (что уже готово)

- **Скоринг:** функция `score_prediction(prediction, actual)` + view `scores` (`predictions ⋈ results`, считается на чтение). Занос в `results` → очки появляются сразу, отдельно считать не нужно.
- **`open_race(p_race_id)`** (миграция 0007): SECURITY DEFINER, гейт «залогиненный=админ, прямое подключение=пропуск», снимок активных пилотов в `race_driver_pool` + `status='open'` (только из `demo`), идемпотентна.
- **RLS:** запись в `results`/`result_changes` — только `is_admin()`; чтение — членам. `races` запись — админ.
- **Схема:** `results(race_id pk, positions jsonb, status 'provisional'|'final', fetched_at)`; `result_changes(id, race_id, before, after, changed_at, reason)`; `races(... status 'demo'|'open'|'closed'|'resulted', scored bool)`; `race_driver_pool(race_id, driver_id)`.
- **Чего НЕТ:** функции/триггера, который при заносе результата ставит `races.status='resulted'`+`scored=true` и пишет в `result_changes`. Делаем в 2c.
- **Фронт (из 2b):** компоненты `PredictionSlots`/`DriverPool`/`DriverChip` (tap-to-assign), `db.ts` (`getRaceWithPool`, `withRetry`), `classifyRace`/`RaceCard`, `AuthContext.isAdmin`, стили. Максимально переиспользуем.

Сегодня 2026-07-14: открытая гонка с пулом — Бельгия (round 10, id 11), дедлайн ~16–19 июля. На ней тестируем занос (админ-override не блокирует занос до дедлайна).

## 3. Решения (из брейншторма)

- **Скоуп:** открытие гонки + ручной занос финального результата (сразу final → resulted+scored) + правка/override с журналом. Двухфазность вручную — НЕ берём (авто-забор = Фаза 4).
- **Занос топ-10:** переиспользуем tap-to-assign из пула гонки (те же компоненты, что в Прогнозе).
- **Запись результата:** серверный RPC `set_race_result()` (подход A) — атомарно: валидация состава + upsert `results` + журнал `result_changes` + `scored/status`. Гейт админа внутри (как `open_race`). Не клиентские записи (нет атомарности/журнал хрупкий) и не триггер (неявно, причину правки не передать).
- **Timing:** сервер не блокирует занос до дедлайна — это админский override.

## 4. Архитектура и файлы

```
supabase/migrations/
  0009_admin_results.sql    — RPC set_race_result() (валидация+журнал+upsert+scored/status)
scripts/db/
  set_race_result.test.js   — pg-тест (валидация, гейт, журнал, scored, override, scores)
src/lib/
  db.ts                     — +openRace(id), +setRaceResult(id, ids, reason?), +getResult(id), +getResultRaceIds()
src/pages/
  Admin.tsx                 — список гонок + действия по статусу (заменяет заглушку /admin)
  AdminResult.tsx           — экран заноса/правки результата (tap-to-assign из пула)
src/auth/
  AdminRoute.tsx            — гейт: не-админа на /admin редиректит (defense-in-depth к RLS)
src/App.tsx                 — маршруты /admin (в AdminRoute) + /admin/result/:raceId
```

**Границы:**
- `db.ts` — единственная точка вызовов Supabase; 4 тонкие обёртки + маппинг ошибок RPC.
- `set_race_result()` — вся логика заноса на сервере (атомарно, гейт, журнал) — конституция §2/§3.
- `Admin.tsx` — оркестрация: `listRaces` + `getResultRaceIds`, кнопки по `classifyRace`.
- `AdminResult.tsx` — переиспользует `PredictionSlots`/`DriverPool`, паттерн экрана Прогноза.
- `AdminRoute` — клиентский гейт (сервер защищён RLS; это UX).

## 5. RPC `set_race_result()`

`set_race_result(p_race_id bigint, p_positions jsonb, p_reason text default null) returns void`, SECURITY DEFINER, `set search_path=public`:

1. **Гейт:** `if auth.uid() is not null and not public.is_admin() then raise exception 'set_race_result: admin only'`.
2. **Валидация состава** (как `validate_prediction`): `p_positions` — массив ровно из 10; 10 РАЗНЫХ `driver_id`; все ∈ `race_driver_pool` этой гонки. Иначе raise с понятным текстом (`exactly 10` / `10 distinct` / `race pool`). Демо-гонки без пула сюда не пройдут.
3. **Журнал:** `before := (select positions from results where race_id=p_race_id)`; `insert into result_changes(race_id, before, after, reason) values (p_race_id, before, p_positions, p_reason)`.
4. **Занос:** upsert в `results(race_id, positions=p_positions, status='final', fetched_at=now())` (on conflict race_id do update).
5. **Зачёт:** `update races set status='resulted', scored=true where id=p_race_id`.

`grant execute on function public.set_race_result(bigint, jsonb, text) to authenticated;`

- Атомарно (ошибка → откат всего). Override = повторный вызов: новая строка в `result_changes` (before→after), `scores` пересчитывается на чтение.
- Timing не проверяется (админ-override).

## 6. Экран «Админка» (`/admin`)

- **Гейт `AdminRoute`:** `!isAdmin` → `<Navigate to="/calendar">`. (Вкладка «Админ» в Shell и так только для админа.)
- **Данные:** `listRaces()` + `getResultRaceIds()` (Set race_id с результатом).
- **Рендер:** список гонок (стиль `race-card`), действие по `classifyRace`:

| Вид | Действие |
|---|---|
| soon (demo, дедлайн в будущем) | кнопка «Открыть гонку» → `openRace(id)` → `load()` |
| open / locked (открыта, пул есть) | кнопка «Занести результат» → `/admin/result/:id` |
| resulted (результат есть) | «Редактировать результат» → `/admin/result/:id` + бейдж «результат ✓» |
| past demo (историческая) | без действия, приглушена |

- Кнопка «Открыть» — инлайн, busy-состояние, после успеха `load()`; ошибка + «Повторить» (паттерн Календаря).

## 7. Экран заноса результата (`/admin/result/:raceId`, `AdminResult.tsx`)

- Зеркало экрана Прогноза, переиспользует `PredictionSlots` + `DriverPool`.
- **Данные:** `getRaceWithPool(raceId)` + `getResult(raceId)` (префилл, если есть).
- **Интеракция:** tap-to-assign (быстрый + прицельный) в 10 слотов «фактический топ-10».
- **Заголовок:** название + статус; если результат есть — подпись «редактирование (перезапишет, изменение попадёт в журнал)».
- **Причина (опц.):** при override — необязательное поле → `p_reason`. При первом заносе скрыто.
- **Сохранение:** активна при 10 слотах → `setRaceResult(raceId, ids, reason?)`. Успех → «Результат сохранён, гонка зачтена» + возврат на `/admin`. Ошибки RPC → текст.
- **Устойчивость:** `withRetry`, «Повторить» на ошибке загрузки.

## 8. Обработка ошибок RPC (`db.ts`)

| Ошибка сервера | Код | Сообщение |
|---|---|---|
| `exactly 10` / `10 distinct` | shape | «Нужно 10 разных пилотов» |
| `race pool` | pool | «Пилот не из состава гонки (обнови страницу)» |
| `admin only` / 42501 / RLS | admin | «Только для администратора» |
| прочее | unknown | «Не удалось сохранить, попробуй ещё» |

Переиспользуем паттерн `SaveError`/`mapSaveError` из 2b (обобщить или отдельный маппер для результата).

## 9. Тестирование

- **`scripts/db/set_race_result.test.js`** (pg, транзакция+rollback): не-админ → raise; валидация (не 10 / дубли / вне пула → raise); успешный занос → `results.status='final'` + строка в `result_changes` + `races.scored=true, status='resulted'`; override → второй `result_changes` (before→after); после заноса `scores` даёт очки для тестового прогноза (сквозной скоринг).
- **Скоринг/RLS/open_race** уже покрыты (Фазы 0/2b) — не дублируем.
- **Фронт:** `npm run build` зелёный + ручной e2e-смоук: открыть soon-гонку кнопкой (либо занести на Бельгии), занести топ-10, увидеть «зачтена», зайти повторно → префилл, изменить → журнал; проверить, что не-админ не проходит на `/admin`.
- React-юнит-тестов нет (нет раннера; YAGNI — как в 2b).

## 10. Процесс (конституция §5)

Исполнение через subagent-driven: свежий сабагент на задачу + spec-ревью + code-quality-ревью; в промпты исполнителей/ревьюеров вкладывается блок релевантных пунктов конституции (безопасность в БД, журнал результата, секреты, UTC/МСК, YAGNI, устойчивость сети) + ссылка на `docs/constitution.md`. Перед merge — финальное ревью ветки с coverage-check (код ↔ спека).

## 11. Вне скоупа 2c

- Двухфазный авто-забор результата из Jolpica, автосинк пилотов — Фаза 4.
- Витрина результатов гонки, общий зачёт, drift-chart для игроков — Фаза 3.
- Резервисты вне пула в результате (редкий случай) — позже.
- Telegram-итоги, Google Sheets бэкап — отдельные под-проекты.
