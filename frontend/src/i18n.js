import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import de from './locales/de.json';
import fr from './locales/fr.json';
import es from './locales/es.json';
import it from './locales/it.json';
import ru from './locales/ru.json';
import zhCN from './locales/zhCN.json';
import pl from './locales/pl.json';
import cs from './locales/cs.json';
import ptBR from './locales/ptBR.json';
import ko from './locales/ko.json';
import { detectLanguage, htmlLang } from './utils/browserLanguage.js';

const resources = {
  en: { translation: en },
  de: { translation: de },
  fr: { translation: fr },
  es: { translation: es },
  it: { translation: it },
  ru: { translation: ru },
  zhCN: {translation: zhCN},
  pl: { translation: pl },
  cs: { translation: cs },
  ptBR: { translation: ptBR },
  ko: { translation: ko },
};

const browserLanguages = typeof navigator === 'undefined' ? []
  : (navigator.languages?.length ? navigator.languages : [navigator.language]);
export const initialLanguage = localStorage.getItem('mailflow_language')
  || detectLanguage(browserLanguages, Object.keys(resources));

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: initialLanguage,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });

// <html lang> follows the UI. A page that always claimed to be English made browsers offer to
// translate a UI already in the user's language, and a translated UI crashes React (see index.html).
const syncHtmlLang = lng => {
  if (typeof document !== 'undefined') document.documentElement.lang = htmlLang(lng);
};
syncHtmlLang(initialLanguage);
i18n.on('languageChanged', syncHtmlLang);

export default i18n;
