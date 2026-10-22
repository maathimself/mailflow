import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import { detectLanguage, htmlLang } from './utils/browserLanguage.js';

// English is bundled: it is the fallback for any key a translation lacks. The others load when
// chosen, each as its own small file: bundling all eleven put 1.1 MB of strings in front of the
// first screen, for one of them to be used.
const LOCALES = {
  de: () => import('./locales/de.json'),
  fr: () => import('./locales/fr.json'),
  es: () => import('./locales/es.json'),
  it: () => import('./locales/it.json'),
  ru: () => import('./locales/ru.json'),
  zhCN: () => import('./locales/zhCN.json'),
  pl: () => import('./locales/pl.json'),
  cs: () => import('./locales/cs.json'),
  ptBR: () => import('./locales/ptBR.json'),
  ko: () => import('./locales/ko.json'),
};
export const LANGUAGE_CODES = ['en', ...Object.keys(LOCALES)];

// An i18next backend: i18next asks it for a language the first time that language is used, and
// changeLanguage resolves once it is in.
const lazyLocales = {
  type: 'backend',
  init() {},
  read(language, _namespace, callback) {
    const load = LOCALES[language];
    if (!load) return callback(null, {});
    load().then(mod => callback(null, mod.default), err => callback(err, null));
  },
};

const browserLanguages = typeof navigator === 'undefined' ? []
  : (navigator.languages?.length ? navigator.languages : [navigator.language]);
export const initialLanguage = localStorage.getItem('mailflow_language')
  || detectLanguage(browserLanguages, LANGUAGE_CODES);

// Resolves once the starting language is in; main.jsx waits for it, so the first screen is not
// drawn in English and then redrawn.
export const i18nReady = i18n
  .use(lazyLocales)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    partialBundledLanguages: true,
    lng: initialLanguage,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });

// <html lang> follows the UI. A page that always claimed to be English made browsers offer to
// translate a UI already in the user's language, and a translated UI crashes React (see index.html).
const syncHtmlLang = lng => {
  if (typeof document !== 'undefined') document.documentElement.lang = htmlLang(lng);
};
syncHtmlLang(initialLanguage);
i18n.on('languageChanged', syncHtmlLang);

export default i18n;
