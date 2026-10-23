// Tier-2 plugin import boundary (v3.0 plugin platform).
//
// A sandboxed plugin may import ONLY the plugin API (../api.js) and its own siblings inside its
// plugin directory. It may NOT reach into core (../../services, ../../utils, ../../middleware,
// ../../index, ../../routes) or platform internals (../registry.js, ../storage.js, …). This config
// enforces that for everything under src/plugins/<name>/ (the barrel src/plugins/api.js and the
// platform files src/plugins/*.js are intentionally NOT covered — they ARE the sanctioned core).
//
// Kept out of the main eslint.config.js (which CI runs with --max-warnings 0) while GTD is still
// being migrated onto the API: run it on demand to measure/track the remaining violations —
//   node ./node_modules/eslint/bin/eslint.js -c eslint.plugins-boundary.js src/plugins
// Once GTD imports only ../api.js + siblings, fold this into the CI config as an error.
import globals from 'globals';

export default [
  {
    files: ['src/plugins/*/**/*.js'],
    ignores: ['**/*.test.js', 'src/plugins/gtd/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['../../**'],
            message: 'Plugin boundary: import core capabilities from the plugin API ("../api.js"), not core directly.',
          },
          {
            group: ['../*', '!../api.js'],
            message: 'Plugin boundary: from the plugin dir, only "../api.js" (the plugin API) may be imported.',
          },
        ],
      }],
    },
  },
  {
    files: ['src/plugins/gtd/**/*.js'],
    ignores: ['**/*.test.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['../../**'],
            message: 'Plugin boundary: import core capabilities from a reviewed plugin API.',
          },
          {
            group: ['../*', '!../api.js', '!../gtdApi.js'],
            message: 'Bundled GTD may import only "../api.js", "../gtdApi.js", and its siblings.',
          },
        ],
      }],
    },
  },
];
