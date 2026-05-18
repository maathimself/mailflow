const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = 'mailflow-host.json';

let mainWindow;

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
            loadSetup();
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    title: 'MailFlow',
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
  await mainWindow.loadURL(normalized);
  return normalized;
});

ipcMain.handle('mailflow:resetHost', () => {
  clearHost();
  loadSetup();
});

app.whenReady().then(() => {
  setupMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
