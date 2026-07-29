# Поиск вакансий через Telegram

Мини-приложение для Telegram-бота.

## Что делает

- По кнопке `Старт` открывает mini app.
- Пользователь заполняет:
  - название вакансии,
  - формат работы (удаленная / частичная / любой),
  - имя в Telegram.
- Бот ищет вакансии и отправляет результаты в чат пользователя.
- После первого поиска бот продолжает проверять новые вакансии на work.ua и присылает только новые.
- Формат выдачи:
  - название фирмы,
  - город,
  - зарплата,
  - ссылка.

## Настройка

Заполните `.env`:

```env
TELEGRAM_BOT_TOKEN=ваш_токен
MINIAPP_URL=http://localhost:3000
PORT=3000
VACANCY_POLL_INTERVAL_MS=180000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=20
BAN_DURATION_MS=3600000
```

`VACANCY_POLL_INTERVAL_MS` задает интервал проверки новых вакансий в миллисекундах. По умолчанию это 180000, то есть 3 минуты.

`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX` и `BAN_DURATION_MS` управляют защитой от спама и временной блокировкой флуда.

## Запуск

```bash
npm install
npm start
```

После запуска откройте бота в Telegram и отправьте `/start`.

Чтобы остановить автообновление вакансий для текущего чата, отправьте команду `/stop_updates`.

## Публичный HTTPS через cloudflared

Для Telegram Mini App нужен публичный HTTPS URL. В этом проекте можно поднять временный tunnel через cloudflared без ручного редактирования `MINIAPP_URL`.

1. Установите cloudflared:

```powershell
winget install --id Cloudflare.cloudflared
```

2. Запустите проект через tunnel:

```bash
npm install
npm run start:tunnel
```

Что делает скрипт:

- поднимает temporary Cloudflare Tunnel до локального `http://127.0.0.1:3000`;
- находит выданный HTTPS URL вида `https://*.trycloudflare.com`;
- запускает бота с правильным `MINIAPP_URL` и `PORT`.

Важно:

- tunnel URL временный и меняется при каждом новом запуске;
- пока открыто окно с `npm run start:tunnel`, бот и mini app доступны извне;
- если Telegram уже был открыт раньше, иногда проще заново отправить `/start`, чтобы получить свежую кнопку.

## Структура

- `src/app.js` - точка сборки приложения
- `src/config/env.js` - загрузка конфигурации из `.env`
- `src/bot/` - обработка команд, подписки и форматирование
- `src/server/createApp.js` - HTTP сервер и webhook route
- `src/services/workua.js` - поиск и парсинг вакансий
- `src/services/rateLimiter.js` - защита от спама и банов
- `public/index.html` - mini app интерфейс
- `public/app.js` - отправка данных в Telegram WebApp
- `public/styles.css` - яркий стиль интерфейса
 - `start-cloudflared.ps1` - запуск временного публичного HTTPS tunnel для mini app
