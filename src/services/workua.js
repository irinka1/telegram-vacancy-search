const axios = require('axios');

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

function getSearchPhrase(title, mode) {
  const base = cleanText(title || 'бухгалтер');
  if (mode === 'remote') return `${base} віддалена робота`;
  if (mode === 'part-time') return `${base} часткова зайнятість`;
  return base;
}

async function fetchMirror(url, timeoutMs) {
  const target = url.replace(/^https?:\/\//i, '');
  const response = await axios.get(`https://r.jina.ai/https://${target}`, {
    timeout: timeoutMs,
    responseType: 'text',
    validateStatus: (status) => status >= 200 && status < 500
  });

  return String(response.data || '');
}

function splitMarkdownSections(markdown) {
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const sections = [];
  let current = null;

  for (const line of lines) {
    if (/^## \[/.test(line)) {
      if (current) sections.push(current);
      current = { titleLine: line, body: [] };
      continue;
    }

    if (current) {
      current.body.push(line);
    }
  }

  if (current) sections.push(current);
  return sections;
}

function extractLinkFromTitleLine(line) {
  const match = line.match(/^## \[(?<title>.*?)\]\((?<url>https?:\/\/[^)\s]+)(?:\s+".*?")?\)/);
  if (!match) return { title: '', url: '' };
  return { title: cleanText(match.groups.title), url: cleanText(match.groups.url) };
}

function parseJobSection(bodyLines) {
  const lines = bodyLines.map(cleanText).filter(Boolean);
  let cursor = 0;

  let salary = 'не вказана';
  if (lines[cursor] && /(грн|₴|\$)/i.test(lines[cursor])) {
    salary = lines[cursor];
    cursor += 1;
  }

  const companyName = lines[cursor] || 'не вказана';
  cursor += 1;

  const city = lines[cursor] ? lines[cursor].split(',')[0].trim() : 'не вказано';

  return {
    companyName,
    city: city || 'не вказано',
    salary,
    detailsText: lines.join(' ')
  };
}

function parsePage(markdown) {
  const sections = splitMarkdownSections(markdown);
  const vacancies = [];

  for (const section of sections) {
    const { title, url } = extractLinkFromTitleLine(section.titleLine);
    if (!url || !/work\.ua\/jobs\/\d+\/?$/i.test(url)) continue;

    const meta = parseJobSection(section.body);

    vacancies.push({
      title,
      companyName: meta.companyName,
      city: meta.city,
      salary: meta.salary,
      description: [title, meta.companyName, meta.detailsText].join(' '),
      source: 'work.ua',
      link: url
    });
  }

  return vacancies;
}

async function fetchPages(buildUrl, pages, timeoutMs) {
  const pageNumbers = Array.from({ length: pages }, (_, index) => index + 1);

  const results = await Promise.allSettled(
    pageNumbers.map((page) => fetchMirror(buildUrl(page), timeoutMs))
  );

  return results
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => parsePage(result.value));
}

// Топ-1 страница поиска work.ua сильно смещена в сторону "гарячих"/офисных вакансий,
// из-за чего вакансии с удалённим форматом часто просто не попадают в неё. Берём
// несколько страниц параллельно, чтобы у фильтра по формату работы было из чего выбирать.
async function fetchWorkUaVacancies(phrase, timeoutMs = 20000, pages = 5) {
  try {
    const vacancies = await fetchPages(
      (page) => `https://www.work.ua/jobs/?search=${encodeURIComponent(phrase)}${page > 1 ? `&page=${page}` : ''}`,
      pages,
      timeoutMs
    );

    return uniqByLink(vacancies).slice(0, 60);
  } catch {
    return [];
  }
}

// У work.ua есть отдельный раздел с вакансиями для удалённої роботи (jobs-remote),
// но его собственный параметр ?search= вакансии не фильтрует (сайт просто игнорирует
// текст запроса и отдаёт общий поток). Поэтому забираем несколько страниц этого раздела
// (все вакансии там гарантированно удалённые) и уже сами фильтруем по названию должности —
// так надёжнее, чем полагаться на текстовые ключевые слова "віддалено" в описании.
async function fetchWorkUaRemoteVacancies(titleKeywords, timeoutMs = 20000, pages = 10) {
  try {
    const vacancies = await fetchPages(
      (page) => `https://www.work.ua/jobs-remote/${page > 1 ? `?page=${page}` : ''}`,
      pages,
      timeoutMs
    );

    const keywords = titleKeywords.map((word) => word.toLowerCase());
    const matched = vacancies.filter((vacancy) => {
      const title = vacancy.title.toLowerCase();
      return keywords.some((keyword) => title.includes(keyword));
    });

    return uniqByLink(matched).slice(0, 30);
  } catch {
    return [];
  }
}

module.exports = {
  getSearchPhrase,
  fetchWorkUaVacancies,
  fetchWorkUaRemoteVacancies
};
