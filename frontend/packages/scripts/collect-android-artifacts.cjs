const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const apkDir = path.join(root, 'packages', 'android', 'app', 'build', 'outputs', 'apk', 'release');
const releaseDir = path.join(root, 'packages', 'release');

if (!fs.existsSync(apkDir)) {
  throw new Error(`Android APK output directory not found: ${apkDir}`);
}

const apks = fs.readdirSync(apkDir)
  .filter((entry) => entry.endsWith('.apk'))
  .map((entry) => path.join(apkDir, entry));

if (apks.length === 0) {
  throw new Error(`No Android APK files found in ${apkDir}`);
}

fs.mkdirSync(releaseDir, { recursive: true });

for (const apk of apks) {
  const suffix = apks.length === 1 ? '' : `-${path.basename(apk, '.apk')}`;
  const target = path.join(releaseDir, `MailFlow-${packageJson.version}${suffix}.apk`);
  fs.copyFileSync(apk, target);
  console.log(`Copied ${path.relative(root, apk)} -> ${path.relative(root, target)}`);
}
