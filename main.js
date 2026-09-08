const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// Fixed regardless of packaging/productName so the notes folder never
// moves between the dev build and the installed build.
app.setName('memo-cabinet');

const dataDir = path.join(app.getPath('userData'), 'data');
const dataFile = path.join(dataDir, 'notes.json');
const configFile = path.join(dataDir, 'widget-config.json');
const attachmentsDir = path.join(dataDir, 'attachments');
const backupsDir = path.join(dataDir, 'backups');
const BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BACKUPS = 40;
let lastBackupTime = 0;

const NUB_W = 8; // barely-visible resting sliver, no labels
const STRIP_W = 34; // tab column width once revealed
const PANEL_W = 300; // quick-edit panel width
const FULL_W = STRIP_W + PANEL_W;
const TAB_H = 92;
const TAB_GAP = 4;
const ADD_TAB_H = 34;
const FPS = 60;
const FRAME_MS = Math.round(1000 / FPS);

function ensureData() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(attachmentsDir)) fs.mkdirSync(attachmentsDir, { recursive: true });
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify({ folders: [] }, null, 2), 'utf-8');
  }
}

function loadData() {
  ensureData();
  try {
    return JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
  } catch (e) {
    return { folders: [] };
  }
}

// Write to a temp file then rename over the real one — if the process is
// killed or a disk error happens mid-write, the original file is never
// left half-written/corrupted; the rename is atomic on Windows/NTFS.
function atomicWriteFileSync(filePath, content) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function logError(context, err) {
  try {
    const line = `[${new Date().toISOString()}] ${context}: ${(err && err.stack) || err}\n`;
    fs.appendFileSync(path.join(dataDir, 'error.log'), line, 'utf-8');
  } catch (e) {
    // logging is best-effort only
  }
}

function pruneBackups() {
  const files = fs.readdirSync(backupsDir).filter((f) => f.startsWith('notes-')).sort();
  while (files.length > MAX_BACKUPS) {
    const oldest = files.shift();
    try {
      fs.unlinkSync(path.join(backupsDir, oldest));
    } catch (e) {
      // fine, will be cleaned up next time
    }
  }
}

// Snapshot the previous good save before overwriting it — at most once
// every few minutes, so a silent save failure or a bad write can never
// wipe out everything. Recoverable from data/backups/ if it ever comes to that.
function maybeBackup() {
  const now = Date.now();
  if (now - lastBackupTime < BACKUP_INTERVAL_MS) return;
  if (!fs.existsSync(dataFile)) return;
  try {
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(dataFile, path.join(backupsDir, `notes-${stamp}.json`));
    lastBackupTime = now;
    pruneBackups();
  } catch (err) {
    logError('maybeBackup', err);
  }
}

function saveData(data) {
  ensureData();
  maybeBackup();
  atomicWriteFileSync(dataFile, JSON.stringify(data, null, 2));
}

function loadConfigFromDisk() {
  ensureData();
  try {
    return { y: null, hidden: false, autoLaunch: true, ...JSON.parse(fs.readFileSync(configFile, 'utf-8')) };
  } catch (e) {
    return { y: null, hidden: false, autoLaunch: true };
  }
}

function saveConfig(cfg) {
  cachedConfig = cfg;
  ensureData();
  try {
    atomicWriteFileSync(configFile, JSON.stringify(cfg, null, 2));
  } catch (err) {
    logError('saveConfig', err);
  }
}

// In-memory caches so hot paths (hover animation, drag, display-follow
// polling) never touch the filesystem synchronously — only real writes
// (data:save / saveConfig) do.
let cachedConfig = null;
let cachedFolderCount = 0;

let mainWindow = null;
let calcWindow = null;
let widgetWindow = null;
let tray = null;
let animTimer = null;
let dragCurrentY = null;
let widgetExpanded = false;
let widgetPinned = false;
let watchdogTimer = null;
let displayWatchTimer = null;
let currentDisplayId = null;

function getActiveDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function getTargetDisplay() {
  if (currentDisplayId != null) {
    const found = screen.getAllDisplays().find((d) => d.id === currentDisplayId);
    if (found) return found;
  }
  return screen.getPrimaryDisplay();
}

function computeHeight(wa) {
  const contentH = cachedFolderCount * (TAB_H + TAB_GAP) + TAB_GAP + ADD_TAB_H + TAB_GAP;
  return Math.min(Math.max(contentH, TAB_H + ADD_TAB_H + 20), wa.height - 24);
}

