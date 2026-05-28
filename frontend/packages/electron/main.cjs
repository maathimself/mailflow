const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, dialog, Notification } = require('electron');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const CONFIG_FILE = 'mailflow-host.json';
const UPDATE_STATUS_CHANNEL = 'mailflow:updates:status';
const UPDATE_RELEASE_URL = 'https://api.github.com/repos/dcoffin88/mailflow/releases/latest';
const UPDATE_ERROR_MESSAGE = 'Could not check for MailFlow updates. Please visit the website instead.';
const NATIVE_ACTION_CHANNEL = 'mailflow:native-action';
const NATIVE_ACTION_ARG = '--mailflow-action=';
const NEW_MAIL_NOTIFICATION_MAX_LENGTH = 240;
const MAILTO_PROTOCOL = 'mailto';
const LINUX_BADGE_DESKTOP_IDS = [
  'MailFlow.desktop',
  'mailflow.desktop',
  'sh.mailflow.app.desktop',
  'mailflow-frontend.desktop',
];

let mainWindow;
let tray = null;
let isQuitting = false;
let updateInfo = null;
let downloadedUpdate = null;
let updateDownloadsInitialized = false;
let nextNativeActionId = 1;
const pendingNativeActions = new Map();
const pendingProtocolUrls = [];

app.setName('MailFlow');
if (process.platform === 'win32') {
  app.setAppUserModelId('sh.mailflow.app');
}
if (process.platform === 'linux' && typeof app.setDesktopName === 'function') {
  app.setDesktopName('MailFlow.desktop');
}

if (process.platform === 'linux' && process.env.APPIMAGE) {
  app.commandLine.appendSwitch('no-sandbox');
}

function registerMailtoProtocol() {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      const registered = app.setAsDefaultProtocolClient(MAILTO_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
      registerWindowsMailtoCapabilities();
      return registered;
    }

    const registered = app.setAsDefaultProtocolClient(MAILTO_PROTOCOL);
    registerWindowsMailtoCapabilities();
    return registered;
  } catch (error) {
    console.error('Could not register mailto protocol handler:', error);
    return false;
  }
}

function writeCurrentUserRegValue(key, name, value) {
  const args = ['add', key, name ? '/v' : '/ve'];
  if (name) args.push(name);
  args.push('/t', 'REG_SZ', '/d', value, '/f');
  execFileSync('reg', args, { stdio: 'ignore', windowsHide: true });
}

function registerWindowsMailtoCapabilities() {
  if (process.platform !== 'win32') return false;

  try {
    const exePath = process.execPath;
    const command = `"${exePath}" "%1"`;

    writeCurrentUserRegValue('HKCU\\Software\\RegisteredApplications', 'MailFlow', 'Software\\Clients\\Mail\\MailFlow\\Capabilities');
    writeCurrentUserRegValue('HKCU\\Software\\Clients\\Mail\\MailFlow', '', 'MailFlow');
    writeCurrentUserRegValue('HKCU\\Software\\Clients\\Mail\\MailFlow\\Capabilities', 'ApplicationName', 'MailFlow');
    writeCurrentUserRegValue('HKCU\\Software\\Clients\\Mail\\MailFlow\\Capabilities', 'ApplicationDescription', 'A self-hosted, unified webmail client.');
    writeCurrentUserRegValue('HKCU\\Software\\Clients\\Mail\\MailFlow\\Capabilities\\URLAssociations', 'mailto', 'MailFlow.mailto');
    writeCurrentUserRegValue('HKCU\\Software\\Classes\\MailFlow.mailto', '', 'URL:MailFlow MailTo Protocol');
    writeCurrentUserRegValue('HKCU\\Software\\Classes\\MailFlow.mailto', 'URL Protocol', '');
    writeCurrentUserRegValue('HKCU\\Software\\Classes\\MailFlow.mailto\\DefaultIcon', '', `${exePath},0`);
    writeCurrentUserRegValue('HKCU\\Software\\Classes\\MailFlow.mailto\\shell\\open\\command', '', command);

    return true;
  } catch (error) {
    console.error('Could not register Windows mailto capabilities:', error);
    return false;
  }
}

function getIconPath() {
  return path.join(__dirname, 'icons', 'icon.png');
}

function getWindowIconPath() {
  if (process.platform === 'win32') return path.join(__dirname, 'icons', 'icon.ico');
  if (process.platform === 'linux') return getIconPath();
  return undefined;
}

