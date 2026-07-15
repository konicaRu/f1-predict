# Фаза 3 — Витрина: Зачёт + Результаты (дизайн)

Дата: 2026-07-14
Статус: согласован, готов к плану
Сверено с `docs/constitution.md` (§1 тайбрейкер, §2 RLS, §5 процесс, §6 YAGNI, §7 дизайн).

## 1. Цель

Дать игрокам увидеть исход игры — замкнуть играбельный цикл (MVP = Фазы 0–3):
- **Зачёт** — лидерборд лиги: место, игрок, суммарные очки, точные попадания, лучшая гонка. Тайбрейкер: точные → лучшая гонка.
- **Результаты** — по выбранной сыгранной гонке: фактический топ-10 + таблица очков всех игроков за эту гонку.

Очки уже считаются в view `scores` — но игроки их не видят (вкладки Зачёт/Результаты пока заглушки). Фаза 3 показывает их.

**Вне 3 (отложено):** drift-chart (canvas с кривыми Безье, §16.8 плана) — отдельной фазой позже. Селектор игрока (нужен был только для drift-chart) — не делаем.

## 2. Контекст (что уже готово)

- **`scores`** (view, `security_invoker=true`): `select user_id, race_id, points, exact_hits from predictions ⋈ results ⋈ score_prediction`. RLS-safe: чужие прогнозы до дедлайна скрыты; для `resulted`-гонок (дедлайн прошёл) видны все → `scores` отдаёт строки всех игроков.
- **`results(race_id, positions jsonb, status, fetched_at)`**, **`races(... status, scored)`**, **`drivers(id, code, name, team, team_color, standing)`**, **`users(id, display_name, is_admin)`**.
- RLS чтения — по членству (`is_member()`): члены видят users/drivers/races/results и свои+прошедшие scores.
- **Данных для показа сейчас НЕТ:** ни одна гонка не `scored` (Бельгия открыта, результата нет). Витрина стартует с первой зачётной гонки — до тех пор пустые состояния.
- Фронт (2b/2c): `db.ts` (`withRetry`), паттерн экрана (loading/error+«Повторить»), цвета команд из `drivers.team_color`, стили.

## 3. Решения (из брейншторма)

- **Скоуп:** Зачёт + Результаты **таблицами**. Drift-chart — позже. Селектор игрока не нужен.
- **Агрегация зачёта — подход A (клиентский):** тонкие обёртки `db.ts` + чистая функция `standings.ts` (сумма/тайбрейкер в JS). Без DB-view (view под Telegram добавим, когда дойдём до бота — YAGNI).
- **Только зачётные гонки** идут в зачёт/результаты: `races.scored=true` (для Результатов — `status='resulted'`). Демо-история (rounds 1–8, scored=false) — не в зачёте.

## 4. Архитектура и файлы

```
src/lib/
  db.ts         — +getScores(), +listUsers(), +listDrivers() (withRetry)
  types.ts      — +Score {user_id,race_id,points,exact_hits}, +LeagueUser {id,display_name}
  standings.ts  — aggregateStandings(scores, users, scoredRaceIds): StandingRow[] (чистая, ранжирование+тайбрейкер)
src/pages/
  Standings.tsx — экран «Зачёт» (заменяет заглушку /standings)
  Results.tsx   — экран «Результаты» (заменяет заглушку /results)
src/App.tsx     — /standings → Standings, /results → Results
src/styles/app.css — стили таблиц зачёта/результатов, race-pills
```

**Границы:**
- `db.ts` — единственная точка Supabase; 3 обёртки-чтения (`getScores`, `listUsers`, `listDrivers`), все через `withRetry`.
- `standings.ts` — чистая функция (без React/БД): агрегирует `scores` по игрокам среди зачётных гонок, ранжирует с тайбрейкером. Тестируема отдельно.
- `Standings.tsx` / `Results.tsx` — оркестрация: грузят через `db.ts`, считают через `standings.ts`, рендерят, держат локальный state, пустые/loading/error состояния.

## 5. Слой данных (`db.ts`)

