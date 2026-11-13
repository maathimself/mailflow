import { registerSlot } from '../registry.js';
import InsertTemplateButton from './InsertTemplateButton.jsx';
import DeferredNames from './DeferredNames.jsx';

registerSlot('compose-observers', {
  pluginId: 'templates',
  render: context => <DeferredNames context={context} />,
});

registerSlot('compose-actions', {
  pluginId: 'templates',
  render: context => <InsertTemplateButton context={context} />,
});