function getConfigPath() {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

function readHost() {
  try {
    const config = readConfig();
    return normalizeHost(config.host);
  } catch {
    return null;
  }
}

function writeHost(host) {
  const normalized = normalizeHost(host);
  writeConfig({ ...readConfig(), host: normalized });
  return normalized;
}

function clearHost() {
  const config = readConfig();
  delete config.host;
  writeConfig(config);
}

function normalizeHost(value) {
  const input = String(value || '').trim();
  const url = new URL(input);

  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('Host must start with https:// or http://');
  }

  url.username = '';
  url.password = '';
  url.hash = '';
  url.search = '';
  url.pathname = '/';

  return url.toString().replace(/\/$/, '');
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `MailFlow/${app.getVersion()}`,
      },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        requestJson(response.headers.location).then(resolve, reject);
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Update request failed with status ${response.statusCode}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on('error', reject);
    request.setTimeout(15000, () => {
      request.destroy(new Error('Update request timed out'));
    });
  });
}

function parseVersion(value) {
  const match = String(value || '').match(/\d+(?:\.\d+){0,2}/);
  if (!match) return null;
  return match[0].split('.').map((part) => Number.parseInt(part, 10));
}

function isNewerVersion(candidate, current) {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;

  for (let index = 0; index < 3; index += 1) {
    const nextPart = next[index] || 0;
    const installedPart = installed[index] || 0;
    if (nextPart > installedPart) return true;
    if (nextPart < installedPart) return false;
  }

  return false;
}

