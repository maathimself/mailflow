const assert = require('node:assert/strict');
const test = require('node:test');
const { printStrings, printTranslator } = require('./printI18n.cjs');
const { normalizePrintOptions } = require('./printOptions.cjs');

test('preview strings and validation errors are available in all eleven locales', () => {
  const english = printStrings().strings;
  for (const language of ['en', 'de', 'fr', 'es', 'it', 'ru', 'zhCN', 'pl', 'cs', 'ptBR', 'ko']) {
    const { strings } = printStrings(language);
    assert.deepEqual(Object.keys(strings), Object.keys(english));
    for (const value of Object.values(strings)) assert.ok(value.trim());
    const t = printTranslator(strings);
    assert.throws(() => normalizePrintOptions({ copies: 0 }, t), { message: strings.invalidCopies });
    assert.ok(t('pageCount', { count: 2 }).includes('2'));
    assert.ok(!t('validPages', { total: 5 }).includes('{{'));
    if (language !== 'en') assert.notEqual(strings.printFailed, english.printFailed);
  }
});

test('HTML language tags select the matching desktop catalog', () => {
  assert.equal(printStrings('pt-BR').language, 'pt-BR');
  assert.equal(printStrings('zh-CN').language, 'zh-CN');
  assert.equal(printStrings('de-DE').language, 'de');
  assert.equal(printStrings('unknown').language, 'en');
});
