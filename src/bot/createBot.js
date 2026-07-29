const { Telegraf } = require('telegraf');
const { createRateLimiter } = require('../services/rateLimiter');
const { searchVacancies } = require('../services/workua');
const { createVacancySubscriptions } = require('./subscriptions');

function isHttpsUrl(url) {
  return /^https:\/\//i.test(url);
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

async function safeReply(ctx, text, extra) {
  try {
    await ctx.reply(text, extra);
  } catch (error) {
    console.error('Ошибка отправки ответа в чат:', error);
  }
}

function createBot({ config, logger = console }) {
  const bot = new Telegraf(config.BOT_TOKEN);
  const limiter = createRateLimiter({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    maxRequests: config.RATE_LIMIT_MAX,
    banDurationMs: config.BAN_DURATION_MS
  });

  const subscriptions = createVacancySubscriptions({
    bot,
    intervalMs: config.VACANCY_POLL_INTERVAL_MS,
    searchVacancies,
    logger
  });

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await next();
      return;
    }

    const verdict = limiter.check(`chat:${chatId}`);
    if (!verdict.allowed) {
      if (verdict.banned) {
        await safeReply(ctx, 'Вы временно заблокированы за частые запросы. Попробуйте позже.');
      }
      return;
    }

    await next();
  });

  function getMiniappUrl() {
    return config.MINIAPP_URL;
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
      `Если открываете с телефона, localhost не будет работать. Нужен публичный HTTPS URL.`
    );
  }

  async function sendSearchResults(chatId, payload) {
    const title = payload.vacancyTitle || 'бухгалтер';
    const mode = payload.workType || 'remote';
    const telegramUsername = payload.telegramUsername || '';

    await bot.telegram.sendMessage(chatId, 'Ищу вакансии, это займет до 20 секунд...');

    const vacancies = await searchVacancies({ title, mode });
    subscriptions.start(chatId, {
      vacancyTitle: title,
      workType: mode,
      telegramUsername
    }, vacancies);

    if (!vacancies.length) {
      await bot.telegram.sendMessage(
        chatId,
        `По запросу "${title}" ничего не найдено на work.ua. Попробуйте другое название вакансии.`
      );

      await bot.telegram.sendMessage(
        chatId,
        `Я продолжу проверять work.ua ${Math.max(1, Math.round(config.VACANCY_POLL_INTERVAL_MS / 60000))} мин. и пришлю новые вакансии, если они появятся.`
      );
      return;
    }

    const header = [
      'Найденные вакансии:',
      `Запрос: ${title}`,
      `Формат: ${mode === 'remote' ? 'удаленная' : mode === 'part-time' ? 'частичная занятость' : 'любой'}`,
      `Telegram пользователя: ${telegramUsername || 'не указан'}`
    ].join('\n');

    await bot.telegram.sendMessage(chatId, header);

    for (let i = 0; i < vacancies.length; i += 1) {
      await bot.telegram.sendMessage(chatId, [
        `${i + 1}. ${vacancies[i].title}`,
        `Фирма: ${vacancies[i].companyName}`,
        `Город: ${vacancies[i].city}`,
        `Зарплата: ${vacancies[i].salary}`,
        `Ссылка: ${vacancies[i].link || 'не указана'}`
      ].join('\n'), {
        disable_web_page_preview: false
      });
    }

    await bot.telegram.sendMessage(
      chatId,
      `Автообновление включено. Я буду проверять новые вакансии каждые ${Math.max(1, Math.round(config.VACANCY_POLL_INTERVAL_MS / 60000))} мин. Остановить можно командой /stop_updates.`
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

  bot.command('stop_updates', async (ctx) => {
    if (!subscriptions.has(ctx.chat.id)) {
      await ctx.reply('Для этого чата сейчас нет активного отслеживания вакансий.');
      return;
    }

    subscriptions.stop(ctx.chat.id);
    await ctx.reply('Автообновление вакансий остановлено.');
  });

  bot.on('message', async (ctx) => {
    const rawData = ctx.message?.web_app_data?.data;
    if (!rawData) return;

    try {
      const payload = JSON.parse(rawData);
      await sendSearchResults(ctx.chat.id, payload);
      await safeReply(ctx, 'Готово. Я отправил вакансии в этот чат.');
    } catch (error) {
      logger.error('Ошибка обработки WebApp данных:', error);
      await safeReply(ctx, 'Не удалось обработать запрос. Попробуйте еще раз.');
    }
  });

  bot.catch((error) => {
    logger.error('Ошибка Telegraf:', error);
  });

  return {
    bot,
    sendSearchResults,
    subscriptions
  };
}

module.exports = {
  createBot
};