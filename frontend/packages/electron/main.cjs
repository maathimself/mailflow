const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, dialog } = require('electron');
const fs = require('fs');
const https = require('https');
const path = require('path');

const CONFIG_FILE = 'mailflow-host.json';
const UPDATE_STATUS_CHANNEL = 'mailflow:updates:status';
const UPDATE_RELEASE_URL = 'https://api.github.com/repos/maathimself/mailflow/releases/latest';
const UPDATE_ERROR_MESSAGE = 'Could not check for MailFlow updates. Please visit the website instead.';

let mainWindow;
let tray = null;
let isQuitting = false;
let updateInfo = null;
let downloadedUpdate = null;
let updateDownloadsInitialized = false;

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

function getUpdateAsset(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const platformAssetPatterns = {
    win32: [/setup.*\.exe$/i, /\.exe$/i],
    darwin: [/\.dmg$/i],
    linux: [/\.appimage$/i, /\.deb$/i, /\.rpm$/i],
  };
  const patterns = platformAssetPatterns[process.platform] || [];

  for (const pattern of patterns) {
    const asset = assets.find((item) => pattern.test(item.name || '') && item.browser_download_url);
    if (asset) return asset;
  }

  return null;
}

function sendUpdateStatus(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(UPDATE_STATUS_CHANNEL, payload);
}

function notifyUpdateStatus({ title, message, type = 'info' }) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('mailflow:notifications:push', { title, message, type });
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

function notifyUpdateAvailable() {
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
  notifyUpdateStatus({
    title: 'Update Available',
    message: 'MailFlow is downloading the newest version for you.',
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

function initializeUpdateDownloads(window) {
  if (updateDownloadsInitialized) return;
  updateDownloadsInitialized = true;

  window.webContents.session.on('will-download', (_event, item) => {
    const totalBytes = item.getTotalBytes();
    const filePath = path.join(app.getPath('downloads'), getUniqueFilename(item.getFilename()));

    item.setSavePath(filePath);

    item.on('updated', () => {
      if (totalBytes > 0) {
        window.setProgressBar(item.getReceivedBytes() / totalBytes);
      }
    });

    item.on('done', (_event, state) => {
      if (!window.isDestroyed()) window.setProgressBar(-1);

      if (state === 'interrupted') {
        dialog.showErrorBox('Download error', `The download of ${item.getFilename()} was interrupted.`);
      }

      if (state === 'completed') {
        downloadedUpdate = item.getSavePath();
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
    const asset = getUpdateAsset(release);

    if (!isNewerVersion(releaseVersion, app.getVersion())) {
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

    notifyUpdateAvailable();
    downloadUpdate(asset.browser_download_url);
    return { updateAvailable: true, downloadAvailable: true };
  } catch (error) {
    console.error('Update check failed:', error);
    notifyUpdateError();
    return { updateAvailable: false, error: error.message };
  }
}

function installDownloadedUpdate() {
  if (!downloadedUpdate) return;

  fs.access(downloadedUpdate, fs.constants.F_OK, (error) => {
    if (error) {
      shell.showItemInFolder(downloadedUpdate);
      return;
    }

    shell.openPath(downloadedUpdate);
    app.quit();
  });
}

function openDownloadedUpdatePath() {
  if (!downloadedUpdate) return;
  shell.showItemInFolder(downloadedUpdate);
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

function createWindow() {
  mainWindow = new BrowserWindow({
    ...getDefaultWindowBounds(),
    ...getSavedWindowBounds(),
    show: false,
    title: 'MailFlow',
    icon: getWindowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
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

ipcMain.handle('mailflow:getHost', () => readHost());

ipcMain.handle('mailflow:saveHost', async (_event, host) => {
  const normalized = writeHost(host);
  return normalized;
});

ipcMain.handle('mailflow:resetHost', () => {
  clearHost();
  loadSetup();
});

ipcMain.handle('mailflow:updates:check', async (_event, { verbose } = {}) => {
  return checkForUpdates(verbose);
});

ipcMain.handle('mailflow:updates:install-downloaded', () => {
  installDownloadedUpdate();
});

ipcMain.handle('mailflow:updates:install-auto', () => {
  installDownloadedUpdate();
});

ipcMain.handle('mailflow:updates:open-download', () => {
  openDownloadedUpdatePath();
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    setupMenu();
    createTray();
    createWindow();

    app.on('activate', () => {
      showMainWindow();
    });
  });

  app.on('second-instance', () => {
    showMainWindow();
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
