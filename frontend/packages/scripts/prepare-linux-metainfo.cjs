const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outputDir = path.join(root, 'packages', 'electron', 'metainfo');
const outputPath = path.join(outputDir, 'sh.mailflow.app.metainfo.xml');
const packageTypeDir = path.join(root, 'packages', 'electron', 'package-type');

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const releaseDate = new Date().toISOString().slice(0, 10);
const productName = packageJson.productName || 'MailFlow';
const description = packageJson.description || 'A self-hosted, unified webmail client.';
const homepage = packageJson.homepage || 'https://mailflow.sh';
const license = packageJson.license || 'GPL-3.0';

const metainfo = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>sh.mailflow.app</id>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>${escapeXml(license)}</project_license>
  <name>${escapeXml(productName)}</name>
  <summary>${escapeXml(description)}</summary>
  <developer_name>${escapeXml(packageJson.author && packageJson.author.name ? packageJson.author.name : productName)}</developer_name>
  <url type="homepage">${escapeXml(homepage)}</url>
  <url type="bugtracker">${escapeXml(packageJson.bugs && packageJson.bugs.url ? packageJson.bugs.url : `${homepage}/docs`)}</url>
  <launchable type="desktop-id">MailFlow.desktop</launchable>
  <categories>
    <category>Network</category>
    <category>Email</category>
  </categories>
  <description>
    <p>${escapeXml(description)}</p>
  </description>
  <releases>
    <release version="${escapeXml(packageJson.version)}" date="${releaseDate}" />
  </releases>
  <content_rating type="oars-1.1" />
</component>
`;

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, metainfo);
fs.mkdirSync(packageTypeDir, { recursive: true });
fs.writeFileSync(path.join(packageTypeDir, 'deb'), 'deb\n');
fs.writeFileSync(path.join(packageTypeDir, 'rpm'), 'rpm\n');
console.log(`Prepared Linux AppStream metadata at ${path.relative(root, outputPath)}.`);
