function formatVacancy(vacancy, index) {
  return [
    `${index + 1}. ${vacancy.title}`,
    `Фирма: ${vacancy.companyName}`,
    `Город: ${vacancy.city}`,
    `Зарплата: ${vacancy.salary}`,
    `Ссылка: ${vacancy.link || 'не указана'}`
  ].join('\n');
}

module.exports = {
  formatVacancy
};