# F1 Predict — Лига прогнозов

## Что это

Закрытая лига прогнозов на гонки Формулы-1 для компании друзей.
Перед каждой гонкой участник расставляет прогноз на топ-10 (drag-and-drop карточки-машины в цветах команд), после гонки система считает очки автоматически.
По итогам сезона — общий зачёт.

## Полный план проекта

**Читай `docs/plan.md` перед любой работой** — там все принятые решения, формула очков с примерами, архитектура, структура БД, RLS-политики, спецификация дизайна, roadmap по фазам. Это единый источник правды.

## Стек

- **Фронтенд:** React + @dnd-kit, хостинг GitHub Pages (github.com/konicaRu/f1-predict)
- **Бэкенд:** Supabase (Postgres + Auth + Edge Functions + pg_cron)
- **Данные F1:** Jolpica API (основной), OpenF1 (фолбэк)
- **Напоминания:** Telegram Bot API → общий групповой чат
- **Keep-alive:** GitHub Actions (cron ×2/нед)

## Ключевые решения (краткая выжимка, детали в docs/plan.md)

- Авторизация: email + пароль (Supabase Auth)
- Дедлайн прогноза: четверг, фиксированное время по МСК, до квалификации (слепой прогноз)
- Формула очков: вес ЗАЯВЛЕННОЙ позиции (Y), штраф 2·|X−Y|, бонус +3 за точное, min 0
- Тайбрейкер: точные попадания → лучшая гонка
- Чужие прогнозы скрыты до дедлайна (RLS на уровне БД, не UI)
- Дедлайн проверяется на сервере (триггер/политика в Postgres)
- Занос результата: двухфазный (T+4ч provisional → T+24ч final) + ручной override
- Справочник пилотов: автосинк из API + снимок пула на дедлайн
- Старт зачёта: прошлые гонки = демо (scored=false), зачёт с первой готовой

## Файловая структура (целевая)

```
f1-predict/
├── CLAUDE.md              ← этот файл
├── docs/
│   └── plan.md            ← полный план проекта (v2)
├── index.html             ← текущий прототип (статический, без React)
├── src/                   ← React-приложение (создать)
│   ├── components/
│   ├── lib/
│   │   ├── supabase.ts    ← клиент Supabase
│   │   └── scoring.ts     ← формула очков
│   ├── pages/
│   │   ├── Calendar.tsx
│   │   ├── Predict.tsx
│   │   ├── Standings.tsx
│   │   └── Results.tsx
│   └── App.tsx
├── supabase/
│   ├── migrations/        ← SQL: таблицы, RLS, функции
│   └── functions/         ← Edge Functions (автозанос, напоминания)
├── .github/
│   └── workflows/
│       └── keepalive.yml  ← keep-alive пинг ×2/нед
└── package.json
```

## Roadmap (фазы сборки)

Порядок критичен — первая играбельная гонка как можно раньше:

1. **Фаза 0** — Supabase: схема таблиц, RLS, Auth, keep-alive workflow
2. **Фаза 1** — Данные: импорт пилотов и календаря из Jolpica, ретро-загрузка 7 демо-гонок
3. **Фаза 2** — Ядро: календарь, экран прогноза (drag-and-drop), админка (ручной ввод топ-10), scores view
4. **Фаза 3** — Витрина: результаты гонки + drift chart, общий зачёт
5. **Фаза 4** — Автоматика: pg_cron + Edge Function (двухфазный забор, автосинк пилотов)
6. **Фаза 5** — Telegram-бот (напоминания по расписанию)
7. **Фаза 6** — Полировка, мобильная отладка, боевой прогон

**Минимум для первой зачётной гонки: Фазы 0–3.**

## Формула очков (для scoring.ts)

```typescript
const WEIGHTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

function scorePrediction(
  prediction: string[],  // 10 driver codes, index = slot (0..9)
  actual: string[]        // 10 driver codes, real top-10
): { points: number; exactHits: number } {
  let points = 0;
  let exactHits = 0;
  for (let i = 0; i < 10; i++) {
    const Y = i + 1;  // заявленная позиция
    const code = prediction[i];
    const actualIndex = actual.indexOf(code);
    if (actualIndex === -1) continue; // вне топ-10 → 0
    const X = actualIndex + 1; // реальная позиция
    let p = Math.max(0, WEIGHTS[i] - 2 * Math.abs(X - Y));
    if (X === Y) { p += 3; exactHits++; }
    points += p;
  }
  return { points, exactHits };
}
```

## Дизайн

Полная спецификация дизайна — в docs/plan.md, раздел 16.
Краткая суть: тёмная тема (#0B0E14), акценты cyan (#00E5FF) и малиновый (#FF2E63),
шрифты Saira Condensed (заголовки/числа) + Inter (текст),
карточки пилотов с вертикальной полосой цветом команды.
Работающий прототип — index.html в корне.

## Важные ограничения

- Anon-ключ Supabase публичен → вся безопасность на RLS (см. plan.md раздел 6)
- Бесплатный Supabase засыпает через 7 дней → keep-alive обязателен
- Часовые пояса: хранить в UTC, отображать в МСК
- Один пилот = один слот (валидация и в UI, и в RLS)
- pg_cron точнее GitHub Actions по таймингу → напоминания и автозанос на pg_cron
