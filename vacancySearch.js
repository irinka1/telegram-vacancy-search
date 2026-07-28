const axios = require('axios');
const cheerio = require('cheerio');

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept-Language': 'ru-RU,ru;q=0.9,uk;q=0.8,en;q=0.7'
};

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function parseBetween(text, start, end) {
  const from = text.indexOf(start);
  if (from === -1) return '';
  const left = from + start.length;
  const right = text.indexOf(end, left);
  if (right === -1) return '';
  return cleanText(text.slice(left, right));
}

function parseSalary(text) {
  const salaryMatch = text.match(/зарплата\s*[-:–]\s*([^,\.]+)/i);
  return cleanText(salaryMatch?.[1]) || 'не указана';
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

function getSearchPhrase(title, mode) {
  const base = cleanText(title || 'бухгалтер');
  if (mode === 'remote') return `${base} удаленная работа`;
  if (mode === 'part-time') return `${base} частичная занятость`;
  return base;
}

async function fetchHtml(url) {
  const response = await axios.get(url, {
    headers: REQUEST_HEADERS,
    timeout: 15000
  });
  return response.data;
}

async function fetchDuckHtml(url) {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0'
    },
    timeout: 15000
  });
  return response.data;
}

function extractWorkLinks(html) {
  const $ = cheerio.load(html);
  const links = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (/^\/jobs\/\d+\/?$/.test(href)) {
      links.add(`https://www.work.ua${href}`);
      return;
    }

    if (/work\.ua\/jobs\/\d+\/?$/.test(href)) {
      links.add(href.startsWith('http') ? href : `https:${href}`);
    }
  });

  return Array.from(links).slice(0, 8);
}

function parseWorkMeta(metaDescription) {
  const company =
    parseBetween(metaDescription, 'У компанію ', ' запрошується') ||
    parseBetween(metaDescription, 'В компанию ', ' приглашается') ||
    'не указана';

  const city =
    parseBetween(metaDescription, 'Робота у ', ', зарплата') ||
    parseBetween(metaDescription, 'Работа в ', ', зарплата') ||
    parseBetween(metaDescription, 'Робота в ', ', зарплата') ||
    'не указан';

  return {
    company,
    city,
    salary: parseSalary(metaDescription)
  };
}

async function fetchWorkUaVacancies(phrase) {
  const searchUrl = `https://www.work.ua/jobs/?search=${encodeURIComponent(phrase)}`;

  try {
    const html = await fetchHtml(searchUrl);
    const links = extractWorkLinks(html);
    if (!links.length) return [];

    const pages = await Promise.allSettled(links.map((link) => fetchHtml(link)));
    const vacancies = [];

    pages.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;

      const $ = cheerio.load(result.value);
      const title = cleanText($('h1').first().text()) || 'Без названия';
      const description = cleanText(($('meta[name="Description"]').attr('content') || '').trim());
      const parsedMeta = parseWorkMeta(description);

      vacancies.push({
        title,
        companyName: parsedMeta.company,
        city: parsedMeta.city,
        salary: parsedMeta.salary,
        description: description || 'не указано',
        source: 'work.ua',
        link: links[index]
      });
    });

    return uniqByLink(vacancies).slice(0, 6);
  } catch {
    return [];
  }
}

function decodeDuckDuckGoLink(href) {
  if (!href) return '';
  const absolute = href.startsWith('//') ? `https:${href}` : href;

  try {
    const url = new URL(absolute);
    const wrapped = url.searchParams.get('uddg');
    return wrapped ? decodeURIComponent(wrapped) : absolute;
  } catch {
    return absolute;
  }
}

function parseRobotaSnippet(snippet) {
  const city =
    parseBetween(snippet, ' in ', ',') ||
    parseBetween(snippet, ' у ', ',') ||
    parseBetween(snippet, ' в ', ',') ||
    'не указан';

  const salaryMatch = snippet.match(/(\d[\d\s]*\s*[₴грн]+)/i);
  const salary = cleanText(salaryMatch?.[1]) || 'не указана';

  return { city, salary };
}

async function fetchRobotaVacanciesViaDuck(phrase) {
  const queries = [
    `site:robota.ua ${phrase}`,
    'site:robota.ua accountant remote',
    'site:robota.ua bukhgalter dystantsiyno'
  ];

  for (const queryText of queries) {
    try {
      const query = encodeURIComponent(queryText);
      const html = await fetchDuckHtml(`https://duckduckgo.com/html/?q=${query}`);
      const $ = cheerio.load(html);
      const vacancies = [];

      $('.result').each((_, element) => {
        if (vacancies.length >= 6) return;
        const anchor = $(element).find('.result__a').first();
        const snippet = cleanText($(element).find('.result__snippet').first().text());
        const link = decodeDuckDuckGoLink(anchor.attr('href'));

        if (!/robota\.ua/i.test(link)) return;

        const title = cleanText(anchor.text()) || 'Без названия';
        const meta = parseRobotaSnippet(snippet);

        vacancies.push({
          title,
          companyName: 'смотрите в вакансии',
          city: meta.city,
          salary: meta.salary,
          description: snippet || 'Описание не указано',
          source: 'robota.ua',
          link
        });
      });

      const unique = uniqByLink(vacancies);
      if (unique.length) {
        return unique;
      }
    } catch {
      // Пробуем следующий fallback-запрос.
    }
  }

  return [];
}

async function searchVacancies({ title, mode }) {
  const phrase = getSearchPhrase(title, mode);
  const [workUa, robotaUa] = await Promise.all([
    fetchWorkUaVacancies(phrase),
    fetchRobotaVacanciesViaDuck(phrase)
  ]);

  return uniqByLink([...workUa, ...robotaUa]).slice(0, 10);
}

module.exports = {
  searchVacancies
};
