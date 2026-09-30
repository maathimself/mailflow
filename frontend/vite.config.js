import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// pdf.js fetches these at run time by URL rather than importing them, so Vite cannot see them:
// the pure-JavaScript JBIG2 / JPEG 2000 decoders scanned PDFs need (the WebAssembly builds are not
// allowed by the app's CSP), the metric-compatible fonts for PDFs that do not embed theirs, and the
// character maps for CJK fonts that are not embedded (a Chinese invoice in STSong-Light shows no
// text without them). They are copied from whichever pdfjs-dist is installed, so they never drift
// from it, under a path named for its version: nginx caches .js as immutable, and without the
// version a browser would keep the old decoders after an upgrade.
function pdfjsRuntimeAssets() {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('pdfjs-dist/package.json'));
  const { version } = require('pdfjs-dist/package.json');
  const base = `pdfjs/${version}/`;
  const files = [
    ...readdirSync(join(root, 'wasm')).filter(f => f.endsWith('_nowasm_fallback.js') || f.startsWith('LICENSE')).map(f => ['wasm', f]),
    ...readdirSync(join(root, 'standard_fonts')).map(f => ['standard_fonts', f]),
    ...readdirSync(join(root, 'cmaps')).filter(f => f.endsWith('.bcmap') || f.startsWith('LICENSE')).map(f => ['cmaps', f]),
  ];
  return {
    name: 'pdfjs-runtime-assets',
    configureServer(server) {
      server.middlewares.use(`/${base}`, (req, res, next) => {
        const [dir, name] = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\//, '').split('/');
        if (!files.some(([d, f]) => d === dir && f === name)) return next();
        res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        res.end(readFileSync(join(root, dir, name)));
      });
    },
    generateBundle() {
      for (const [dir, name] of files) {
        this.emitFile({ type: 'asset', fileName: `${base}${dir}/${name}`, source: readFileSync(join(root, dir, name)) });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsRuntimeAssets()],
  // Module workers, so the pdf.js worker (an ES module) keeps its dynamic imports of the decoders.
  worker: { format: 'es' },
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
