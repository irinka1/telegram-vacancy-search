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

async function searchVacancies({ title, mode, city }) {
  const baseTitle = cleanText(title) || 'бухгалтер';
  const cityText = cleanText(city);
  const variants = expandGenderVariants(baseTitle);

  // work.ua и robota.ua одинаково понимают "Киев" и "Київ" — отдельный перевод
  // города не нужен, достаточно передать его как есть.
  const phraseFor = (variantTitle) => getSearchPhrase(cityText ? `${variantTitle} ${cityText}` : variantTitle, 'any');

  if (mode === 'remote') {
    // Раздел work.ua "робота дистанційно" игнорирует свой же параметр поиска, поэтому
    // забираем оттуда несколько страниц (всё гарантированно удалённо) и фильтруем сами
    // по названию должности. Параллельно держим и обычный поиск с фильтром по ключевым
    // словам "удалённо" в описании как второй, независимый источник — вакансий с удалённым
    // форматом в принципе мало, поэтому чем больше независимых способов их найти, тем лучше.
    const titleKeywords = variants.flatMap((variant) => variant.split(/\s+/)).filter(Boolean);

    const [workUaRemoteCategory, workUaGeneralFiltered, robotaUa] = await Promise.all([
      fetchWorkUaRemoteVacancies(titleKeywords),
      Promise.all(variants.map((variantTitle) => fetchWorkUaVacancies(phraseFor(variantTitle))))
        .then((r) => filterByMode(r.flat(), 'remote')),
      Promise.all(variants.map((variantTitle) => fetchRobotaUaVacancies(getSearchPhrase(variantTitle, 'any'), undefined, undefined, cityText))).then((r) => r.flat())
    ]);

    // robota.ua не даёт такого же серверного фильтра, поэтому для неё оставляем
    // проверку по ключевым словам формата работы в описании.
    const combined = [...workUaRemoteCategory, ...workUaGeneralFiltered, ...filterByMode(robotaUa, 'remote')];
    return finalize(combined);
  }

  // Для остальных режимов не сужаем сам поисковый запрос словами формата работы —
  // сайты трактуют это как часть фразы и находят почти ничего. Ищем по названию
  // должности (+ городу, если указан), а формат работы отфильтровываем по описанию.
  const perVariant = await Promise.all(variants.map(async (variantTitle) => {
    const [workUa, robotaUa] = await Promise.all([
      fetchWorkUaVacancies(phraseFor(variantTitle)),
      fetchRobotaUaVacancies(getSearchPhrase(variantTitle, 'any'), undefined, undefined, cityText)
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
