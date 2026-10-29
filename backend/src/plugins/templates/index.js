import router from './routes.js';
import { expandOutgoingVariables } from './variables.js';

export const templatesPlugin = {
  id: 'templates', name: 'Templates', version: '1.0.0', tier: 1,
  router: { base: '/api/templates', handler: router },
  hooks: { outgoingContent: expandOutgoingVariables },
};