- `getScores(): Promise<Score[]>` — `supabase.from('scores').select('user_id,race_id,points,exact_hits')`. Возвращает все видимые строки (RLS).
- `listUsers(): Promise<LeagueUser[]>` — `supabase.from('users').select('id,display_name')`.
- `listDrivers(): Promise<Driver[]>` — `supabase.from('drivers').select('id,code,name,team,team_color,standing')` (для рендера топ-10 результата).
- `getResult(raceId)` — уже есть (2c): `results.positions | null`.
Все читающие — через `withRetry`.

## 6. `standings.ts` (чистая функция)

```
type StandingRow = {
  userId: string; name: string; points: number; exact: number; bestRace: number; played: number; rank: number;
};
aggregateStandings(scores: Score[], users: LeagueUser[], scoredRaceIds: Set<number>): StandingRow[]
```
- По каждому игроку (из `users`) суммируем `points`/`exact_hits` только по `scores`, где `race_id ∈ scoredRaceIds`; `bestRace = max(points)`; `played = число таких гонок`.
- Игроки без прогнозов — 0/0/0/0 (показываем всех членов).
- Сортировка: `points ↓ → exact ↓ → bestRace ↓` (тайбрейкер §1). Соревновательный ранг (равным — одно место, следующий — с пропуском мест, как в реальном зачёте F1).

## 7. Экран «Зачёт» (`/standings`)

- **Данные:** `getScores()` + `listUsers()` + `listRaces()`; `scoredRaceIds` = id гонок с `scored=true`.
- **Рендер (таблица, §16.7):** Место | Игрок (+тег «ты») | Очки | Точных | Лучшая гонка.
  - Места 1/2/3 — золото/серебро/бронза; строка текущего `auth.uid` — cyan-рамка + «ты».
  - Очки крупно (Titillium Web), tabular-nums.
- **Пустое состояние:** нет зачётных гонок → «Зачёт появится после первой зачётной гонки».
- Подпись про тайбрейкер под таблицей.

## 8. Экран «Результаты» (`/results`)

- **Данные:** `listRaces()` → `resulted`-гонки для селектора; по выбранной: `getResult(raceId)`, `listDrivers()` (карта id→driver), `getScores()` (фильтр по race_id), `listUsers()`.
- **Селектор (race pills):** только `status='resulted'`, по умолчанию последняя (макс round); на мобиле — горизонтальный скролл.
- **Раскладка (§16.8, две колонки):**
  - Слева — фактический топ-10: место | полоса цветом команды | код | фамилия. Подиум P1–P3 — место золотом.
  - Справа — очки за гонку: игрок | очки (cyan) | точных; строка «ты» — cyan-рамка; сорт по очкам ↓.
- **Пустое состояние:** нет `resulted`-гонок → «Результатов пока нет».
- Без drift-chart, без селектора игрока.

## 9. Тестирование

- **Фронт-верификация:** `npm run build` зелёный.
- **Тестовые данные (сид/очистка через SQL, cloud-direct):** раз ничего не `scored`, для смоука временно засеять:
  - дальнюю гонку-подопытную (R21 Qatar) + снимок пула (open_race);
  - 3 фикстур-игрока (`auth.users`+`public.users`) с разными прогнозами;
  - занос результата через `set_race_result` → гонка `scored`.
  Затем e2e-смоук в браузере: Зачёт (3 игрока, места/подсветка/тайбрейкер верны для известных очков), Результаты (топ-10 + очки, селектор гонок, пустые состояния до выбора). **После — полностью удалить фикстуры** (игроки/прогнозы/результат/журнал/пул) и откатить R21 в demo. Бельгию не трогать.
- **`standings.ts`** проверяется на контролируемых фикстурах в смоуке (React-юнит-раннера нет — как в 2b/2c; логика простая).
- Скоринг/RLS/set_race_result уже покрыты (Фазы 0/2c) — не дублируем.

## 10. Процесс (конституция §5)

Исполнение subagent-driven с блоком конституции в промптах исполнителей/ревьюеров (RLS-чтение, тайбрейкер §1, UTC/МСК, YAGNI, устойчивость сети). Финальное ревью ветки с coverage-check перед merge.

## 11. Вне скоупа Фазы 3

- Drift-chart (canvas, кривые Безье, сводка промахов) — отдельная фаза.
- Селектор игрока в Результатах.
- DB-view `standings` (добавим под Telegram-итоги, Фаза 5).
- Telegram-итоги, Google Sheets бэкап — отдельные под-проекты.
