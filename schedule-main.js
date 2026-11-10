// Main-process side of the schedule feature: the events store, the reminder
// engine, the reminder pop-up and the calendar window. The renderers never write
// events.json themselves — they send single operations here, which keeps two
// windows from overwriting each other's edits.
const { app, BrowserWindow, ipcMain, screen, shell, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const Core = require('./renderer/schedule-core.js');

const TICK_MS = 10 * 1000;
const LATE_MS = 2 * 60 * 1000; // a reminder this far past its time is flagged "놓침"
const MAX_LOOKBACK_MS = 7 * Core.DAY_MS;
const RELEVANT_MS = 12 * 60 * 60 * 1000; // late reminders for events older than this are dropped
const STATE_WRITE_MS = 60 * 1000;
const BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BACKUPS = 40;
const DEFAULT_COLOR = '#a7c8ec';
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SNOOZE_CHOICES = [5, 30, 60];

let ctx = null; // helpers handed over by main.js
let eventsFile = '';
let stateFile = '';
let events = [];
let pending = []; // reminders showing in the pop-up, waiting to be dismissed
let snoozes = []; // dismissed-for-now reminders with a dueAt
let lastCheck = Date.now();
let lastStateWrite = 0;
let lastEventsBackup = 0;
let tickTimer = null;
let reminderWin = null;
let calendarWin = null;
let quitting = false;

// ---------- Events store ----------

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function sanitizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.date !== 'string' || !Core.parseYmd(raw.date)) return null;
  const title = String(raw.title == null ? '' : raw.title).trim().slice(0, 120);
  if (!title) return null;
  const time = TIME_RE.test(raw.time || '') ? raw.time : '';
  const endTime = time && TIME_RE.test(raw.endTime || '') && raw.endTime > time ? raw.endTime : '';
  const repeat = Core.REPEATS.includes(raw.repeat) ? raw.repeat : 'none';
  const repeatUntil = repeat !== 'none' && typeof raw.repeatUntil === 'string' && Core.parseYmd(raw.repeatUntil) && raw.repeatUntil >= raw.date ? raw.repeatUntil : null;
  const remind = Array.isArray(raw.remind)
    ? Array.from(new Set(raw.remind.filter((m) => Core.REMIND_CHOICES.includes(m)))).sort((a, b) => a - b)
    : [];
  const skip = Array.isArray(raw.skip)
    ? Array.from(new Set(raw.skip.filter((s) => typeof s === 'string' && Core.parseYmd(s)))).slice(0, 2000)
    : [];
  const now = new Date().toISOString();
  return {
    id: typeof raw.id === 'string' && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : newId(),
    title,
    date: raw.date,
    time,
    endTime,
    repeat,
    repeatUntil,
    remind,
    skip,
    color: typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color : DEFAULT_COLOR,
    folderId: typeof raw.folderId === 'string' && raw.folderId && raw.folderId.length <= 64 ? raw.folderId : null,
    note: String(raw.note == null ? '' : raw.note).slice(0, 2000),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: now,
  };
}

function loadEvents() {
  if (!fs.existsSync(eventsFile)) {
    events = [];
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(eventsFile, 'utf-8'));
    events = (Array.isArray(raw.events) ? raw.events : []).map((r) => {
      const clean = sanitizeEvent(r);
      if (clean && typeof r.updatedAt === 'string') clean.updatedAt = r.updatedAt; // loading isn't editing
      return clean;
    }).filter(Boolean);
  } catch (err) {
    // Keep the unreadable file around instead of overwriting it with an empty list.
    ctx.logError('loadEvents', err);
    try {
      fs.renameSync(eventsFile, `${eventsFile}.corrupt-${Date.now()}`);
    } catch (e) {
      // best effort
    }
    events = [];
  }
}

function pruneEventBackups() {
  const files = fs.readdirSync(ctx.backupsDir).filter((f) => f.startsWith('events-')).sort();
  while (files.length > MAX_BACKUPS) {
    try {
      fs.unlinkSync(path.join(ctx.backupsDir, files.shift()));
    } catch (e) {
      // cleaned up next time
    }
  }
}

