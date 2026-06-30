# Фаза 1 — Данные. Дизайн

**Дата:** 2026-06-30
**Источник правды по продукту:** `docs/plan.md` (§5 схема, §9 пилоты/пул, §12 старт зачёта, §13 roadmap).
**Предусловие:** Фаза 0 закрыта — схема + RLS в облаке `konicaRu_f1`, работаем cloud-direct (session pooler,
`scripts/db`-паттерн). Docker недоступен.

**Цель Фазы 1:** наполнить БД реальными данными сезона 2026 из Jolpica — справочник пилотов, календарь
(все 22 гонки), результаты прошедших гонок как демо/история (`scored=false`).

**Скоуп:** ТОЛЬКО данные. Авторизация/аккаунты (email+пароль, флаг админа) — отдельной фазой, не здесь.

**Критерий готовности:** зелёный `scripts/import/verify.js` (раздел 6): 22 гонки, 8 результатов по 10 пилотов,
драйверы с командами/цветами, спринты помечены, повторный запуск идемпотентен.

---

## Решения этой сессии

| # | Вопрос | Решение |
|---|---|---|
| P1 | Скоуп | Только данные (без auth/аккаунтов) |
| P2 | Подход | **A — Node-скрипт импорта** (cloud-direct, fetch Jolpica → UPSERT в облако). Не SQL-сид, не Edge Function |
| P3 | Дедлайн | Ближайший четверг перед гонкой, **20:00 UTC** (= 23:00 МСК) |
| P4 | Демо-гонки | Все завершённые раунды (на 2026-06-30 это **1–8**), derive автоматически, не хардкод числа |
| P5 | `team_color` | Локальная карта `constructorId → HEX` из plan §16.9 (11 команд, пробелов нет), фолбэк серый `#888`+варнинг |
| P6 | Спринты | **Добавить `is_sprint boolean`** (миграция 0005), заполнять из Jolpica |
| P7 | Пул для демо | НЕ заполняем `race_driver_pool` для демо-гонок (пул нужен только принимающим прогнозы — Фаза 2) |
| P8 | Источник команды | Из результатов (`Constructor`), т.к. `/2026/drivers` команду не отдаёт |

**Важно:** реальный грид 2026 из Jolpica — источник истины; хардкод-список в plan §16.10 был спекулятивным
и игнорируется. Цвета (plan §16.9) ложатся на реальные `constructorId` без пробелов.

## 1. Архитектура импорта

```
scripts/import/
├── package.json        — pg (как scripts/db)
├── lib.js              — pg-клиент (читает SUPABASE_DB_URL из ../../.env) + fetchJolpica(path) с ретраем
├── teams.js            — карта constructorId → team_color (plan §16.9)
├── import.js           — node import.js [drivers|calendar|results|all]
└── verify.js           — проверка критерия готовности
```
- Jolpica base: `https://api.jolpi.ca/ergast/f1/2026/...?format=json`. Фетч с ретраем (сеть флапает).
- Запись в облако — UPSERT (`insert ... on conflict ... do update`), постейтментно с ретраем (как `scripts/db/runner.js`).
- Идемпотентно: повторный `node import.js all` обновляет данные, не плодит дубли.
- Разовый ручной запуск. Автосинк по расписанию — Фаза 4 (Edge Function), здесь НЕ делаем.

## 2. Миграция 0005 — `is_sprint`

```sql
-- 0005_is_sprint.sql
alter table public.races add column if not exists is_sprint boolean not null default false;
```
Применяется `scripts/db/runner.js` (rebuild подхватит её в общий порядок).

## 3. Пилоты (`drivers`)

- Источник: `/2026/drivers` (полный список ~31, включая резервистов) + команда каждого из результатов
  (`/2026/{round}/results` → `Constructor`).
- Строка: `id`=`driverId`-слаг, `code`, `name`=`"{givenName} {familyName}"`,
  `team`=имя последнего `Constructor` пилота (null если ещё не ехал), `team_color`=`teams[constructorId]`
  (серый `#888` + варнинг для незнакомой команды), `active`=true.
- UPSERT: `insert into drivers(id,code,name,team,team_color,active) values(...)
  on conflict (id) do update set code=excluded.code, name=excluded.name, team=excluded.team,
  team_color=excluded.team_color, active=excluded.active`.

## 4. Календарь (`races`)

- Все 22 гонки из `/2026/races`.
- `season`=2026, `round`, `name`=`raceName`, `race_datetime_utc`=`{date}T{time}` (Jolpica отдаёт UTC, напр.
  `2026-03-08` + `04:00:00Z`), `is_sprint`= наличие `Sprint` в объекте гонки, `scored`=false.
- **`deadline_utc`**: ближайший четверг строго перед `date` гонки, время `20:00:00Z`. Для воскресной гонки —
  `date − 3 дня` 20:00 UTC. Алгоритм: от даты гонки идём назад до ближайшего четверга (dow=4).
- `status`: если по раунду есть результат → `resulted`; иначе → `demo` (плейсхолдер; Фаза 2 откроет приём).
- UPSERT по `(season, round)`: `on conflict (season, round) do update set name, race_datetime_utc,
  deadline_utc, is_sprint, status` (НЕ трогаем `scored` — им управляет админ/Фаза 2).

## 5. Результаты и демо-гонки (`results`)

- «Завершённый раунд» = `/2026/{round}/results` возвращает непустой `Results`. На 2026-06-30 это раунды 1–8.
- Топ-10 по `position` (1..10) → `positions` = jsonb-массив из 10 `driverId` по порядку.
- UPSERT в `results(race_id, positions, status, fetched_at)`: `status='final'` (прошедшие, устоявшиеся),
  `on conflict (race_id) do update set positions=excluded.positions, status='final', fetched_at=now()`.
  `race_id` берётся по `(season=2026, round)` из `races`.
- Соответствующим гонкам выставляем `status='resulted'`.
- `race_driver_pool` для демо НЕ заполняем (P7).

## 6. Проверка — критерий готовности (`verify.js`)

Одним-двумя запросами к облаку, печатает PASS/FAIL:
- `races`: ровно **22** строки (season 2026). У round 9 (British) `deadline_utc = 2026-07-02T20:00:00Z`.
- `results`: ровно **8** строк; у каждой `jsonb_array_length(positions)=10`. Спот-чек: round 1 → `positions->>0 = 'russell'`.
- `drivers`: ≥ **22**; у всех, встречающихся в результатах, `team` и `team_color` НЕ null и `team_color <> '#888'`.
- `is_sprint`: число `true` совпадает с количеством спринт-уикендов в Jolpica (≥1; round 2 Китай — спринт).
- **Идемпотентность:** повторный `node import.js all` → те же counts (22/8/N), без дублей.

Зелёный verify = Фаза 1 готова.

## Вне скоупа (следующие фазы)
- Email-авторизация, аккаунты друзей, флаг админа.
- Открытие гонок на приём прогнозов, снимок пула на дедлайн — Фаза 2.
- Автосинк пилотов/результатов по расписанию (Edge Function + pg_cron) — Фаза 4.
