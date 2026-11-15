// Scream to Unlock — Electron main process.
// Creates the full-screen "lock screen", serves the app over a tiny local
// HTTP server (vosk-browser needs real http:// URLs for its worker), and
// wires up the global hotkeys.

const {
  app, BrowserWindow, globalShortcut, ipcMain, powerMonitor,
  session, systemPreferences, Menu,
} = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

// `npm run dev` → windowed, no kiosk, re-locks itself after each unlock.
const DEV = process.argv.includes('--dev');

const APP_DIR = path.join(__dirname, 'app');
const VOSK_JS = path.join(__dirname, 'node_modules', 'vosk-browser', 'dist', 'vosk.js');
const PREFERRED_PORT = 47123; // fixed port = stable origin = Vosk model stays cached

// ---- Hotkeys (Cmd+Shift+Option+…) -----------------------------------------
const KEYS = {
  quit: 'CommandOrControl+Shift+Alt+Q',        // ESCAPE HATCH: quit instantly
  lock: 'CommandOrControl+Shift+Alt+L',        // lock right now (for demos)
  forceUnlock: 'CommandOrControl+Shift+Alt+U', // plan B if recognition dies on stage
};

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let locked = false;
let quitting = false;

// ---- Local static server ---------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.gz': 'application/gzip',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function resolveFile(urlPath) {
  if (urlPath === '/vendor/vosk.js') return VOSK_JS;
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(APP_DIR, rel));
  return file.startsWith(APP_DIR + path.sep) ? file : null; // no ../ escapes
}

function startServer() {
  const server = http.createServer((req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch { res.writeHead(400); return res.end(); }
    const file = resolveFile(urlPath);
    if (!file) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code !== 'EADDRINUSE') return reject(err);
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    server.listen(PREFERRED_PORT, '127.0.0.1', () => resolve(server.address().port));
  });
}

// ---- Lock / unlock ---------------------------------------------------------
function lock() {
  if (!win) return;
  locked = true;
  if (!DEV) {
    win.show();
    win.setKiosk(true); // hides Dock + menu bar, blocks Cmd+Tab and Force Quit
    win.setAlwaysOnTop(true, 'screen-saver');
  } else {
    win.show();
  }
  win.focus();
  win.webContents.send('lock');
}

function unlock() {
  locked = false;
  if (DEV) {
    setTimeout(lock, 2500); // keep iterating on the design
    return;
  }
  win.setAlwaysOnTop(false);
  if (win.isKiosk()) {
    // Wait for macOS to finish leaving full screen before hiding, or it glitches.
    let hidden = false;
    const hide = () => { if (!hidden && !locked) { hidden = true; win.hide(); } };
    win.once('leave-full-screen', hide);
    setTimeout(hide, 1500);
    win.setKiosk(false);
  } else {
    win.hide();
  }
}

// ---- Window ----------------------------------------------------------------
function createWindow(port) {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    frame: DEV,
    backgroundColor: '#ffffff',
    title: 'Scream to Unlock',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.loadURL(`http://127.0.0.1:${port}/${DEV ? '?dev=1' : ''}`);

  // Print the page's console.log output in the terminal (handy for debugging).
  win.webContents.on('console-message', (e) => {
    const msg = e.message ?? e;
    if (typeof msg === 'string' && !msg.includes('Electron Security Warning')) console.log('[page]', msg);
  });

  // Start locked: cover the screen as soon as there's something to show.
  win.once('ready-to-show', lock);

  // While locked, closing the window is not an option.
  win.on('close', (e) => {
    if (!quitting && (locked || !DEV)) e.preventDefault();
  });
}

// ---- App lifecycle ---------------------------------------------------------
app.whenReady().then(async () => {
  // Without a menu, Cmd+Q / Cmd+W / Cmd+H do nothing. Dev keeps it for DevTools.
  if (!DEV) Menu.setApplicationMenu(null);

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); }
    catch (err) { console.error('Mic permission request failed:', err); }
  }

  const port = await startServer();
  createWindow(port);

  globalShortcut.register(KEYS.quit, () => { quitting = true; app.quit(); });
  globalShortcut.register(KEYS.lock, lock);
  globalShortcut.register(KEYS.forceUnlock, () => win && win.webContents.send('force-unlock'));

  // Waking the Mac or unlocking the real macOS lock screen → our lock screen.
  powerMonitor.on('resume', lock);
  powerMonitor.on('unlock-screen', lock);

  ipcMain.on('renderer-ready', () => { if (locked) win.webContents.send('lock'); });
  ipcMain.on('unlocked', unlock);

  console.log(`\nScream to Unlock running${DEV ? ' (dev mode)' : ''} on http://127.0.0.1:${port}`);
  console.log('  Cmd+Shift+Option+Q  quit (escape hatch)');
  console.log('  Cmd+Shift+Option+L  lock now');
  console.log('  Cmd+Shift+Option+U  force unlock (demo plan B)\n');
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* stay alive in the background */ });
