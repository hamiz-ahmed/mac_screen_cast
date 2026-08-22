const { execFile } = require('child_process');
const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  desktopCapturer,
  screen,
  systemPreferences,
  shell,
  dialog,
} = require('electron');
const path = require('path');
const os = require('os');
const { startServer } = require('./server');

let win = null;
let serverPort = null;
let serverCtl = null;
let wantAudio = true;
let selectedDisplayId = null;

function bestLocalIp() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

function watchUrl() {
  return `http://${bestLocalIp()}:${serverPort}/`;
}

function createWindow() {
  win = new BrowserWindow({
    width: 660,
    height: 780,
    minWidth: 420,
    minHeight: 540,
    title: 'Mac Screencast',
    backgroundColor: '#16181d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Size the window to the page so it opens without a scrollbar, however
  // tall the content renders on this machine.
  win.webContents.once('did-finish-load', async () => {
    try {
      const contentHeight = await win.webContents.executeJavaScript(
        'document.documentElement.scrollHeight'
      );
      const maxHeight = screen.getDisplayMatching(win.getBounds()).workArea.height - 24;
      const [contentWidth] = win.getContentSize();
      win.setContentSize(contentWidth, Math.min(contentHeight, maxHeight));
    } catch {
      // Keep the default size; scrolling still works.
    }
  });
}

app.whenReady().then(async () => {
  // Auto-grant screen capture for the display chosen in the UI instead of
  // showing Chromium's source-picker dialog.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        const source =
          sources.find((s) => s.display_id === String(selectedDisplayId)) ||
          sources[0];
        if (!source) return callback(null);
        // 'loopback' captures the Mac's system audio (macOS 13+); if this
        // combo rejects it the renderer retries video-only.
        if (wantAudio) callback({ video: source, audio: 'loopback' });
        else callback({ video: source });
      } catch (err) {
        console.error('capture handler failed:', err);
        callback(null);
      }
    }
  );

  serverCtl = await startServer({
    preferredPort: 8080,
    viewerDir: path.join(__dirname, '..', 'viewer'),
  });
  serverPort = serverCtl.port;

  createWindow();
});

app.on('window-all-closed', () => {
  setSystemMute(false);
  app.quit();
});

ipcMain.handle('get-state', () => ({
  port: serverPort,
  watchUrl: watchUrl(),
  playerUrl: `${watchUrl()}player`,
  displays: screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || `Display ${i + 1}`,
    width: d.size.width,
    height: d.size.height,
  })),
  screenAccess: systemPreferences.getMediaAccessStatus('screen'),
}));

ipcMain.handle('set-display', (_e, id) => {
  selectedDisplayId = id;
});

ipcMain.handle('set-want-audio', (_e, v) => {
  wantAudio = Boolean(v);
});

// Silence the Mac's speakers while viewers carry the sound; always restored
// on Stop and on quit. Never touches the volume if we didn't mute it.
let mutedByUs = false;
function setSystemMute(v) {
  if (v === mutedByUs) return;
  mutedByUs = v;
  execFile('/usr/bin/osascript', ['-e', `set volume output muted ${v}`], () => {});
}
ipcMain.handle('set-system-mute', (_e, v) => setSystemMute(Boolean(v)));

ipcMain.handle('pick-video', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a video to serve on the player page',
    properties: ['openFile'],
    filters: [
      { name: 'Videos', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  const filePath = result.filePaths[0];
  serverCtl.setMedia(filePath);
  const name = path.basename(filePath);
  const compatible = /\.(mp4|m4v|mov|webm)$/i.test(name);
  return { ok: true, name, compatible, playerUrl: `${watchUrl()}player` };
});

ipcMain.handle('open-screen-settings', () => {
  shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
  );
});
