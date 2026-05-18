const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const androidDir = path.join(root, 'packages', 'android');
const gradle = process.platform === 'win32' ? 'gradlew.bat' : 'sh';
const args = process.platform === 'win32'
  ? [':app:assembleRelease']
  : ['gradlew', ':app:assembleRelease'];

const result = spawnSync(gradle, args, {
  cwd: androidDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);
