/**
 * The desktop window.
 *
 * Electron's main process is Node, so it starts the same local server the
 * browser version uses and points a window at it. Nothing in gui/ or src/
 * knows the difference, which is the reason the server was built this way:
 * one engine, one UI, two ways of putting a frame around it.
 *
 * Written as ESM because the rest of the project is; Electron has supported an
 * ESM main process since 28, and mixing module systems inside one package is
 * its own small tax.
 */
import { app, BrowserWindow, shell, dialog, Menu } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { start } from '../gui/server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ICON = join(HERE, '..', 'build', 'icon.png');

let win = null;
let server = null;
let origin = '';

async function createWindow() {
  let url;
  try {
    // open:false — the window IS the browser here, so launching the system one
    // as well would put two copies of the app in front of the user.
    ({ url, server } = await start({ port: 0, open: false }));
  } catch (e) {
    dialog.showErrorBox('Elin PageSpeed Insight', String(e.message || e));
    return app.quit();
  }
  origin = new URL(url).origin;

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#f4f5f7',
    icon: ICON,
    title: 'Elin PageSpeed Insight',
    webPreferences: {
      // The page is served over HTTP from our own loopback port and never gets
      // Node access; everything privileged already sits behind the API token.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Nothing flashes an empty white frame before the UI is ready.
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  // Links to Google's console and to pagespeed.web.dev belong in the user's
  // real browser, where they are already signed in — not in this window, which
  // has no address bar to come back from.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(origin)) {
      e.preventDefault();
      shell.openExternal(target);
    }
  });

  await win.loadURL(url);
}

// One window. A second launch focuses it rather than starting a second server.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'File', submenu: [{ role: 'quit' }] },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
          { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' }, { type: 'separator' },
          { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
          { type: 'separator' }, { role: 'toggleDevTools' },
        ],
      },
    ]));

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (server) server.close();
    // An app with no window has nothing to do, on macOS as much as anywhere.
    app.quit();
  });
}