function saveEvents() {
  const now = Date.now();
  if (now - lastEventsBackup >= BACKUP_INTERVAL_MS && fs.existsSync(eventsFile)) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(eventsFile, path.join(ctx.backupsDir, `events-${stamp}.json`));
      lastEventsBackup = now;
      pruneEventBackups();
    } catch (err) {
      ctx.logError('events backup', err);
    }
  }
  try {
    ctx.atomicWrite(eventsFile, JSON.stringify({ events }, null, 2));
    return null;
  } catch (err) {
    ctx.logError('saveEvents', err);
    return String((err && err.message) || err);
  }
}

function broadcastEvents() {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send('events:changed');
  });
}

// ---------- Reminder state (survives restarts) ----------

function isReminder(r) {
  return r && typeof r === 'object' && typeof r.id === 'string' && typeof r.title === 'string' && typeof r.date === 'string';
}

function loadState() {
  lastCheck = Date.now();
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    if (Number.isFinite(s.lastCheck) && s.lastCheck <= lastCheck) lastCheck = s.lastCheck;
    pending = Array.isArray(s.pending) ? s.pending.filter(isReminder) : [];
    snoozes = Array.isArray(s.snoozes) ? s.snoozes.filter((r) => isReminder(r) && Number.isFinite(r.dueAt)) : [];
  } catch (e) {
    pending = [];
    snoozes = [];
  }
}

function persistState(force) {
  const now = Date.now();
  if (!force && now - lastStateWrite < STATE_WRITE_MS) return;
  lastStateWrite = now;
  try {
    ctx.atomicWrite(stateFile, JSON.stringify({ lastCheck, pending, snoozes }));
  } catch (err) {
    ctx.logError('persistState', err);
  }
}

// ---------- Reminder engine ----------

function stillRelevant(ev, due, now) {
  if (!ev) return false;
  if (Core.isTimed(ev)) return due.startMs >= now - RELEVANT_MS;
  return due.date >= Core.toYmd(new Date(now));
}

function makeReminder(ev, due, late) {
  return {
    id: `${ev.id}|${due.date}|${due.remindMin}`,
    eventId: ev.id,
    title: ev.title,
    date: due.date,
    time: Core.isTimed(ev) ? ev.time : '',
    remindMin: due.remindMin,
    color: ev.color,
    folderId: ev.folderId,
    startMs: due.startMs,
    late: !!late,
    snoozed: false,
  };
}

function tick() {
  const now = Date.now();
  if (now < lastCheck) lastCheck = now; // the clock moved backwards
  const from = Math.max(lastCheck, now - MAX_LOOKBACK_MS);
  let added = false;

  const stillSnoozed = [];
  for (const s of snoozes) {
    if (s.dueAt <= now) {
      if (!pending.some((p) => p.id === s.id)) {
        const { dueAt, ...rest } = s;
        pending.push({ ...rest, snoozed: true, late: false });
        added = true;
      }
    } else {
      stillSnoozed.push(s);
    }
  }
  snoozes = stillSnoozed;

  for (const due of Core.remindersBetween(events, from, now)) {
    const ev = events.find((e) => e.id === due.eventId);
    const late = now - due.fireAt > LATE_MS;
    if (late && !stillRelevant(ev, due, now)) continue;
    if (!ev) continue;
    const r = makeReminder(ev, due, late);
    if (pending.some((p) => p.id === r.id)) continue;
    pending.push(r);
    added = true;
  }

  lastCheck = now;
  persistState(added);
  if (added) {
    shell.beep();
    syncReminderWindow();
  }
}

function startEngine() {
  if (tickTimer) return;
  tick(); // anything that came due while the app was closed shows up right away
  tickTimer = setInterval(tick, TICK_MS);
  powerMonitor.on('resume', tick);
}

// ---------- Reminder pop-up ----------

const REMIND_W = 380;
function reminderHeight(count) {
  const wa = ctx.getActiveDisplay().workArea;
  const h = 56 + Math.min(count, 4) * 104 + (count > 1 ? 46 : 0) + 8;
  return Math.min(h, wa.height - 40);
}

function reminderBounds(count) {
  const wa = ctx.getActiveDisplay().workArea;
  const h = reminderHeight(count);
  return { x: wa.x + wa.width - REMIND_W - 16, y: wa.y + wa.height - h - 16, width: REMIND_W, height: h };
}

function pushReminders() {
  if (reminderWin && !reminderWin.isDestroyed()) reminderWin.webContents.send('reminders:changed', pending);
}

