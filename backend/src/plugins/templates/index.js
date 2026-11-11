import router from './routes.js';

export const templatesPlugin = {
  id: 'templates', name: 'Templates', version: '1.0.0', tier: 1,
  router: { base: '/api/templates', handler: router },
};
