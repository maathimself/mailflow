import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(frontendRoot, '..');

const read = (path) => readFileSync(path, 'utf8');

test('uses MailExpert in product-facing metadata and documentation', () => {
  const frontendPackage = JSON.parse(read(join(frontendRoot, 'package.json')));
  const backendPackage = JSON.parse(read(join(repositoryRoot, 'backend', 'package.json')));
  const manifest = JSON.parse(read(join(frontendRoot, 'public', 'manifest.json')));

  assert.equal(frontendPackage.name, 'mailexpert-frontend');
  assert.equal(frontendPackage.productName, 'MailExpert');
  assert.equal(frontendPackage.bugs.url, 'https://github.com/wyrtensi/MailExpert/issues');
  assert.equal(backendPackage.name, 'mailexpert-backend');
  assert.equal(manifest.name, 'MailExpert');
  assert.equal(manifest.short_name, 'MailExpert');
  assert.match(read(join(frontendRoot, 'index.html')), /<title>MailExpert<\/title>/);
  const readme = read(join(repositoryRoot, 'README.md'));
  assert.match(readme, /<h1 align="center">MailExpert<\/h1>/);
  assert.match(readme, /media\/mailexpert-logo\.png/);
  assert.match(read(join(repositoryRoot, '.env.example')), /^# MailExpert — Environment Configuration$/m);
  const nativeSetup = read(join(frontendRoot, 'packages', 'native-shell', 'index.html'));
  const nativeUnavailable = read(join(frontendRoot, 'packages', 'native-shell', 'host-unavailable.html'));
  const electronMain = read(join(frontendRoot, 'packages', 'electron', 'main.cjs'));
  const androidPlugin = read(join(frontendRoot, 'packages', 'android', 'app', 'src', 'main', 'java', 'sh', 'mailflow', 'app', 'MailFlowNativePlugin.java'));
  assert.doesNotMatch(nativeSetup, /<title>MailFlow|>Connect MailFlow<|your MailFlow server/);
  assert.doesNotMatch(nativeUnavailable, /<title>MailFlow|alt="MailFlow"|>MailFlow could not/);
  assert.match(electronMain, /api\.github\.com\/repos\/wyrtensi\/MailExpert\/releases\/latest/);
  assert.match(androidPlugin, /api\.github\.com\/repos\/wyrtensi\/MailExpert\/releases\/latest/);
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