function getLinuxDistributionIds() {
  if (process.platform !== 'linux') return [];

  try {
    const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
    const ids = [];

    for (const key of ['ID', 'ID_LIKE']) {
      const match = osRelease.match(new RegExp(`^${key}=(.+)$`, 'm'));
      if (!match) continue;

      const values = match[1]
        .replace(/^"|"$/g, '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      ids.push(...values);
    }

    return ids;
  } catch {
    return [];
  }
}

function isDebLikeLinuxDistribution(distroIds = getLinuxDistributionIds()) {
  return distroIds.some((id) => ['debian', 'ubuntu', 'linuxmint', 'pop'].some((match) => id === match || id.includes(match)));
}

function isRpmLikeLinuxDistribution(distroIds = getLinuxDistributionIds()) {
  return distroIds.some((id) => ['fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'suse', 'opensuse'].some((match) => id === match || id.includes(match)));
}

function getInstalledLinuxPackageType() {
  if (process.platform !== 'linux') return null;
  if (process.env.APPIMAGE) return 'appimage';

  try {
    const packageType = fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim().toLowerCase();
    if (['deb', 'rpm', 'appimage'].includes(packageType)) return packageType;
  } catch {}

  if (getLinuxPackageManagerVersion('rpm')) return 'rpm';
  if (getLinuxPackageManagerVersion('deb')) return 'deb';

  const distroIds = getLinuxDistributionIds();
  if (isRpmLikeLinuxDistribution(distroIds) || getAvailableCommand(['rpm', 'dnf', 'dnf5', 'yum'])) return 'rpm';
  if (isDebLikeLinuxDistribution(distroIds) || getAvailableCommand(['dpkg', 'apt', 'apt-get'])) return 'deb';

  return null;
}

function getLinuxPackageManagerVersion(packageType) {
  if (process.platform !== 'linux' || !['deb', 'rpm'].includes(packageType)) return null;

  const packageNames = ['mailflow', 'MailFlow', 'mailflow-frontend'];
  for (const packageName of packageNames) {
    try {
      const args = packageType === 'rpm'
        ? ['-q', '--qf', '%{VERSION}', packageName]
        : ['-W', '-f=${Version}', packageName];
      const command = packageType === 'rpm' ? 'rpm' : 'dpkg-query';
      const output = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (output) return output;
    } catch {}
  }

  return null;
}

function getInstalledAppVersion(packageType = getInstalledLinuxPackageType()) {
  return getLinuxPackageManagerVersion(packageType) || app.getVersion();
}

function getAvailableCommand(commands = []) {
  for (const command of commands) {
    try {
      const output = execFileSync('which', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (output) return command;
    } catch {}
  }

  return null;
}

function emitUnityLauncherBadgeCount(count) {
  if (process.platform !== 'linux') return false;

  const gdbus = getAvailableCommand(['gdbus']);
  if (!gdbus) return false;

  const visible = count > 0;
  const properties = visible
    ? `{'count': <int64 ${count}>, 'count-visible': <true>}`
    : `{'count': <int64 0>, 'count-visible': <false>}`;

  for (const desktopId of LINUX_BADGE_DESKTOP_IDS) {
    const child = spawn(gdbus, [
      'emit',
      '--session',
      '--object-path',
      '/',
      '--signal',
      'com.canonical.Unity.LauncherEntry.Update',
      `application://${desktopId}`,
      properties,
    ], {
      detached: true,
      stdio: 'ignore',
    });

    child.unref();
  }

  return true;
}

function setUnreadBadgeCount(count) {
  let badgeSet = false;

  if (typeof app.setBadgeCount === 'function') {
    badgeSet = app.setBadgeCount(count);
  }

  return emitUnityLauncherBadgeCount(count) || badgeSet;
}

function getLinuxPackagePatternGroups() {
  const arch = process.arch === 'arm64'
    ? '(?:arm64|aarch64)'
    : '(?:amd64|x64|x86_64)';
  const deb = [new RegExp(`${arch}\\.deb$`, 'i'), /\.deb$/i];
  const rpm = [new RegExp(`${arch}\\.rpm$`, 'i'), /\.rpm$/i];

  const installedPackageType = getInstalledLinuxPackageType();
  if (installedPackageType === 'appimage') return [];
  if (installedPackageType === 'deb') return [deb];
  if (installedPackageType === 'rpm') return [rpm];

  const distroIds = getLinuxDistributionIds();
  if (isDebLikeLinuxDistribution(distroIds)) {
    return [deb];
  }
  if (isRpmLikeLinuxDistribution(distroIds)) {
    return [rpm];
  }

  if (getAvailableCommand(['rpm', 'dnf', 'dnf5', 'yum'])) return [rpm];
  if (getAvailableCommand(['dpkg', 'apt', 'apt-get'])) return [deb];

  return [];
}

function getUpdateAsset(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const platformAssetPatternGroups = {
    win32: [[/setup.*\.exe$/i], [/\.exe$/i]],
    darwin: [[/\.dmg$/i]],
    linux: getLinuxPackagePatternGroups(),
  };
  const patternGroups = platformAssetPatternGroups[process.platform] || [];

  for (const patterns of patternGroups) {
    for (const pattern of patterns) {
      const asset = assets.find((item) => pattern.test(item.name || '') && item.browser_download_url);
      if (asset) return asset;
    }
  }

  return null;
}

function sendUpdateStatus(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(UPDATE_STATUS_CHANNEL, payload);
}

function showInAppNotification({ title = '', message = '', type = 'info', actionLabel = '', action = '', persistent = false }) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const payload = JSON.stringify({ title, message, type, actionLabel, action, persistent });
  mainWindow.webContents.executeJavaScript(`
    (() => {
      if (window.__mailflowNativeBridgeReady) return;

      const notification = ${payload};
      const id = 'mailflow-electron-toasts';
      let root = document.getElementById(id);

      if (!root) {
        root = document.createElement('div');
        root.id = id;
        root.style.position = 'fixed';
        root.style.right = '24px';
        root.style.bottom = '24px';
        root.style.zIndex = '2147483647';
        root.style.display = 'flex';
        root.style.flexDirection = 'column-reverse';
        root.style.gap = '8px';
        root.style.pointerEvents = 'none';
        document.documentElement.appendChild(root);
      }

      const toast = document.createElement('div');
      toast.style.width = '340px';
      toast.style.maxWidth = 'calc(100vw - 48px)';
      toast.style.boxSizing = 'border-box';
      toast.style.display = 'flex';
      toast.style.alignItems = 'flex-start';
      toast.style.gap = '10px';
      toast.style.padding = '12px 14px';
      toast.style.borderRadius = '10px';
      toast.style.border = '1px solid rgba(255,255,255,0.10)';
      toast.style.background = 'rgba(36,36,41,0.98)';
      toast.style.boxShadow = '0 4px 20px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.04)';
      toast.style.color = '#e8e8ed';
      toast.style.font = '13px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      toast.style.pointerEvents = 'all';
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'opacity 180ms ease, transform 180ms ease';

      const icon = document.createElement('div');
      icon.style.width = '32px';
      icon.style.height = '32px';
      icon.style.borderRadius = '8px';
      icon.style.flex = '0 0 auto';
      icon.style.display = 'grid';
      icon.style.placeItems = 'center';
      icon.style.background = notification.type === 'negative' || notification.type === 'error'
        ? 'rgba(248,113,113,0.15)'
        : 'rgba(124,106,247,0.28)';
      icon.style.color = notification.type === 'negative' || notification.type === 'error' ? '#f87171' : '#a99cff';
      icon.textContent = notification.type === 'positive' ? '✓' : notification.type === 'negative' || notification.type === 'error' ? '!' : 'i';

      const copy = document.createElement('div');
      copy.style.flex = '1';
      copy.style.minWidth = '0';

      const heading = document.createElement('div');
      heading.textContent = notification.title;
      heading.style.fontWeight = '650';
      heading.style.marginBottom = '2px';
      heading.style.whiteSpace = 'nowrap';
      heading.style.overflow = 'hidden';
      heading.style.textOverflow = 'ellipsis';

      const body = document.createElement('div');
      body.textContent = notification.message;
      body.style.fontSize = '12px';
      body.style.color = '#9898a8';
      body.style.whiteSpace = 'normal';
      body.style.overflow = 'visible';
      body.style.textOverflow = 'clip';
      body.style.lineHeight = '1.35';

      const close = document.createElement('button');
      close.type = 'button';
      close.setAttribute('aria-label', 'Dismiss');
      close.textContent = '×';
      close.style.border = '0';
      close.style.background = 'transparent';
      close.style.color = '#9898a8';
      close.style.cursor = 'pointer';
      close.style.font = '20px/1 Inter, ui-sans-serif, system-ui';
      close.style.padding = '0';

      let action = null;
      if (notification.actionLabel && notification.action) {
        action = document.createElement('button');
        action.type = 'button';
        action.textContent = notification.actionLabel;
        action.style.border = '1px solid rgba(255,255,255,0.12)';
        action.style.borderRadius = '6px';
        action.style.background = 'rgba(255,255,255,0.08)';
        action.style.color = '#e8e8ed';
        action.style.cursor = 'pointer';
        action.style.font = '600 12px Inter, ui-sans-serif, system-ui';
        action.style.padding = '5px 10px';
        action.style.flex = '0 0 auto';
        action.addEventListener('click', () => {
          if (notification.action === 'install-update') {
            window.mailflowNative?.updates?.installDownloaded?.();
          }
          dismiss();
        });
      }

      const dismiss = () => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        window.setTimeout(() => toast.remove(), 190);
      };

      close.addEventListener('click', dismiss);
      copy.append(heading, body);
      toast.append(icon, copy);
      if (action) toast.appendChild(action);
      toast.appendChild(close);
      root.appendChild(toast);

      window.requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(0)';
      });

      if (!notification.persistent) {
        window.setTimeout(dismiss, 5000);
      }
    })();
  `).catch(() => {});
}

function notifyUpdateStatus({ title, message, type = 'info' }) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  showInAppNotification({ title, message, type });
  mainWindow.webContents.send('mailflow:notifications:push', { title, message, type });
}

function cleanNotificationText(value, fallback = '') {
  const text = String(value || fallback)
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= NEW_MAIL_NOTIFICATION_MAX_LENGTH) return text;
  return `${text.slice(0, NEW_MAIL_NOTIFICATION_MAX_LENGTH - 1)}…`;
}

function showNewMailNotification({ title, body, count, messageId, accountId, folder, message } = {}) {
  if (!Notification.isSupported()) {
    return { shown: false, reason: 'unsupported' };
  }

  const normalizedTitle = cleanNotificationText(title, 'New mail');
  const normalizedBody = cleanNotificationText(body, 'No subject');
  const notification = new Notification({
    title: normalizedTitle,
    body: count > 1 ? `${normalizedBody}\n${count} new messages` : normalizedBody,
    icon: getIconPath(),
    silent: true,
  });

  notification.on('click', () => {
    if (messageId) {
      sendNativeAction('open-message', {
        messageId,
        accountId,
        folder,
        message,
      });
      return;
    }

    showMainWindow();
  });
  notification.show();

  return { shown: true };
}

function notifyCheckingUpdate(verbose) {
  if (!verbose) return;

  sendUpdateStatus({ type: 'checking' });
  notifyUpdateStatus({
    title: 'Checking for update',
    message: 'Checking for new MailFlow updates.',
  });
}

function notifyUpdateError(message = UPDATE_ERROR_MESSAGE) {
  sendUpdateStatus({ type: 'error', message });
  notifyUpdateStatus({
    title: 'Update Error',
    message,
    type: 'negative',
  });
}

function notifyUpToDate(verbose) {
  if (!verbose) return;

  sendUpdateStatus({ type: 'up-to-date' });
  notifyUpdateStatus({
    title: 'Up to date',
    message: 'Your version of MailFlow is up to date.',
    type: 'positive',
  });
}

function notifyUpdateAvailable(verbose = true) {
  sendUpdateStatus({
    type: 'available',
    data: {
      releaseNotes: updateInfo.releaseNotes,
      releaseName: updateInfo.releaseName,
      releaseDate: updateInfo.releaseDate,
      updateUrl: updateInfo.updateUrl,
      manual: true,
    },
  });

  if (!verbose) return;

  notifyUpdateStatus({
    title: 'Update Available',
    message: 'MailFlow is downloading the newest version for you.',
  });
}

function notifyUpdateDownloaded() {
  sendUpdateStatus({
    type: 'downloaded',
    data: {
      releaseNotes: updateInfo && updateInfo.releaseNotes,
      releaseName: updateInfo && updateInfo.releaseName,
      releaseDate: updateInfo && updateInfo.releaseDate,
      updateUrl: updateInfo && updateInfo.updateUrl,
      filePath: downloadedUpdate,
      manual: true,
    },
  });
  showInAppNotification({
    title: 'Update Ready',
    message: 'MailFlow downloaded the update.',
    type: 'positive',
    actionLabel: 'Install',
    action: 'install-update',
    persistent: true,
  });
}

function filePostfix() {
  const date = new Date();
  return `${date.getMonth() + 1}.${date.getDate()}-${date.getHours()}.${date.getMinutes()}.${date.getSeconds()}`;
}

function getUniqueFilename(filename) {
  const extension = path.extname(filename);
  const file = path.basename(filename, extension);
  return `${file} (${filePostfix()})${extension}`;
}

function setDownloadProgress(window, value) {
  try {
    if (!window || window.isDestroyed()) return;
    window.setProgressBar(value);
  } catch {
    // Download events can outlive the BrowserWindow they started from.
  }
}

function getLinuxTerminalCommand() {
  return getAvailableCommand([
    'ptyxis',
    'kgx',
    'gnome-terminal',
    'konsole',
    'xterm',
    'x-terminal-emulator',
  ]);
}

function getTerminalArgs(terminal, command, args = []) {
  const shellCommand = ['sh', '-lc', 'exec "$@"', 'mailflow-installer', command, ...args];
  if (['ptyxis', 'kgx', 'gnome-terminal'].includes(terminal)) return ['--', ...shellCommand];
  return ['-e', ...shellCommand];
}

function launchTerminalCommand(command, args = []) {
  const terminal = getLinuxTerminalCommand();
  if (!terminal) {
    throw new Error('No supported terminal was found.');
  }

  const child = spawn(terminal, getTerminalArgs(terminal, command, args), {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();
}

function initializeUpdateDownloads(window) {
  if (updateDownloadsInitialized) return;
  updateDownloadsInitialized = true;

  window.webContents.session.on('will-download', (_event, item) => {
    const totalBytes = item.getTotalBytes();
    const filePath = path.join(app.getPath('downloads'), getUniqueFilename(item.getFilename()));

    item.setSavePath(filePath);

    item.on('updated', () => {
      if (totalBytes > 0) {
        setDownloadProgress(window, item.getReceivedBytes() / totalBytes);
      }
    });

    item.on('done', (_event, state) => {
      setDownloadProgress(window, -1);

      if (state === 'interrupted') {
        dialog.showErrorBox('Download error', `The download of ${item.getFilename()} was interrupted.`);
      }

      if (state === 'completed') {
        downloadedUpdate = item.getSavePath();
        notifyUpdateDownloaded();
      }
    });
  });
}

function downloadUpdate(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.downloadURL(url);
}

async function checkForUpdates(verbose = false) {
  notifyCheckingUpdate(verbose);

  try {
    const release = await requestJson(UPDATE_RELEASE_URL);
    const releaseVersion = release.tag_name || release.name;
    const installedPackageType = getInstalledLinuxPackageType();
    const installedVersion = getInstalledAppVersion(installedPackageType);
    const asset = getUpdateAsset(release);

    if (!isNewerVersion(releaseVersion, installedVersion)) {
      notifyUpToDate(verbose);
      return { updateAvailable: false };
    }

    if (!asset) {
      notifyUpdateError('A MailFlow update is available, but no installer was found for this platform.');
      return { updateAvailable: true, downloadAvailable: false };
    }

    updateInfo = {
      releaseNotes: release.body || '',
      releaseName: release.name || release.tag_name,
      releaseDate: release.published_at,
      updateUrl: asset.browser_download_url,
    };

    notifyUpdateAvailable(verbose);
    downloadUpdate(asset.browser_download_url);
    return { updateAvailable: true, downloadAvailable: true };
  } catch (error) {
    console.error('Update check failed:', error);
    notifyUpdateError();
    return { updateAvailable: false, error: error.message };
  }
}

function launchDownloadedUpdate(updatePath) {
  if (process.platform === 'win32' && /\.exe$/i.test(updatePath)) {
    const child = spawn(updatePath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });

    child.unref();
    return Promise.resolve();
  }

  if (process.platform === 'linux' && /\.deb$/i.test(updatePath)) {
    launchTerminalCommand('sudo', ['dpkg', '--install', updatePath]);
    return Promise.resolve();
  }

  if (process.platform === 'linux' && /\.rpm$/i.test(updatePath)) {
    const packageInstaller = getAvailableCommand(['dnf', 'dnf5', 'yum']);
    if (!packageInstaller) {
      throw new Error('No RPM package installer was found.');
    }

    launchTerminalCommand('sudo', [packageInstaller, 'install', updatePath]);
    return Promise.resolve();
  }

  return shell.openPath(updatePath).then((error) => {
    if (error) throw new Error(error);
  });
}

function installDownloadedUpdate() {
  if (!downloadedUpdate) {
    return Promise.resolve({ installed: false, reason: 'missing-download' });
  }

  return new Promise((resolve) => {
    fs.access(downloadedUpdate, fs.constants.F_OK, async (error) => {
      if (error) {
        shell.showItemInFolder(downloadedUpdate);
        resolve({ installed: false, reason: 'missing-file' });
        return;
      }

      try {
        await launchDownloadedUpdate(downloadedUpdate);
        isQuitting = true;
        setTimeout(() => app.quit(), 500);
        resolve({ installed: true });
      } catch (launchError) {
        console.error('Could not launch downloaded update:', launchError);
        shell.showItemInFolder(downloadedUpdate);
        notifyUpdateError('The update was downloaded, but MailFlow could not start the installer.');
        resolve({ installed: false, reason: 'launch-failed', error: launchError.message });
      }
    });
  });
}

function openDownloadedUpdatePath() {
  if (!downloadedUpdate) return;
  shell.showItemInFolder(downloadedUpdate);
}

function isMailtoUrl(value) {
  return /^mailto:/i.test(String(value || '').trim());
}

function parseProtocolUrlArg(args = []) {
  return args.find(isMailtoUrl) || null;
}

function splitMailtoAddresses(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function appendMailtoAddresses(target, value) {
  target.push(...splitMailtoAddresses(value));
}

function parseMailtoUrl(url) {
  const input = String(url || '').trim();
  if (!isMailtoUrl(input)) return null;

  try {
    const parsed = new URL(input);
    const composeData = {
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      body: '',
    };

    appendMailtoAddresses(composeData.to, decodeURIComponent(parsed.pathname || ''));

    for (const [key, value] of parsed.searchParams.entries()) {
      const normalizedKey = key.toLowerCase();

      if (normalizedKey === 'to') appendMailtoAddresses(composeData.to, value);
      else if (normalizedKey === 'cc') appendMailtoAddresses(composeData.cc, value);
      else if (normalizedKey === 'bcc') appendMailtoAddresses(composeData.bcc, value);
      else if (normalizedKey === 'subject') composeData.subject = value;
      else if (normalizedKey === 'body') composeData.body = value;
    }

    composeData.to = [...new Set(composeData.to)];
    composeData.cc = [...new Set(composeData.cc)];
    composeData.bcc = [...new Set(composeData.bcc)];

    return composeData;
  } catch (error) {
    console.error('Could not parse mailto URL:', error);
    return null;
  }
}

function sendMailtoAction(url) {
  const composeData = parseMailtoUrl(url);
  if (!composeData) return false;

  sendNativeAction('new-mail', { composeData, source: 'mailto' });
  return true;
}

function flushPendingProtocolUrls() {
  while (pendingProtocolUrls.length > 0) {
    sendMailtoAction(pendingProtocolUrls.shift());
  }
}

function parseNativeActionArg(args = []) {
  const actionArg = args.find((arg) => String(arg).startsWith(NATIVE_ACTION_ARG));
  if (!actionArg) return null;

  const action = actionArg.slice(NATIVE_ACTION_ARG.length);
  if (['new-mail', 'sync'].includes(action)) return action;
  return null;
}

function createNativeActionPayload(action, data = {}) {
  const payload = {
    ...data,
    id: nextNativeActionId,
    action,
    createdAt: Date.now(),
  };
  nextNativeActionId += 1;
  pendingNativeActions.set(payload.id, payload);
  return payload;
}

function sendNativeAction(action, data = {}) {
  if (!action) return;

  const payload = createNativeActionPayload(action, data);
  showMainWindow();

  const dispatchScript = `
    window.dispatchEvent(new CustomEvent('mailflow:native-action', {
      detail: ${JSON.stringify(payload)}
    }));
    window.postMessage({
      type: 'mailflow:native-action',
      payload: ${JSON.stringify(payload)}
    }, '*');
  `;

  const send = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(NATIVE_ACTION_CHANNEL, payload);
    mainWindow.webContents.executeJavaScript(dispatchScript).catch(() => {});
  };

  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(send, 100);
    });
    return;
  }

  setTimeout(send, 100);
}

