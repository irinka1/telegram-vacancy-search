const fs = require('fs');
const path = require('path');
const express = require('express');
const { Telegraf } = require('telegraf');
const { searchVacancies } = require('./vacancySearch');

function loadEnvFromFile() {
  const envPath = path.join(__dirname, 'keys.env');
  if (!fs.existsSync(envPath)) return {};

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  const env = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    env[key] = value;
  }

  return env;
}

const envFile = loadEnvFromFile();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || envFile.TELEGRAM_BOT_TOKEN;
const MINIAPP_URL = process.env.MINIAPP_URL || envFile.MINIAPP_URL || 'http://localhost:3000';
const PORT = Number(process.env.PORT || envFile.PORT || 3000);
let ACTIVE_MINIAPP_URL = MINIAPP_URL;

if (!BOT_TOKEN) {
  console.error('Не задан TELEGRAM_BOT_TOKEN в keys.env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

function isHttpsUrl(url) {
  return /^https:\/\//i.test(url);
}

function getMiniappUrl() {
  return ACTIVE_MINIAPP_URL;
}

function isLocalHttpUrl(url) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(url);
}

function withPort(url, port) {
  try {
    const parsed = new URL(url);
    parsed.port = String(port);
    return parsed.toString();
  } catch {
    return url;
  }
}

function appendChatId(url, chatId) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('chat_id', String(chatId));
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}chat_id=${encodeURIComponent(String(chatId))}`;
  }
}

function startButton(chatId) {
  const miniappUrl = getMiniappUrl();

  if (isHttpsUrl(miniappUrl)) {
    return {
      text: 'Старт',
      web_app: { url: miniappUrl }
    };
  }

  return {
    text: 'Старт',
    url: appendChatId(miniappUrl, chatId)
  };
}

async function sendStartMessage(ctx, text) {
  const miniappUrl = getMiniappUrl();

  if (isHttpsUrl(miniappUrl)) {
    await ctx.reply(text, {
      reply_markup: {
        inline_keyboard: [[startButton(ctx.chat.id)]]
      }
    });
    return;
  }

  const fallbackUrl = appendChatId(miniappUrl, ctx.chat.id);
  await ctx.reply(
    `${text}\n\n` +
    `Сейчас у вас локальный URL, поэтому Telegram не может показать кнопку.\n` +
    `Откройте ссылку вручную:\n${fallbackUrl}\n\n` +
    `Если открываете с телефона, localhost не будет работать. Нужен публичный HTTPS URL (например, cloudflared).`
  );
}

bot.start(async (ctx) => {
  const text = isHttpsUrl(getMiniappUrl())
    ? 'Открой миниапп и заполни параметры поиска вакансий:'
    : 'Открой форму по кнопке Старт. Для localhost откроется безопасный режим через ссылку:';

  await sendStartMessage(ctx, text);
});

bot.command('find', async (ctx) => {
  await sendStartMessage(ctx, 'Нажми Старт и заполни форму.');
});

function formatVacancy(vacancy, index) {
  return [
    `${index + 1}. ${vacancy.title}`,
    `Фирма: ${vacancy.companyName}`,
    `Город: ${vacancy.city}`,
    `Зарплата: ${vacancy.salary}`,
    `Чем занимается компания: ${vacancy.description}`,
    `Сайт: ${vacancy.source}`,
    `Ссылка: ${vacancy.link || 'не указана'}`
  ].join('\n');
}

async function sendSearchResults(chatId, payload) {
  const title = payload.vacancyTitle || 'бухгалтер';
  const mode = payload.workType || 'remote';
  const telegramUsername = payload.telegramUsername || '';

  await bot.telegram.sendMessage(chatId, 'Ищу вакансии, это займет до 20 секунд...');

  const vacancies = await searchVacancies({ title, mode });

  if (!vacancies.length) {
    await bot.telegram.sendMessage(
      chatId,
      `По запросу "${title}" ничего не найдено на work.ua и robota.ua. Попробуйте другое название вакансии.`
    );
    return;
  }

  const hasRobotaSource = vacancies.some((item) => item.source === 'robota.ua');

  const header = [
    'Найденные вакансии:',
    `Запрос: ${title}`,
    `Формат: ${mode === 'remote' ? 'удаленная' : mode === 'part-time' ? 'частичная занятость' : 'любой'}`,
    `Telegram пользователя: ${telegramUsername || 'не указан'}`
  ].join('\n');

  await bot.telegram.sendMessage(chatId, header);

  for (let i = 0; i < vacancies.length; i += 1) {
    await bot.telegram.sendMessage(chatId, formatVacancy(vacancies[i], i), {
      disable_web_page_preview: false
    });
  }

  if (!hasRobotaSource) {
    await bot.telegram.sendMessage(
      chatId,
      'Примечание: robota.ua временно ограничивает автоматический доступ (Cloudflare), поэтому сейчас показаны найденные вакансии в основном из work.ua.'
    );
  }
}

bot.on('message', async (ctx) => {
  const message = ctx.message;
  if (!message?.web_app_data?.data) return;

  try {
    const payload = JSON.parse(message.web_app_data.data);
    await sendSearchResults(ctx.chat.id, payload);
    await ctx.reply('Готово. Я отправил вакансии в этот чат.');
  } catch (error) {
    console.error('Ошибка обработки WebApp данных:', error);
    await ctx.reply('Не удалось обработать запрос. Попробуйте еще раз.');
  }
});

bot.catch((error) => {
  console.error('Ошибка Telegraf:', error);
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_, res) => {
  res.json({ ok: true });
});

app.post('/api/search', async (req, res) => {
  try {
    const { vacancyTitle, workType, telegramUsername, chatId } = req.body || {};
    const numericChatId = Number(chatId);

    if (!Number.isFinite(numericChatId)) {
      return res.status(400).json({ ok: false, error: 'Некорректный chat_id.' });
    }

    await sendSearchResults(numericChatId, {
      vacancyTitle,
      workType,
      telegramUsername
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error('Ошибка /api/search:', error);
    return res.status(500).json({ ok: false, error: 'Не удалось отправить результаты.' });
  }
});

function startHttpServer(preferredPort) {
  const server = app.listen(preferredPort, () => {
    if (isLocalHttpUrl(MINIAPP_URL)) {
      ACTIVE_MINIAPP_URL = withPort(MINIAPP_URL, preferredPort);
    }
    console.log(`Miniapp server: http://localhost:${preferredPort}`);
    console.log(`Miniapp URL for bot: ${ACTIVE_MINIAPP_URL}`);
  });

  server.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      const nextPort = preferredPort + 1;
      console.warn(`Порт ${preferredPort} занят, пробую ${nextPort}...`);
      startHttpServer(nextPort);
      return;
    }
    console.error('Ошибка запуска HTTP сервера:', error);
    process.exit(1);
  });
}

startHttpServer(PORT);

bot.launch().then(() => {
  console.log('Telegram bot started');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