function syncReminderWindow() {
  if (!pending.length) {
    if (reminderWin && !reminderWin.isDestroyed()) reminderWin.close();
    return;
  }
  if (reminderWin && !reminderWin.isDestroyed()) {
    reminderWin.setBounds(reminderBounds(pending.length));
    if (!reminderWin.isVisible()) reminderWin.showInactive();
    pushReminders();
    return;
  }
  reminderWin = new BrowserWindow({
    ...reminderBounds(pending.length),
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#fffaf0',
    webPreferences: { preload: ctx.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  ctx.lockDown(reminderWin);
  reminderWin.setAlwaysOnTop(true, 'screen-saver');
  reminderWin.once('ready-to-show', () => {
    if (reminderWin && !reminderWin.isDestroyed()) reminderWin.showInactive(); // never steal the keyboard from what you're typing
  });
  reminderWin.on('closed', () => {
    reminderWin = null;
    // A reminder that arrived while the last pop-up was closing still needs one.
    if (pending.length) syncReminderWindow();
  });
  reminderWin.loadFile(path.join(__dirname, 'renderer', 'reminder.html'));
}

function removePending(id) {
  pending = pending.filter((p) => p.id !== id);
}

function afterPendingChange() {
  persistState(true);
  syncReminderWindow();
}

// ---------- Calendar window ----------

function calendarConfig() {
  return (ctx.getConfig() && ctx.getConfig().calendar) || {};
}

function patchCalendarConfig(patch) {
  ctx.patchConfig({ calendar: { ...calendarConfig(), ...patch } });
}

function calendarBounds() {
  const cfg = calendarConfig();
  const width = Math.max(330, Math.min(Number(cfg.width) || 390, 900));
  const height = Math.max(460, Math.min(Number(cfg.height) || 640, 1200));
  if (Number.isFinite(cfg.x) && Number.isFinite(cfg.y)) {
    // Only trust a remembered position that is still on a connected monitor.
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return cfg.x + 80 < a.x + a.width && cfg.x + width - 80 > a.x && cfg.y >= a.y - 10 && cfg.y + 60 < a.y + a.height;
    });
    if (onScreen) return { x: cfg.x, y: cfg.y, width, height };
  }
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - width - 360, y: wa.y + Math.max(24, Math.round((wa.height - height) / 3)), width, height };
}

function sendCalendarCommand(cmd) {
  if (!cmd || !calendarWin || calendarWin.isDestroyed()) return;
  const send = () => calendarWin && !calendarWin.isDestroyed() && calendarWin.webContents.send('calendar:command', cmd);
  if (calendarWin.webContents.isLoading()) calendarWin.webContents.once('did-finish-load', send);
  else send();
}

function createCalendarWindow(cmd, focus) {
  const cfg = calendarConfig();
  calendarWin = new BrowserWindow({
    ...calendarBounds(),
    minWidth: 330,
    minHeight: 460,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: !!cfg.onTop,
    show: false,
    backgroundColor: '#fffaf0',
    webPreferences: { preload: ctx.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  ctx.lockDown(calendarWin);
  calendarWin.once('ready-to-show', () => {
    if (!calendarWin || calendarWin.isDestroyed()) return;
    if (focus) calendarWin.show();
    else calendarWin.showInactive();
  });
  let saveTimer = null;
  const rememberBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!calendarWin || calendarWin.isDestroyed() || calendarWin.isMinimized()) return;
      patchCalendarConfig(calendarWin.getBounds());
    }, 500);
  };
  calendarWin.on('moved', rememberBounds);
  calendarWin.on('resized', rememberBounds);
  calendarWin.on('closed', () => {
    clearTimeout(saveTimer);
    calendarWin = null;
    // Closing it yourself means "don't bring it back"; quitting the app doesn't.
    if (!quitting) patchCalendarConfig({ open: false });
  });
  calendarWin.loadFile(path.join(__dirname, 'renderer', 'calendar.html'));
  patchCalendarConfig({ open: true });
  sendCalendarCommand(cmd);
}

