// Renders the README screenshots from the real app (docs/notepad-light.png, docs/notepad-dark.png).
// Run with: npm run screenshots
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs');
const PREFIX = 'kitchen-notepad:v1:';

// Sample pages so the shots aren't blank
const PAGES = {
  notes: 'Olive oil, lemons, parmesan\nAsk Sam about Saturday\nRenew library card',
  mon: 'Gym at 6\nReply to Priya',
  tue: 'Lab report draft',
  wed: 'Dentist 2:30\nPick up prescription',
  thu: 'Study group · library',
  fri: 'Clean the kitchen\nMovie night',
  sat: 'Farmers market',
  sun: 'Plan next week',
};

const BACKDROPS = {
  light: 'radial-gradient(120% 90% at 30% 20%, #f3e9d8 0%, #e6d6bd 55%, #d6c3a3 100%)',
  dark: 'radial-gradient(120% 90% at 30% 20%, #3a3f52 0%, #262a3a 55%, #181b26 100%)',
};

app.setPath('userData', path.join(os.tmpdir(), 'notepad-screenshots'));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 760,
    height: 900,
    show: false,
    frame: false,
    backgroundColor: '#ffffff',
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const load = () => win.loadFile(path.join(ROOT, 'index.html'), { query: { desktop: '1' } });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // The app saves every page's text when the window unloads, so the sample text has to be
  // typed into the pages (not just written to storage) before the reload that applies a shot's
  // theme and page.
  const fill = `
    ${Object.entries(PAGES).map(([id, text]) => `{ const t = document.querySelector('#page-${id} textarea'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); }`).join('\n')}
  `;

  const shots = [
    { name: 'light', theme: 'light', page: 'mon' },
    { name: 'dark', theme: 'dark', page: 'week' },
  ];
  await load();
  await js('localStorage.clear()');
  for (const shot of shots) {
    await js(`
      ${fill}
      localStorage.setItem(${JSON.stringify(PREFIX + 'prefs')}, JSON.stringify({ theme: ${JSON.stringify(shot.theme)}, font: 'hand', scale: 100 }));
      localStorage.setItem(${JSON.stringify(PREFIX + 'current')}, ${JSON.stringify(shot.page)});
    `);
    await load();
    await js(`document.body.style.background = ${JSON.stringify(BACKDROPS[shot.theme])}; document.fonts.ready`);
    await wait(900);
    if (process.env.DEBUG) {
      console.log('keys:', await js(`JSON.stringify(Object.keys(localStorage))`));
      console.log('mon textarea:', await js(`JSON.stringify(document.querySelector('#page-mon textarea')?.value)`));
    }
    const image = await win.webContents.capturePage();
    const file = path.join(OUT, `notepad-${shot.name}.png`);
    fs.writeFileSync(file, image.toPNG());
    console.log(`wrote ${path.relative(ROOT, file)} (${image.getSize().width}x${image.getSize().height})`);
  }
  app.exit(0);
});