function getWidgetBounds(expanded) {
  const wa = getTargetDisplay().workArea;
  const height = computeHeight(wa);
  let y;
  if (typeof dragCurrentY === 'number') {
    y = dragCurrentY;
  } else if (typeof cachedConfig.y === 'number') {
    y = cachedConfig.y;
  } else {
    y = wa.y + Math.round((wa.height - height) / 2);
  }
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));
  const width = expanded ? FULL_W : NUB_W;
  const x = wa.x + wa.width - width;
  return { x, y, width, height };
}

// Single time-based animation loop (progress from elapsed wall-clock time,
// not a step counter) so motion stays smooth and correct even if the timer
// itself drifts a little — ticking at a clean 60fps cadence.
function runAnimation(from, to, duration) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  clearInterval(animTimer);
  const start = Date.now();
  animTimer = setInterval(() => {
    if (!widgetWindow || widgetWindow.isDestroyed()) {
      clearInterval(animTimer);
      return;
    }
    const t = Math.min((Date.now() - start) / duration, 1);
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // ease-in-out cubic
    widgetWindow.setBounds({
      x: Math.round(from.x + (to.x - from.x) * ease),
      y: Math.round(from.y + (to.y - from.y) * ease),
      width: Math.round(from.width + (to.width - from.width) * ease),
      height: Math.round(from.height + (to.height - from.height) * ease),
    });
    if (t >= 1) {
      clearInterval(animTimer);
      animTimer = null;
    }
  }, FRAME_MS);
}

function animateWidget(expanded) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const from = widgetWindow.getBounds();
  const target = getWidgetBounds(expanded);
  // Hover reveal only ever changes x/width — y/height stay put.
  runAnimation(from, { x: target.x, y: from.y, width: target.width, height: from.height }, 220);
}

function moveToActiveDisplay() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const from = widgetWindow.getBounds();
  const target = getWidgetBounds(widgetExpanded);
  runAnimation(from, target, 260);
}

function refreshWidgetSize() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const cur = widgetWindow.getBounds();
  const wasExpanded = cur.width > NUB_W + 5;
  widgetWindow.setBounds(getWidgetBounds(wasExpanded));
}

// A single lightweight poll (not one window per monitor) that relocates
// the one widget window to whichever display currently has the cursor.
// Skipped while expanded/pinned so it never yanks the panel away mid-use.
function startDisplayWatch() {
  if (displayWatchTimer) return;
  displayWatchTimer = setInterval(() => {
    if (widgetExpanded || widgetPinned) return;
    const disp = getActiveDisplay();
    if (disp.id !== currentDisplayId) {
      currentDisplayId = disp.id;
      moveToActiveDisplay();
    }
  }, 1200);
}

// Transparent click-through windows can occasionally miss a DOM
// mouseleave event on Windows, leaving the panel stuck open. This
// watchdog is a reliable fallback: while expanded, it polls the real
// cursor position and force-collapses if the mouse has actually left.
function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (!widgetWindow || widgetWindow.isDestroyed() || widgetPinned) return;
    const pt = screen.getCursorScreenPoint();
    // Check against the fully-expanded TARGET bounds, not the window's
    // current (possibly still-animating) bounds. Using the live bounds
    // made this fire mid-expand-animation whenever the mouse had already
    // moved toward where the panel was about to appear — reading "outside"
    // against the still-narrow window and force-collapsing, which made the
    // tab's mouseenter fire again immediately: a rapid expand/collapse
    // flicker loop.
    const b = getWidgetBounds(true);
    const margin = 6;
    const inside =
      pt.x >= b.x - margin && pt.x <= b.x + b.width + margin &&
      pt.y >= b.y - margin && pt.y <= b.y + b.height + margin;
    if (!inside) forceCollapse();
  }, 250);
}

function stopWatchdog() {
  clearInterval(watchdogTimer);
  watchdogTimer = null;
}

function forceCollapse() {
  widgetExpanded = false;
  animateWidget(false);
  if (widgetWindow) {
    widgetWindow.setIgnoreMouseEvents(true, { forward: true });
    widgetWindow.webContents.send('force-collapse');
  }
  stopWatchdog();
}

function configureAutoLaunch(enable) {
  app.setLoginItemSettings({
    openAtLogin: enable,
    path: process.execPath,
    args: app.isPackaged ? [] : [path.resolve(__dirname)],
  });
}

function createWidgetWindow() {
  const bounds = getWidgetBounds(false);
  widgetWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    thickFrame: false,
    minWidth: 1,
    minHeight: 1,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  widgetWindow.setAlwaysOnTop(true, 'screen-saver');
  widgetWindow.setIgnoreMouseEvents(true, { forward: true });
  widgetWindow.loadFile(path.join(__dirname, 'renderer', 'widget.html'));
  widgetWindow.on('closed', () => {
    widgetWindow = null;
  });
}

function ensureMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#e9e0cd',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
}

function openMain(folderId) {
  const win = ensureMainWindow();
  const send = () => {
    if (folderId) win.webContents.send('goto-folder', folderId);
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send);
  } else {
    send();
  }
  win.show();
  win.focus();
}

function openMainForNewFolder() {
  const win = ensureMainWindow();
  const send = () => win.webContents.send('create-folder');
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send);
  } else {
    send();
  }
  win.show();
  win.focus();
}

function openCalculator(value) {
  const send = () => {
    if (typeof value === 'number' && calcWindow) calcWindow.webContents.send('load-value', value);
  };
  if (calcWindow && !calcWindow.isDestroyed()) {
    calcWindow.show();
    calcWindow.focus();
    send();
    return;
  }
  calcWindow = new BrowserWindow({
    width: 300,
    height: 470,
    resizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#fffaf0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  calcWindow.loadFile(path.join(__dirname, 'renderer', 'calc.html'));
  calcWindow.webContents.once('did-finish-load', send);
  calcWindow.on('closed', () => {
    calcWindow = null;
  });
}

function broadcastDataChanged(excludeWebContentsId) {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (w.webContents.id !== excludeWebContentsId) {
      w.webContents.send('data:changed');
    }
  });
}

function setWidgetVisible(visible) {
  if (!widgetWindow) return;
  if (visible) widgetWindow.show();
  else widgetWindow.hide();
  saveConfig({ ...cachedConfig, hidden: !visible });
  updateTrayMenu();
}

function resetWidgetPosition() {
  dragCurrentY = null;
  saveConfig({ ...cachedConfig, y: null });
  refreshWidgetSize();
}

