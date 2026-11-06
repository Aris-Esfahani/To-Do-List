// Canvas LMS integration (main process).
//
// Two ways to connect, both per user, neither needing anything from the school:
//   - Sign in: a window shows the school's real Canvas login page (SSO and all). Once Canvas
//     reports a signed-in user, the window closes and the app keeps that session's cookies in
//     its own partition and reads the same endpoints the Canvas website uses.
//   - Access token: pasted from Canvas → Account → Settings → "New Access Token". Never expires
//     unless revoked, so no re-signing-in. Stored encrypted with safeStorage.
//
// Assignments come from the planner API (what Canvas's own calendar and to-do list use), which
// includes submission status. Results are cached on disk so the pad shows the last known
// assignments while offline or signed out.
'use strict';

const { BrowserWindow, net, safeStorage, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const PARTITION = 'persist:canvas';
const REFRESH_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKS_AHEAD = 2;

// Fallback course colors (Canvas's own custom colors win when the user has set them)
const PALETTE = ['#c4513a', '#d79a2b', '#6f8f3e', '#3f8f7f', '#4a78b0', '#8a5aa0', '#c07040', '#5a6e8c'];

let app = null;
let win = null;
let files = { settings: '', cache: '' };
let settings = { host: '', mode: null, token: null, userName: '', enabled: false, hiddenCourses: [] };
let cache = { items: [], courses: [], colors: {}, updatedAt: 0 };
let status = 'disconnected'; // disconnected | connecting | connected | signed-out | error
let error = '';
let loginWin = null;
let timer = null;
let refreshing = null;

/* ---------- Files ---------- */

function readJSON(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) };
  } catch {
    return { ...fallback };
  }
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch {
    /* not fatal */
  }
}

const saveSettings = () => writeJSON(files.settings, settings);
const saveCache = () => writeJSON(files.cache, cache);

function encrypt(text) {
  if (!safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(text).toString('base64');
}

function decrypt(blob) {
  try {
    return blob && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(blob, 'base64')) : '';
  } catch {
    return '';
  }
}

/* ---------- HTTP ---------- */

const canvasSession = () => session.fromPartition(PARTITION);

