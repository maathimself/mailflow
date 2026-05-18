const fs = require('fs');
const path = require('path');

const releaseDir = path.join(__dirname, '..', 'release');

if (!fs.existsSync(releaseDir)) {
  console.log('No release directory found; skipping Linux artifact rename.');
  process.exit(0);
}

const replacements = [
  [/^(.+)-x64\.AppImage$/, '$1.AppImage'],
  [/^(.+)-x64\.deb$/, '$1-amd64.deb'],
  [/^(.+)-arm64\.deb$/, '$1-arm64.deb'],
  [/^(.+)-x64\.snap$/, '$1-amd64.snap'],
  [/^(.+)-arm64\.snap$/, '$1-arm64.snap'],
  [/^(.+)-x64\.rpm$/, '$1-x86_64.rpm'],
  [/^(.+)-arm64\.rpm$/, '$1-aarch64.rpm'],
];

for (const entry of fs.readdirSync(releaseDir)) {
  if (/^(.+)-arm64\.AppImage$/.test(entry)) {
    fs.rmSync(path.join(releaseDir, entry), { force: true });
    console.log(`Removed unrequested Linux artifact ${entry}`);
    continue;
  }

  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(entry)) continue;

    const renamed = entry.replace(pattern, replacement);
    if (renamed === entry) break;

    const from = path.join(releaseDir, entry);
    const to = path.join(releaseDir, renamed);
    fs.renameSync(from, to);
    console.log(`Renamed ${entry} -> ${renamed}`);
    break;
  }
}
