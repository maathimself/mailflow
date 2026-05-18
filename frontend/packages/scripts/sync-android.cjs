const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const packagesDir = path.join(root, 'packages');
const cap = path.join(
  root,
  'node_modules',
  '@capacitor',
  'cli',
  'bin',
  'capacitor',
);

const result = spawnSync(process.execPath, [cap, 'sync', 'android'], {
  cwd: packagesDir,
  stdio: 'inherit',
});

process.exit(result.status || 0);
