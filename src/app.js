const { loadEnv } = require('./config/env');
const { createBot } = require('./bot/createBot');
const { createApp } = require('./server/createApp');

function isHttpsUrl(url) {
  return /^https:\/\//i.test(url);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setWebhookWithRetries(bot, webhookUrl, attempts = 10, delayMs = 2000) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await bot.telegram.setWebhook(webhookUrl);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(`setWebhook attempt ${attempt}/${attempts} failed. Retrying...`);
        await sleep(delayMs);
      }
    }
  }

  throw lastError || new Error('Failed to set webhook');
}

async function startTelegramTransport(bot, config) {
  if (isHttpsUrl(config.MINIAPP_URL)) {
    const webhookUrl = new URL(config.WEBHOOK_PATH, `${config.MINIAPP_URL.replace(/\/?$/, '/')}`).toString();
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await setWebhookWithRetries(bot, webhookUrl);
    console.log(`Telegram bot started in webhook mode: ${webhookUrl}`);
    return;
  }

  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  console.log('Starting Telegram bot in polling mode...');
  await bot.launch({ dropPendingUpdates: true });
  console.log('Telegram bot started in polling mode');
}

async function main() {
  const config = loadEnv();

  if (!config.BOT_TOKEN) {
    console.error('Не задан TELEGRAM_BOT_TOKEN в .env');
    process.exit(1);
  }

  const { bot, sendSearchResults, subscriptions } = createBot({ config, logger: console });
  const app = createApp({ bot, config, sendSearchResults, logger: console });

  const server = app.listen(config.PORT, async () => {
    console.log(`Miniapp server: http://localhost:${config.PORT}`);
    console.log(`Miniapp URL for bot: ${config.MINIAPP_URL}`);

    try {
      await startTelegramTransport(bot, config);
    } catch (error) {
      console.error('Ошибка запуска Telegram транспорта:', error);
      process.exit(1);
    }
  });

  server.on('error', (error) => {
    console.error('Ошибка запуска HTTP сервера:', error);
    process.exit(1);
  });

  const shutdown = async (signal) => {
    try {
      subscriptions.stopAll();
      await bot.stop(signal);
    } catch (error) {
      console.error('Ошибка остановки Telegram бота:', error);
    } finally {
      server.close();
    }
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Не удалось запустить приложение:', error);
  process.exit(1);
});