function toggleAutoLaunch() {
  const next = !cachedConfig.autoLaunch;
  saveConfig({ ...cachedConfig, autoLaunch: next });
  configureAutoLaunch(next);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const isVisible = !!widgetWindow && widgetWindow.isVisible();
  const menu = Menu.buildFromTemplate([
    { label: '메모함 열기', click: () => openMain() },
    { label: '계산기', click: () => openCalculator() },
    { type: 'separator' },
    {
      label: isVisible ? '위젯 숨기기' : '위젯 보이기',
      click: () => setWidgetVisible(!isVisible),
    },
    { label: '위젯 위치 초기화', click: () => resetWidgetPosition() },
    { type: 'separator' },
    { label: '백업 폴더 열기', click: () => shell.openPath(backupsDir) },
    { type: 'separator' },
    {
      label: 'Windows 시작 시 자동 실행',
      type: 'checkbox',
      checked: cachedConfig.autoLaunch !== false,
      click: () => toggleAutoLaunch(),
    },
    { label: '업데이트 확인', click: () => checkForUpdates(true) },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('메모함');
  updateTrayMenu();
  tray.on('click', () => openMain());
}

// Checks GitHub Releases for a newer build and, if found, downloads it in
// the background and offers to restart. `manual` distinguishes a user-
// initiated check (always show a result) from the silent automatic one.
let updaterReady = false;
function setupAutoUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  updaterReady = true;

  autoUpdater.on('update-downloaded', (info) => {
    const choice = dialog.showMessageBoxSync({
      type: 'info',
      title: '업데이트 준비 완료',
      message: `새 버전(${info.version})이 준비됐습니다. 지금 재시작해서 적용할까요?`,
      buttons: ['지금 재시작', '나중에 (종료 시 자동 적용)'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (choice === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => {
    logError('autoUpdater', err);
  });
}

function checkForUpdates(manual) {
  if (!updaterReady) {
    if (manual) dialog.showMessageBox({ message: '개발 모드에서는 업데이트를 확인할 수 없습니다.' });
    return;
  }
  if (manual) {
    // Whichever of these three fires, remove all three — .once() only
    // self-removes its own listener, so the other two would otherwise sit
    // there forever (a small leak, since a manual check can be repeated).
    const cleanup = () => {
      autoUpdater.off('update-available', onAvailable);
      autoUpdater.off('update-not-available', onNotAvailable);
      autoUpdater.off('error', onError);
    };
    const onAvailable = (info) => {
      cleanup();
      dialog.showMessageBox({ message: `새 버전(${info.version})을 찾았습니다. 다운로드를 시작합니다.` });
    };
    const onNotAvailable = () => {
      cleanup();
      dialog.showMessageBox({ message: '이미 최신 버전입니다.' });
    };
    const onError = (err) => {
      cleanup();
      dialog.showMessageBox({ message: `업데이트 확인에 실패했습니다: ${err.message}` });
    };
    autoUpdater.on('update-available', onAvailable);
    autoUpdater.on('update-not-available', onNotAvailable);
    autoUpdater.on('error', onError);
  }
  autoUpdater.checkForUpdates().catch((err) => logError('checkForUpdates', err));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    openMain();
  });

  app.whenReady().then(() => {
    ensureData();
    cachedConfig = loadConfigFromDisk();
    cachedFolderCount = loadData().folders.length;
    currentDisplayId = getActiveDisplay().id;
    configureAutoLaunch(cachedConfig.autoLaunch !== false);
    createWidgetWindow();
    if (cachedConfig.hidden) widgetWindow.hide();
    createTray();
    startDisplayWatch();

    setupAutoUpdater();
    setTimeout(() => checkForUpdates(false), 10 * 1000); // let startup settle first
    setInterval(() => checkForUpdates(false), 4 * 60 * 60 * 1000); // the widget stays open for hours/days
  });
}

app.on('window-all-closed', () => {
  // The widget/tray keep the app alive; quitting happens via the tray menu.
});

ipcMain.handle('data:get', () => loadData());
ipcMain.handle('data:save', (event, data) => {
  let ok = true;
  let error = null;
  try {
    saveData(data);
  } catch (err) {
    logError('saveData (1st attempt)', err);
    try {
      // A brief file lock from antivirus/backup software is the most likely
      // transient cause — one immediate retry clears most of those.
      saveData(data);
    } catch (err2) {
      logError('saveData (retry)', err2);
      ok = false;
      error = String((err2 && err2.message) || err2);
    }
  }
  cachedFolderCount = data.folders.length;
  broadcastDataChanged(event.sender.id);
  refreshWidgetSize();
  return { ok, error };
});

ipcMain.on('widget:hover', (event, expanded) => {
  widgetExpanded = expanded;
  animateWidget(expanded);
  // Tie click-through directly to the same signal that expands/collapses
  // the panel, so it can never be visibly open with clicks still passing
  // through to whatever is behind it (mouseenter/mouseleave on a
  // transparent forwarding window aren't reliable enough to gate this).
  if (!widgetWindow) return;
  if (expanded) {
    widgetWindow.setIgnoreMouseEvents(false);
    startWatchdog();
  } else if (!widgetPinned) {
    widgetWindow.setIgnoreMouseEvents(true, { forward: true });
    stopWatchdog();
  }
});

ipcMain.on('widget:set-pinned', (event, pinned) => {
  widgetPinned = pinned;
  if (!widgetWindow) return;
  if (pinned) {
    stopWatchdog();
    widgetWindow.setIgnoreMouseEvents(false);
  } else if (widgetExpanded) {
    startWatchdog();
  }
});

ipcMain.on('widget:drag-by', (event, dy) => {
  if (!widgetWindow) return;
  const b = widgetWindow.getBounds();
  const wa = getTargetDisplay().workArea;
  let newY = (dragCurrentY == null ? b.y : dragCurrentY) + dy;
  newY = Math.max(wa.y, Math.min(newY, wa.y + wa.height - b.height));
  dragCurrentY = newY;
  widgetWindow.setBounds({ x: b.x, y: newY, width: b.width, height: b.height });
});

ipcMain.on('widget:drag-end', () => {
  if (dragCurrentY == null) return;
  saveConfig({ ...cachedConfig, y: dragCurrentY });
});

ipcMain.on('widget:open-folder', (event, id) => openMain(id));
ipcMain.on('widget:new-folder', () => openMainForNewFolder());
ipcMain.on('open-calculator', () => openCalculator());
ipcMain.on('send-to-calculator', (event, value) => openCalculator(value));

ipcMain.handle('attachment:add', (event, { sourcePath, name }) => {
  ensureData();
  const safeName = path.basename(name || path.basename(sourcePath));
  const storedName = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}_${safeName}`;
  const destPath = path.join(attachmentsDir, storedName);
  fs.copyFileSync(sourcePath, destPath);
  const stat = fs.statSync(destPath);
  return { storedName, name: safeName, size: stat.size };
});

ipcMain.on('attachment:open', (event, storedName) => {
  shell.openPath(path.join(attachmentsDir, storedName));
});

const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

ipcMain.handle('attachment:read-data-url', (event, storedName) => {
  const p = path.join(attachmentsDir, storedName);
  const mime = IMAGE_MIME_BY_EXT[path.extname(storedName).toLowerCase()];
  if (!mime || !fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  return `data:${mime};base64,${buf.toString('base64')}`;
});

ipcMain.handle('attachment:remove', (event, storedName) => {
  const p = path.join(attachmentsDir, storedName);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {
    // already gone — fine
  }
  return true;
});
