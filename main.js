const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, shell, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const schedule = require('./schedule-main');

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

const STRIP_W = 34; // tab column width once revealed
const PANEL_W = 300; // quick-edit panel width
const FULL_W = STRIP_W + PANEL_W; // the widget window is always this wide
const TAB_H = 92;
const TAB_GAP = 4;
const ADD_TAB_H = 34;
const SCHED_TAB_H = 64; // the 일정 tab pinned above the folder tabs
const MIN_WIDGET_H = 380; // tall enough for the schedule panel's list and quick-add form
// Horizontal docks (top / bottom): the tab strip lies along the edge, the panel opens away from it.
const STRIP_H = 34;
const PANEL_H = 420;
const H_TAB_W = 92;
const H_SCHED_TAB_W = 64;
const DOCKS = ['right', 'left', 'top', 'bottom'];
const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const DONATE_URL = 'https://www.buymeacoffee.com/kdwikorea';
// Attachments open with the default app, which for these would run them —
// show them in Explorer instead so opening one is always a deliberate step.
const BLOCKED_OPEN_EXT = new Set(['.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.hta', '.lnk', '.reg', '.dll', '.jar', '.cpl']);

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
let dragCurrent = null; // live position while the handle is being dragged: {x, y}
let dragSession = null; // set between drag-start and drag-end
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
  const contentH = SCHED_TAB_H + TAB_GAP + cachedFolderCount * (TAB_H + TAB_GAP) + TAB_GAP + ADD_TAB_H + TAB_GAP;
  return Math.min(Math.max(contentH, MIN_WIDGET_H), wa.height - 24);
}

// The window never changes size when the panel opens or closes — the slide is
// a CSS transform inside it (see widget.css). It stays click-through while
// idle, so the transparent area never blocks the app underneath.
function currentDock() {
  return DOCKS.includes(cachedConfig && cachedConfig.dock) ? cachedConfig.dock : 'right';
}

function computeWidth(wa) {
  const contentW = H_SCHED_TAB_W + cachedFolderCount * H_TAB_W + ADD_TAB_H + (cachedFolderCount + 3) * TAB_GAP + 16;
  return Math.min(Math.max(contentW, PANEL_W), wa.width - 24);
}

function getWidgetBounds() {
  const wa = getTargetDisplay().workArea;
  const dock = currentDock();
  if (dock === 'top' || dock === 'bottom') {
    const width = computeWidth(wa);
    const height = STRIP_H + Math.max(300, Math.min(PANEL_H, wa.height - 24 - STRIP_H));
    let x = dragCurrent && typeof dragCurrent.x === 'number' ? dragCurrent.x : cachedConfig.x;
    if (typeof x !== 'number') x = wa.x + (dock === 'bottom' ? 12 : Math.round((wa.width - width) / 2));
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
    return { x, y: dock === 'top' ? wa.y : wa.y + wa.height - height, width, height };
  }
  const height = computeHeight(wa);
  let y = dragCurrent && typeof dragCurrent.y === 'number' ? dragCurrent.y : cachedConfig.y;
  if (typeof y !== 'number') y = wa.y + Math.round((wa.height - height) / 2);
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));
  return { x: dock === 'left' ? wa.x : wa.x + wa.width - FULL_W, y, width: FULL_W, height };
}

// Moving between monitors with different scaling sometimes lands a few pixels
// off on the first setBounds, so check the result and apply it again.
function placeWidget() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const target = getWidgetBounds();
  for (let i = 0; i < 3; i++) {
    widgetWindow.setBounds(target);
    const got = widgetWindow.getBounds();
    if (got.x === target.x && got.y === target.y && got.width === target.width && got.height === target.height) break;
  }
}

function refreshWidgetSize() {
  placeWidget();
}

// Hop to the new monitor invisibly (so it never visibly flies across the
// desktop), then nudge in from the edge once it has arrived.
function moveToActiveDisplay() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const visible = widgetWindow.isVisible();
  widgetWindow.setOpacity(0);
  placeWidget();
  if (!visible) {
    widgetWindow.setOpacity(1);
    return;
  }
  setTimeout(() => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    widgetWindow.webContents.send('widget:arrive');
    widgetWindow.setOpacity(1);
  }, 80);
}

// A single lightweight poll (not one window per monitor) that relocates
// the one widget window to whichever display currently has the cursor.
// Skipped while expanded/pinned so it never yanks the panel away mid-use.
function startDisplayWatch() {
  if (displayWatchTimer) return;
  displayWatchTimer = setInterval(() => {
    if (widgetExpanded || widgetPinned || dragSession) return;
    const disp = getActiveDisplay();
    if (disp.id !== currentDisplayId) {
      currentDisplayId = disp.id;
      moveToActiveDisplay();
    }
  }, 400);
  // Plugging a monitor in/out or changing scaling re-seats the widget too.
  const reseat = () => {
    if (!screen.getAllDisplays().some((d) => d.id === currentDisplayId)) currentDisplayId = screen.getPrimaryDisplay().id;
    moveToActiveDisplay();
  };
  screen.on('display-added', reseat);
  screen.on('display-removed', reseat);
  screen.on('display-metrics-changed', reseat);
}

