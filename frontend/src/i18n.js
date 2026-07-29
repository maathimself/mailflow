import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import de from './locales/de.json';
import fr from './locales/fr.json';
import es from './locales/es.json';
import it from './locales/it.json';
import ru from './locales/ru.json';
import zhCN from './locales/zhCN.json';
import { bindDocumentDirection } from './direction.js';

const savedLng = localStorage.getItem('mailflow_language') || 'en';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      de: { translation: de },
      fr: { translation: fr },
      es: { translation: es },
      it: { translation: it },
      ru: { translation: ru },
      zhCN: {translation: zhCN},
    },
    lng: savedLng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });

bindDocumentDirection(
  i18n,
  () => localStorage.getItem('mailflow_interface_direction') || 'auto',
);

export default i18n;
