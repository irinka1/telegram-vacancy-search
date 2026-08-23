const FEMININE_OVERRIDES = {
  'вчитель': 'вчителька',
  'учитель': 'учителька',
  'продавець': 'продавчиня',
  'кухар': 'кухарка',
  'водій': 'водійка',
  'офіціант': 'офіціантка',
  'бухгалтер': 'бухгалтерка',
  'менеджер': 'менеджерка',
  'директор': 'директорка',
  'секретар': 'секретарка',
  'консультант': 'консультантка',
  'асистент': 'асистентка',
  'програміст': 'програмістка',
  'дизайнер': 'дизайнерка',
  'юрист': 'юристка',
  'лікар': 'лікарка',
  'психолог': 'психологиня',
  'касир': 'касирка',
  'адміністратор': 'адміністраторка',
  'оператор': 'операторка',
  'помічник': 'помічниця',
  'робітник': 'робітниця',
  'двірник': 'двірниця',
  'вихователь': 'вихователька',
  'керівник': 'керівниця',
  'фахівець': 'фахівчиня',
  'кур\'єр': 'кур\'єрка',
  'перекладач': 'перекладачка',
  'редактор': 'редакторка',
  'маркетолог': 'маркетологиня',
  'аналітик': 'аналітикиня',
  'технолог': 'технологиня'
};

const REVERSE_OVERRIDES = Object.fromEntries(
  Object.entries(FEMININE_OVERRIDES).map(([masculine, feminine]) => [feminine, masculine])
);

function clean(value) {
  return String(value || '').trim();
}

function guessVariant(word) {
  const lower = word.toLowerCase();

  if (FEMININE_OVERRIDES[lower]) return FEMININE_OVERRIDES[lower];
  if (REVERSE_OVERRIDES[lower]) return REVERSE_OVERRIDES[lower];

  if (/тель$/i.test(word)) return word.replace(/тель$/i, 'телька');
  if (/телька$/i.test(word)) return word.replace(/телька$/i, 'тель');
  if (/ник$/i.test(word)) return word.replace(/ник$/i, 'ниця');
  if (/ниця$/i.test(word)) return word.replace(/ниця$/i, 'ник');
  if (/іст$/i.test(word)) return word.replace(/іст$/i, 'істка');
  if (/істка$/i.test(word)) return word.replace(/істка$/i, 'іст');
  if (/(ерка|орка|арка)$/i.test(word)) return word.replace(/ка$/i, '');
  if (/(ер|ор|ар)$/i.test(word)) return `${word}ка`;

  return null;
}

/**
 * Расширяет фразу украинскими гендерными вариантами должности
 * (наприклад "вчитель" -> "вчитель", "вчителька"), чтобы поиск
 * не пропускал вакансии/резюме, размещені з іншою формою слова.
 */
function expandGenderVariants(phrase) {
  const base = clean(phrase);
  const words = base.split(/\s+/).filter(Boolean);
  if (!words.length) return [base];

  const variants = new Set([words.join(' ')]);

  words.forEach((word, index) => {
    const variant = guessVariant(word);
    if (!variant || variant.toLowerCase() === word.toLowerCase()) return;

    const variantWords = [...words];
    variantWords[index] = variant;
    variants.add(variantWords.join(' '));
  });

  return Array.from(variants);
}

module.exports = {
  expandGenderVariants
};
