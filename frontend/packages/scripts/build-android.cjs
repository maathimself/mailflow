const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const androidDir = path.join(root, 'packages', 'android');
const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';

const result = spawnSync(gradle, [':app:assembleRelease'], {
  cwd: androidDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status || 0);
