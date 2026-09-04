const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

if (tg) {
  tg.ready();
  tg.expand();
}

const form = document.getElementById('search-form');
const statusBox = document.getElementById('status');

function getChatIdFromQuery() {
  const params = new URLSearchParams(window.location.search);
  return params.get('chat_id') || '';
}

function getTelegramUserId() {
  const userId = tg && tg.initDataUnsafe && tg.initDataUnsafe.user
    ? tg.initDataUnsafe.user.id
    : '';

  return userId ? String(userId) : '';
}

function getTargetChatId() {
  return getChatIdFromQuery() || getTelegramUserId();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const payload = {
    vacancyTitle: (formData.get('vacancyTitle') || '').toString().trim(),
    city: (formData.get('city') || '').toString().trim(),
    workType: (formData.get('workType') || 'remote').toString(),
    telegramUsername: (formData.get('telegramUsername') || '').toString().trim()
  };

  if (!payload.vacancyTitle || !payload.telegramUsername) {
    statusBox.textContent = 'Заполните все поля.';
    return;
  }

  statusBox.textContent = 'Отправляю запрос боту...';

  const chatId = getTargetChatId();
  if (!chatId) {
    statusBox.textContent = 'Откройте форму по кнопке Старт в боте.';
    return;
  }

  try {
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, chatId })
    });

    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error || 'Ошибка отправки запроса.');
    }

    statusBox.textContent = 'Готово. Результаты отправлены в ваш Telegram-чат.';

    if (tg) {
      setTimeout(() => {
        tg.close();
      }, 1200);
    }
  } catch (error) {
    statusBox.textContent = error.message || 'Ошибка сети. Попробуйте снова.';
  }
});
