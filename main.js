// Notepad — desktop shell.
// A transparent, frameless window: only the notepad and its tabs are drawn, and clicks on the empty
// space around them fall through to whatever is underneath. Drag a page's title area to move it.
// Minimize goes to the taskbar; the × button (or closing) tucks it into the system tray.
// Quit from the tray icon's right-click menu.
'use strict';

const { app, BrowserWindow, Menu, Tray, ipcMain, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const canvas = require('./canvas');

const APP_NAME = 'Notepad';
const APP_ID = 'com.notepad.clipboard';
const ICON = path.join(__dirname, 'assets', 'icon.ico');
const START_HIDDEN = process.argv.includes('--hidden');

// Must match the layout numbers in styles.css (--gap-*, the 70px tab allowance, the clipboard ratio).
const GAP = { top: 20, x: 20, bottom: 30 };
const TAB_ALLOWANCE = 70;
const BOARD_RATIO = 0.75; // notepad width / height
const MIN_BOARD_HEIGHT = 420;

let win = null;
let tray = null;
let quitting = false;
let resizeTimer = null;
let moveStart = null; // window bounds when a drag began
let pinned = false;

app.setAppUserModelId(APP_ID);

/* ---------- Saved state ---------- */

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8').replace(/^﻿/, ''));
  } catch {
    return {};
  }
}

function writeState(patch) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...patch }, null, 2));
  } catch {
    /* not fatal */
  }
}

// Bring over pages written while the app was called "Kitchen Notepad".
function migrateOldPages() {
  const from = path.join(app.getPath('appData'), 'Kitchen Notepad', 'Local Storage');
  const to = path.join(app.getPath('userData'), 'Local Storage');
  if (!fs.existsSync(from) || fs.existsSync(to)) return;
  try {
    fs.cpSync(from, to, { recursive: true, filter: (src) => path.basename(src) !== 'LOCK' });
  } catch {
    /* start with blank pages */
  }
}

/* ---------- Window size (always shaped to fit the clipboard) ---------- */

function windowSizeFor(boardHeight) {
  return {
    width: Math.round(boardHeight * BOARD_RATIO + TAB_ALLOWANCE + GAP.x * 2),
    height: Math.round(boardHeight + GAP.top + GAP.bottom),
  };
}

const boardHeightOf = (bounds) => bounds.height - GAP.top - GAP.bottom;

function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const board = Math.max(MIN_BOARD_HEIGHT, Math.min(820, workArea.height - GAP.top - GAP.bottom - 40));
  const size = windowSizeFor(board);
  return {
    ...size,
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + (workArea.height - size.height) / 2),
  };
}

// Only reuse saved bounds if they still land on a connected screen.
function savedBounds(bounds) {
  if (!bounds) return null;
  const { workArea } = screen.getDisplayMatching(bounds);
  const visibleX = Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
  const visibleY = Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
  if (visibleX < 120 || visibleY < 120) return null;
  return { x: bounds.x, y: bounds.y, ...windowSizeFor(Math.max(MIN_BOARD_HEIGHT, boardHeightOf(bounds))) };
}

function saveWindowState() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  writeState({ bounds: win.getBounds() });
}

// Moving from the tabs or week rows. Preferred: once the page sees a real drag begin, hand the
// move to Windows itself (the same native loop a title bar uses), which keeps the window glued
// to the cursor at the display's refresh rate. That needs two calls into user32.dll.
const nativeDrag = (() => {
  if (process.platform !== 'win32') return null;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const ReleaseCapture = user32.func('bool __stdcall ReleaseCapture()');
    const PostMessageW = user32.func('bool __stdcall PostMessageW(intptr_t hwnd, uint32 msg, uintptr_t wParam, intptr_t lParam)');
    const WM_NCLBUTTONDOWN = 0x00a1;
    const HTCAPTION = 2;
    return (window) => {
      const hwnd = Number(window.getNativeWindowHandle().readBigUInt64LE());
      ReleaseCapture(); // the page grabbed the mouse on pointerdown; Windows needs it back
      return Boolean(PostMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0));
    };
  } catch {
    return null; // koffi missing or failed to load: the page falls back to moveBy below
  }
})();

// Fallback: the page sends how far the pointer has travelled, once per display frame, and the
// window follows. The window keeps its size, and stays at least partly on screen.
function startMove() {
  stopMove();
  if (pinned) return;
  moveStart = win.getBounds();
}

function moveBy(dx, dy) {
  if (!moveStart || !win || win.isDestroyed()) return;
  const x = moveStart.x + dx;
  const y = moveStart.y + dy;
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  win.setBounds({
    x: Math.round(Math.max(workArea.x - moveStart.width + 80, Math.min(workArea.x + workArea.width - 80, x))),
    y: Math.round(Math.max(workArea.y, Math.min(workArea.y + workArea.height - 80, y))),
    width: moveStart.width,
    height: moveStart.height,
  });
}

function stopMove() {
  if (!moveStart) return;
  moveStart = null;
  saveWindowState();
}

// Resizing follows the cursor while the grip by the pad's corner is held.
function startResize() {
  stopResize();
  if (pinned) return;
  const start = win.getBounds();
  const startBoard = boardHeightOf(start);
  const origin = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayMatching(start);
  const roomBelow = workArea.y + workArea.height - start.y - GAP.top - GAP.bottom;
  const roomRight = (workArea.x + workArea.width - start.x - TAB_ALLOWANCE - GAP.x * 2) / BOARD_RATIO;
  const maxBoard = Math.max(startBoard, Math.min(roomBelow, roomRight));

  resizeTimer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      stopResize();
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const byHeight = startBoard + (cursor.y - origin.y);
    const byWidth = startBoard + (cursor.x - origin.x) / BOARD_RATIO;
    const board = Math.max(MIN_BOARD_HEIGHT, Math.min(maxBoard, Math.max(byHeight, byWidth)));
    win.setBounds({ x: start.x, y: start.y, ...windowSizeFor(board) });
  }, 16);
}

