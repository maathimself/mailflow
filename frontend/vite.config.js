import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const EMAIL_APPEARANCE_MODULES = [
  '/src/utils/emailColors.js',
  '/src/utils/emailPalette.js',
  '/src/utils/emailAppearance.js',
];

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{
            name: 'email-style-safety',
            test: id => id.replaceAll('\\', '/').endsWith('/src/utils/cssControlText.js'),
            priority: 2,
            includeDependenciesRecursively: false,
          }, {
            name: 'email-appearance',
            test: id => EMAIL_APPEARANCE_MODULES.some(
              path => id.replaceAll('\\', '/').endsWith(path),
            ),
            priority: 1,
            includeDependenciesRecursively: false,
          }],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://backend:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://backend:3000',
        ws: true,
      }
    }
  }
});
