const { getSearchPhrase, fetchWorkUaVacancies } = require('./workua');
const { fetchRobotaUaVacancies, closeRobotaBrowser } = require('./robotaua');
const { expandGenderVariants } = require('./synonyms');

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

function getVacancySearchText(vacancy) {
  return cleanText([vacancy.title, vacancy.description].join(' ')).toLowerCase();
}

function matchesRemoteMode(vacancy) {
  return /(віддален|дистанційн|дистанцион|удален|remote)/i.test(getVacancySearchText(vacancy));
}

function matchesPartTimeMode(vacancy) {
  return /(частков[аоії]|неповн[аоії]|part[\s-]?time|частичн)/i.test(getVacancySearchText(vacancy));
}

function filterByMode(vacancies, mode) {
  if (mode === 'remote') return vacancies.filter(matchesRemoteMode);
  if (mode === 'part-time') return vacancies.filter(matchesPartTimeMode);
  return vacancies;
}

async function searchVacancies({ title, mode }) {
  const baseTitle = cleanText(title) || 'бухгалтер';
  const variants = expandGenderVariants(baseTitle);

  const perVariant = await Promise.all(variants.map(async (variantTitle) => {
    const phrase = getSearchPhrase(variantTitle, mode);
    const [workUa, robotaUa] = await Promise.all([
      fetchWorkUaVacancies(phrase),
      fetchRobotaUaVacancies(phrase)
    ]);

    return [...workUa, ...robotaUa];
  }));

  const combined = uniqByLink(perVariant.flat());
  const filtered = filterByMode(combined, mode);

  return uniqByLink(filtered).slice(0, 12).map((vacancy) => ({
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
  searchVacancies,
  closeRobotaBrowser
};
