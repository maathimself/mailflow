// Test support: the source of a react-i18next stand-in backed by the English locale file.
import { readFileSync } from 'node:fs';

export function reactI18nextMockSource() {
  const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
  return [
    `const en = ${JSON.stringify(en)};`,
    'const t = (key) => {',
    '  const text = key.split(".").reduce((node, part) => node?.[part], en);',
    '  return typeof text === "string" ? text : key;',
    '};',
    'export const useTranslation = () => ({ t, i18n: { language: "en", changeLanguage: () => {} } });',
    'export const initReactI18next = { type: "3rdParty", init: () => {} };',
    'export default { useTranslation, initReactI18next };',
  ].join('\n');
}
