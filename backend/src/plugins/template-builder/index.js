import templateBuilderRoutes from './routes.js';

export const templateBuilderPlugin = {
  id: 'template-builder',
  name: 'Template Builder',
  version: '1.0.0',
  tier: 1,
  router: { base: '/api/template-builder', handler: templateBuilderRoutes },
};