// One request against the Canvas host, with either the token or the signed-in session's cookies.
function request(url, { auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const useSession = auth && settings.mode === 'session';
    const req = net.request(useSession
      ? { url, session: canvasSession(), useSessionCookies: true, redirect: 'follow' }
      : { url, redirect: 'follow' });
    req.setHeader('Accept', 'application/json');
    if (auth && settings.mode === 'token') req.setHeader('Authorization', `Bearer ${decrypt(settings.token)}`);
    const chunks = [];
    req.on('response', (res) => {
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').replace(/^while\(1\);/, ''); // session responses carry an anti-hijack prefix
        const link = [].concat(res.headers.link ?? []).join(',');
        resolve({ status: res.statusCode, text, link });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function api(pathname, options) {
  const res = await request(`https://${settings.host}${pathname}`, options);
  let data = null;
  try {
    data = JSON.parse(res.text);
  } catch {
    /* not JSON: a login page, usually */
  }
  return { ...res, data };
}

// Follows Canvas's Link: <...>; rel="next" pagination.
async function apiAll(pathname, limit = 6) {
  const out = [];
  let url = `https://${settings.host}${pathname}`;
  for (let i = 0; i < limit && url; i++) {
    const res = await request(url);
    if (res.status !== 200) return { status: res.status, data: out };
    let page;
    try {
      page = JSON.parse(res.text);
    } catch {
      return { status: 0, data: out };
    }
    out.push(...page);
    url = /<([^>]+)>;\s*rel="next"/.exec(res.link)?.[1] ?? null;
  }
  return { status: 200, data: out };
}

/* ---------- Host ---------- */

// Instructure's public school directory (the same one the Canvas Student app's
// "Find my school" uses). Returns [{ name, domain }].
async function searchSchools(query) {
  const q = String(query ?? '').trim();
  if (q.length < 2) return [];
  const res = await request(`https://canvas.instructure.com/api/v1/accounts/search?search_term=${encodeURIComponent(q)}`, { auth: false });
  if (res.status !== 200) throw new Error('The school directory isn\'t answering right now. Enter the Canvas address instead.');
  let list;
  try {
    list = JSON.parse(res.text);
  } catch {
    throw new Error('The school directory gave an unexpected answer.');
  }
  return (Array.isArray(list) ? list : [])
    .filter((s) => s && s.domain && s.name)
    .slice(0, 8)
    .map((s) => ({ name: s.name, domain: String(s.domain).toLowerCase() }));
}

// "sjsu" → "sjsu.instructure.com"; also accepts full URLs. Checks that it really is Canvas.
async function resolveHost(input) {
  let host = String(input ?? '').trim().toLowerCase();
  host = host.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  if (!host) throw new Error('Enter your school\'s Canvas address.');
  if (!host.includes('.')) host = `${host}.instructure.com`;
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error('That doesn\'t look like a web address.');
  let res;
  try {
    res = await request(`https://${host}/api/v1/users/self`, { auth: false });
  } catch {
    throw new Error(`Couldn't reach ${host}. Check the address and your connection.`);
  }
  // A Canvas server answers this with a JSON "unauthenticated" error
  if (res.status !== 401 || !/unauthenticated|Invalid access token|user authorization required/i.test(res.text)) {
    throw new Error(`${host} doesn't look like a Canvas site.`);
  }
  return host;
}

async function whoAmI() {
  if (!settings.host || !settings.mode) return null;
  const res = await api('/api/v1/users/self');
  return res.status === 200 && res.data?.id ? res.data : null;
}

/* ---------- Sign-in window ---------- */

function openLogin() {
  if (loginWin && !loginWin.isDestroyed()) {
    if (loginWin.isMinimized()) loginWin.restore();
    loginWin.show();
    loginWin.focus();
    loginWin.moveTop();
    return;
  }
  loginWin = new BrowserWindow({
    width: 540,
    height: 720,
    title: `Sign in to Canvas (${settings.host})`,
    show: false,
    alwaysOnTop: Boolean(win && !win.isDestroyed() && win.isAlwaysOnTop()), // never buried under a pinned notepad
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Some schools' sign-in flows open popups; keep them in the same session
  loginWin.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: PARTITION, sandbox: true } },
  }));

  const before = { mode: settings.mode, status };
  let signedIn = false;
  let checking = false;
  // After each page the login flow lands on, ask Canvas who the session belongs to
  const check = async () => {
    if (checking || signedIn || !loginWin || loginWin.isDestroyed()) return;
    checking = true;
    try {
      settings.mode = 'session';
      const me = await whoAmI();
      if (me) {
        signedIn = true;
        settings.userName = me.short_name || me.name || '';
        settings.enabled = true;
        saveSettings();
        setStatus('connected');
        if (loginWin && !loginWin.isDestroyed()) loginWin.close();
        refresh();
      } else {
        settings.mode = before.mode;
      }
    } catch {
      settings.mode = before.mode;
    } finally {
      checking = false;
    }
  };
  loginWin.once('ready-to-show', () => {
    loginWin.show();
    loginWin.focus();
    loginWin.moveTop();
  });
  loginWin.webContents.on('did-navigate', check);
  loginWin.webContents.on('did-finish-load', check);
  loginWin.on('closed', () => {
    loginWin = null;
    if (!signedIn) setStatus(before.status);
  });
  loginWin.loadURL(`https://${settings.host}/login`);
  setStatus('connecting');
}

/* ---------- Assignments ---------- */

const mondayOf = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
};

function compactItem(item) {
  const p = item.plannable ?? {};
  const when = p.due_at ?? p.todo_date ?? p.start_at ?? item.plannable_date;
  const sub = item.submissions || null;
  const done = Boolean(sub?.submitted || sub?.graded || sub?.excused || item.planner_override?.marked_complete);
  const url = item.html_url ? new URL(item.html_url, `https://${settings.host}/`).href : '';
  return {
    id: `${item.plannable_type}-${p.id ?? item.plannable_id}`,
    type: item.plannable_type,
    title: p.title ?? p.name ?? '(untitled)',
    date: when,
    timed: Boolean(p.due_at || p.start_at),
    courseId: item.course_id ?? null,
    course: item.context_name ?? '',
    url,
    done,
    missing: Boolean(sub?.missing),
    late: Boolean(sub?.late),
  };
}

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    if (!settings.host || !settings.mode) return;
    const start = mondayOf(new Date());
    const end = new Date(start.getTime() + (7 * (WEEKS_AHEAD + 1)) * DAY_MS);
    const q = `start_date=${start.toISOString()}&end_date=${end.toISOString()}&per_page=100`;
    try {
      const planner = await apiAll(`/api/v1/planner/items?${q}`);
      if (planner.status === 401) {
        setStatus(settings.mode === 'session' ? 'signed-out' : 'error', settings.mode === 'session' ? '' : 'Canvas rejected the access token.');
        return;
      }
      if (planner.status !== 200) {
        setStatus('error', `Canvas answered ${planner.status || 'unexpectedly'}.`);
        return;
      }
      const items = planner.data
        .filter((i) => !['announcement', 'planner_note'].includes(i.plannable_type))
        .map(compactItem)
        .filter((i) => i.date);

      const [colors, courses] = await Promise.all([
        api('/api/v1/users/self/colors'),
        apiAll('/api/v1/courses?enrollment_state=active&per_page=100'),
      ]);
      const seen = new Map();
      for (const c of courses.status === 200 ? courses.data : []) {
        if (c.id && c.name) seen.set(c.id, { id: c.id, name: c.name, code: c.course_code ?? '' });
      }
      for (const i of items) {
        if (i.courseId && !seen.has(i.courseId)) seen.set(i.courseId, { id: i.courseId, name: i.course, code: '' });
      }
      cache = {
        items,
        courses: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
        colors: colors.status === 200 ? colors.data?.custom_colors ?? {} : cache.colors,
        updatedAt: Date.now(),
      };
      saveCache();
      setStatus('connected');
    } catch (e) {
      setStatus('error', 'Couldn\'t reach Canvas. Showing the last update.');
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (settings.enabled && settings.mode) refresh();
  }, REFRESH_MS);
}