// Transparent click-through windows can occasionally miss a DOM
// mouseleave event on Windows, leaving the panel stuck open. This
// watchdog is a reliable fallback: while expanded, it polls the real
// cursor position and force-collapses if the mouse has actually left.
function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (!widgetWindow || widgetWindow.isDestroyed() || widgetPinned || dragSession) return;
    const pt = screen.getCursorScreenPoint();
    // The window is always full width, so its target bounds are the real
    // bounds. (Back when it was resized to reveal the panel, checking the
    // live mid-animation bounds here force-collapsed it while it was still
    // opening — a rapid expand/collapse flicker.)
    const b = getWidgetBounds();
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

// Windows only ever show local pages: links open in the default browser and
// anything that tries to navigate the window elsewhere (a dropped file, a
// clicked link) is refused.
function lockDown(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
}

function createWidgetWindow() {
  const bounds = getWidgetBounds();
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
    show: !(cachedConfig && cachedConfig.hidden),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  lockDown(widgetWindow);
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
    backgroundColor: windowBg(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  lockDown(mainWindow);
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
    backgroundColor: windowBg(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  lockDown(calcWindow);
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
  dragCurrent = null;
  saveConfig({ ...cachedConfig, dock: 'right', x: null, y: null });
  notifyDock();
  moveToActiveDisplay();
  updateTrayMenu();
}

function notifyDock() {
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.webContents.send('widget:dock', currentDock());
}

// Pick an edge from the tray menu: centred along that edge until dragged.
function setDock(dock) {
  if (!DOCKS.includes(dock)) return;
  dragCurrent = null;
  saveConfig({ ...cachedConfig, dock, x: null, y: null });
  notifyDock();
  forceCollapseUnlessPinned();
  moveToActiveDisplay();
  updateTrayMenu();
}

function forceCollapseUnlessPinned() {
  if (!widgetPinned) forceCollapse();
}

// Theme: 'system' follows Windows, otherwise forced. nativeTheme.themeSource
// drives prefers-color-scheme in every window, so the CSS needs nothing else.
const THEMES = ['system', 'light', 'dark'];
const THEME_LABELS = { system: '자동 (Windows 설정 따라가기)', light: '라이트', dark: '다크' };
function currentTheme() {
  return THEMES.includes(cachedConfig && cachedConfig.theme) ? cachedConfig.theme : 'system';
}
function windowBg() {
  return nativeTheme.shouldUseDarkColors ? '#141A2A' : '#F7F8FB';
}
function setTheme(theme) {
  if (!THEMES.includes(theme)) return;
  saveConfig({ ...cachedConfig, theme });
  nativeTheme.themeSource = theme;
  updateTrayMenu();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w !== widgetWindow) w.setBackgroundColor(windowBg());
  }
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
    { label: '빼꼬미 열기', click: () => openMain() },
    { label: '📅 일정 달력', click: () => schedule.openCalendar({ type: 'show' }) },
    { label: '계산기', click: () => openCalculator() },
    { type: 'separator' },
    {
      label: isVisible ? '위젯 숨기기' : '위젯 보이기',
      click: () => setWidgetVisible(!isVisible),
    },
    {
      label: '위젯 붙이는 곳',
      submenu: [['right', '오른쪽'], ['left', '왼쪽'], ['top', '위쪽'], ['bottom', '아래쪽']].map(([d, label]) => ({
        label,
        type: 'radio',
        checked: currentDock() === d,
        click: () => setDock(d),
      })),
    },
    { label: '위젯 위치 초기화', click: () => resetWidgetPosition() },
    {
      label: '화면 테마',
      submenu: THEMES.map((t) => ({
        label: THEME_LABELS[t],
        type: 'radio',
        checked: currentTheme() === t,
        click: () => setTheme(t),
      })),
    },
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
    { label: '☕ 후원하기', click: () => shell.openExternal(DONATE_URL) },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon); // tray.png + tray@2x.png: Electron picks the size for the display scale
  tray.setToolTip('빼꼬미');
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
    nativeTheme.themeSource = currentTheme();
    cachedFolderCount = loadData().folders.length;
    currentDisplayId = getActiveDisplay().id;
    configureAutoLaunch(cachedConfig.autoLaunch !== false);
    createWidgetWindow();
    schedule.init({
      dataDir,
      backupsDir,
      preloadPath: path.join(__dirname, 'preload.js'),
      atomicWrite: atomicWriteFileSync,
      logError,
      lockDown,
      getConfig: () => cachedConfig,
      patchConfig: (patch) => saveConfig({ ...cachedConfig, ...patch }),
      getActiveDisplay,
      windowBg,
    });
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
// Just enough about each folder for the calendar to link events to it, without
// shipping every page (and pasted image) of every note across IPC.
ipcMain.handle('theme:get', () => currentTheme());
ipcMain.handle('theme:cycle', () => {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  setTheme(next);
  return next;
});

