const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const requestedVersion = process.argv[2] || process.env.APP_VERSION || process.env.GITHUB_REF_NAME;
const requestedCode = process.argv[3] || process.env.APP_VERSION_CODE || process.env.GITHUB_RUN_NUMBER;

function normalizeVersion(value) {
  if (!value) return null;

  const normalized = String(value).trim().replace(/^refs\/tags\//, '').replace(/^v[.]?/, '');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeVersionCode(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function updateJsonVersion(filePath, version) {
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  json.version = version;
  if (json.packages && json.packages['']) {
    json.packages[''].version = version;
  }
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

const version = normalizeVersion(requestedVersion);
if (!version) {
  if (requestedVersion) {
    console.error(`Invalid release tag version "${requestedVersion}". Expected a semver tag like v1.2.3.`);
    process.exit(1);
  }

  console.log('No release tag version detected; keeping package versions unchanged.');
  process.exit(0);
}

updateJsonVersion(path.join(root, 'package.json'), version);
updateJsonVersion(path.join(root, 'package-lock.json'), version);

const buildGradlePath = path.join(root, 'packages', 'android', 'app', 'build.gradle');
let buildGradle = fs.readFileSync(buildGradlePath, 'utf8');
buildGradle = buildGradle.replace(/versionName\s+"[^"]+"/, `versionName "${version}"`);

const versionCode = normalizeVersionCode(requestedCode);
if (versionCode) {
  buildGradle = buildGradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
}

fs.writeFileSync(buildGradlePath, buildGradle);

console.log(`Prepared app package version ${version}${versionCode ? ` (${versionCode})` : ''}.`);
