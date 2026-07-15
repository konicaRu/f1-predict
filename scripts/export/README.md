# Экспорт в Google Sheets

Ручной бэкап прогнозов/результатов/очков лиги в Google-таблицу. Каждый запуск полностью
перезаписывает три вкладки актуальным снэпшотом из Supabase. Без автосинка (это отдельная
задача на будущее) — запускается по требованию.

## Разовая настройка

1. Открыть [Google Cloud Console](https://console.cloud.google.com/) → создать новый проект
   (или выбрать существующий).
2. В проекте: **APIs & Services → Library** → найти «Google Sheets API» → **Enable**.
3. **APIs & Services → Credentials → Create Credentials → Service Account**.
   Имя — любое (например `f1-predict-export`), роль на уровне проекта не нужна — доступ дадим
   точечно через шаринг конкретной таблицы (шаг 7). На экранах «Grant this service account
   access to project» и «Grant users access to this service account» ничего не выбирать и не
   заполнять — просто Continue/Done.
4. Открыть созданный сервис-аккаунт → вкладка **Keys → Add Key → Create new key → JSON**.
   Скачается файл ключа.
5. Положить скачанный файл в `scripts/export/service-account.json` (путь уже в `.gitignore`,
   в git не попадёт).
6. Открыть скачанный JSON, скопировать поле `client_email`
   (вид: `имя@проект.iam.gserviceaccount.com`).
7. Создать пустую Google-таблицу ([sheets.new](https://sheets.new)) → **Настройки доступа** →
   расшарить на email из шага 6 с правом **Редактор**.
8. Скопировать ID таблицы из её URL: `https://docs.google.com/spreadsheets/d/`**`ЭТОТ_ID`**`/edit`.
9. В корневом `.env` (НЕ `.env.example`) добавить (см. шаблон в `.env.example`):
   ```
   GOOGLE_SHEET_ID=<id из шага 8>
   GOOGLE_SERVICE_ACCOUNT_KEY_PATH=scripts/export/service-account.json
   ```

## Запуск

```bash
cd scripts/export
npm install   # один раз
npm run export
```

Скрипт сам создаст вкладки «Прогнозы», «Результаты», «Очки» (если их ещё нет в таблице),
полностью перезапишет их текущими данными и напечатает счётчики строк, например:

```
Прогнозы: 4 строк | Результаты: 1 строк | Очки: 4 строк
```

Это и есть проверка успешного запуска — отдельного verify-скрипта нет (низкий риск: только
чтение из Supabase и запись наружу, схема БД не меняется).

Если скрипт падает с ошибкой доступа (permission denied) — скорее всего таблица не расшарена
на email сервис-аккаунта из шага 6/7, или расшарена не на тот email. Проверить это в первую
очередь.
