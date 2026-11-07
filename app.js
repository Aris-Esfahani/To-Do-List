/* Notepad — a top-bound pad whose sheets flip up and over the top */
(() => {
  'use strict';

  // Running inside the desktop app? (main.js loads the page with ?desktop=1)
  const isDesktop = new URLSearchParams(location.search).has('desktop');
  const root = document.documentElement;
  if (isDesktop) root.classList.add('is-desktop');

  // Kept from the app's first name so pages written before the rename still load.
  const STORAGE_PREFIX = 'kitchen-notepad:v1:';
  const store = {
    get(key) {
      try { return localStorage.getItem(STORAGE_PREFIX + key); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(STORAGE_PREFIX + key, value); } catch { /* storage unavailable: keep working in memory */ }
    },
    remove(key) {
      try { localStorage.removeItem(STORAGE_PREFIX + key); } catch { /* fine */ }
    },
  };
  const readJSON = (key, fallback) => {
    try {
      const raw = store.get(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  };

  // The page flip is the point of the desktop app, so it always plays there (Windows reports
  // "reduced motion" whenever its Animation effects setting is off). In a plain browser tab,
  // the reduced-motion preference is respected and pages switch instantly.
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const shouldAnimate = () => isDesktop || !reducedMotion.matches;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const uid = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  /* ---------- Preferences: appearance, writing font, list style ---------- */

  const FONTS = {
    hand: { label: 'Handwritten', family: 'var(--hand)', ratio: 0.82 },
    serif: { label: 'Serif', family: 'var(--serif)', ratio: 0.6 },
    sans: { label: 'Sans', family: '"Segoe UI", system-ui, sans-serif', ratio: 0.58 },
    mono: { label: 'Mono', family: '"Cascadia Mono", Consolas, monospace', ratio: 0.55 },
  };
  const THEMES = { system: 'System', light: 'Light', dark: 'Dark' };
  const MARKS = { strike: 'Cross out', checkbox: 'Checkboxes', numbered: 'Numbered' };
  const SCALE = { min: 70, max: 160, step: 10 };
  const DEFAULT_PREFS = { theme: 'system', font: 'hand', scale: 100, marks: 'strike', notesExpanded: true };

  let prefs = { ...DEFAULT_PREFS, ...readJSON('prefs', {}) };
  if (!FONTS[prefs.font]) prefs.font = DEFAULT_PREFS.font;
  if (!THEMES[prefs.theme]) prefs.theme = DEFAULT_PREFS.theme;
  if (!MARKS[prefs.marks]) prefs.marks = DEFAULT_PREFS.marks;
  prefs.scale = Math.min(SCALE.max, Math.max(SCALE.min, Number(prefs.scale) || 100));
  prefs.notesExpanded = prefs.notesExpanded !== false;

  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  function applyPrefs() {
    const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && systemDark.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.marks = prefs.marks;
    const font = FONTS[prefs.font];
    root.style.setProperty('--write-font', font.family);
    root.style.setProperty('--write-ratio', String(font.ratio));
    root.style.setProperty('--text-scale', String(prefs.scale / 100));
  }
  function setPrefs(patch) {
    prefs = { ...prefs, ...patch };
    store.set('prefs', JSON.stringify(prefs));
    applyPrefs();
  }
  systemDark.addEventListener('change', applyPrefs);
  applyPrefs();

  /* ---------- This week's dates (Monday first); re-checked so the pad stays current overnight ---------- */

  const addDays = (date, n) => {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  };
  const fmt = (options) => new Intl.DateTimeFormat(undefined, options);
  const shortDay = fmt({ weekday: 'short' });
  const longDay = fmt({ weekday: 'long' });
  const monthDay = fmt({ month: 'long', day: 'numeric' });
  const shortDate = fmt({ month: 'short', day: 'numeric' });
  const timeFmt = fmt({ hour: 'numeric', minute: '2-digit' });
  const DAY_IDS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  function computeWeek() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const offset = (today.getDay() + 6) % 7;
    const monday = addDays(today, -offset);
    const days = DAY_IDS.map((id, i) => {
      const date = addDays(monday, i);
      return { id, kind: 'day', date, isToday: i === offset, label: shortDay.format(date), title: longDay.format(date), sub: monthDay.format(date) };
    });
    const sunday = days[6].date;
    const range = typeof shortDate.formatRange === 'function'
      ? shortDate.formatRange(monday, sunday)
      : `${shortDate.format(monday)} – ${shortDate.format(sunday)}`;
    return { days, range, key: today.toDateString() };
  }
  let week = computeWeek();

  /* ---------- Note sections: the pages before the week overview ---------- */

  function loadSections() {
    const list = readJSON('sections', null);
    if (Array.isArray(list) && list.length && list.every((s) => s && typeof s.id === 'string' && typeof s.title === 'string')) {
      return list.map((s) => ({ id: s.id, title: s.title }));
    }
    return [{ id: 'notes', title: 'Notes' }];
  }
  let sections = loadSections();
  const saveSections = () => store.set('sections', JSON.stringify(sections));

  /* ---------- What's written on a page: lines, each possibly crossed out ---------- */

  function loadItems(id) {
    const raw = store.get(`page:${id}`);
    if (!raw) return [];
    if (raw[0] === '{') {
      try {
        const data = JSON.parse(raw);
        if (Array.isArray(data.items)) return data.items.filter((i) => i && typeof i.t === 'string').map((i) => ({ t: i.t, d: Boolean(i.d) }));
      } catch { /* fall through */ }
    }
    return raw.split('\n').map((t) => ({ t, d: false })); // pages from before lines could be crossed out
  }
  const storeItems = (id, items) => store.set(`page:${id}`, JSON.stringify({ items }));

  /* ---------- Pages and tabs ---------- */

  const tablist = document.querySelector('.tabs');
  const pad = document.querySelector('.pad');
  const padShade = pad.querySelector('.pad-shade');

  let pages = []; // stack order, top sheet first
  let current = 0;
  let busy = false;
  let queued = null;
  let groupTab = null;
  let canvasUI = null; // set up below when the desktop bridge exists

  const restingZ = (i) => 10 + (pages.length - i); // under the window buttons (z 45)
  const liftedZ = (i) => 60 + (pages.length - i); // over everything while flipping
  const pageById = (id) => pages.find((p) => p.id === id);
  const pageOf = (node) => pages.find((p) => p.el.contains(node));

  const ICON = {
    pencil: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.5 2.5l2 2L5 13H3v-2z"/></svg>',
    crumple: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l3 1 2-2 2 3 3-1-1 3 2 2-3 2 1 3-3-1-2 2-2-3-3 1 1-3-2-2 3-2z"/></svg>',
  };

  const weekHTML = () => `
    <ol class="week">
      ${week.days.map((d) => `
        <li>
          <button type="button" class="week-day${d.isToday ? ' is-today' : ''}" data-go="${d.id}">
            <span class="week-date">
              <span class="wd-name">${esc(d.label)}</span>
              <span class="wd-num">${d.date.getDate()}</span>
            </span>
            <span class="wd-body">
              <span class="wd-due" data-due="${d.id}"></span>
              <span class="wd-preview" data-preview="${d.id}"></span>
            </span>
          </button>
        </li>`).join('')}
    </ol>`;

  // (Re)creates every sheet and tab from storage. Called at start, and whenever the sections
  // or the date change.
  function build(selectId) {
    saveDirty();
    for (const p of pages) p.el.remove();
    pages = [
      ...sections.map((s, i) => ({ id: s.id, kind: 'notes', label: s.title, title: s.title, sub: 'Notes', first: i === 0 })),
      { id: 'week', kind: 'week', label: 'Week', title: 'This Week', sub: week.range },
      ...week.days.map((d) => ({ ...d })),
    ];
    pages.forEach((p, i) => { p.index = i; });

    const frag = document.createDocumentFragment();
    for (const p of pages) {
      const page = document.createElement('section');
      page.className = `page page--${p.kind}`;
      page.id = `page-${p.id}`;
      page.setAttribute('role', 'tabpanel');
      page.style.zIndex = restingZ(p.index);
      const sub = p.kind === 'notes'
        ? `<button type="button" class="sub-btn" data-rename>${ICON.pencil}Rename</button><button type="button" class="sub-btn" data-crumple>${ICON.crumple}Crumple</button>`
        : `<span>${esc(p.sub)}</span>${p.isToday ? '<span class="stamp">Today</span>' : ''}`;
      page.innerHTML = `
        <div class="face face--front">
          <div class="drag-strip" aria-hidden="true"></div>
          <header class="page-head">
            <h2 class="page-title"${p.kind === 'notes' ? ' title="Double-click to rename"' : ''}>${esc(p.title)}</h2>
            <p class="page-sub">${sub}</p>
          </header>
          ${p.kind === 'week' ? weekHTML() : `${p.kind === 'day' ? '<div class="due" hidden></div>' : ''}<div class="lines"></div>`}
          ${p.index < pages.length - 1 ? '<button type="button" class="corner" tabindex="-1" aria-label="Next page"></button>' : ''}
          <div class="face-shade"></div>
        </div>
        <div class="face face--back"><div class="face-shade"></div></div>`;
      frag.append(page);
      Object.assign(p, {
        el: page,
        front: page.querySelector('.face--front'),
        back: page.querySelector('.face--back'),
        shades: page.querySelectorAll('.face-shade'),
        lines: page.querySelector('.lines'),
        dirty: false,
      });
      if (p.lines) mountLines(p, loadItems(p.id));
    }
    pad.insertBefore(frag, padShade);
    for (const p of pages) updatePreview(p);

    const idx = pages.findIndex((p) => p.id === selectId);
    current = idx >= 0 ? idx : 0;
    renderTabs();
    settle();
    canvasUI?.render();
  }

  // Index tabs: the Notes group (one tab, or expanded into a tab per notes page), a "+" tab to
  // add a page, then Week and the days. Only the left part of a tab shows (the rest is under
  // the pad), so the group's chevron sits on the left, before its label.
  function renderTabs() {
    tablist.innerHTML = '';
    const multi = sections.length > 1;
    const expanded = multi && prefs.notesExpanded;

    groupTab = document.createElement('div');
    groupTab.className = 'tab tab--group';
    groupTab.setAttribute('role', 'tab');
    groupTab.tabIndex = -1;
    groupTab.style.setProperty('--tab-color', 'var(--tab-notes)');
    const chevTitle = expanded ? 'Collapse the notes pages' : 'Show the notes pages';
    groupTab.innerHTML = `${multi ? `<button type="button" class="tab-chev" title="${chevTitle}" aria-label="${chevTitle}">${expanded ? '▾' : '▸'}</button>` : ''}<span class="tab-label">Notes</span>`;
    groupTab.addEventListener('click', (e) => {
      if (e.target.closest('.tab-chev')) {
        setPrefs({ notesExpanded: !prefs.notesExpanded });
        renderTabs();
        return;
      }
      const cur = pages[current];
      goTo(cur.kind === 'notes' ? cur.index : 0);
    });
    groupTab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        goTo(pages[current].kind === 'notes' ? current : 0);
      }
    });
    tablist.append(groupTab);

    for (const p of pages) {
      if (p.kind === 'notes') {
        p.tab = null;
        if (!expanded) continue;
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'tab tab--sub';
        tab.id = `tab-${p.id}`;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', `page-${p.id}`);
        tab.style.setProperty('--tab-color', `var(--tab-sub-${p.index % 3})`);
        tab.innerHTML = `<span class="tab-label">${esc(p.label)}</span>`;
        tab.addEventListener('click', () => goTo(p.index));
        tablist.append(tab);
        p.tab = tab;
        continue;
      }
      if (p.kind === 'week') {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'tab tab--add';
        add.title = 'Add a notes page';
        add.setAttribute('aria-label', 'Add a notes page');
        add.innerHTML = '<span class="tab-label">+</span>';
        add.addEventListener('click', addSection);
        tablist.append(add);
      }
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = `tab${p.kind === 'week' ? ' tab--week' : ''}${p.isToday ? ' is-today' : ''}`;
      tab.id = `tab-${p.id}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `page-${p.id}`);
      tab.style.setProperty('--tab-color', `var(--tab-${p.id})`);
      tab.innerHTML = `<span class="tab-label">${esc(p.label)}</span>${p.isToday ? '<span class="sr-only">, today</span>' : ''}`;
      tab.addEventListener('click', () => goTo(p.index));
      tablist.append(tab);
      p.tab = tab;
    }
    updateTabState(current);
  }

  function updateTabState(index) {
    const target = pages[index];
    const expanded = sections.length > 1 && prefs.notesExpanded;
    for (const t of tablist.querySelectorAll('[role="tab"]')) {
      t.classList.remove('is-active');
      t.setAttribute('aria-selected', 'false');
      t.tabIndex = -1;
    }
    const tab = target.kind === 'notes' ? (target.tab ?? groupTab) : target.tab;
    tab.classList.add('is-active');
    tab.setAttribute('aria-selected', 'true');
    tab.tabIndex = 0;
    if (target.kind === 'notes') groupTab.classList.add('is-active');
    groupTab.querySelector('.tab-label').textContent = sections.length > 1 && !expanded && target.kind === 'notes' ? target.title : 'Notes';
    groupTab.setAttribute('aria-controls', `page-${target.kind === 'notes' ? target.id : sections[0].id}`);
  }

  tablist.addEventListener('keydown', (e) => {
    const tabs = [...tablist.querySelectorAll('[role="tab"]')];
    const from = tabs.indexOf(document.activeElement);
    if (from < 0) return;
    let to = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') to = Math.min(tabs.length - 1, from + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') to = Math.max(0, from - 1);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = tabs.length - 1;
    if (to === null) return;
    e.preventDefault();
    tabs[to].focus();
    tabs[to].click();
  });

  /* ---------- Flipping ---------- */

  // Put every sheet in its resting place for the current page, ready to write on.
  function settle() {
    for (const p of pages) {
      p.el.classList.toggle('is-flipped', p.index < current);
      p.el.inert = p.index !== current;
    }
    updateTabState(current);
    store.set('current', pages[current].id);
    focusEditor(pages[current]);
  }

  const DURATION = 640;
  const ROTATE = 'perspective(4500px) rotateX(';

  // One sheet lifting up toward you and tipping over the top (or coming back down when `up` is false).
  // It fades out as it goes edge-on, so it never swings past the top of the (transparent) window.
  function flip(p, up, timing) {
    const lo = restingZ(p.index);
    const hi = liftedZ(p.index);
    const orient = (frames) => (up ? frames : frames.map((f) => ({ ...f, offset: 1 - f.offset })).reverse());

    const turn = orient([
      { offset: 0, transform: `${ROTATE}0deg)`, zIndex: lo },
      { offset: 0.1, transform: `${ROTATE}12deg)`, zIndex: lo },
      { offset: 0.11, transform: `${ROTATE}13deg)`, zIndex: hi },
      { offset: 1, transform: `${ROTATE}100deg)`, zIndex: hi },
    ]);
    const fade = orient([
      { offset: 0, opacity: 1 },
      { offset: 0.72, opacity: 1 },
      { offset: 0.96, opacity: 0 },
      { offset: 1, opacity: 0 },
    ]);
    const frontShade = orient([
      { offset: 0, opacity: 0 },
      { offset: 0.9, opacity: 0.65 },
      { offset: 1, opacity: 0.65 },
    ]);
    const backShade = orient([
      { offset: 0, opacity: 0.6 },
      { offset: 1, opacity: 0.6 },
    ]);

    const [frontShadeEl, backShadeEl] = p.shades;
    return [
      p.el.animate(turn, timing),
      p.front.animate(fade, timing),
      p.back.animate(fade, timing),
      frontShadeEl.animate(frontShade, timing),
      backShadeEl.animate(backShade, timing),
    ];
  }

  function goTo(target) {
    if (target < 0 || target >= pages.length) return;
    if (busy) {
      queued = target;
      updateTabState(target);
      return;
    }
    if (target === current) return;
    if (!shouldAnimate()) {
      current = target;
      settle();
      return;
    }

    busy = true;
    updateTabState(target);

    const up = target > current;
    const order = [];
    if (up) for (let i = current; i < target; i++) order.push(i);
    else for (let i = current - 1; i >= target; i--) order.push(i);

    const stagger = Math.min(120, 600 / order.length);
    const easing = up ? 'cubic-bezier(.45, .05, .3, 1)' : 'cubic-bezier(.3, .05, .25, 1)';
    const animations = [];

    order.forEach((i, k) => {
      const p = pages[i];
      p.el.inert = true;
      p.el.classList.remove('is-flipped');
      animations.push(...flip(p, up, { duration: DURATION, delay: k * stagger, easing, fill: 'both' }));
    });

    const total = DURATION + stagger * (order.length - 1);
    animations.push(padShade.animate(
      [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0.7, offset: 0.75 }, { opacity: 0 }],
      { duration: total, easing: 'ease-in-out' },
    ));

    Promise.allSettled(animations.map((a) => a.finished)).then(() => {
      current = target;
      settle();
      animations.forEach((a) => a.cancel());
      busy = false;
      if (queued !== null) {
        const next = queued;
        queued = null;
        goTo(next);
      }
    });
  }

  /* ---------- Writing: one editable line per item; crossed-out lines sink to the bottom ---------- */

  function makeLine(text, done, p) {
    const line = document.createElement('div');
    line.className = 'line';
    line.dataset.done = String(Boolean(done));
    line.innerHTML = `<span class="gutter"><button type="button" class="mark" tabindex="-1" aria-label="${done ? 'Un-cross this line' : 'Cross this line out'}"></button></span><div class="text" contenteditable="plaintext-only" spellcheck="true"${p.first ? ' data-placeholder="Jot anything down…"' : ''}></div>`;
    line.querySelector('.text').textContent = text;
    return line;
  }

  // Puts the caret where writing would naturally continue: the end of the last line still to
  // do, or a fresh line if that one already has text (or if only crossed-out lines are left).
  function focusEditor(p, force = false) {
    if (!p?.lines) return;
    const active = [...p.lines.children].filter((l) => l.dataset.done !== 'true');
    let target = active[active.length - 1] ?? null;
    if (!target || (force && textOf(target).textContent)) {
      target = makeLine('', false, p);
      p.lines.insertBefore(target, firstDone(p.lines));
    }
    setCaret(textOf(target), textOf(target).textContent.length);
  }

  function mountLines(p, items) {
    const list = items.length ? items : [{ t: '', d: false }];
    const ordered = [...list.filter((i) => !i.d), ...list.filter((i) => i.d)];
    p.lines.replaceChildren(...ordered.map((i) => makeLine(i.t, i.d, p)));
  }

  const textOf = (line) => line.querySelector('.text');
  const itemsOf = (p) => [...p.lines.children].map((l) => ({ t: textOf(l).textContent, d: l.dataset.done === 'true' }));

  const saveTimers = new Map();
  function savePage(p) {
    if (!p.lines) return;
    clearTimeout(saveTimers.get(p));
    const items = itemsOf(p);
    // Empty lines left at the end of the to-do part (and the end of the page) aren't notes
    const done = items.filter((i) => i.d);
    let active = items.filter((i) => !i.d);
    while (active.length && !active[active.length - 1].t) active.pop();
    storeItems(p.id, [...active, ...done]);
    p.dirty = false;
    updatePreview(p);
  }
  function scheduleSave(p) {
    p.dirty = true;
    clearTimeout(saveTimers.get(p));
    saveTimers.set(p, setTimeout(() => savePage(p), 300));
  }
  function saveDirty() {
    for (const p of pages) if (p.dirty) savePage(p);
  }
  window.addEventListener('pagehide', saveDirty);

  function updatePreview(p) {
    if (p.kind !== 'day') return;
    const el = pad.querySelector(`[data-preview="${p.id}"]`);
    if (el) el.textContent = itemsOf(p).filter((i) => !i.d && i.t.trim()).map((i) => i.t.trim()).join(' · ');
  }

  // Caret position inside a line's text, as a character offset
  function caretOffset(el) {
    const sel = document.getSelection();
    if (!sel?.rangeCount || !el.contains(sel.anchorNode)) return el.textContent.length;
    const range = sel.getRangeAt(0);
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
  }

  function setCaret(el, offset) {
    el.focus();
    const sel = document.getSelection();
    const range = document.createRange();
    let remaining = Math.max(0, Math.min(offset, el.textContent.length));
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (remaining <= node.length) {
        range.setStart(node, remaining);
        break;
      }
      remaining -= node.length;
      node = walker.nextNode();
    }
    if (!node) range.setStart(el, el.childNodes.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Moves a line to a new place in its list, sliding the lines in between out of the way
  function moveLine(container, line, before) {
    if ((before === null && container.lastElementChild === line) || (before && line.nextElementSibling === before) || before === line) return;
    const kids = [...container.children];
    const tops = new Map(kids.map((l) => [l, l.getBoundingClientRect().top]));
    container.insertBefore(line, before);
    if (!shouldAnimate()) return;
    for (const l of kids) {
      const dy = tops.get(l) - l.getBoundingClientRect().top;
      if (dy) l.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.3, .7, .3, 1)' });
    }
  }

  const firstDone = (container, except) => [...container.querySelectorAll('.line[data-done="true"]')].find((l) => l !== except) ?? null;

  function toggleDone(line) {
    const p = pageOf(line);
    if (!p) return;
    const done = line.dataset.done !== 'true';
    line.dataset.done = String(done);
    line.querySelector('.mark').setAttribute('aria-label', done ? 'Un-cross this line' : 'Cross this line out');
    if (done) moveLine(p.lines, line, null); // crossed out: down to the bottom
    else moveLine(p.lines, line, firstDone(p.lines, line)); // back up, after the lines still to do
    scheduleSave(p);
  }

  pad.addEventListener('mousedown', (e) => {
    const lines = e.target.closest('.lines');
    if (!lines || e.target.closest('.mark')) return;
    const gutter = e.target.closest('.gutter');
    if (gutter) {
      // The margin beside a line: put the caret at the start of that line
      e.preventDefault();
      setCaret(textOf(gutter.closest('.line')), 0);
      return;
    }
    if (e.target.closest('.line')) return;
    e.preventDefault(); // clicked the empty paper below the last line: start writing there
    focusEditor(pageOf(lines), true);
  });

  pad.addEventListener('input', (e) => {
    const text = e.target.closest?.('.text');
    if (!text) return;
    if (!text.textContent) text.innerHTML = ''; // Chromium leaves a <br> behind; keep the placeholder working
    scheduleSave(pageOf(text));
  });

  pad.addEventListener('focusout', (e) => {
    const text = e.target.closest?.('.text');
    const p = text && pageOf(text);
    if (p?.dirty) savePage(p);
  });

  pad.addEventListener('keydown', (e) => {
    const text = e.target.closest?.('.text');
    if (!text) return;
    const line = text.closest('.line');
    const p = pageOf(text);
    const sel = document.getSelection();

    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        toggleDone(line);
        return;
      }
      const pos = caretOffset(text);
      const full = text.textContent;
      text.textContent = full.slice(0, pos);
      const next = makeLine(full.slice(pos), false, p);
      line.after(next);
      if (line.dataset.done === 'true') moveLine(p.lines, next, firstDone(p.lines, next)); // new lines are things to do
      setCaret(textOf(next), 0);
      scheduleSave(p);
      return;
    }
    if (e.key === 'Backspace' && sel.isCollapsed && caretOffset(text) === 0) {
      const prev = line.previousElementSibling;
      if (!prev) return;
      e.preventDefault();
      const ptext = textOf(prev);
      const at = ptext.textContent.length;
      ptext.textContent += text.textContent;
      line.remove();
      setCaret(ptext, at);
      scheduleSave(p);
      return;
    }
    if (e.key === 'Delete' && sel.isCollapsed && caretOffset(text) === text.textContent.length) {
      const next = line.nextElementSibling;
      if (!next) return;
      e.preventDefault();
      const at = text.textContent.length;
      text.textContent += textOf(next).textContent;
      next.remove();
      setCaret(text, at);
      scheduleSave(p);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const sibling = e.key === 'ArrowUp' ? line.previousElementSibling : line.nextElementSibling;
      if (!sibling) return;
      e.preventDefault();
      setCaret(textOf(sibling), caretOffset(text));
      return;
    }
    if (e.key === 'Tab') e.preventDefault();
  });

  pad.addEventListener('paste', (e) => {
    const text = e.target.closest?.('.text');
    if (!text) return;
    e.preventDefault();
    const parts = (e.clipboardData.getData('text/plain') || '').replace(/\r/g, '').split('\n');
    const p = pageOf(text);
    if (parts.length === 1) {
      document.execCommand('insertText', false, parts[0]);
      return;
    }
    // Several lines: the first joins this line, the rest become lines below it
    const pos = caretOffset(text);
    const full = text.textContent;
    text.textContent = full.slice(0, pos) + parts[0];
    let after = text.closest('.line');
    for (const part of parts.slice(1, -1)) {
      const nl = makeLine(part, false, p);
      after.after(nl);
      after = nl;
    }
    const last = makeLine(parts[parts.length - 1] + full.slice(pos), false, p);
    after.after(last);
    setCaret(textOf(last), parts[parts.length - 1].length);
    scheduleSave(p);
  });

  /* ---------- Sections: add, rename, crumple ---------- */

  function addSection() {
    saveDirty();
    const id = uid();
    sections.push({ id, title: `Notes ${sections.length + 1}` });
    saveSections();
    if (!prefs.notesExpanded) setPrefs({ notesExpanded: true });
    build(id);
    startRename(pages[current]);
  }

  function startRename(p) {
    const h = p.el.querySelector('.page-title');
    if (p.kind !== 'notes' || h.isContentEditable) return;
    const before = p.title;
    let cancelled = false;
    h.contentEditable = 'plaintext-only';
    h.spellcheck = false;
    h.classList.add('is-editing');
    h.focus();
    document.getSelection()?.selectAllChildren(h);
    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        h.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelled = true;
        h.blur();
      }
    };
    h.addEventListener('keydown', onKey);
    h.addEventListener('blur', () => {
      h.removeEventListener('keydown', onKey);
      h.contentEditable = 'false';
      h.classList.remove('is-editing');
      const title = cancelled ? before : (h.textContent.replace(/\s+/g, ' ').trim().slice(0, 28) || before);
      h.textContent = title;
      if (title !== before) {
        p.title = title;
        p.label = title;
        const s = sections.find((x) => x.id === p.id);
        if (s) s.title = title;
        saveSections();
        renderTabs();
      }
    }, { once: true });
  }

  function askCrumple(p) {
    const sub = p.el.querySelector('.page-sub');
    p.subHTML ??= sub.innerHTML;
    sub.innerHTML = `<span class="sub-ask">${sections.length > 1 ? 'Crumple this page?' : 'Crumple it and start fresh?'}</span><button type="button" class="sub-btn sub-btn--danger" data-crumple-yes>Crumple</button><button type="button" class="sub-btn" data-crumple-no>Keep</button>`;
  }

  function restoreSub(p) {
    if (p.subHTML) p.el.querySelector('.page-sub').innerHTML = p.subHTML;
  }

  // The crumple: the sheet lifts, scrunches into a jagged ball (its outline is clipped to a
  // crumpled shape while creases fade in), then drops off the bottom of the pad.
  const RECT = [[0, 0], [25, 0], [50, 0], [75, 0], [100, 0], [100, 25], [100, 50], [100, 75], [100, 100], [75, 100], [50, 100], [25, 100], [0, 100], [0, 75], [0, 50], [0, 25]];
  const BALL = [[8, 6], [28, 2], [52, 9], [74, 1], [94, 10], [100, 30], [92, 52], [99, 74], [90, 96], [72, 100], [50, 91], [27, 99], [6, 94], [0, 72], [9, 50], [2, 27]];
  const poly = (points) => `polygon(${points.map(([x, y]) => `${x}% ${y}%`).join(', ')})`;

  // Balls the page up and drops it, then removes the section (or wipes it clean if it's the last one)
  async function crumple(p) {
    if (p.crumpling) return;
    p.crumpling = true;
    clearTimeout(saveTimers.get(p));
    p.dirty = false; // its notes are going; don't save them on the way out

    if (shouldAnimate()) {
      const el = p.el;
      el.style.zIndex = liftedZ(p.index);
      el.style.transformOrigin = '50% 55%';
      const creases = document.createElement('div');
      creases.className = 'creases';
      p.front.append(creases);
      const DUR = 1150;
      creases.animate([{ opacity: 0 }, { opacity: 0, offset: 0.22 }, { opacity: 1, offset: 0.55 }, { opacity: 1 }], { duration: DUR, fill: 'forwards' });
      const fall = el.animate([
        { offset: 0, transform: 'none', clipPath: poly(RECT), opacity: 1 },
        { offset: 0.2, transform: 'translateY(-1.5%) scale(1.02) rotate(-1deg)', clipPath: poly(RECT), opacity: 1 },
        { offset: 0.55, transform: 'scale(0.42, 0.5) rotate(7deg)', clipPath: poly(BALL), opacity: 1 },
        { offset: 0.7, transform: 'scale(0.36, 0.42) rotate(-5deg) translateY(6%)', clipPath: poly(BALL), opacity: 1 },
        { offset: 1, transform: 'scale(0.3, 0.34) rotate(35deg) translateY(190%)', clipPath: poly(BALL), opacity: 0 },
      ], { duration: DUR, easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' });
      await fall.finished.catch(() => {});
    }

    const i = sections.findIndex((s) => s.id === p.id);
    store.remove(`page:${p.id}`);
    let nextId;
    if (sections.length === 1) {
      sections[0].title = 'Notes';
      nextId = sections[0].id;
    } else {
      sections.splice(i, 1);
      nextId = sections[Math.min(i, sections.length - 1)].id;
    }
    saveSections();
    build(nextId);
  }

  pad.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) {
      const p = pageById(go.dataset.go);
      if (p) goTo(p.index);
      return;
    }
    if (e.target.closest('.corner')) {
      goTo(current + 1);
      return;
    }
    const mark = e.target.closest('.mark');
    if (mark) {
      toggleDone(mark.closest('.line'));
      return;
    }
    const p = pageOf(e.target);
    if (!p) return;
    if (e.target.closest('[data-rename]')) startRename(p);
    else if (e.target.closest('[data-crumple]')) askCrumple(p);
    else if (e.target.closest('[data-crumple-yes]')) crumple(p);
    else if (e.target.closest('[data-crumple-no]')) restoreSub(p);
  });

  // (In the browser the title can be double-clicked to rename; in the desktop app the title is
  // a drag handle and the Rename button does it.)
  pad.addEventListener('dblclick', (e) => {
    const title = e.target.closest('.page-title');
    const p = title && pageOf(title);
    if (p?.kind === 'notes' && !title.isContentEditable) startRename(p);
  });

  // While a card (settings, Canvas) is open, the header stops being a drag handle so the card's
  // buttons over it can be clicked (see styles.css).
  const cards = document.querySelectorAll('.card');
  const syncCards = () => root.classList.toggle('has-card', [...cards].some((c) => !c.hidden));
  const cardWatcher = new MutationObserver(syncCards);
  for (const card of cards) cardWatcher.observe(card, { attributes: true, attributeFilter: ['hidden'] });
  syncCards();

  /* ---------- Keep the dates right: the app lives in the tray for days at a time ---------- */

  function checkDate() {
    const next = computeWeek();
    if (next.key === week.key) return;
    week = next;
    build(pages[current]?.id);
  }
  setInterval(checkDate, 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkDate();
  });
  window.addEventListener('focus', checkDate);

  build(store.get('current') ?? sections[0].id);

  /* ---------- Desktop window: buttons, click-through, resize grip ---------- */

  const bridge = isDesktop ? window.notepad : null;
  const desktop = { pinned: false, onTop: false };

  if (bridge) {
    document.querySelector('.win-controls').addEventListener('click', (e) => {
      const button = e.target.closest('[data-win]');
      if (button) bridge.window(button.dataset.win);
    });

    // Clicks on the empty, transparent space around the pad fall through to the desktop. The
    // window turns solid as soon as the pointer comes near the pad or the tabs (not only once
    // it's over them), so a quick press right after arriving can't slip through.
    const clipboard = document.querySelector('.clipboard');
    const MARGIN = 12;
    const near = (r, x, y) => x >= r.left - MARGIN && x <= r.right + MARGIN && y >= r.top - MARGIN && y <= r.bottom + MARGIN;
    let passThrough = null;
    const setPassThrough = (on) => {
      if (on === passThrough) return;
      passThrough = on;
      bridge.setPassThrough(on);
    };
    document.addEventListener('mousemove', (e) => {
      const inside = e.target.closest?.('.clipboard') || near(clipboard.getBoundingClientRect(), e.clientX, e.clientY) || near(tablist.getBoundingClientRect(), e.clientX, e.clientY);
      setPassThrough(!inside);
    }, { passive: true });
    // A press reached the page, so the window can't be ignoring the mouse; keep the two in step
    document.addEventListener('pointerdown', () => setPassThrough(false), true);
    // The desktop side also turns click-through off by itself when it sees the cursor over the
    // pad (a safety net for when forwarded mouse moves don't arrive); it tells the page so.
    bridge.onPassThrough((on) => { passThrough = on; });
    setPassThrough(true);

    const pinButton = document.querySelector('[data-pin]');
    pinButton.addEventListener('click', () => bridge.setPinned(!desktop.pinned));
    bridge.onState((state) => {
      desktop.pinned = Boolean(state.pinned);
      desktop.onTop = Boolean(state.onTop);
      root.classList.toggle('is-pinned', desktop.pinned);
      pinButton.setAttribute('aria-pressed', String(desktop.pinned));
      pinButton.title = desktop.pinned ? 'Unpin (let it move again)' : 'Pin in place, in front of other apps';
      pinButton.setAttribute('aria-label', pinButton.title);
      settingsUI.render();
    });

    const grip = document.querySelector('.resize-grip');
    const endResize = () => bridge.resize('end');
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || desktop.pinned) return;
      grip.setPointerCapture(e.pointerId);
      bridge.resize('start');
    });
    grip.addEventListener('pointerup', endResize);
    grip.addEventListener('lostpointercapture', endResize);

    // Drag the tabs or the week rows to move the notepad. (The title area is dragged natively
    // by Windows, via CSS.) A press only becomes a move after the pointer travels a few pixels,
    // so clicks on the tabs and the week's days still work as clicks. Once it is a move, the
    // window is handed to Windows, which drags it itself until the button is released; if that
    // isn't possible, the page drives the move from its own pointer events, once per frame.
    const DRAG_FROM = '.tabs, .week';
    const NOT_FROM = '.tab-chev, .tab--add';
    const MOVE_THRESHOLD = 4;
    let press = null;
    let justMoved = false;
    let frame = 0;
    const sendMove = () => {
      frame = 0;
      if (press?.moving === 'self') bridge.moveBy(press.dx, press.dy);
    };
    // Back to normal: no grabbing cursor, and the click that ends a drag isn't a click
    const finish = () => {
      if (!root.classList.contains('is-moving')) return;
      root.classList.remove('is-moving');
      justMoved = true;
      setTimeout(() => { justMoved = false; }, 0);
    };
    const endMove = () => {
      if (!press) return;
      if (press.moving === 'self') {
        cancelAnimationFrame(frame);
        frame = 0;
        bridge.moveBy(press.dx, press.dy);
        bridge.move('end');
      }
      finish();
      press = null;
    };
    bridge.onMoved(finish);
    document.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || desktop.pinned) return;
      if (!e.target.closest(DRAG_FROM) || e.target.closest(NOT_FROM)) return;
      press = { x: e.screenX, y: e.screenY, dx: 0, dy: 0, moving: false, target: e.target, id: e.pointerId };
    });
    document.addEventListener('pointermove', (e) => {
      // Windows eats the button release when it has moved the window itself, so the first
      // buttonless move afterwards is the sign that the drag is over
      if (e.buttons === 0 && (press?.moving === 'native' || root.classList.contains('is-moving'))) {
        finish();
        press = null;
        return;
      }
      if (!press) return;
      press.dx = e.screenX - press.x;
      press.dy = e.screenY - press.y;
      if (!press.moving) {
        if (Math.hypot(press.dx, press.dy) < MOVE_THRESHOLD) return;
        press.moving = 'pending';
        root.classList.add('is-moving');
        const p = press;
        bridge.dragWindow().then((native) => {
          if (p !== press) return; // the press ended before the answer came back
          if (native) {
            press.moving = 'native';
            return;
          }
          press.moving = 'self';
          try { press.target.setPointerCapture(press.id); } catch { /* fine without it */ }
          bridge.move('start');
          bridge.moveBy(press.dx, press.dy);
        });
        return;
      }
      if (press.moving === 'self' && !frame) frame = requestAnimationFrame(sendMove);
    });
    document.addEventListener('pointerup', endMove);
    document.addEventListener('pointercancel', endMove);
    window.addEventListener('blur', endMove);
    // A drag that started on a tab or the week overview shouldn't also count as a click
    document.addEventListener('click', (e) => {
      if (justMoved) e.stopPropagation();
    }, true);

    canvasUI = setupCanvas(bridge.canvas);
  }

  const settingsUI = setupSettings();

  /* ---------- Settings card ---------- */

  function setupSettings() {
    const panel = document.querySelector('.settings-panel');
    const body = panel.querySelector('.cp-body');
    const seg = (name, options, value) =>
      `<span class="cp-seg" role="group">${Object.entries(options).map(([k, label]) =>
        `<button type="button" data-set="${name}" data-value="${k}" aria-pressed="${k === value}">${esc(label)}</button>`).join('')}</span>`;

    function render() {
      if (panel.hidden) return;
      const fonts = Object.fromEntries(Object.entries(FONTS).map(([k, f]) => [k, f.label]));
      body.innerHTML = `
        <div class="cp-setting">
          <span class="cp-label">Appearance</span>
          ${seg('theme', THEMES, prefs.theme)}
        </div>
        <div class="cp-setting">
          <span class="cp-label">Writing font</span>
          ${seg('font', fonts, prefs.font)}
        </div>
        <div class="cp-setting">
          <span class="cp-label">Text size</span>
          <span class="cp-stepper">
            <button type="button" class="cp-btn" data-step="-1" aria-label="Smaller" ${prefs.scale <= SCALE.min ? 'disabled' : ''}>−</button>
            <output>${prefs.scale}%</output>
            <button type="button" class="cp-btn" data-step="1" aria-label="Larger" ${prefs.scale >= SCALE.max ? 'disabled' : ''}>+</button>
          </span>
        </div>
        <div class="cp-setting">
          <span class="cp-label">List style</span>
          ${seg('marks', MARKS, prefs.marks)}
        </div>
        ${bridge ? `
        <div class="cp-setting">
          <span class="cp-label">Keep in front of other apps</span>
          ${seg('onTop', { off: 'Off', on: 'On' }, desktop.onTop ? 'on' : 'off')}
        </div>` : ''}
        <div class="cp-setting">
          <span class="cp-label">Canvas assignments</span>
          ${canvasUI
            ? `<span class="cp-stepper"><span class="cp-muted">${esc(canvasUI.summary())}</span><button type="button" class="cp-btn" data-canvas>Open…</button></span>`
            : '<span class="cp-muted">Available in the desktop app</span>'}
        </div>
        <p class="cp-muted cp-hint">Tip: click the mark in the margin (or press Ctrl+Enter) to cross a line out. Crossed-out lines sink to the bottom.</p>`;
    }

    body.addEventListener('click', (e) => {
      const choice = e.target.closest('[data-set]');
      if (choice) {
        if (choice.dataset.set === 'onTop') bridge?.setOnTop(choice.dataset.value === 'on');
        else setPrefs({ [choice.dataset.set]: choice.dataset.value });
        render();
        return;
      }
      const step = e.target.closest('[data-step]');
      if (step) {
        setPrefs({ scale: Math.min(SCALE.max, Math.max(SCALE.min, prefs.scale + Number(step.dataset.step) * SCALE.step)) });
        render();
        return;
      }
      if (e.target.closest('[data-canvas]')) {
        panel.hidden = true;
        canvasUI?.openPanel();
      }
    });
    panel.querySelector('.cp-close').addEventListener('click', () => { panel.hidden = true; });
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') panel.hidden = true;
    });
    document.querySelector('[data-settings]')?.addEventListener('click', () => {
      const canvasPanel = document.querySelector('.canvas-panel');
      if (canvasPanel) canvasPanel.hidden = true;
      panel.hidden = !panel.hidden;
      render();
    });
    return { render };
  }

  /* ---------- Canvas assignments (desktop app only; see canvas.js) ---------- */

  function setupCanvas(cv) {
    const bar = document.querySelector('.canvas-bar');
    const check = bar.querySelector('.canvas-check');
    const hint = bar.querySelector('.canvas-hint');
    const panel = document.querySelector('.canvas-panel');
    const body = panel.querySelector('.cp-body');

    let cs = null; // latest state from canvas.js
    let view = 'auto'; // which card to show: auto | host | address | token
    let notice = ''; // error shown in the card

    const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const course = (id) => cs?.courses.find((c) => c.id === id);
    const colorOf = (item) => course(item.courseId)?.color ?? '#9a9a9a';
    const shortCourse = (item) => course(item.courseId)?.code || item.course || '';
    const message = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

    const ago = (t) => {
      if (!t) return 'never';
      const m = Math.round((Date.now() - t) / 60000);
      if (m < 1) return 'just now';
      if (m < 60) return `${m} min ago`;
      const h = Math.round(m / 60);
      return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
    };

    /* --- assignments on the pages --- */

    function renderItems() {
      const on = Boolean(cs?.enabled && cs.mode);
      root.classList.toggle('canvas-on', on);
      const hidden = new Set((cs?.courses ?? []).filter((c) => c.hidden).map((c) => c.id));
      const byDay = new Map();
      for (const item of on ? cs.items : []) {
        if (hidden.has(item.courseId)) continue;
        const key = dayKey(new Date(item.date));
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(item);
      }
      for (const d of pages.filter((p) => p.kind === 'day')) {
        const list = (byDay.get(dayKey(d.date)) ?? []).sort((a, b) => new Date(a.date) - new Date(b.date));
        const due = d.el.querySelector('.due');
        due.innerHTML = list.map((i) => `
          <button type="button" class="due-item${i.done ? ' is-done' : ''}${i.missing ? ' is-missing' : ''}" data-url="${esc(i.url)}" title="${esc(i.course)}${i.done ? ' · submitted' : ''}">
            <i class="dot" style="--c:${esc(colorOf(i))}"></i>
            <span class="due-title">${esc(i.title)}</span>
            <span class="due-meta">${i.timed ? esc(timeFmt.format(new Date(i.date))) + ' · ' : ''}${esc(shortCourse(i))}</span>
          </button>`).join('');
        due.hidden = list.length === 0;
        const row = pad.querySelector(`[data-due="${d.id}"]`);
        if (row) {
          row.innerHTML = list.slice(0, 3).map((i) => `<span class="wd-item${i.done ? ' is-done' : ''}"><i class="dot" style="--c:${esc(colorOf(i))}"></i>${esc(i.title)}</span>`).join('')
            + (list.length > 3 ? `<span class="wd-more">+${list.length - 3} more</span>` : '');
        }
      }
    }

    pad.addEventListener('click', (e) => {
      const item = e.target.closest('.due-item');
      if (item?.dataset.url) cv.open(item.dataset.url);
    });

    /* --- the toggle --- */

    function renderBar() {
      check.checked = Boolean(cs?.enabled && cs.mode);
      hint.textContent = !cs ? '' : cs.status === 'signed-out' ? '· sign in' : cs.status === 'error' ? '· !' : cs.status === 'connecting' ? '· signing in…' : '';
      hint.title = cs?.error ?? '';
    }

    check.addEventListener('change', () => {
      if (!cs?.mode) {
        check.checked = false;
        openPanel();
        return;
      }
      cv.setEnabled(check.checked);
    });
    panel.querySelector('.cp-close').addEventListener('click', closePanel);

    function openPanel() {
      view = 'auto';
      notice = '';
      document.querySelector('.settings-panel').hidden = true;
      panel.hidden = false;
      renderPanel();
    }

    function closePanel() {
      panel.hidden = true;
    }

    /* --- the settings card --- */

    function renderPanel() {
      if (panel.hidden || !cs) return;
      const step = view !== 'auto' ? view : !cs.host ? 'host' : cs.mode ? 'connected' : 'auth';
      let html = '';

      if (step === 'host') {
        html = `
          <p>Show your Canvas assignments on each day's page and in the week overview. First, find your school so we can open its Canvas sign-in page.</p>
          <label class="cp-label" for="cp-school">Find your school</label>
          <div class="cp-row">
            <input class="cp-input" id="cp-school" placeholder="Start typing your school's name…" autocomplete="off" spellcheck="false">
          </div>
          <ul class="cp-schools" data-schools></ul>
          <p class="cp-muted">Not listed? <button type="button" class="cp-link" data-act="to-address">Enter the Canvas address instead</button></p>`;
      } else if (step === 'address') {
        html = `
          <p><button type="button" class="cp-link" data-act="change-host">← Find by name</button></p>
          <label class="cp-label" for="cp-host">Your school's Canvas address</label>
          <div class="cp-row">
            <input class="cp-input" id="cp-host" placeholder="yourschool  or  yourschool.instructure.com" value="${esc(cs.host)}" autocomplete="off" spellcheck="false">
            <button type="button" class="cp-btn cp-btn--primary" data-act="host">Continue</button>
          </div>
          <p class="cp-muted">It's the address in your browser when you're on Canvas. Most schools are <em>school</em>.instructure.com, so the short name is enough; if yours uses its own domain, paste the full address.</p>`;
      } else if (step === 'auth') {
        const open = cs.status === 'connecting';
        html = `
          <p><strong>${esc(cs.host)}</strong> <button type="button" class="cp-link" data-act="change-host">change</button></p>
          ${open ? '<p><strong>The sign-in window is open.</strong> Finish signing in there and this card will update by itself.</p>' : ''}
          <div class="cp-row">
            <button type="button" class="cp-btn cp-btn--primary" data-act="sign-in">${open ? 'Show the sign-in window' : 'Sign in to Canvas'}</button>
          </div>
          <p class="cp-muted">Opens your school's normal Canvas sign-in page in its own window. The password goes to Canvas only; the notepad just keeps the signed-in session.</p>
          <p class="cp-muted">Sessions expire after a while, so you'll occasionally be asked to sign in again. To avoid that, <button type="button" class="cp-link" data-act="to-token">use an access token instead</button>.</p>`;
      } else if (step === 'token') {
        html = `
          <p><strong>${esc(cs.host)}</strong> <button type="button" class="cp-link" data-act="back">back</button></p>
          <p>In Canvas go to <strong>Account → Settings</strong>, scroll to <strong>Approved Integrations</strong> and click <strong>+ New Access Token</strong>. Leave the expiry blank, copy the token and paste it here. It's stored encrypted on this computer.</p>
          <label class="cp-label" for="cp-token">Access token</label>
          <div class="cp-row">
            <input class="cp-input" id="cp-token" type="password" autocomplete="off" spellcheck="false">
            <button type="button" class="cp-btn cp-btn--primary" data-act="token">Connect</button>
          </div>
          ${cs.canStoreToken ? '' : '<p class="cp-error">This computer can\'t store a token securely, so only sign-in is available.</p>'}`;
      } else {
        const who = cs.userName ? `<strong>${esc(cs.userName)}</strong> at ` : '';
        const how = cs.mode === 'token' ? 'access token' : 'signed in';
        let state = '';
        if (cs.status === 'signed-out') {
          state = `<p class="cp-error">Your Canvas session has expired.</p>
            <div class="cp-row"><button type="button" class="cp-btn cp-btn--primary" data-act="sign-in">Sign in again</button>
            <button type="button" class="cp-btn" data-act="to-token">Use a token instead</button></div>`;
        } else if (cs.status === 'error') {
          state = `<p class="cp-error">${esc(cs.error)}</p>`;
        }
        const courses = cs.courses.length
          ? `<span class="cp-label">Courses</span>
             <ul class="cp-courses">${cs.courses.map((c) => `
               <li><label class="cp-course"><input type="checkbox" data-course="${c.id}" ${c.hidden ? '' : 'checked'}><i class="dot" style="--c:${esc(c.color)}"></i><span>${esc(c.name)}</span></label></li>`).join('')}
             </ul>`
          : '<p class="cp-muted">No courses loaded yet.</p>';
        html = `
          <p>${who}<strong>${esc(cs.host)}</strong> <span class="cp-muted">(${how})</span></p>
          ${state}
          <p class="cp-muted">Updated ${esc(ago(cs.updatedAt))}. <button type="button" class="cp-link" data-act="refresh">Refresh now</button></p>
          ${courses}
          <div class="cp-row">
            ${cs.mode === 'session' ? '<button type="button" class="cp-btn" data-act="to-token">Switch to a token</button>' : ''}
            <button type="button" class="cp-btn" data-act="disconnect">${cs.mode === 'token' ? 'Remove token' : 'Sign out'}</button>
            <button type="button" class="cp-btn" data-act="change-host">Change school</button>
          </div>`;
      }
      body.innerHTML = `${html}<p class="cp-error" data-notice>${esc(notice)}</p>`;
      body.querySelector('.cp-input')?.focus();
    }

    async function run(task) {
      notice = '';
      body.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        await task();
      } catch (e) {
        notice = message(e);
      }
      renderPanel();
    }

    body.addEventListener('click', (e) => {
      const button = e.target.closest('[data-act]');
      if (!button) return;
      const act = button.dataset.act;
      if (act === 'host') run(async () => { await cv.setHost(body.querySelector('#cp-host').value); view = 'auto'; await cv.signIn(); });
      else if (act === 'school') run(async () => { await cv.setHost(button.dataset.domain); view = 'auto'; await cv.signIn(); });
      else if (act === 'change-host') { view = 'host'; notice = ''; renderPanel(); }
      else if (act === 'to-address') { view = 'address'; notice = ''; renderPanel(); }
      else if (act === 'sign-in') run(() => cv.signIn());
      else if (act === 'to-token') { view = 'token'; notice = ''; renderPanel(); }
      else if (act === 'back') { view = 'auto'; notice = ''; renderPanel(); }
      else if (act === 'token') run(async () => { await cv.useToken(body.querySelector('#cp-token').value); view = 'auto'; });
      else if (act === 'refresh') run(() => cv.refresh());
      else if (act === 'disconnect') run(() => cv.disconnect());
    });
    body.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.classList.contains('cp-input')) return;
      e.preventDefault();
      (body.querySelector('.cp-row .cp-btn--primary') ?? body.querySelector('[data-act="school"]'))?.click();
    });

    // School finder: search as you type (debounced), ignore answers that arrive out of order
    let searchTimer = 0;
    let searchSeq = 0;
    body.addEventListener('input', (e) => {
      if (e.target.id !== 'cp-school') return;
      const list = body.querySelector('[data-schools]');
      const q = e.target.value.trim();
      clearTimeout(searchTimer);
      const seq = ++searchSeq;
      if (q.length < 2) {
        list.innerHTML = '';
        return;
      }
      list.innerHTML = '<li class="cp-muted">Searching…</li>';
      searchTimer = setTimeout(async () => {
        try {
          const schools = await cv.searchSchools(q);
          if (seq !== searchSeq) return;
          list.innerHTML = schools.length
            ? schools.map((s) => `<li><button type="button" class="cp-school" data-act="school" data-domain="${esc(s.domain)}"><span class="cp-school-name">${esc(s.name)}</span><span class="cp-school-domain">${esc(s.domain)}</span></button></li>`).join('')
            : '<li class="cp-muted">No schools found with that name.</li>';
        } catch (err) {
          if (seq === searchSeq) list.innerHTML = `<li class="cp-error">${esc(message(err))}</li>`;
        }
      }, 250);
    });
    body.addEventListener('change', (e) => {
      const box = e.target.closest('[data-course]');
      if (box) cv.setCourseHidden(box.dataset.course, !box.checked);
    });
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePanel();
    });

    /* --- state --- */

    function apply(state) {
      if (!state) return;
      cs = state;
      renderBar();
      renderItems();
      renderPanel();
    }
    cv.onState(apply);
    cv.getState().then(apply);
    return {
      openPanel,
      render: renderItems,
      summary: () => (!cs ? '' : !cs.mode ? 'Not connected' : cs.status === 'signed-out' ? 'Session expired' : `${cs.userName || 'Connected'} · ${cs.host}`),
    };
  }
})();
