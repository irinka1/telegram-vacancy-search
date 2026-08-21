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
  if (mode === 'remote') return `${base} віддалена робота`;
  if (mode === 'part-time') return `${base} часткова зайнятість`;
  return base;
}

function getVacancySearchText(vacancy) {
  return cleanText([
    vacancy.title,
    vacancy.description
  ].join(' ')).toLowerCase();
}

function matchesRemoteMode(vacancy) {
  const text = getVacancySearchText(vacancy);
  return /(віддален|дистанційн|дистанцион|удален|remote)/i.test(text);
}

function matchesPartTimeMode(vacancy) {
  const text = getVacancySearchText(vacancy);
  return /(частков[аоії]|неповн[аоії]|part[\s-]?time|частичн)/i.test(text);
}

function filterByMode(vacancies, mode) {
  if (mode === 'remote') {
    return vacancies.filter(matchesRemoteMode);
  }

  if (mode === 'part-time') {
    return vacancies.filter(matchesPartTimeMode);
  }

  return vacancies;
}

async function fetchHtml(url) {
  const response = await axios.get(url, {
    headers: REQUEST_HEADERS,
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
      const detailsText = cleanText($('body').text());
      const parsedMeta = parseWorkMeta(description);

      vacancies.push({
        title,
        companyName: parsedMeta.company,
        city: parsedMeta.city,
        salary: parsedMeta.salary,
        description: description || 'не указано',
        detailsText,
        source: 'work.ua',
        link: links[index]
      });
    });

    return uniqByLink(vacancies).slice(0, 6);
  } catch {
    return [];
  }
}

async function searchVacancies({ title, mode }) {
  const phrase = getSearchPhrase(title, mode);
  const workUa = await fetchWorkUaVacancies(phrase);
  const filtered = filterByMode(workUa, mode);

  return uniqByLink(filtered).slice(0, 10).map((vacancy) => ({
    title: vacancy.title,
    companyName: vacancy.companyName,
    city: vacancy.city,
    salary: vacancy.salary,
    description: vacancy.description,
    source: vacancy.source,
    link: vacancy.link
  }));
}

module.exports = {
  searchVacancies
};