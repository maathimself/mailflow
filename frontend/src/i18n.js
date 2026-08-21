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
      pl: { translation: pl },
      cs: { translation: cs },
    },
    lng: savedLng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });

export default i18n;