// cmd: { type: 'show', date? } | { type: 'new', date?, folderId?, title? } | { type: 'edit', eventId, date? }
function openCalendar(cmd) {
  if (calendarWin && !calendarWin.isDestroyed()) {
    if (calendarWin.isMinimized()) calendarWin.restore();
    calendarWin.show();
    calendarWin.focus();
    sendCalendarCommand(cmd);
    return;
  }
  createCalendarWindow(cmd, true);
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('events:get', () => events);

  ipcMain.handle('events:upsert', (event, raw) => {
    const clean = sanitizeEvent(raw);
    if (!clean) return { ok: false, error: '제목과 날짜를 확인해 주세요' };
    const idx = events.findIndex((e) => e.id === clean.id);
    if (idx !== -1) {
      clean.skip = events[idx].skip; // renderers never edit the skipped dates
      clean.createdAt = events[idx].createdAt;
      events[idx] = clean;
    } else {
      events.push(clean);
    }
    const error = saveEvents();
    broadcastEvents();
    return error ? { ok: false, error } : { ok: true, event: clean };
  });

  ipcMain.handle('events:delete', (event, id) => {
    events = events.filter((e) => e.id !== id);
    pending = pending.filter((p) => p.eventId !== id);
    snoozes = snoozes.filter((s) => s.eventId !== id);
    const error = saveEvents();
    persistState(true);
    syncReminderWindow();
    broadcastEvents();
    return { ok: !error, error };
  });

  // Delete a single occurrence of a repeating event.
  ipcMain.handle('events:skip', (event, id, date) => {
    const ev = events.find((e) => e.id === id);
    if (!ev || typeof date !== 'string' || !Core.parseYmd(date)) return { ok: false, error: '일정을 찾을 수 없습니다' };
    if (ev.repeat === 'none') {
      events = events.filter((e) => e.id !== id);
    } else if (!ev.skip.includes(date)) {
      ev.skip.push(date);
    }
    pending = pending.filter((p) => !(p.eventId === id && p.date === date));
    snoozes = snoozes.filter((s) => !(s.eventId === id && s.date === date));
    const error = saveEvents();
    persistState(true);
    syncReminderWindow();
    broadcastEvents();
    return { ok: !error, error };
  });

  ipcMain.on('calendar:open', (event, cmd) => {
    const ok = cmd && typeof cmd === 'object' && ['show', 'new', 'edit'].includes(cmd.type);
    openCalendar(ok ? cmd : { type: 'show' });
  });
  ipcMain.on('calendar:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && win === calendarWin) win.close();
  });
  ipcMain.handle('calendar:get-state', () => ({ onTop: !!calendarConfig().onTop }));
  ipcMain.on('calendar:set-top', (event, onTop) => {
    if (calendarWin && !calendarWin.isDestroyed()) calendarWin.setAlwaysOnTop(!!onTop);
    patchCalendarConfig({ onTop: !!onTop });
  });

  ipcMain.handle('reminders:get', () => pending);
  ipcMain.on('reminders:dismiss', (event, id) => {
    removePending(id);
    afterPendingChange();
  });
  ipcMain.on('reminders:dismiss-all', () => {
    pending = [];
    afterPendingChange();
  });
  ipcMain.on('reminders:snooze', (event, id, minutes) => {
    const r = pending.find((p) => p.id === id);
    if (!r || !SNOOZE_CHOICES.includes(minutes)) return;
    removePending(id);
    snoozes = snoozes.filter((s) => s.id !== id);
    snoozes.push({ ...r, dueAt: Date.now() + minutes * 60000 });
    afterPendingChange();
  });
  ipcMain.on('reminders:open', (event, id) => {
    const r = pending.find((p) => p.id === id);
    if (!r) return;
    removePending(id);
    afterPendingChange();
    openCalendar(events.some((e) => e.id === r.eventId) ? { type: 'edit', eventId: r.eventId, date: r.date } : { type: 'show', date: r.date });
  });
}

// ---------- Entry point ----------

// ctx: { dataDir, backupsDir, preloadPath, atomicWrite, logError, lockDown,
//        getConfig, patchConfig, getActiveDisplay }
function init(context) {
  ctx = context;
  eventsFile = path.join(ctx.dataDir, 'events.json');
  stateFile = path.join(ctx.dataDir, 'schedule-state.json');
  loadEvents();
  loadState();
  registerIpc();
  app.on('before-quit', () => {
    quitting = true;
    persistState(true);
  });
  startEngine();
  syncReminderWindow(); // reminders still unacknowledged from last time
  if (calendarConfig().open) createCalendarWindow(null, false);
}

module.exports = { init, openCalendar };
