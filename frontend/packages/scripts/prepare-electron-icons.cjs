const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..', '..');
const publicDir = path.join(rootDir, 'public');
const iconDir = path.join(rootDir, 'packages', 'electron', 'icons');

const pngBySize = new Map(
  [32, 72, 96, 128, 144, 152, 192, 384, 512]
    .map((size) => [size, path.join(publicDir, `icon-${size}.png`)])
    .filter(([, file]) => fs.existsSync(file))
);

if (!pngBySize.has(512)) {
  throw new Error('Expected frontend/public/icon-512.png to exist.');
}

fs.mkdirSync(iconDir, { recursive: true });

fs.copyFileSync(pngBySize.get(512), path.join(iconDir, 'icon.png'));
for (const [size, file] of pngBySize) {
  fs.copyFileSync(file, path.join(iconDir, `${size}x${size}.png`));
}

writeIco(path.join(iconDir, 'icon.ico'), [512, 128]);
writeIcns(path.join(iconDir, 'icon.icns'), [
  ['ic07', 128],
  ['ic09', 512],
]);

console.log(`Prepared Electron icons in ${path.relative(rootDir, iconDir)}`);

function writeIco(outFile, sizes) {
  const images = sizes
    .filter((size) => pngBySize.has(size))
    .map((size) => ({
      size,
      data: fs.readFileSync(pngBySize.get(size)),
    }));

  if (images.length === 0) {
    throw new Error('No suitable PNG files were found for icon.ico.');
  }

  const headerSize = 6;
  const entrySize = 16;
  let offset = headerSize + images.length * entrySize;
  const header = Buffer.alloc(offset);

  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  images.forEach((image, index) => {
    const entryOffset = headerSize + index * entrySize;
    header.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset);
    header.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(image.data.length, entryOffset + 8);
    header.writeUInt32LE(offset, entryOffset + 12);
    offset += image.data.length;
  });

  fs.writeFileSync(outFile, Buffer.concat([header, ...images.map((image) => image.data)]));
}

function writeIcns(outFile, entries) {
  const chunks = entries.map(([type, size]) => {
    const data = readBestPng(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });

  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(chunks.reduce((total, chunk) => total + chunk.length, 8), 4);

  fs.writeFileSync(outFile, Buffer.concat([header, ...chunks]));
}

function readBestPng(targetSize) {
  const exact = pngBySize.get(targetSize);
  if (exact) return fs.readFileSync(exact);

  const fallbackSize = [...pngBySize.keys()]
    .filter((size) => size >= targetSize)
    .sort((a, b) => a - b)[0] ?? 512;

  return fs.readFileSync(pngBySize.get(fallbackSize));
}
