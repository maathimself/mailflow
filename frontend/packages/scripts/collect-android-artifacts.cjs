const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outputsDir = path.join(root, 'packages', 'android', 'app', 'build', 'outputs');
const releaseDir = path.join(root, 'packages', 'release');

if (!fs.existsSync(outputsDir)) {
  throw new Error(`Android output directory not found: ${outputsDir}`);
}

const outputFiles = listFiles(outputsDir);
const apks = outputFiles.filter((file) => {
  const normalized = file.replace(/\\/g, '/').toLowerCase();
  return normalized.endsWith('.apk') && normalized.includes('/release/') && !normalized.endsWith('-unsigned.apk');
});

if (apks.length === 0) {
  const unsignedApks = outputFiles.filter((file) => {
    const normalized = file.replace(/\\/g, '/').toLowerCase();
    return normalized.endsWith('-unsigned.apk') && normalized.includes('/release/');
  });
  const found = outputFiles
    .map((file) => path.relative(root, file))
    .join('\n  ');
  const unsignedHint = unsignedApks.length > 0
    ? '\nUnsigned release APKs were found, but Android cannot install them. Configure release signing or rebuild with the updated Gradle fallback.'
    : '';
  throw new Error(`No signed Android release APK files found under ${outputsDir}.${unsignedHint}${found ? ` Found:\n  ${found}` : ''}`);
}

fs.mkdirSync(releaseDir, { recursive: true });

for (const apk of apks) {
  const suffix = apks.length === 1 ? '' : `-${path.basename(apk, '.apk')}`;
  const target = path.join(releaseDir, `MailFlow-${packageJson.version}${suffix}.apk`);
  fs.copyFileSync(apk, target);
  console.log(`Copied ${path.relative(root, apk)} -> ${path.relative(root, target)}`);
}

function listFiles(dir) {
  const files = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}
