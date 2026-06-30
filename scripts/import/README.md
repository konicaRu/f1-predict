# scripts/import — загрузка данных сезона из Jolpica (Фаза 1)

Cloud-direct: тянет Jolpica и UPSERT'ит в облако через пулер (см. `../db/README.md` про `.env`).
Подключение — **transaction-пулер (порт 6543)**: соединение возвращается в пул после каждого запроса,
не залипают сессии при множестве коротких CLI-запусков (session-пулер 5432 упирался в лимит 15 клиентов).

## Команды (`cd scripts/import && npm install`)
- `npm run drivers`  — пилоты + команды/цвета (безкодовые резервисты пропускаются).
- `npm run calendar` — 22 гонки (deadline = чт 20:00 UTC, is_sprint).
- `npm run results`  — результаты завершённых раундов (демо, scored=false).
- `npm run all`      — всё подряд. Идемпотентно (UPSERT).
- `npm run verify`   — критерий готовности Фазы 1 (7 проверок).
- `npm test`         — юнит-тест `deadlineUtc`.

Источник истины по данным — Jolpica (не хардкод грида из plan §16.10). `team_color` — локальная карта
`teams.js` по `constructorId` (plan §16.9).
