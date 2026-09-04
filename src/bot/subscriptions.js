const fs = require('fs');
const path = require('path');
const { formatVacancy } = require('./formatVacancy');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'subscriptions.json');

function getVacancyKey(vacancy) {
  return vacancy.link || `${vacancy.title}|${vacancy.companyName}|${vacancy.city}|${vacancy.salary}`;
}

function queryKey(query) {
  return `${query.vacancyTitle}|${query.workType}|${query.city || ''}`;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('subscription tick timeout')), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Старый формат (до многозапросного поиска) хранил один запрос прямо в payload:
// { vacancyTitle, workType, telegramUsername }. Приводим его к новому виду
// { queries: [...], telegramUsername }, чтобы старые подписки не терялись при обновлении.
function normalizeLegacyPayload(payload) {
  if (!payload) return { queries: [], telegramUsername: '' };

  if (Array.isArray(payload.queries)) {
    return { queries: payload.queries, telegramUsername: payload.telegramUsername || '' };
  }

  if (payload.vacancyTitle) {
    return {
      queries: [{ vacancyTitle: payload.vacancyTitle, workType: payload.workType || 'remote', city: payload.city || '' }],
      telegramUsername: payload.telegramUsername || ''
    };
  }

  return { queries: [], telegramUsername: '' };
}

function createVacancySubscriptions({ bot, intervalMs, searchVacancies, logger = console }) {
  const subscriptions = new Map();

  function persist() {
    try {
      fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
      const data = Array.from(subscriptions.values()).map((subscription) => ({
        chatId: subscription.chatId,
        telegramUsername: subscription.telegramUsername,
        payload: { queries: subscription.payload.queries },
        seenKeys: Array.from(subscription.seenKeys)
      }));
      fs.writeFileSync(STORE_PATH, JSON.stringify(data), 'utf8');
    } catch (error) {
      logger.error('Ошибка сохранения подписок на диск:', error);
    }
  }

  async function sendVacancyList(chatId, vacancies, prefix) {
    if (prefix) {
      await bot.telegram.sendMessage(chatId, prefix);
    }

    for (let i = 0; i < vacancies.length; i += 1) {
      await bot.telegram.sendMessage(chatId, formatVacancy(vacancies[i], i), {
        disable_web_page_preview: false
      });
    }
  }

  function createSubscription(chatId, telegramUsername, queries, seenKeys) {
    const subscription = {
      chatId,
      telegramUsername: telegramUsername || '',
      payload: {
        queries: queries.length ? queries : [{ vacancyTitle: 'бухгалтер', workType: 'remote' }]
      },
      seenKeys,
      isRunning: false,
      intervalId: null
    };

    subscription.intervalId = setInterval(async () => {
      if (subscription.isRunning) return;

      subscription.isRunning = true;

      try {
        const resultsPerQuery = await withTimeout(
          Promise.all(subscription.payload.queries.map((query) => searchVacancies({
            title: query.vacancyTitle,
            mode: query.workType,
            city: query.city
          }))),
          5 * 60 * 1000
        );

        const freshVacancies = resultsPerQuery.flat().filter((vacancy) => {
          const vacancyKey = getVacancyKey(vacancy);
          if (subscription.seenKeys.has(vacancyKey)) {
            return false;
          }

          subscription.seenKeys.add(vacancyKey);
          return true;
        });

        if (!freshVacancies.length) return;

        persist();

        await sendVacancyList(
          chatId,
          freshVacancies,
          'Появились новые вакансии по вашим запросам.'
        );
      } catch (error) {
        logger.error('Ошибка автообновления вакансий:', error);
      } finally {
        subscription.isRunning = false;
      }
    }, intervalMs);

    return subscription;
  }

  function stop(chatId) {
    const key = String(chatId);
    const subscription = subscriptions.get(key);
    if (!subscription) return;

    clearInterval(subscription.intervalId);
    subscriptions.delete(key);
    persist();
  }

  function stopAll() {
    for (const subscription of subscriptions.values()) {
      clearInterval(subscription.intervalId);
    }
    subscriptions.clear();
    persist();
  }

  // Останавливает таймеры при завершении процесса, но НЕ трогает файл на диске —
  // подписки должны пережить перезапуск/деплой, а не только "мягкую" остановку одним пользователем.
  function haltIntervals() {
    for (const subscription of subscriptions.values()) {
      clearInterval(subscription.intervalId);
    }
  }

  // Добавляет новый запрос к уже отслеживаемым (не заменяет их). Возвращает итоговый
  // список запросов и признак того, был ли этот конкретный запрос новым.
  function addQuery(chatId, query, telegramUsername) {
    const key = String(chatId);
    const existing = subscriptions.get(key);
    const existingQueries = existing ? existing.payload.queries : [];

    const alreadyTracked = existingQueries.some((item) => queryKey(item) === queryKey(query));
    const queries = alreadyTracked ? existingQueries : [...existingQueries, query];
    const seenKeys = existing ? existing.seenKeys : new Set();
    const resolvedUsername = telegramUsername || (existing ? existing.telegramUsername : '');

    if (existing) {
      clearInterval(existing.intervalId);
    }

    const subscription = createSubscription(chatId, resolvedUsername, queries, seenKeys);
    subscriptions.set(key, subscription);
    persist();

    return { added: !alreadyTracked, queries };
  }

  // Отмечает вакансии как уже показанные пользователю, чтобы часовая проверка
  // не прислала их повторно как "новые".
  function markSeen(chatId, vacancies) {
    const subscription = subscriptions.get(String(chatId));
    if (!subscription) return;

    vacancies.forEach((vacancy) => subscription.seenKeys.add(getVacancyKey(vacancy)));
    persist();
  }

  function restore() {
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    } catch {
      return;
    }

    if (!Array.isArray(saved)) return;

    for (const entry of saved) {
      if (!entry || !entry.chatId) continue;

      const key = String(entry.chatId);
      const seenKeys = new Set(entry.seenKeys || []);
      const normalized = normalizeLegacyPayload({
        ...entry.payload,
        telegramUsername: entry.telegramUsername || entry.payload?.telegramUsername
      });
      const subscription = createSubscription(entry.chatId, normalized.telegramUsername, normalized.queries, seenKeys);
      subscriptions.set(key, subscription);
    }

    // Сразу пересохраняем в новом формате, чтобы миграция произошла один раз.
    persist();
  }

  function getQueries(chatId) {
    const subscription = subscriptions.get(String(chatId));
    return subscription ? subscription.payload.queries : [];
  }

  function removeQuery(chatId, query) {
    const key = String(chatId);
    const subscription = subscriptions.get(key);
    if (!subscription) return;

    const remaining = subscription.payload.queries.filter(
      (item) => queryKey(item) !== queryKey(query)
    );

    if (!remaining.length) {
      stop(chatId);
      return;
    }

    subscription.payload.queries = remaining;
    persist();
  }

  function getAll() {
    return Array.from(subscriptions.values()).map((subscription) => ({
      chatId: subscription.chatId,
      telegramUsername: subscription.telegramUsername,
      queries: subscription.payload.queries
    }));
  }

  return {
    addQuery,
    markSeen,
    stop,
    stopAll,
    haltIntervals,
    restore,
    getQueries,
    removeQuery,
    getAll,
    has(chatId) {
      return subscriptions.has(String(chatId));
    }
  };
}

module.exports = {
  createVacancySubscriptions
};
