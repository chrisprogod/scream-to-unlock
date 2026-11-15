// ScreamLock — Electron main process.
// Creates the full-screen "lock screen", serves the app over a tiny local
// HTTP server (vosk-browser needs real http:// URLs for its worker), and
// wires up the global hotkeys.

const {
  app, BrowserWindow, globalShortcut, ipcMain, powerMonitor,
  session, systemPreferences, Menu, screen,
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
let allowQuit = false; // only the escape hatch may quit while locked

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

// ---- Keeping the lock in front ------------------------------------------------
// The real blocker is the window itself: simple fullscreen + screen-saver level
// + visible on all Spaces keeps it covering the screen even if another app
// (e.g. a browser) becomes the front app. Newer macOS versions don't let apps
// steal keyboard focus, so focus requests here may be ignored; the watchdog
// still keeps the window shown and on top.
let watchdog = null;

function grabFront() {
  if (DEV || !locked || !win) return;
  if (!win.isVisible()) win.show();
  if (!win.isFocused()) {
    app.focus({ steal: true });
    win.focus();
    win.moveTop();
  }
}

function startWatchdog() {
  clearInterval(watchdog);
  watchdog = setInterval(grabFront, 250);
}

function stopWatchdog() {
  clearInterval(watchdog);
  watchdog = null;
}

// Extra monitors get a plain blocker window, so they can't be used either.
let blockers = [];

function showBlockers() {
  hideBlockers();
  const mainDisplay = screen.getDisplayMatching(win.getBounds());
  for (const display of screen.getAllDisplays()) {
    if (display.id === mainDisplay.id) continue;
    const blocker = new BrowserWindow({
      ...display.bounds,
      frame: false, show: false, focusable: false, hasShadow: false,
      skipTaskbar: true, enableLargerThanScreen: true, backgroundColor: '#ffffff',
    });
    blocker.setAlwaysOnTop(true, 'screen-saver');
    blocker.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    blocker.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<body style="margin:0;height:100vh;display:grid;place-items:center;font:700 48px Comic Sans MS,cursive">' +
      'nice try. go scream at the other screen.</body>'));
    blocker.once('ready-to-show', () => blocker.showInactive());
    blockers.push(blocker);
  }
}

function hideBlockers() {
  for (const blocker of blockers) if (!blocker.isDestroyed()) blocker.destroy();
  blockers = [];
}

// ---- Lock / unlock ---------------------------------------------------------
function lock() {
  if (!win) return;
  locked = true;
  if (!DEV) {
    // Show on every desktop/Space, so switching desktops doesn't escape it.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.show();
    win.setKiosk(true); // hides Dock + menu bar, blocks Cmd+Tab and Force Quit
    win.setAlwaysOnTop(true, 'screen-saver');
    showBlockers();
    startWatchdog();
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
  stopWatchdog();
  hideBlockers();
  win.setAlwaysOnTop(false);
  win.setVisibleOnAllWorkspaces(false);
  if (win.isKiosk()) {
    // Wait for macOS to finish leaving full screen before hiding, or it glitches.
    let hidden = false;
    const hide = () => { if (!hidden && !locked) { hidden = true; win.hide(); } };
    const simple = win.isSimpleFullScreen();
    win.once('leave-full-screen', hide);
    setTimeout(hide, simple ? 200 : 1500);
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
    // Real mode: cover the screen on the CURRENT desktop instead of moving to a
    // separate full-screen Space that other apps can switch away from.
    simpleFullscreen: !DEV,
    backgroundColor: '#ffffff',
    title: 'ScreamLock',
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

  // Something else took focus while locked? Take it back immediately.
  win.on('blur', () => setTimeout(grabFront, 30));

  // Start locked: cover the screen as soon as there's something to show.
  win.once('ready-to-show', lock);

  // While locked, closing the window is not an option.
  win.on('close', (e) => {
    if (!quitting && (locked || !DEV)) e.preventDefault();
  });
}

// ---- App lifecycle ---------------------------------------------------------
app.whenReady().then(async () => {
  // Real mode: a menu with NO Quit/Close/Hide items, so Cmd+Q / Cmd+W / Cmd+H
  // aren't bound to anything. (A null menu still let Cmd+Q through on macOS.)
  // Dev keeps the default menu for DevTools.
  if (!DEV) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [{ label: 'Scream to unlock. There is no quit.', enabled: false }] },
    ]));
  }

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); }
    catch (err) { console.error('Mic permission request failed:', err); }
  }

  const port = await startServer();
  createWindow(port);

  globalShortcut.register(KEYS.quit, () => { allowQuit = true; app.quit(); });
  globalShortcut.register(KEYS.lock, lock);
  globalShortcut.register(KEYS.forceUnlock, () => win && win.webContents.send('force-unlock'));

  // Waking the Mac or unlocking the real macOS lock screen → our lock screen.
  powerMonitor.on('resume', lock);
  powerMonitor.on('unlock-screen', lock);

  ipcMain.on('renderer-ready', () => { if (locked) win.webContents.send('lock'); });
  ipcMain.on('unlocked', unlock);

  console.log(`\nScreamLock running${DEV ? ' (dev mode)' : ''} on http://127.0.0.1:${port}`);
  console.log('  Cmd+Shift+Option+Q  quit (escape hatch)');
  console.log('  Cmd+Shift+Option+L  lock now');
  console.log('  Cmd+Shift+Option+U  force unlock (demo plan B)\n');
});

// Every way of quitting (Cmd+Q, Dock → Quit, app.quit()) ends up here.
// While locked in real mode, refuse unless it came from the escape hatch.
app.on('before-quit', (e) => {
  if (!DEV && locked && !allowQuit) {
    e.preventDefault();
    console.log('Quit blocked: you have to scream (or press Cmd+Shift+Option+Q).');
    return;
  }
  quitting = true;
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* stay alive in the background */ });
