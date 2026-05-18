const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = 'mailflow-host.json';

let mainWindow;
let tray;
let isQuitting = false;

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

function readHost() {
  try {
    const config = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
    return normalizeHost(config.host);
  } catch {
    return null;
  }
}

function writeHost(host) {
  const normalized = normalizeHost(host);
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify({ host: normalized }, null, 2));
  return normalized;
}

function clearHost() {
  try {
    fs.rmSync(getConfigPath(), { force: true });
  } catch {}
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quitApp() {
  isQuitting = true;
  app.quit();
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

function setupMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'MailFlow',
      submenu: [
        {
          label: 'Change MailFlow Host',
          click: () => {
            clearHost();
            showMainWindow();
            loadSetup();
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Quit MailFlow', click: quitApp },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupTray() {
  if (tray) return;

  tray = new Tray(getIconPath());
  tray.setToolTip('MailFlow');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show MailFlow', click: showMainWindow },
    {
      label: 'Change MailFlow Host',
      click: () => {
        clearHost();
        showMainWindow();
        loadSetup();
      },
    },
    { type: 'separator' },
    { label: 'Quit MailFlow', click: quitApp },
  ]));

  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

function isConfiguredHostUrl(url) {
  const host = readHost();
  if (!host) return false;

  try {
    return new URL(url).origin === new URL(host).origin;
  } catch {
    return false;
  }
}

function setupPermissions() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    if (permission === 'notifications' && isConfiguredHostUrl(details.requestingUrl || webContents.getURL())) {
      callback(true);
      return;
    }

    callback(false);
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return permission === 'notifications' && isConfiguredHostUrl(requestingOrigin || webContents.getURL());
  });
}

function showNativeNotification(payload = {}) {
  if (!Notification.isSupported()) return false;

  const title = String(payload.title || 'MailFlow').slice(0, 120);
  const body = String(payload.body || 'New message').slice(0, 500);
  const notification = new Notification({
    title,
    body,
    icon: getIconPath(),
    silent: false,
  });

  notification.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  notification.show();
  return true;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    title: 'MailFlow',
    icon: getWindowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;

    event.preventDefault();
    mainWindow.hide();
  });

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

ipcMain.handle('mailflow:notify', (_event, payload) => showNativeNotification(payload));

app.whenReady().then(() => {
  setupPermissions();
  setupMenu();
  setupTray();
  createWindow();

  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (isQuitting) app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
});
