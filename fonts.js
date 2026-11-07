// Fonts the user imports for writing (main process).
//
// A font can come from Google Fonts (by name, or a link to its page or stylesheet) or from a
// direct link to a font file. The files are downloaded once into the app's data folder, and
// the page loads them from there (as bytes, so the page's strict content policy stays as is).
'use strict';

const { net } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE = 6 * 1024 * 1024; // a font file bigger than this isn't a font we want
const MAX_FACES = 12; // Google Fonts splits a family into per-script files; this is plenty
const FONT_FILE = /\.(woff2?|ttf|otf)$/i;
// Google Fonts hands out woff2 files with unicode ranges to browsers it recognises
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let dir = '';
let indexFile = '';
let fonts = []; // [{ id, family, source, files: [{ file, weight, style, unicodeRange }] }]

/* ---------- Storage ---------- */

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(indexFile, 'utf8').replace(/^﻿/, ''));
    fonts = Array.isArray(list) ? list.filter((f) => f && typeof f.id === 'string' && typeof f.family === 'string' && Array.isArray(f.files)) : [];
  } catch {
    fonts = [];
  }
}

function save() {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(indexFile, JSON.stringify(fonts, null, 2));
}

const list = () => fonts.map(({ id, family, source }) => ({ id, family, source }));

/* ---------- Downloading ---------- */

function fetchBytes(url, maxBytes = MAX_FILE) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = net.request({ url, redirect: 'follow' });
    } catch {
      reject(new Error('That link doesn\'t look right.'));
      return;
    }
    req.setHeader('User-Agent', BROWSER_UA);
    const chunks = [];
    let size = 0;
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`The server answered ${res.statusCode} for that link.`));
        return;
      }
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new Error('That file is too big to be a font.'));
          req.abort();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => reject(new Error('The download broke off.')));
    });
    req.on('error', () => reject(new Error('Couldn\'t reach that link. Check it and your connection.')));
    req.end();
  });
}

// The @font-face blocks of a Google Fonts stylesheet
function parseFaces(css) {
  const faces = [];
  const block = /@font-face\s*{([^}]*)}/g;
  let m;
  while ((m = block.exec(css))) {
    const body = m[1];
    const prop = (name) => (body.match(new RegExp(`${name}\\s*:\\s*([^;]+);`)) || [])[1]?.trim() ?? '';
    const family = prop('font-family').replace(/^['"]|['"]$/g, '');
    const url = (prop('src').match(/url\(([^)]+)\)/) || [])[1]?.replace(/^['"]|['"]$/g, '');
    if (!family || !url) continue;
    faces.push({ family, weight: prop('font-weight') || '400', style: prop('font-style') || 'normal', unicodeRange: prop('unicode-range'), url });
  }
  return faces;
}

async function addGoogleFamily(family) {
  const name = family.trim().replace(/\s+/g, ' ');
  const existing = fonts.find((f) => f.family.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}&display=swap`;
  let css;
  try {
    css = (await fetchBytes(url, 512 * 1024)).toString('utf8');
  } catch {
    throw new Error(`Google Fonts doesn't have a font called "${name}".`);
  }
  const faces = parseFaces(css);
  if (!faces.length) throw new Error(`Google Fonts doesn't have a font called "${name}".`);
  // Latin first, so the files that matter are the ones kept if there are too many
  faces.sort((a, b) => Number(/U\+0000/i.test(b.unicodeRange)) - Number(/U\+0000/i.test(a.unicodeRange)));
  return storeFont(faces[0].family, 'google', faces.slice(0, MAX_FACES));
}

async function addFontFile(url) {
  const existing = fonts.find((f) => f.source === url);
  if (existing) return existing;
  const file = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'font');
  const family = file.replace(FONT_FILE, '').replace(/[-_+]+/g, ' ').replace(/\s*(regular|webfont)\s*$/i, '').trim() || 'Imported font';
  return storeFont(family, url, [{ family, weight: '400', style: 'normal', unicodeRange: '', url }]);
}

async function storeFont(family, source, faces) {
  const id = crypto.randomBytes(6).toString('hex');
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const [i, face] of faces.entries()) {
    const bytes = await fetchBytes(face.url);
    const ext = (face.url.match(FONT_FILE) || ['.woff2'])[0].toLowerCase();
    const file = `${id}-${i}${ext}`;
    fs.writeFileSync(path.join(dir, file), bytes);
    files.push({ file, weight: face.weight, style: face.style, unicodeRange: face.unicodeRange });
  }
  const entry = { id, family, source, files };
  fonts.push(entry);
  save();
  return entry;
}

/* ---------- What the page asks ---------- */

// A Google Fonts name, a Google Fonts page or stylesheet link, or a link to a font file
async function add(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new Error('Type a font name or paste a link.');
  if (!/^https?:\/\//i.test(text)) return addGoogleFamily(text);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('That link doesn\'t look right.');
  }
  if (url.hostname === 'fonts.google.com') {
    const m = url.pathname.match(/\/specimen\/([^/]+)/);
    if (!m) throw new Error('Paste the link of a font\'s own page on Google Fonts.');
    return addGoogleFamily(decodeURIComponent(m[1]).replace(/\+/g, ' '));
  }
  if (url.hostname === 'fonts.googleapis.com') {
    const family = url.searchParams.get('family');
    if (!family) throw new Error('That Google Fonts link doesn\'t name a font.');
    return addGoogleFamily(family.split(':')[0].replace(/\+/g, ' '));
  }
  if (FONT_FILE.test(url.pathname)) return addFontFile(url.href);
  throw new Error('Paste a link to a font file (.ttf, .otf, .woff, .woff2) or to a font on Google Fonts.');
}

function remove(id) {
  const entry = fonts.find((f) => f.id === id);
  if (!entry) return;
  for (const { file } of entry.files) {
    try { fs.unlinkSync(path.join(dir, file)); } catch { /* already gone */ }
  }
  fonts = fonts.filter((f) => f !== entry);
  save();
}

// The font's files as bytes, for the page to build FontFaces from
function data(id) {
  const entry = fonts.find((f) => f.id === id);
  if (!entry) throw new Error('That font is no longer here.');
  return entry.files.map(({ file, weight, style, unicodeRange }) => ({
    family: entry.family,
    weight,
    style,
    unicodeRange,
    bytes: fs.readFileSync(path.join(dir, file)),
  }));
}

function init({ app, ipcMain, window }) {
  dir = path.join(app.getPath('userData'), 'fonts');
  indexFile = path.join(dir, 'index.json');
  load();
  const ours = (event) => window && !window.isDestroyed() && event.sender === window.webContents;
  ipcMain.handle('fonts:list', (event) => (ours(event) ? list() : []));
  ipcMain.handle('fonts:add', async (event, input) => {
    if (!ours(event)) return null;
    const { id, family, source } = await add(input);
    return { id, family, source };
  });
  ipcMain.handle('fonts:remove', (event, id) => {
    if (ours(event)) remove(String(id));
  });
  ipcMain.handle('fonts:data', (event, id) => (ours(event) ? data(String(id)) : []));
}

module.exports = { init, add, remove, data, list, parseFaces };