/* ---------- State for the page ---------- */

function setStatus(next, message = '') {
  status = next;
  error = message;
  push();
}

function state() {
  const hidden = new Set(settings.hiddenCourses);
  const courses = cache.courses.map((c, i) => ({
    ...c,
    color: cache.colors[`course_${c.id}`] ?? PALETTE[i % PALETTE.length],
    hidden: hidden.has(c.id),
  }));
  return {
    enabled: settings.enabled,
    host: settings.host,
    mode: settings.mode,
    userName: settings.userName,
    status,
    error,
    updatedAt: cache.updatedAt,
    courses,
    items: cache.items,
    canStoreToken: safeStorage.isEncryptionAvailable(),
  };
}

function push() {
  if (win && !win.isDestroyed()) win.webContents.send('canvas:state', state());
}

/* ---------- Actions ---------- */

async function disconnect() {
  settings = { ...settings, mode: null, token: null, userName: '' };
  cache = { items: [], courses: [], colors: {}, updatedAt: 0 };
  saveSettings();
  saveCache();
  try {
    await canvasSession().clearStorageData();
  } catch {
    /* fine */
  }
  setStatus('disconnected');
}

const actions = {
  'canvas:get-state': () => state(),
  'canvas:set-enabled': (on) => {
    settings.enabled = Boolean(on);
    saveSettings();
    push();
    if (settings.enabled && settings.mode && Date.now() - cache.updatedAt > 5 * 60 * 1000) refresh();
  },
  'canvas:search-schools': (query) => searchSchools(query),
  'canvas:set-host': async (input) => {
    const host = await resolveHost(input);
    if (host !== settings.host) await disconnect();
    settings.host = host;
    saveSettings();
    push();
    return host;
  },
  'canvas:sign-in': () => {
    if (!settings.host) throw new Error('Set your school\'s Canvas address first.');
    openLogin();
  },
  'canvas:use-token': async (token) => {
    const clean = String(token ?? '').trim();
    if (!settings.host) throw new Error('Set your school\'s Canvas address first.');
    if (!clean) throw new Error('Paste the access token from Canvas.');
    const blob = encrypt(clean);
    if (!blob) throw new Error('This computer can\'t store the token securely. Use Sign in instead.');
    const before = { mode: settings.mode, token: settings.token };
    settings.mode = 'token';
    settings.token = blob;
    const me = await whoAmI().catch(() => null);
    if (!me) {
      Object.assign(settings, before);
      throw new Error('Canvas didn\'t accept that token.');
    }
    settings.userName = me.short_name || me.name || '';
    settings.enabled = true;
    saveSettings();
    setStatus('connected');
    refresh();
  },
  'canvas:refresh': () => refresh(),
  'canvas:disconnect': () => disconnect(),
  'canvas:set-course-hidden': (id, hidden) => {
    const set = new Set(settings.hiddenCourses);
    if (hidden) set.add(Number(id));
    else set.delete(Number(id));
    settings.hiddenCourses = [...set];
    saveSettings();
    push();
  },
  'canvas:open': (url) => {
    if (typeof url === 'string' && settings.host && url.startsWith(`https://${settings.host}/`)) shell.openExternal(url);
  },
};

/* ---------- Setup ---------- */

function init({ app: electronApp, window, ipcMain }) {
  app = electronApp;
  win = window;
  files = {
    settings: path.join(app.getPath('userData'), 'canvas.json'),
    cache: path.join(app.getPath('userData'), 'canvas-cache.json'),
  };
  settings = readJSON(files.settings, settings);
  cache = readJSON(files.cache, cache);
  if (settings.mode === 'token' && !decrypt(settings.token)) settings.mode = null; // encrypted on another account/machine
  status = settings.mode ? 'connected' : 'disconnected';

  const ours = (event) => win && !win.isDestroyed() && event.sender === win.webContents;
  for (const [channel, fn] of Object.entries(actions)) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!ours(event)) return null;
      return fn(...args);
    });
  }
  win.webContents.on('did-finish-load', push);
  win.on('focus', () => {
    if (settings.enabled && settings.mode && Date.now() - cache.updatedAt > REFRESH_MS) refresh();
  });
  if (settings.enabled && settings.mode) refresh();
  schedule();
}

module.exports = { init };
