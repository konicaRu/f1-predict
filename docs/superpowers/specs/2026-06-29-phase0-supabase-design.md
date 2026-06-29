# Фаза 0 — Фундамент Supabase. Дизайн

**Дата:** 2026-06-29
**Источник правды по продукту:** `docs/plan.md` (разделы 5, 6, 11, 14).
**Цель Фазы 0:** схема БД + RLS-политики + валидация прогноза + view очков + keep-alive,
обкатанные локально и запушенные в облако. Это фундамент, на котором стоит вся
безопасность лиги (anon-ключ публичен → закрытость держится на RLS).

**Критерий готовности:** на локальном стеке проходят все 5 RLS-сценариев (раздел
«Проверка»), миграции применяются с нуля через `supabase db reset`, схема
запушена в облачный проект `konicaRu_f1`.

---

## Принятые решения (этой сессии)

| # | Вопрос | Решение |
|---|---|---|
| W1 | Ведение схемы | **CLI + миграции в репо** (`supabase/migrations/`), под git |
| W2 | Окружение | `npx supabase` (без глобальной установки) + локальный стек в Docker |
| W3 | Где разрабатываем | **Локально на Docker**, в конце `link` + `db push` в облако |
| W4 | Облачный проект | Уже создан: `konicaRu_f1`, ref `kolrwuhjjsclqalapfzt`, EU-West, FREE, пустой |
| D1 | `drivers.id` | **Слаг из Jolpica** (`driverId`), `code` — отдельное unique-поле для UI |
| D2 | `predictions.positions` | **jsonb-массив из 10** (индекс 0..9 = слот 1..10), как в `scoring.ts` |
| D3 | Роль админа | **Флаг `is_admin`** в `users` (не отдельная Postgres-роль) |
| D4 | `scores` | **View** (не таблица) поверх функции `score_prediction` |
| D5 | Формула очков | **Дубль SQL + TS** осознанно: SQL для зачёта, TS для мгновенного превью в UI; один набор тест-кейсов на обе реализации |

**Безопасность ключей:** project ref и anon-ключ публичны (норма). `service_role`-ключ
и пароль БД — только в `.env` (в `.gitignore`) и в GitHub repo secrets; в git и в
workflow открытым текстом не попадают. Команды `link`/`db push`/заведение секретов
выполняет пользователь.

---

## 1. Структура файлов

```
supabase/
├── config.toml                  ← npx supabase init
├── migrations/
│   ├── 0001_schema.sql          ← таблицы + индексы + FK
│   ├── 0002_rls.sql             ← enable RLS + политики
│   ├── 0003_validation.sql      ← BEFORE-триггер валидации прогноза
│   └── 0004_scores.sql          ← функция score_prediction + view scores
├── seed.sql                     ← минимальный сид для локальных тестов (юзеры, гонка, пул)
└── tests/
    └── rls_test.sql             ← 5 «красных» RLS-сценариев
.github/workflows/keepalive.yml  ← keep-alive пинг ×2/нед
.env.example                     ← шаблон (SUPABASE_URL, SUPABASE_ANON_KEY) — в git
.env                             ← реальные ключи — НЕ в git
```

Воркфлоу: `npx supabase init` → `npx supabase start` (Docker) → пишем миграции →
`npx supabase db reset` (накат + сид) для перетестов RLS → `npx supabase test`/
прогон `rls_test.sql` → `npx supabase link --project-ref kolrwuhjjsclqalapfzt` →
`npx supabase db push`.

## 2. Схема таблиц (раздел 5 плана)

### `users` — профиль поверх `auth.users`
| поле | тип | примечание |
|---|---|---|
| id | uuid PK → `auth.users(id)` on delete cascade | |
| display_name | text not null | видно всем (зачёт) |
| telegram_username | text | напоминания |
| telegram_user_id | bigint | привязка в админке |
| is_admin | boolean not null default false | флаг админа (D3) |
| created_at | timestamptz not null default now() | |

### `drivers` — справочник, автосинк из API
| поле | тип | примечание |
|---|---|---|
| id | text PK | слаг Jolpica `driverId` (D1) |
| code | text not null unique | 3 буквы (VER) — UI |
| name | text not null | |
| team | text | |
| team_color | text | HEX команды |
| active | boolean not null default true | |

### `races` — календарь
| поле | тип | примечание |
|---|---|---|
| id | bigint generated always as identity PK | |
| season | int not null default 2026 | |
| round | int not null | |
| name | text not null | |
| race_datetime_utc | timestamptz | старт гонки |
| deadline_utc | timestamptz not null | четверг по МСК → UTC |
| status | text not null default 'demo' | `demo` / `open` / `closed` / `resulted` |
| scored | boolean not null default false | идёт ли в зачёт |
| | | **unique(season, round)** |

`status` — CHECK на четыре значения. `scored=false` — демо/история (раздел 12).

### `race_driver_pool` — снимок пула (раздел 9)
| race_id bigint → races(id) on delete cascade · driver_id text → drivers(id) · **PK(race_id, driver_id)** |

### `predictions`
| поле | тип | примечание |
|---|---|---|
| id | bigint identity PK | |
| user_id | uuid not null → users(id) on delete cascade | |
| race_id | bigint not null → races(id) on delete cascade | |
| positions | jsonb not null | массив 10 driver_id, индекс 0..9 = слот 1..10 (D2) |
| created_at | timestamptz not null default now() | |
| updated_at | timestamptz not null default now() | |
| | | **unique(user_id, race_id)** |

