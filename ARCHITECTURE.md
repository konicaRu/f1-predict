# ARCHITECTURE

## Назначение
Лига прогнозов на топ-10 гонок Формулы-1: участник до дедлайна расставляет прогноз
(drag-and-drop), после гонки очки считаются автоматически, по сезону — общий зачёт.
Полная спецификация — `docs/plan.md` (единый источник правды).

## Стек
- Фронтенд: React + @dnd-kit, хостинг GitHub Pages (github.com/konicaRu/f1-predict)
- Бэкенд: Supabase (Postgres + Auth + Edge Functions + pg_cron)
- Данные F1: Jolpica API (основной), OpenF1 (фолбэк)
- Напоминания: Telegram Bot API; Keep-alive: GitHub Actions

## Структура (текущая)
```
f1_predict/
├── CLAUDE.md       — инструкции проекта для агента
├── docs/plan.md    — полный план (v2): решения, формула очков, БД, RLS, дизайн, roadmap
├── index.html      — рабочий статический прототип (без React)
├── MEMORY.md       — журнал сессий
├── ARCHITECTURE.md — этот файл
└── README.md       — как пользоваться
```
Целевая структура (`src/`, `supabase/`, `.github/workflows/`, `package.json`) — см. CLAUDE.md / plan.md, создаётся по фазам.

## Roadmap (фазы)
0 Supabase (схема, RLS, Auth, keep-alive) · 1 Данные (импорт пилотов/календаря, демо-гонки)
· 2 Ядро (календарь, прогноз, админка, scores) · 3 Витрина (результаты, drift chart, зачёт)
· 4 Автоматика (pg_cron, Edge Functions) · 5 Telegram-бот · 6 Полировка.
MVP = Фазы 0–3.

## Команды
- (пока не заданы — появятся с `package.json` на этапе React-каркаса)

## Changelog
### 2026-06-26
- Разворот по project-starter: git init, .gitignore, контекстные файлы.
- План перемещён в `docs/plan.md`.