ipcMain.handle('folders:list', () => {
  const data = loadData();
  const folders = Array.isArray(data.folders) ? data.folders : [];
  return folders.map((f) => ({ id: f.id, title: f.title, color: f.color }));
});
ipcMain.handle('data:save', (event, data) => {
  if (!data || !Array.isArray(data.folders)) return { ok: false, error: '메모 데이터 형식이 올바르지 않습니다' };
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

ipcMain.handle('widget:get-dock', () => currentDock());

// Dragging the handle moves the whole window freely with the cursor (one
// setBounds per animation frame, sent from the renderer only while the button
// is down — nothing polls). Letting go snaps it to the nearest screen edge.
ipcMain.on('widget:drag-start', () => {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const b = widgetWindow.getBounds();
  const c = screen.getCursorScreenPoint();
  dragSession = { gx: c.x - b.x, gy: c.y - b.y, w: b.width, h: b.height };
});

ipcMain.on('widget:drag-move', () => {
  if (!dragSession || !widgetWindow || widgetWindow.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(c).bounds;
  const x = Math.max(d.x, Math.min(c.x - dragSession.gx, d.x + d.width - dragSession.w));
  const y = Math.max(d.y, Math.min(c.y - dragSession.gy, d.y + d.height - dragSession.h));
  widgetWindow.setBounds({ x, y, width: dragSession.w, height: dragSession.h });
});

ipcMain.on('widget:drag-end', () => {
  if (!dragSession) return;
  dragSession = null;
  const c = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(c);
  const wa = disp.workArea;
  const dists = {
    left: c.x - wa.x,
    right: wa.x + wa.width - c.x,
    top: c.y - wa.y,
    bottom: wa.y + wa.height - c.y,
  };
  const dock = DOCKS.reduce((best, d) => (dists[d] < dists[best] ? d : best), 'right');
  currentDisplayId = disp.id;
  dragCurrent = null;
  const patch = { dock };
  if (dock === 'left' || dock === 'right') patch.y = c.y - 24;
  else patch.x = c.x - Math.round(PANEL_W / 2);
  saveConfig({ ...cachedConfig, ...patch });
  notifyDock();
  forceCollapseUnlessPinned();
  moveToActiveDisplay();
  updateTrayMenu();
});

ipcMain.on('widget:open-folder', (event, id) => openMain(id));
ipcMain.on('widget:new-folder', () => openMainForNewFolder());
ipcMain.on('open-calculator', () => openCalculator());
ipcMain.on('send-to-calculator', (event, value) => openCalculator(value));

// Attachment names come from the renderer, so never let one point outside
// the attachments folder.
function storedPath(storedName) {
  if (typeof storedName !== 'string' || !storedName || storedName !== path.basename(storedName) || storedName.startsWith('.')) return null;
  return path.join(attachmentsDir, storedName);
}

ipcMain.handle('attachment:add', (event, { sourcePath, name } = {}) => {
  if (typeof sourcePath !== 'string' || !sourcePath) throw new Error('첨부할 파일을 찾을 수 없습니다');
  const st = fs.statSync(sourcePath);
  if (!st.isFile()) throw new Error('파일만 첨부할 수 있습니다');
  if (st.size > MAX_ATTACHMENT_BYTES) throw new Error('200MB 보다 큰 파일은 첨부할 수 없습니다');
  ensureData();
  const safeName = path.basename(String(name || path.basename(sourcePath))).replace(/[\\/:*?"<>|]/g, '_');
  const storedName = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}_${safeName}`;
  fs.copyFileSync(sourcePath, path.join(attachmentsDir, storedName));
  return { storedName, name: safeName, size: st.size };
});

ipcMain.on('attachment:open', (event, storedName) => {
  const p = storedPath(storedName);
  if (!p || !fs.existsSync(p)) return;
  if (BLOCKED_OPEN_EXT.has(path.extname(p).toLowerCase())) {
    shell.showItemInFolder(p);
    return;
  }
  shell.openPath(p);
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
  const p = storedPath(storedName);
  const mime = p && IMAGE_MIME_BY_EXT[path.extname(p).toLowerCase()];
  if (!mime || !fs.existsSync(p)) return null;
  return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
});

ipcMain.handle('attachment:remove', (event, storedName) => {
  const p = storedPath(storedName);
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {
    // already gone — fine
  }
  return true;
});
