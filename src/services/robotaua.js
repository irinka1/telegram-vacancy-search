const puppeteer = require('puppeteer-extra');
const puppeteerStealth = require('puppeteer-extra-plugin-stealth');

puppeteer.use(puppeteerStealth());

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
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

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }).catch((error) => {
      browserPromise = null;
      throw error;
    });
  }

  return browserPromise;
}

async function closeRobotaBrowser() {
  if (!browserPromise) return;

  try {
    const browser = await browserPromise;
    await browser.close();
  } catch {
    // ignore
  } finally {
    browserPromise = null;
  }
}

function buildVacancyUrl(phrase, city) {
  const part = encodeURIComponent(cleanText(phrase) || 'робота');
  const cityPart = encodeURIComponent(cleanText(city) || 'ukraine');
  return `https://robota.ua/zapros/${part}/${cityPart}`;
}

function parseVacancyCard(card, city) {
  const title = cleanText(card.title);
  if (!title) return null;

  const companyName = cleanText(
    (card.imgAlt || '').split(/\s*—\s*вакансія\s+в\s+/i)[1] || card.imgAlt
  ) || 'не вказана';

  const salarySpan = (card.spans || []).find((span) => /(грн|₴|\$|uah)/i.test(span));
  const salary = cleanText(salarySpan) || 'не вказана';

  const vacancyId = (card.href.match(/vacancy(\d+)/) || [])[1];
  if (!vacancyId) return null;

  return {
    title,
    companyName,
    city: cleanText(city) || 'Україна',
    salary,
    description: [title, companyName].join(' '),
    source: 'robota.ua',
    link: `https://robota.ua${card.href}`
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchRobotaUaVacanciesInner(phrase, timeoutMs, limit, city) {
  let page;

  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36');
    await page.goto(buildVacancyUrl(phrase, city), { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    try {
      await page.waitForSelector('a[href*="/vacancy"]', { timeout: Math.min(timeoutMs, 8000) });
    } catch {
      return [];
    }

    await new Promise((resolve) => setTimeout(resolve, 800));

    const rawCards = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/vacancy"]'));
      return anchors.map((a) => {
        const heading = a.querySelector('h2, h3');
        const img = a.querySelector('img');
        return {
          href: a.getAttribute('href'),
          title: heading ? heading.textContent.trim() : '',
          imgAlt: img ? img.getAttribute('alt') : '',
          spans: Array.from(a.querySelectorAll('span')).map((span) => span.textContent.trim()).filter(Boolean)
        };
      });
    });

    return uniqByLink(
      rawCards.map((card) => parseVacancyCard(card, city)).filter(Boolean)
    ).slice(0, limit);
  } catch {
    return [];
  } finally {
    if (page) {
      // page.close() иногда зависает навсегда под нагрузкой (осиротевший renderer-процесс
      // Chrome) — без своего таймаута это молча блокирует весь цикл автообновления вакансий.
      withTimeout(page.close(), 5000).catch(() => {});
    }
  }
}

// Любой шаг Puppeteer может зависнуть без ошибки и без таймаута, если сам процесс Chrome
// стал нездоров. Внешний таймаут гарантирует, что поиск по robota.ua всегда завершится —
// успехом или пустым результатом — и не заблокирует навсегда всю подписку.
async function fetchRobotaUaVacancies(phrase, timeoutMs = 20000, limit = 15, city = '') {
  try {
    return await withTimeout(fetchRobotaUaVacanciesInner(phrase, timeoutMs, limit, city), timeoutMs + 15000);
  } catch {
    return [];
  }
}

module.exports = {
  fetchRobotaUaVacancies,
  closeRobotaBrowser
};
