const { getSearchPhrase, fetchWorkUaVacancies, fetchWorkUaRemoteVacancies } = require('./workua');
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

function finalize(vacancies) {
  return uniqByLink(vacancies).slice(0, 15).map((vacancy) => ({
    title: vacancy.title,
    companyName: vacancy.companyName,
    city: vacancy.city,
    salary: vacancy.salary,
    description: vacancy.description,
    source: vacancy.source,
    link: vacancy.link
  }));
}

async function searchVacancies({ title, mode }) {
  const baseTitle = cleanText(title) || 'бухгалтер';
  const variants = expandGenderVariants(baseTitle);

  if (mode === 'remote') {
    // Раздел work.ua "робота дистанційно" игнорирует свой же параметр поиска, поэтому
    // забираем оттуда несколько страниц (всё гарантированно удалённо) и фильтруем сами
    // по названию должности. Параллельно держим и обычный поиск с фильтром по ключевым
    // словам "удалённо" в описании как второй, независимый источник — вакансий с удалённым
    // форматом в принципе мало, поэтому чем больше независимых способов их найти, тем лучше.
    const titleKeywords = variants.flatMap((variant) => variant.split(/\s+/)).filter(Boolean);

    const [workUaRemoteCategory, workUaGeneralFiltered, robotaUa] = await Promise.all([
      fetchWorkUaRemoteVacancies(titleKeywords),
      Promise.all(variants.map((variantTitle) => fetchWorkUaVacancies(getSearchPhrase(variantTitle, 'any'))))
        .then((r) => filterByMode(r.flat(), 'remote')),
      Promise.all(variants.map((variantTitle) => fetchRobotaUaVacancies(getSearchPhrase(variantTitle, 'any')))).then((r) => r.flat())
    ]);

    // robota.ua не даёт такого же серверного фильтра, поэтому для неё оставляем
    // проверку по ключевым словам формата работы в описании.
    const combined = [...workUaRemoteCategory, ...workUaGeneralFiltered, ...filterByMode(robotaUa, 'remote')];
    return finalize(combined);
  }

  // Для остальных режимов не сужаем сам поисковый запрос словами формата работы —
  // сайты трактуют это как часть фразы и находят почти ничего. Ищем по названию
  // должности как есть, а формат работы отфильтровываем ниже по полному описанию.
  const perVariant = await Promise.all(variants.map(async (variantTitle) => {
    const phrase = getSearchPhrase(variantTitle, 'any');
    const [workUa, robotaUa] = await Promise.all([
      fetchWorkUaVacancies(phrase),
      fetchRobotaUaVacancies(phrase)
    ]);

    return [...workUa, ...robotaUa];
  }));

  const combined = uniqByLink(perVariant.flat());
  const filtered = filterByMode(combined, mode);

  return finalize(filtered);
}

module.exports = {
  searchVacancies,
  closeRobotaBrowser
};
