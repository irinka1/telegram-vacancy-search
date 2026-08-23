const { Telegraf } = require('telegraf');
const { createRateLimiter } = require('../services/rateLimiter');
const { searchVacancies } = require('../services/search');
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

function formatWorkType(mode) {
  if (mode === 'remote') return 'удаленная';
  if (mode === 'part-time') return 'частичная занятость';
  return 'любой';
}

const NEW_SEARCH_LABEL = '🔎 Новий пошук';
const LIST_LABEL = '📋 Перелік вакансій, які вже у пошуку';
const STOP_LABEL = '🛑 Зупинити пошук';
const ADMIN_LIST_LABEL = '👥 Перелік вакансій (усі)';

function queryLabel(payload) {
  return `${payload.vacancyTitle} — ${formatWorkType(payload.workType)}`;
}

function isAdminChat(chatId, config) {
  return Boolean(config.ADMIN_CHAT_ID) && String(chatId) === String(config.ADMIN_CHAT_ID);
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

  function buildMenuKeyboard(chatId) {
    const rows = [
      [NEW_SEARCH_LABEL],
      [LIST_LABEL],
      [STOP_LABEL]
    ];

    if (isAdminChat(chatId, config)) {
      rows.push([ADMIN_LIST_LABEL]);
    }

    return {
      reply_markup: {
        keyboard: rows,
        resize_keyboard: true,
        is_persistent: true
      }
    };
  }

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
    } else {
      const fallbackUrl = appendChatId(miniappUrl, ctx.chat.id);
      await ctx.reply(
        `${text}\n\n` +
        `Сейчас у вас локальный URL, поэтому Telegram не может показать кнопку.\n` +
        `Откройте ссылку вручную:\n${fallbackUrl}\n\n` +
        `Если открываете с телефона, localhost не будет работать. Нужен публичный HTTPS URL.`
      );
    }

    await ctx.reply('Меню:', buildMenuKeyboard(ctx.chat.id));
  }

  subscriptions.restore();

  async function sendSearchResults(chatId, payload) {
    const title = payload.vacancyTitle || 'бухгалтер';
    const mode = payload.workType || 'remote';
    const telegramUsername = payload.telegramUsername || '';

    await bot.telegram.sendMessage(chatId, 'Ищу вакансии, это займет до минуты...');

    const vacancies = await searchVacancies({ title, mode });
    subscriptions.start(chatId, {
      vacancyTitle: title,
      workType: mode,
      telegramUsername
    }, vacancies);

    if (config.ADMIN_CHAT_ID) {
      const requester = telegramUsername ? `@${telegramUsername}` : `chat_id ${chatId}`;
      bot.telegram.sendMessage(
        config.ADMIN_CHAT_ID,
        `Новый поиск вакансий от ${requester}:\n- ${title} — ${formatWorkType(mode)}`
      ).catch((error) => {
        logger.error('Ошибка отправки уведомления администратору:', error);
      });
    }

    if (!vacancies.length) {
      await bot.telegram.sendMessage(
        chatId,
        `По запросу "${title}" ничего не найдено. Попробуйте другое название вакансии.`
      );

      await bot.telegram.sendMessage(
        chatId,
        `Я продолжу проверять новые вакансии каждые ${Math.max(1, Math.round(config.VACANCY_POLL_INTERVAL_MS / 60000))} мин. и пришлю их, если они появятся.`
      );
      return;
    }

    const header = [
      'Найденные вакансии:',
      `Запрос: ${title}`,
      `Формат: ${formatWorkType(mode)}`,
      `Telegram пользователя: ${telegramUsername || 'не указан'}`
    ].join('\n');

    await bot.telegram.sendMessage(chatId, header);

    for (let i = 0; i < vacancies.length; i += 1) {
      await bot.telegram.sendMessage(chatId, [
        `${i + 1}. ${vacancies[i].title}`,
        `Фирма: ${vacancies[i].companyName}`,
        `Город: ${vacancies[i].city}`,
        `Зарплата: ${vacancies[i].salary}`,
        `Источник: ${vacancies[i].source}`,
        `Ссылка: ${vacancies[i].link || 'не указана'}`
      ].join('\n'), {
        disable_web_page_preview: false
      });
    }

    await bot.telegram.sendMessage(
      chatId,
      `Автообновление включено. Я буду проверять новые вакансии каждые ${Math.max(1, Math.round(config.VACANCY_POLL_INTERVAL_MS / 60000))} мин. Остановить можно кнопкой "${STOP_LABEL}".`
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

  bot.hears(NEW_SEARCH_LABEL, async (ctx) => {
    const text = isHttpsUrl(getMiniappUrl())
      ? 'Открой миниапп и заполни параметры поиска вакансий:'
      : 'Открой форму по кнопке Старт. Для localhost откроется безопасный режим через ссылку:';

    await sendStartMessage(ctx, text);
  });

  bot.hears(LIST_LABEL, async (ctx) => {
    const payload = subscriptions.get(ctx.chat.id);

    if (!payload) {
      await ctx.reply('Сейчас нет активных поисков.');
      return;
    }

    await ctx.reply(`Сейчас отслеживается:\n1. ${queryLabel(payload)}`);
  });

  bot.hears(STOP_LABEL, async (ctx) => {
    if (!subscriptions.has(ctx.chat.id)) {
      await ctx.reply('Сейчас нет активных поисков, нечего останавливать.');
      return;
    }

    subscriptions.stop(ctx.chat.id);
    await ctx.reply('Автообновление вакансий остановлено.', buildMenuKeyboard(ctx.chat.id));
  });

  bot.hears(ADMIN_LIST_LABEL, async (ctx) => {
    if (!isAdminChat(ctx.chat.id, config)) return;

    const active = subscriptions.getAll();

    if (!active.length) {
      await ctx.reply('Сейчас нет активных поисков ни у одного пользователя.');
      return;
    }

    const list = active
      .map((subscription, index) => {
        const requester = subscription.payload.telegramUsername
          ? `@${subscription.payload.telegramUsername}`
          : `chat_id ${subscription.chatId}`;
        return `${index + 1}. ${queryLabel(subscription.payload)} — ${requester}`;
      })
      .join('\n');

    await ctx.reply(`Активні пошуки (усі користувачі):\n${list}`);
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
