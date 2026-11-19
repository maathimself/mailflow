const path = require('node:path');
const languages = ['en', 'de', 'fr', 'es', 'it', 'ru', 'zhCN', 'pl', 'cs', 'ptBR', 'ko'];

function printStrings(language = 'en') {
  const compact = String(language).replace('-', '').toLowerCase();
  const code = languages.find(code => code.toLowerCase() === compact)
    || languages.find(code => code === compact.slice(0, 2)) || 'en';
  return { language: code === 'zhCN' ? 'zh-CN' : code === 'ptBR' ? 'pt-BR' : code,
    strings: require(path.join(__dirname, '..', '..', 'src', 'locales', `${code}.json`)).printPreview };
}

function printTranslator(strings = printStrings().strings) {
  return (key, values = {}) => strings[key].replace(/\{\{(\w+)\}\}/g, (_match, name) => String(values[name] ?? ''));
}

module.exports = { printStrings, printTranslator };
