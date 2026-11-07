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

// Sample pages so the shots aren't blank: [text, done?]
const PAGES = {
  notes: [['Olive oil, lemons, parmesan'], ['Ask Sam about Saturday'], ['Renew library card', true]],
  mon: [['Reply to Priya'], ['Book dentist'], ['Gym at 6', true]],
  tue: [['Lab report draft']],
  wed: [['Dentist 2:30'], ['Pick up prescription']],
  thu: [['Study group · library']],
  fri: [['Clean the kitchen'], ['Movie night']],
  sat: [['Farmers market']],
  sun: [['Plan next week']],
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

  // Storage is written while the page is loaded (same origin), then the page is reloaded so the
  // app starts from it. The app only saves pages that changed, so the reload doesn't undo this.
  const seed = Object.entries(PAGES).map(([id, lines]) =>
    `localStorage.setItem(${JSON.stringify(`${PREFIX}page:${id}`)}, ${JSON.stringify(JSON.stringify({ items: lines.map(([t, d]) => ({ t, d: Boolean(d) })) }))});`).join('\n');

  const shots = [
    { name: 'light', theme: 'light', page: 'mon' },
    { name: 'dark', theme: 'dark', page: 'week' },
  ];
  await load();
  await js('localStorage.clear()');
  for (const shot of shots) {
    await js(`
      ${seed}
      localStorage.setItem(${JSON.stringify(`${PREFIX}prefs`)}, JSON.stringify({ theme: ${JSON.stringify(shot.theme)}, font: 'hand', scale: 100, marks: 'strike' }));
      localStorage.setItem(${JSON.stringify(`${PREFIX}current`)}, ${JSON.stringify(shot.page)});
    `);
    await load();
    await js(`document.body.style.background = ${JSON.stringify(BACKDROPS[shot.theme])}; document.fonts.ready`);
    await wait(900);
    const image = await win.webContents.capturePage();
    const file = path.join(OUT, `notepad-${shot.name}.png`);
    fs.writeFileSync(file, image.toPNG());
    console.log(`wrote ${path.relative(ROOT, file)} (${image.getSize().width}x${image.getSize().height})`);
  }
  app.exit(0);
});
