const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const shellIndex = path.join(root, 'packages', 'native-shell', 'index.html');
const distIndex = path.join(root, 'dist', 'index.html');

fs.copyFileSync(shellIndex, distIndex);
console.log('Prepared native shell in dist/index.html');
