const { readdirSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { gzipSync } = require('node:zlib');

const MAX_GZIP_BYTES = 12 * 1024;
const distDirectory = resolve(__dirname, '../../dist');
const assetsDirectory = resolve(__dirname, '../../dist/assets');
const chunks = readdirSync(assetsDirectory)
  .filter(name => /^email-appearance-[^.]+\.js$/.test(name));

if (chunks.length !== 1) {
  throw new Error(`Expected one email appearance chunk, found ${chunks.length}`);
}

const chunk = chunks[0];
const gzipBytes = gzipSync(readFileSync(resolve(assetsDirectory, chunk))).byteLength;
console.log(`${chunk}: ${gzipBytes} gzip bytes (limit ${MAX_GZIP_BYTES})`);

if (gzipBytes > MAX_GZIP_BYTES) {
  process.exitCode = 1;
}

const safetyChunks = readdirSync(assetsDirectory)
  .filter(name => /^email-style-safety-[^.]+\.js$/.test(name));
if (safetyChunks.length !== 1) {
  throw new Error(`Expected one email style safety chunk, found ${safetyChunks.length}`);
}
const safetyChunk = safetyChunks[0];
const safetyGzipBytes = gzipSync(readFileSync(resolve(assetsDirectory, safetyChunk))).byteLength;
console.log(`${safetyChunk}: ${safetyGzipBytes} gzip bytes (eager preflight dependency)`);

const html = readFileSync(resolve(distDirectory, 'index.html'), 'utf8');
if (html.includes(`/assets/${chunk}`)) {
  throw new Error('Email appearance engine must not be preloaded by index.html');
}

const entries = readdirSync(assetsDirectory).filter(name => /^index-[^.]+\.js$/.test(name));
if (entries.length !== 1) throw new Error(`Expected one application entry, found ${entries.length}`);
const entry = readFileSync(resolve(assetsDirectory, entries[0]), 'utf8');
const staticImports = [...entry.matchAll(/(?:^|;)\s*import(?!\()[^;]*?["'`]([^"'`]+)["'`]/g)]
  .map(match => match[1]);
if (staticImports.some(specifier => specifier.endsWith(`/${chunk}`))) {
  throw new Error('Email appearance engine must remain dynamically imported');
}
