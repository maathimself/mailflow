import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(frontendRoot, '..');

const read = (path) => readFileSync(path, 'utf8');
const legacyBrandPattern = new RegExp(['Mail', 'Flow'].join(''), 'i');

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
  const androidPlugin = read(join(frontendRoot, 'packages', 'android', 'app', 'src', 'main', 'java', 'sh', 'mailexpert', 'app', 'MailExpertNativePlugin.java'));
  const capacitorConfig = JSON.parse(read(join(frontendRoot, 'packages', 'capacitor.config.json')));
  const compose = read(join(repositoryRoot, 'docker-compose.yml'));
  const store = read(join(frontendRoot, 'src', 'store', 'index.js'));
  const favicon = read(join(frontendRoot, 'public', 'favicon.svg'));
  assert.doesNotMatch(nativeSetup, legacyBrandPattern);
  assert.doesNotMatch(nativeUnavailable, legacyBrandPattern);
  assert.match(electronMain, /api\.github\.com\/repos\/wyrtensi\/MailExpert\/releases\/latest/);
  assert.match(androidPlugin, /api\.github\.com\/repos\/wyrtensi\/MailExpert\/releases\/latest/);
  assert.equal(capacitorConfig.appId, 'sh.mailexpert.app');
  assert.doesNotMatch(electronMain, legacyBrandPattern);
  assert.doesNotMatch(androidPlugin, legacyBrandPattern);
  assert.doesNotMatch(compose, legacyBrandPattern);
  assert.doesNotMatch(store, legacyBrandPattern);
  assert.match(favicon, /#1ea7ff/);
  assert.match(favicon, /#e4002b/);
  assert.doesNotMatch(favicon, legacyBrandPattern);
});

test('does not expose the upstream name in localized product copy', () => {
  const localesDir = join(frontendRoot, 'src', 'locales');
  const localeFiles = readdirSync(localesDir).filter((name) => name.endsWith('.json'));

  for (const localeFile of localeFiles) {
    assert.doesNotMatch(
      read(join(localesDir, localeFile)),
      legacyBrandPattern,
      `${localeFile} still contains the upstream product name`,
    );
  }
});

test('does not render the upstream name as a split wordmark', () => {
  // The legacy brand was a styled wordmark split into two adjacent elements,
  // which the whole-word pattern above cannot see. The pattern is assembled from
  // parts so this test file does not match itself.
  const splitWordmarkPattern = new RegExp(
    ['>\\s*Mail\\s*', '<\\/[a-z]+>\\s*<[a-z]+\\b[^>]*>', '\\s*Flow\\s*<'].join(''),
    'i',
  );
  const sourceFiles = [];
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (statSync(child).isDirectory()) walk(child);
      else if (/\.(jsx?|html)$/.test(name)) sourceFiles.push(child);
    }
  };
  walk(join(frontendRoot, 'src'));

  assert.ok(sourceFiles.length > 0);
  for (const file of sourceFiles) {
    assert.doesNotMatch(read(file), splitWordmarkPattern, `${file} still renders the upstream wordmark`);
  }
});
