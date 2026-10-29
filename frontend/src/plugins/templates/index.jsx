import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { registerCollector, registerPluginMeta, registerSlot } from '../registry.js';
import InsertTemplateButton, { TemplateIcon } from './InsertTemplateButton.jsx';

const TemplatesSettings = lazy(() => import('./TemplatesSettings.jsx'));
function SettingsPage() {
  const { t } = useTranslation();
  return <Suspense fallback={<p>{t('common.loading')}</p>}><TemplatesSettings /></Suspense>;
}

registerPluginMeta('templates', {
  settingsLocation: { tab: 'templates', labelKey: 'templates.title' },
});

registerCollector('settings-tabs', {
  pluginId: 'templates',
  build: () => [{ id: 'templates', group: 'mail', labelKey: 'templates.title', icon: <TemplateIcon />, render: () => <SettingsPage /> }],
});

registerSlot('compose-actions', {
  pluginId: 'templates',
  render: context => <InsertTemplateButton context={context} />,
});