### `results`
| race_id bigint PK → races(id) · positions jsonb not null (топ-10) · status text (`provisional`/`final`) · fetched_at timestamptz not null default now() |

### `result_changes` — журнал правок результата (раздел 8)
| id bigint identity PK · race_id bigint → races(id) · before jsonb · after jsonb · changed_at timestamptz not null default now() · reason text |

### `scores` — VIEW (D4)
Не хранится. Считается из `predictions` ⋈ `results`. Поля: `user_id`, `race_id`,
`points`, `exact_hits`. Тайбрейкер сезона (точные попадания, лучшая гонка)
агрегируется из этого view, ничего дополнительно не хранится.

## 3. RLS-политики (раздел 6 плана)

RLS включается на **всех** таблицах. Базовый принцип: читать — любой
аутентифицированный; писать критичное — `service_role` или `is_admin`.

| Таблица | SELECT | INSERT / UPDATE / DELETE |
|---|---|---|
| `users` | все аутентиф. (нужны display_name всех) | UPDATE только своей строки; **`is_admin` менять нельзя** (отзыв грантов на колонку + WITH CHECK) |
| `drivers` | все аутентиф. | `service_role` или `is_admin` |
| `races` | все аутентиф. | `service_role` или `is_admin` |
| `race_driver_pool` | все аутентиф. | `service_role` или `is_admin` |
| `predictions` | своя — всегда; чужая — только если `now() > deadline_utc` гонки | INSERT/UPDATE: `user_id = auth.uid()` И `now() <= deadline_utc`; DELETE запрещён |
| `results` | все аутентиф. | `service_role` или `is_admin` |
| `result_changes` | все аутентиф. | `service_role` или `is_admin` |

«Слепой прогноз» (раздел 6 п.1–2) реализуется политиками `predictions`: видимость
чужого до дедлайна закрыта на уровне БД, серверная проверка дедлайна — в WITH CHECK.

Открытый момент (не блокирует): telegram-поля `users` видны всем аутентиф. Для
компании друзей приемлемо; при желании скрыть — вынести в отдельный column-grant.
По умолчанию — видно.

## 4. Валидация прогноза — BEFORE-триггер (раздел 6 п.3)

RLS ловит владельца и дедлайн. Состав прогноза (подзапросы по jsonb-массиву в
WITH CHECK неудобны) проверяет `BEFORE INSERT OR UPDATE ON predictions`:
- `positions` — массив ровно из 10 элементов;
- 10 **разных** driver_id (нет дублей);
- каждый driver_id ∈ `race_driver_pool` этой гонки;
- иначе `RAISE EXCEPTION` (запись отклоняется).

Разделение: **дедлайн + владелец → RLS**, **состав → триггер**.

## 5. Функция очков + view (раздел 3 плана, D5)

```sql
score_prediction(prediction jsonb, actual jsonb) RETURNS (points int, exact_hits int)
-- WEIGHTS = {25,18,15,12,10,8,6,4,2,1}
-- для слота Y (1..10) с пилотом D: X = позиция D в actual;
--   вне топ-10 → 0; иначе p = max(0, WEIGHTS[Y] - 2*|X-Y|); если X==Y → p+=3, exact_hits++
-- 1:1 повтор формулы из CLAUDE.md / scoring.ts

CREATE VIEW scores AS
  SELECT p.user_id, p.race_id, (f).points, (f).exact_hits
  FROM predictions p
  JOIN results r ON r.race_id = p.race_id
  CROSS JOIN LATERAL score_prediction(p.positions, r.positions) AS f;
```

D5: формула живёт в SQL (зачёт) и TS (превью в UI). При правке формулы менять обе
реализации; один набор тест-кейсов — **7 примеров из раздела 3 плана** — гоняется
против обеих.

## 6. Keep-alive workflow (раздел 11)

`.github/workflows/keepalive.yml`:
- `schedule` cron ×2/нед (Пн и Чт) + `workflow_dispatch` (ручной пинг).
- Шаг: `curl "$SUPABASE_URL/rest/v1/drivers?select=id&limit=1" -H "apikey: $SUPABASE_ANON_KEY"`.
  Любой запрос к БД обнуляет таймер простоя → проект не засыпает → pg_cron жив.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — GitHub repo secrets (заводит пользователь).
- Репо `konicaRu/f1-predict` уже есть → workflow активен после пуша.

## 7. Проверка RLS — критерий готовности (раздел 14)

Тесты на локальном стеке (`supabase/tests/rls_test.sql`), подмена пользователя через
`request.jwt.claims`. «Красные» сценарии — должны вести себя так:
1. Юзер A читает прогноз B **до** дедлайна → 0 строк; **после** дедлайна → видно.
2. Юзер A пишет прогноз **после** дедлайна → отказ.
3. Прогноз с дублем пилота / пилотом не из пула / длиной ≠ 10 → отказ (триггер).
4. Обычный юзер пишет в `results`/`drivers` → отказ.
5. Обычный юзер меняет свой `is_admin` → отказ.

Прогон: `npx supabase db reset` (миграции + `seed.sql`) → запуск `rls_test.sql` →
все 5 как ожидается. Зелёный прогон = Фаза 0 готова к пушу в облако.

## Вне скоупа Фазы 0 (следующие фазы)

- Импорт пилотов/календаря и ретро-загрузка демо-гонок — **Фаза 1**.
- Экраны (календарь/прогноз/админка), `scoring.ts` в UI — **Фаза 2**.
- Витрина результатов и зачёта — **Фаза 3**.
- pg_cron + Edge Functions (двухфазный занос, автосинк) — **Фаза 4**.
