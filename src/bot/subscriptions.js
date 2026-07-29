const { formatVacancy } = require('./formatVacancy');

function createVacancySubscriptions({ bot, intervalMs, searchVacancies, logger = console }) {
  const subscriptions = new Map();

  function getVacancyKey(vacancy) {
    return vacancy.link || `${vacancy.title}|${vacancy.companyName}|${vacancy.city}|${vacancy.salary}`;
  }

  function stop(chatId) {
    const key = String(chatId);
    const subscription = subscriptions.get(key);
    if (!subscription) return;

    clearInterval(subscription.intervalId);
    subscriptions.delete(key);
  }

  function stopAll() {
    for (const subscription of subscriptions.values()) {
      clearInterval(subscription.intervalId);
    }
    subscriptions.clear();
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

  function start(chatId, payload, knownVacancies) {
    const key = String(chatId);
    stop(key);

    const seenKeys = new Set((knownVacancies || []).map(getVacancyKey));
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
        const vacancies = await searchVacancies({
          title: subscription.payload.vacancyTitle,
          mode: subscription.payload.workType
        });

        const freshVacancies = vacancies.filter((vacancy) => {
          const vacancyKey = getVacancyKey(vacancy);
          if (subscription.seenKeys.has(vacancyKey)) {
            return false;
          }

          subscription.seenKeys.add(vacancyKey);
          return true;
        });

        if (!freshVacancies.length) return;

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

    subscriptions.set(key, subscription);
  }

  return {
    start,
    stop,
    stopAll,
    has(chatId) {
      return subscriptions.has(String(chatId));
    }
  };
}

module.exports = {
  createVacancySubscriptions
};