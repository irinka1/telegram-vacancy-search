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

function uniqByLink(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.link || `${item.source}:${item.title}:${item.companyName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const NEW_SEARCH_LABEL = '🔎 Новий пошук';
const LIST_LABEL = '📋 Перелік вакансій, які вже у пошуку';
const DELETE_LABEL = '🗑 Видалити пошук';
const CANCEL_LABEL = '↩️ Скасувати';
const ADMIN_LIST_LABEL = '👥 Перелік вакансій (усі)';

function queryLabel(query) {
  return `${query.vacancyTitle} — ${formatWorkType(query.workType)}`;
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

  const pendingDeleteSelection = new Map();

  function buildMenuKeyboard(chatId) {
    const rows = [
      [NEW_SEARCH_LABEL],
      [LIST_LABEL],
      [DELETE_LABEL]
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
    const newQuery = { vacancyTitle: title, workType: mode };

    await bot.telegram.sendMessage(chatId, 'Ищу вакансии, это займет до минуты...');

    const { added, queries } = subscriptions.addQuery(chatId, newQuery, telegramUsername);

    if (config.ADMIN_CHAT_ID) {
      const requester = telegramUsername ? `@${telegramUsername}` : `chat_id ${chatId}`;
      bot.telegram.sendMessage(
        config.ADMIN_CHAT_ID,
        `Новый поиск вакансий от ${requester}:\n- ${title} — ${formatWorkType(mode)}`
      ).catch((error) => {
        logger.error('Ошибка отправки уведомления администратору:', error);
      });
    }

    // Считаем результаты сразу по ВСЕМ активным запросам (старым и новому)
    // и присылаем общий список — а не только то, что нашлось по новому запросу.
    const resultsPerQuery = await Promise.all(
      queries.map((query) => searchVacancies({ title: query.vacancyTitle, mode: query.workType }))
    );
    const combined = uniqByLink(resultsPerQuery.flat());

    subscriptions.markSeen(chatId, combined);

    const queriesSummary = queries.map((query) => queryLabel(query)).join('; ');
    const pollMinutes = Math.max(1, Math.round(config.VACANCY_POLL_INTERVAL_MS / 60000));

    if (!added) {
      await bot.telegram.sendMessage(chatId, `Запрос "${queryLabel(newQuery)}" уже отслеживается.`);
    }

    if (!combined.length) {
      await bot.telegram.sendMessage(
        chatId,
        `По текущим запросам (${queriesSummary}) вакансий пока не найдено.`
      );

      await bot.telegram.sendMessage(
        chatId,
        `Я продолжу проверять их каждые ${pollMinutes} мин. и пришлю новые, если появятся.`
      );
      return;
    }

    await bot.telegram.sendMessage(chatId, [
      'Текущие вакансии по всем активным поискам:',
      `Запросы: ${queriesSummary}`,
      `Telegram пользователя: ${telegramUsername || 'не указан'}`
    ].join('\n'));

    for (let i = 0; i < combined.length; i += 1) {
      await bot.telegram.sendMessage(chatId, [
        `${i + 1}. ${combined[i].title}`,
        `Фирма: ${combined[i].companyName}`,
        `Город: ${combined[i].city}`,
        `Зарплата: ${combined[i].salary}`,
        `Источник: ${combined[i].source}`,
        `Ссылка: ${combined[i].link || 'не указана'}`
      ].join('\n'), {
        disable_web_page_preview: false
      });
    }

    await bot.telegram.sendMessage(
      chatId,
      `Автообновление включено для всех запросов. Я буду проверять новые вакансии каждые ${pollMinutes} мин.`
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
    await ctx.reply('Автообновление вакансий остановлено для всех запросов.');
  });

  bot.hears(NEW_SEARCH_LABEL, async (ctx) => {
    pendingDeleteSelection.delete(ctx.chat.id);

    const text = isHttpsUrl(getMiniappUrl())
      ? 'Открой миниапп и заполни параметры поиска вакансий:'
      : 'Открой форму по кнопке Старт. Для localhost откроется безопасный режим через ссылку:';

    await sendStartMessage(ctx, text);
  });

  bot.hears(LIST_LABEL, async (ctx) => {
    const queries = subscriptions.getQueries(ctx.chat.id);

    if (!queries.length) {
      await ctx.reply('Сейчас нет активных поисков.');
      return;
    }

    const list = queries.map((query, index) => `${index + 1}. ${queryLabel(query)}`).join('\n');
    await ctx.reply(`Сейчас отслеживаются:\n${list}`);
  });

  bot.hears(DELETE_LABEL, async (ctx) => {
    const queries = subscriptions.getQueries(ctx.chat.id);

    if (!queries.length) {
      await ctx.reply('Сейчас нет активных поисков, нечего удалять.');
      return;
    }

    pendingDeleteSelection.set(ctx.chat.id, queries);

    await ctx.reply('Выберите, какой поиск удалить:', {
      reply_markup: {
        keyboard: [...queries.map((query) => [queryLabel(query)]), [CANCEL_LABEL]],
        resize_keyboard: true,
        is_persistent: true
      }
    });
  });

  bot.hears(ADMIN_LIST_LABEL, async (ctx) => {
    if (!isAdminChat(ctx.chat.id, config)) return;

    const active = subscriptions.getAll();
    const rows = active.flatMap((subscription) => {
      const requester = subscription.telegramUsername ? `@${subscription.telegramUsername}` : `chat_id ${subscription.chatId}`;
      return subscription.queries.map((query) => `${queryLabel(query)} — ${requester}`);
    });

    if (!rows.length) {
      await ctx.reply('Сейчас нет активных поисков ни у одного пользователя.');
      return;
    }

    const list = rows.map((row, index) => `${index + 1}. ${row}`).join('\n');
    await ctx.reply(`Активні пошуки (усі користувачі):\n${list}`);
  });

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const pending = pendingDeleteSelection.get(chatId);
    if (!pending) return;

    const text = ctx.message.text;

    if (text === CANCEL_LABEL) {
      pendingDeleteSelection.delete(chatId);
      await ctx.reply('Отменено.', buildMenuKeyboard(chatId));
      return;
    }

    const match = pending.find((query) => queryLabel(query) === text);
    if (!match) return;

    subscriptions.removeQuery(chatId, match);
    pendingDeleteSelection.delete(chatId);
    await ctx.reply(`Удалён поиск: ${queryLabel(match)}`, buildMenuKeyboard(chatId));
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
