const fs = require('fs');
const path = require('path');
const { formatVacancy } = require('./formatVacancy');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'subscriptions.json');

function getVacancyKey(vacancy) {
  return vacancy.link || `${vacancy.title}|${vacancy.companyName}|${vacancy.city}|${vacancy.salary}`;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('subscription tick timeout')), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createVacancySubscriptions({ bot, intervalMs, searchVacancies, logger = console }) {
  const subscriptions = new Map();

  function persist() {
    try {
      fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
      const data = Array.from(subscriptions.values()).map((subscription) => ({
        chatId: subscription.chatId,
        payload: subscription.payload,
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

  function createSubscription(chatId, payload, seenKeys) {
    const subscription = {
      chatId,
      payload: {
        vacancyTitle: payload.vacancyTitle || 'бухгалтер',
        workType: payload.workType || 'remote',
        telegramUsername: payload.telegramUsername || ''
      },
      seenKeys,
      isRunning: false,
      intervalId: null
    };

    subscription.intervalId = setInterval(async () => {
      if (subscription.isRunning) return;

      subscription.isRunning = true;

      try {
        const vacancies = await withTimeout(searchVacancies({
          title: subscription.payload.vacancyTitle,
          mode: subscription.payload.workType
        }), 5 * 60 * 1000);

        const freshVacancies = vacancies.filter((vacancy) => {
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
          `Появились новые вакансии по запросу "${subscription.payload.vacancyTitle}".`
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

  function start(chatId, payload, knownVacancies) {
    const key = String(chatId);
    stop(key);

    const seenKeys = new Set((knownVacancies || []).map(getVacancyKey));
    const subscription = createSubscription(chatId, payload, seenKeys);
    subscriptions.set(key, subscription);
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
      const subscription = createSubscription(entry.chatId, entry.payload || {}, seenKeys);
      subscriptions.set(key, subscription);
    }
  }

  function get(chatId) {
    const subscription = subscriptions.get(String(chatId));
    return subscription ? subscription.payload : null;
  }

  function getAll() {
    return Array.from(subscriptions.values()).map((subscription) => ({
      chatId: subscription.chatId,
      payload: subscription.payload
    }));
  }

  return {
    start,
    stop,
    stopAll,
    haltIntervals,
    restore,
    get,
    getAll,
    has(chatId) {
      return subscriptions.has(String(chatId));
    }
  };
}

module.exports = {
  createVacancySubscriptions
};
