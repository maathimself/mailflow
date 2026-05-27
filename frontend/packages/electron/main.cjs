const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const CONFIG_FILE = 'mailflow-host.json';
const UPDATE_STATUS_CHANNEL = 'mailflow:updates:status';
const UPDATE_RELEASE_URL = 'https://api.github.com/repos/dcoffin88/mailflow/releases/latest';
const UPDATE_ERROR_MESSAGE = 'Could not check for MailFlow updates. Please visit the website instead.';
const NATIVE_ACTION_CHANNEL = 'mailflow:native-action';
const NATIVE_ACTION_ARG = '--mailflow-action=';

let mainWindow;
let tray = null;
let isQuitting = false;
let updateInfo = null;
let downloadedUpdate = null;
let updateDownloadsInitialized = false;
let nextNativeActionId = 1;
const pendingNativeActions = new Map();

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

function showInAppNotification({ title = '', message = '', type = 'info', actionLabel = '', action = '' }) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const payload = JSON.stringify({ title, message, type, actionLabel, action });
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

      window.setTimeout(dismiss, 5000);
    })();
  `).catch(() => {});
}

function notifyUpdateStatus({ title, message, type = 'info' }) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  showInAppNotification({ title, message, type });
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

function parseNativeActionArg(args = []) {
  const actionArg = args.find((arg) => String(arg).startsWith(NATIVE_ACTION_ARG));
  if (!actionArg) return null;

  const action = actionArg.slice(NATIVE_ACTION_ARG.length);
  if (['new-mail', 'sync'].includes(action)) return action;
  return null;
}

function createNativeActionPayload(action) {
  const payload = {
    id: nextNativeActionId,
    action,
    createdAt: Date.now(),
  };
  nextNativeActionId += 1;
  pendingNativeActions.set(payload.id, payload);
  return payload;
}

function sendNativeAction(action) {
  if (!action) return;

  const payload = createNativeActionPayload(action);
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
    setupMenu();
    setupDockMenu();
    setupTaskbarTasks();
    createTray();
    createWindow();
    sendNativeAction(parseNativeActionArg(process.argv));

    app.on('activate', () => {
      showMainWindow();
    });
  });

  app.on('second-instance', (_event, args) => {
    showMainWindow();
    sendNativeAction(parseNativeActionArg(args));
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
