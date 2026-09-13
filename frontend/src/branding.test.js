import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(frontendRoot, '..');

const read = (path) => readFileSync(path, 'utf8');

test('uses MailExp in product-facing metadata and documentation', () => {
  const frontendPackage = JSON.parse(read(join(frontendRoot, 'package.json')));
  const backendPackage = JSON.parse(read(join(repositoryRoot, 'backend', 'package.json')));
  const manifest = JSON.parse(read(join(frontendRoot, 'public', 'manifest.json')));

  assert.equal(frontendPackage.name, 'mailexp-frontend');
  assert.equal(frontendPackage.productName, 'MailExp');
  assert.equal(frontendPackage.bugs.url, 'https://github.com/wyrtensi/MailExp/issues');
  assert.equal(backendPackage.name, 'mailexp-backend');
  assert.equal(manifest.name, 'MailExp');
  assert.equal(manifest.short_name, 'MailExp');
  assert.match(read(join(frontendRoot, 'index.html')), /<title>MailExp<\/title>/);
  assert.match(read(join(repositoryRoot, 'README.md')), /^# MailExp\b/m);
  assert.match(read(join(repositoryRoot, '.env.example')), /^# MailExp — Environment Configuration$/m);
  const nativeSetup = read(join(frontendRoot, 'packages', 'native-shell', 'index.html'));
  const nativeUnavailable = read(join(frontendRoot, 'packages', 'native-shell', 'host-unavailable.html'));
  const electronMain = read(join(frontendRoot, 'packages', 'electron', 'main.cjs'));
  const androidPlugin = read(join(frontendRoot, 'packages', 'android', 'app', 'src', 'main', 'java', 'sh', 'mailflow', 'app', 'MailFlowNativePlugin.java'));
  assert.doesNotMatch(nativeSetup, /<title>MailFlow|>Connect MailFlow<|your MailFlow server/);
  assert.doesNotMatch(nativeUnavailable, /<title>MailFlow|alt="MailFlow"|>MailFlow could not/);
  assert.match(electronMain, /api\.github\.com\/repos\/wyrtensi\/MailExp\/releases\/latest/);
  assert.match(androidPlugin, /api\.github\.com\/repos\/wyrtensi\/MailExp\/releases\/latest/);
  assert.doesNotMatch(electronMain, /api\.github\.com\/repos\/maathimself\/mailflow\/releases/);
  assert.doesNotMatch(androidPlugin, /api\.github\.com\/repos\/maathimself\/mailflow\/releases/);
});

test('does not expose the upstream name in localized product copy', () => {
  const localesDir = join(frontendRoot, 'src', 'locales');
  const localeFiles = readdirSync(localesDir).filter((name) => name.endsWith('.json'));

  for (const localeFile of localeFiles) {
    assert.doesNotMatch(
      read(join(localesDir, localeFile)),
      /MailFlow/,
      `${localeFile} still contains the upstream product name`,
    );
  }
});
