const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const shellIndex = path.join(root, 'packages', 'native-shell', 'index.html');
const shellHostUnavailable = path.join(root, 'packages', 'native-shell', 'host-unavailable.html');
const distIndex = path.join(root, 'dist', 'index.html');
const distHostUnavailable = path.join(root, 'dist', 'host-unavailable.html');

fs.copyFileSync(shellIndex, distIndex);

const hostUnavailableHtml = fs
  .readFileSync(shellHostUnavailable, 'utf8')
  .replace('../electron/icons/512x512.png', 'icon-512.png');
fs.writeFileSync(distHostUnavailable, hostUnavailableHtml);

console.log('Prepared native shell in dist/index.html and dist/host-unavailable.html');