function nativeActionMenuItems() {
  return [
    {
      label: 'New Mail',
      click: () => sendNativeAction('new-mail'),
    },
    {
      label: 'Sync',
      click: () => sendNativeAction('sync'),
    },
  ];
}

function changeMailFlowHost() {
  clearHost();
  showMainWindow();
  loadSetup();
}

function fileMenuItems() {
  return [
    {
      label: 'Change MailFlow Host',
      accelerator: 'CmdOrCtrl+,',
      click: changeMailFlowHost,
    },
  ];
}

function editMenuItems() {
  return [
    { label: 'Undo', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
    { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo' },
    { type: 'separator' },
    { label: 'Cut', accelerator: 'CmdOrCtrl+X', role: 'cut' },
    { label: 'Copy', accelerator: 'CmdOrCtrl+C', role: 'copy' },
    { label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' },
    { label: 'Paste and Match Style', accelerator: 'Shift+CmdOrCtrl+V', role: 'pasteAndMatchStyle' },
    { label: 'Delete', role: 'delete' },
    { type: 'separator' },
    { label: 'Select All', accelerator: 'CmdOrCtrl+A', role: 'selectAll' },
  ];
}

function viewMenuItems() {
  return [
    {
      label: 'Reload',
      accelerator: 'CmdOrCtrl+R',
      click(_item, focusedWindow) {
        if (focusedWindow) focusedWindow.reload();
      },
    },
    {
      label: 'Toggle Full Screen',
      accelerator: process.platform === 'darwin' ? 'Ctrl+Command+F' : 'F11',
      click(_item, focusedWindow) {
        if (!focusedWindow) return;
        focusedWindow.setFullScreen(!focusedWindow.isFullScreen());
      },
    },
    {
      label: 'Toggle Developer Tools',
      accelerator: process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I',
      click(_item, focusedWindow) {
        if (focusedWindow) focusedWindow.webContents.toggleDevTools();
      },
    },
  ];
}

function windowMenuItems() {
  if (process.platform === 'darwin') {
    return [
      { label: 'Close', accelerator: 'CmdOrCtrl+W', role: 'close' },
      { label: 'Minimize', accelerator: 'CmdOrCtrl+M', role: 'minimize' },
      { label: 'Zoom', role: 'zoom' },
      { type: 'separator' },
      { label: 'Bring All to Front', role: 'front' },
    ];
  }

  return [
    { label: 'Minimize', accelerator: 'CmdOrCtrl+M', role: 'minimize' },
    { label: 'Close', accelerator: 'CmdOrCtrl+W', role: 'close' },
  ];
}

function helpMenuItems() {
  return [
    {
      label: 'Learn More',
      click: () => shell.openExternal('https://mailflow.sh'),
    },
    { type: 'separator' },
    {
      label: 'Help',
      click: () => shell.openExternal('https://mailflow.sh/docs'),
    },
    {
      label: 'Report Issue',
      click: () => shell.openExternal('https://github.com/maathimself/mailflow/issues'),
    },
    { type: 'separator' },
    {
      label: 'Check For Updates',
      click: () => checkForUpdates(true),
    },
  ];
}

function buildDarwinMenuTemplate() {
  const name = app.name;

  return [
    {
      label: name,
      submenu: [
        { label: `About ${name}`, role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences',
          accelerator: 'Command+,',
          click: changeMailFlowHost,
        },
        { label: 'Services', role: 'services', submenu: [] },
        { type: 'separator' },
        { label: `Hide ${name}`, accelerator: 'Command+H', role: 'hide' },
        { label: 'Hide Others', accelerator: 'Command+Alt+H', role: 'hideOthers' },
        { label: 'Show All', role: 'unhide' },
        { type: 'separator' },
        { label: `Quit ${name}`, accelerator: 'Command+Q', role: 'quit' },
      ],
    },
    {
      label: 'File',
      id: 'file',
      submenu: fileMenuItems(),
    },
    {
      label: 'Edit',
      submenu: editMenuItems(),
    },
    {
      label: 'View',
      submenu: viewMenuItems(),
    },
    {
      label: 'Window',
      role: 'window',
      submenu: windowMenuItems(),
    },
    {
      label: 'Help',
      role: 'help',
      submenu: helpMenuItems(),
    },
  ];
}

function buildDefaultMenuTemplate() {
  return [
    {
      label: 'File',
      id: 'file',
      submenu: [
        ...fileMenuItems(),
        { type: 'separator' },
        { label: 'Exit', role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: editMenuItems(),
    },
    {
      label: 'View',
      submenu: viewMenuItems(),
    },
    {
      label: 'Window',
      role: 'window',
      submenu: windowMenuItems(),
    },
    {
      label: 'Help',
      role: 'help',
      submenu: helpMenuItems(),
    },
  ];
}

function setupMenu() {
  const template = process.platform === 'darwin'
    ? buildDarwinMenuTemplate()
    : buildDefaultMenuTemplate();

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function getDefaultWindowBounds() {
  return {
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 620,
  };
}

function getSavedWindowBounds() {
  const bounds = readConfig().windowBounds;
  if (!bounds || typeof bounds !== 'object') return {};

  const numericBounds = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    if (Number.isFinite(bounds[key])) numericBounds[key] = bounds[key];
  }

  return numericBounds;
}

function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  writeConfig({
    ...readConfig(),
    windowBounds: mainWindow.getBounds(),
  });
}

function showMainWindow({ reload = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  const wasHidden = !mainWindow.isVisible();

  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();

  if (reload && wasHidden) {
    mainWindow.webContents.reload();
  }
}

function getTrayIcon() {
  const trayIconPath = process.platform === 'win32'
    ? path.join(__dirname, 'icons', 'icon.ico')
    : process.platform === 'darwin'
      ? path.join(__dirname, 'icons', 'icon.icns')
      : path.join(__dirname, 'icons', '96x96.png');

  return nativeImage.createFromPath(trayIconPath);
}

function refreshTrayMenu() {
  if (!tray) return;

  const isWindowVisible = !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  tray.setContextMenu(Menu.buildFromTemplate([
    ...nativeActionMenuItems(),
    { type: 'separator' },
    {
      label: isWindowVisible ? 'Hide MailFlow' : 'Show MailFlow',
      click: () => {
        if (isWindowVisible) {
          saveWindowBounds();
          mainWindow.hide();
        } else {
          showMainWindow({ reload: true });
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Change MailFlow Host',
      click: () => {
        clearHost();
        showMainWindow();
        loadSetup();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ]));
}

function createTray() {
  if (tray) return;

  const trayIcon = getTrayIcon();
  if (trayIcon.isEmpty()) return;

  tray = new Tray(trayIcon);
  tray.setToolTip('MailFlow');
  tray.on('click', () => {
    refreshTrayMenu();
    showMainWindow({ reload: true });
  });
  refreshTrayMenu();
}

function setupDockMenu() {
  if (process.platform !== 'darwin' || !app.dock) return;
  app.dock.setMenu(Menu.buildFromTemplate(nativeActionMenuItems()));
}

function setupTaskbarTasks() {
  if (process.platform !== 'win32') return;

  app.setUserTasks([
    {
      program: process.execPath,
      arguments: `${NATIVE_ACTION_ARG}new-mail`,
      iconPath: getWindowIconPath(),
      iconIndex: 0,
      title: 'New Mail',
      description: 'Compose a new MailFlow message',
    },
    {
      program: process.execPath,
      arguments: `${NATIVE_ACTION_ARG}sync`,
      iconPath: getWindowIconPath(),
      iconIndex: 0,
      title: 'Sync',
      description: 'Sync MailFlow mail',
    },
  ]);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...getDefaultWindowBounds(),
    ...getSavedWindowBounds(),
    show: false,
    title: 'MailFlow',
    icon: getWindowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && tray) {
      event.preventDefault();
      saveWindowBounds();
      mainWindow.hide();
      refreshTrayMenu();
      return;
    }

    saveWindowBounds();
  });

  mainWindow.on('show', refreshTrayMenu);
  mainWindow.on('hide', refreshTrayMenu);
  mainWindow.on('closed', () => {
    mainWindow = null;
    refreshTrayMenu();
  });

  initializeUpdateDownloads(mainWindow);

  const host = readHost();
  if (host) {
    mainWindow.loadURL(host);
  } else {
    loadSetup();
  }
}

function loadSetup() {
  if (!mainWindow) return;
  mainWindow.loadFile(path.join(__dirname, '..', 'native-shell', 'index.html'));
}

function scheduleStartupUpdateCheck() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!readHost()) return;

  const check = () => {
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      checkForUpdates(false);
    }, 5000);
  };

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', check);
    return;
  }

  check();
}

ipcMain.handle('mailflow:getHost', () => readHost());

ipcMain.handle('mailflow:saveHost', async (_event, host) => {
  const normalized = writeHost(host);
  return normalized;
});

ipcMain.handle('mailflow:resetHost', () => {
  clearHost();
  loadSetup();
});

ipcMain.handle('mailflow:badge:set-unread-count', (_event, count) => {
  const unreadCount = Math.max(0, Number.parseInt(count, 10) || 0);
  return setUnreadBadgeCount(unreadCount);
});

ipcMain.handle('mailflow:notification:new-mail', (_event, notification) => {
  return showNewMailNotification(notification);
});

ipcMain.handle('mailflow:updates:check', async (_event, { verbose } = {}) => {
  return checkForUpdates(verbose);
});

ipcMain.handle('mailflow:updates:install-downloaded', () => {
  return installDownloadedUpdate();
});

ipcMain.handle('mailflow:updates:install-auto', () => {
  return installDownloadedUpdate();
});

ipcMain.handle('mailflow:updates:open-download', () => {
  openDownloadedUpdatePath();
});

ipcMain.handle('mailflow:native-actions:pending', () => {
  return Array.from(pendingNativeActions.values());
});

ipcMain.handle('mailflow:native-actions:ack', (_event, id) => {
  pendingNativeActions.delete(id);
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    registerMailtoProtocol();
    setupMenu();
    setupDockMenu();
    setupTaskbarTasks();
    createTray();
    createWindow();
    scheduleStartupUpdateCheck();
    sendNativeAction(parseNativeActionArg(process.argv));
    sendMailtoAction(parseProtocolUrlArg(process.argv));
    flushPendingProtocolUrls();

    app.on('activate', () => {
      showMainWindow();
    });
  });

  app.on('second-instance', (_event, args) => {
    const mailtoUrl = parseProtocolUrlArg(args);
    if (mailtoUrl) {
      sendMailtoAction(mailtoUrl);
      return;
    }

    showMainWindow();
    sendNativeAction(parseNativeActionArg(args));
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('open-url', (event, url) => {
  event.preventDefault();

  if (mainWindow) {
    sendMailtoAction(url);
    return;
  }

  pendingProtocolUrls.push(url);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
