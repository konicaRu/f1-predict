# Telegram-напоминания и итоги

Автоматические сообщения в общий чат лиги: 🏁 RACE WEEK по понедельникам, напоминания о дедлайне
по средам и четвергам (дважды в день), итоги гонки как только результат занесён финально (без
повтора при последующей правке результата). Работает через GitHub Actions
(`.github/workflows/telegram-notify.yml`) по расписанию — деплоя не требует, достаточно завести
секреты и один раз проверить вручную.

## Разовая настройка

1. В Telegram написать [@BotFather](https://t.me/BotFather) → `/newbot` → придумать имя и
   username бота (username должен заканчиваться на `bot`, например `f1predict_league_bot`).
   BotFather пришлёт токен вида `123456:ABC-DEF...` — это `TELEGRAM_BOT_TOKEN`.
2. Добавить бота в общий групповой чат лиги как обычного участника.
3. В чате написать команду `/id` (текст команды не важен, главное чтобы сообщение начиналось с
   `/` — обычные сообщения бот по умолчанию не видит из-за privacy mode).
4. Открыть в браузере (подставив свой токен вместо `<TOKEN>`):
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   В JSON-ответе найти `"chat":{"id": -100XXXXXXXXXX, ...}` — это отрицательное число и есть
   `TELEGRAM_CHAT_ID` (у групповых чатов id всегда отрицательный). Если `result` пустой —
   убедитесь, что отправили именно команду (начинается с `/`), а не обычный текст.
5. В GitHub-репозитории: **Settings → Secrets and variables → Actions → New repository secret**,
   добавить три секрета:
   - `TELEGRAM_BOT_TOKEN` — токен из шага 1
   - `TELEGRAM_CHAT_ID` — id из шага 4
   - `SUPABASE_DB_URL` — та же строка подключения, что в локальном `.env` (Dashboard → Connect →
     Session pooler, порт заменить на 6543 — если её раньше не заводили как GitHub secret)

## Проверка

Во вкладке **Actions** репозитория найти workflow «telegram-notify» → **Run workflow** →
выбрать режим (`raceweek` / `deadline` / `results` / `remind` / `autoresults`) → запустить вручную. Проверить, что
сообщение пришло в чат (или что скрипт вывел «ничего не шлём», если сейчас нет подходящей гонки —
это нормальное поведение, не ошибка). После этого расписание сработает само.

Если workflow упал с ошибкой вида `... не найден в .env` — проверьте, что все три секрета
сохранены и не пустые в Settings → Secrets and variables → Actions.

## Локальный запуск (для отладки)

```bash
cd scripts/telegram
npm install
```

В корневой `.env` добавить `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (см. шаги 1–4 выше);
`SUPABASE_DB_URL` там уже должен быть из настройки других `scripts/*`. Затем:

```bash
node notify.js raceweek   # или deadline, или results
```