function stopResize() {
  if (!resizeTimer) return;
  clearInterval(resizeTimer);
  resizeTimer = null;
  saveWindowState();
}

// Pinned: kept in front of other apps and locked in place (no moving or resizing).
function setPinned(on) {
  pinned = Boolean(on);
  if (pinned) {
    stopMove();
    stopResize();
  }
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(pinned, 'floating');
    win.webContents.send('notepad:pinned', pinned);
  }
  writeState({ pinned });
  updateTrayMenu();
}

/* ---------- Window ---------- */

function hideToTray() {
  win.hide();
  if (!readState().trayHintShown) {
    tray?.displayBalloon({
      iconType: 'info',
      title: APP_NAME,
      content: 'Still here in your hidden icons. Right-click the notepad icon to quit.',
    });
    writeState({ trayHintShown: true });
  }
}

function createWindow() {
  const state = readState();
  pinned = Boolean(state.pinned ?? state.alwaysOnTop); // alwaysOnTop: the setting's old name

  win = new BrowserWindow({
    ...(savedBounds(state.bounds) ?? defaultBounds()),
    show: false,
    title: APP_NAME,
    icon: ICON,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false, // resized with the grip by the pad's corner instead
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: pinned,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'), { query: { desktop: '1' } });

  win.once('ready-to-show', () => {
    if (!START_HIDDEN) win.show();
    updateTrayMenu();
  });
  win.webContents.on('did-finish-load', () => win.webContents.send('notepad:pinned', pinned));

  // Closing (Alt+F4, taskbar "Close window") hides to the tray instead of quitting.
  win.on('close', (event) => {
    saveWindowState();
    if (quitting) return;
    event.preventDefault();
    hideToTray();
  });

  let saveTimer = 0;
  win.on('move', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindowState, 400);
  });
  // Windows has finished a native move: let the page tidy up its drag state
  win.on('moved', () => win.webContents.send('notepad:moved'));
  win.on('blur', () => {
    stopMove();
    stopResize();
  });
  for (const event of ['show', 'hide', 'minimize', 'restore']) win.on(event, updateTrayMenu);

  // Links open in the real browser; the window itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  // Right-click menu: spelling suggestions plus cut/copy/paste.
  win.webContents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: suggestion, click: () => win.webContents.replaceMisspelling(suggestion) });
      }
      items.push({
        label: 'Add to dictionary',
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      items.push({ type: 'separator' });
    }
    if (params.isEditable) {
      items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
    } else if (params.selectionText) {
      items.push({ role: 'copy' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win && win.isVisible() && !win.isMinimized()) win.hide();
  else showWindow();
}

/* ---------- Messages from the page (see preload.js) ---------- */

const fromOurWindow = (event) => win && !win.isDestroyed() && event.sender === win.webContents;

ipcMain.on('notepad:window', (event, action) => {
  if (!fromOurWindow(event)) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'hide') hideToTray();
});

ipcMain.on('notepad:pass-through', (event, on) => {
  if (!fromOurWindow(event)) return;
  win.setIgnoreMouseEvents(Boolean(on), { forward: true });
});

ipcMain.handle('notepad:drag-window', (event) => {
  if (!fromOurWindow(event) || pinned || !nativeDrag) return false;
  try {
    return nativeDrag(win);
  } catch {
    return false;
  }
});

ipcMain.on('notepad:move', (event, phase) => {
  if (!fromOurWindow(event)) return;
  if (phase === 'start') startMove();
  else stopMove();
});

ipcMain.on('notepad:move-by', (event, dx, dy) => {
  if (!fromOurWindow(event)) return;
  moveBy(dx, dy);
});

ipcMain.on('notepad:resize', (event, phase) => {
  if (!fromOurWindow(event)) return;
  if (phase === 'start') startResize();
  else stopResize();
});

ipcMain.on('notepad:pin', (event, on) => {
  if (!fromOurWindow(event)) return;
  setPinned(on);
});

/* ---------- Tray (hidden icons) ---------- */

// In development the app runs through electron.exe, which needs the app folder as an argument.
const loginItem = () => ({
  path: process.execPath,
  args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'],
});

function updateTrayMenu() {
  if (!tray || !win || win.isDestroyed()) return;
  const visible = win.isVisible() && !win.isMinimized();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? 'Hide notepad' : 'Show notepad', click: toggleWindow },
    { type: 'separator' },
    {
      label: 'Pin in place (in front of other apps)',
      type: 'checkbox',
      checked: pinned,
      click: (item) => setPinned(item.checked),
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings(loginItem()).openAtLogin,
      click: (item) => app.setLoginItemSettings({ ...loginItem(), openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: `Quit ${APP_NAME}`, click: () => app.quit() },
  ]));
}

function createTray() {
  tray = new Tray(ICON);
  tray.setToolTip(APP_NAME);
  tray.on('click', toggleWindow);
  updateTrayMenu();
}

/* ---------- App lifecycle ---------- */

if (!app.requestSingleInstanceLock()) {
  app.quit(); // already running: the first copy shows itself (see 'second-instance')
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => {
    /* keep running in the tray */
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    migrateOldPages();
    createWindow();
    createTray();
    canvas.init({ app, window: win, ipcMain });
  });
}
