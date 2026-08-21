# Telegram Vacancy Search Bot

Telegram-бот с мини-приложением для соискателей: ищет вакансии на work.ua по названию должности и формату работы, присылает результаты в чат и сам следит за новыми объявлениями.

## Возможности

- Мини-приложение с формой: должность, формат работы (удалённая / частичная / любая), имя в Telegram.
- Поиск и парсинг вакансий с work.ua: название компании, город, зарплата, ссылка на вакансию.
- Автообновление: бот периодически проверяет новые вакансии по сохранённому запросу и присылает только новые, пока не остановить командой `/stop_updates`.
- Rate limiting от спама и флуда (на чат и на IP).
- Скрипт быстрого публичного HTTPS через `cloudflared` — можно протестировать Mini App с телефона без своего домена.

## Технологии

Node.js · Express · Telegraf · Axios · Cheerio

## Архитектура

```
public/           — Telegram Mini App (форма поиска вакансий)
src/server/       — Express-сервер и webhook-роут
src/bot/          — Telegram-логика, подписки на автообновление
src/services/     — Парсинг вакансий с work.ua
```

## Запуск

```bash
npm install
cp .env.example .env   # заполнить своими значениями
npm start
```

После запуска откройте бота в Telegram и отправьте `/start`.

| Переменная | Назначение |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен бота |
| `MINIAPP_URL` | публичный HTTPS-адрес мини-аппа |
| `PORT` | порт HTTP-сервера |
| `VACANCY_POLL_INTERVAL_MS` | интервал проверки новых вакансий (по умолчанию 180000 = 3 мин) |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `BAN_DURATION_MS` | защита от спама и флуда |

## Быстрый публичный HTTPS для разработки

Для Telegram Mini App нужен публичный HTTPS URL. Скрипт поднимает временный Cloudflare Tunnel без ручного редактирования `MINIAPP_URL`:

```powershell
winget install --id Cloudflare.cloudflared
npm run start:tunnel
```

Что делает скрипт:

- поднимает temporary Cloudflare Tunnel до локального `http://127.0.0.1:3000`;
- находит выданный HTTPS URL вида `https://*.trycloudflare.com`;
- запускает бота с правильным `MINIAPP_URL` и `PORT`.

Tunnel-адрес временный и меняется при каждом запуске; пока открыто окно с `npm run start:tunnel`, бот и mini app доступны извне.
