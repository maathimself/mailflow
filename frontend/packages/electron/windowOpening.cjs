const { isSameOrigin } = require('./security.cjs');

function isPrintWindow({ url, frameName, referrer }, host, openerUrl) {
  return url === 'about:blank'
    && /^mailflow-print-\d+$/.test(frameName)
    && isSameOrigin(host, openerUrl)
    // Referrer-Policy can omit the referrer for about:blank; the opener URL is
    // supplied by Electron rather than relying on that optional request header.
    && (!referrer?.url || isSameOrigin(host, referrer.url));
}

function configureWindowOpening(webContents, { getHost, isAllowedExternalUrl, openExternal }) {
  const openLink = (url) => {
    if (isAllowedExternalUrl(url)) openExternal(url);
  };

  webContents.setWindowOpenHandler((details) => {
    if (isPrintWindow(details, getHost(), webContents.getURL())) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            // Explicitly clear the inherited main preload: email HTML gets no native bridge.
            preload: undefined,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            webviewTag: false,
          },
        },
      };
    }
    openLink(details.url);
    return { action: 'deny' };
  });

  webContents.on('did-create-window', (child) => {
    // Print content stays in its blank, same-origin document so document.write and the
    // existing image CSP work. Links leave through the browser, never this child window.
    child.webContents.setWindowOpenHandler(({ url }) => {
      openLink(url);
      return { action: 'deny' };
    });
    child.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      openLink(url);
    });
    child.webContents.on('will-redirect', (event) => event.preventDefault());
  });
}

module.exports = { configureWindowOpening, isPrintWindow };
