/* Notepad — a top-bound pad whose sheets flip up and over the top */
(() => {
  'use strict';

  // Running inside the desktop app? (main.js loads the page with ?desktop=1)
  const isDesktop = new URLSearchParams(location.search).has('desktop');
  if (isDesktop) document.documentElement.classList.add('is-desktop');

  // Kept from the app's first name so pages written before the rename still load.
  const STORAGE_PREFIX = 'kitchen-notepad:v1:';
  const store = {
    get(key) {
      try { return localStorage.getItem(STORAGE_PREFIX + key); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(STORAGE_PREFIX + key, value); } catch { /* storage unavailable: keep working in memory */ }
    },
  };

  // The page flip is the point of the desktop app, so it always plays there (Windows reports
  // "reduced motion" whenever its Animation effects setting is off). In a plain browser tab,
  // the reduced-motion preference is respected and pages switch instantly.
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const shouldAnimate = () => isDesktop || !reducedMotion.matches;

  /* ---------- This week's dates (Monday first) ---------- */

  const addDays = (date, n) => {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayOffset = (today.getDay() + 6) % 7;
  const monday = addDays(today, -todayOffset);

  const fmt = (options) => new Intl.DateTimeFormat(undefined, options);
  const shortDay = fmt({ weekday: 'short' });
  const longDay = fmt({ weekday: 'long' });
  const monthDay = fmt({ month: 'long', day: 'numeric' });
  const shortDate = fmt({ month: 'short', day: 'numeric' });

  const DAY_IDS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const days = DAY_IDS.map((id, i) => {
    const date = addDays(monday, i);
    return {
      id,
      kind: 'day',
      date,
      isToday: i === todayOffset,
      label: shortDay.format(date),
      title: longDay.format(date),
      sub: monthDay.format(date),
    };
  });
  const sunday = days[6].date;
  const weekRange = typeof shortDate.formatRange === 'function'
    ? shortDate.formatRange(monday, sunday)
    : `${shortDate.format(monday)} – ${shortDate.format(sunday)}`;

  // Stack order, top sheet first: Notes, then the Week overview, then each day.
  const pages = [
    { id: 'notes', kind: 'notes', label: 'Notes', title: 'Notes', sub: 'Scratch pad' },
    { id: 'week', kind: 'week', label: 'Week', title: 'This Week', sub: weekRange },
    ...days,
  ];
  const COUNT = pages.length;
  pages.forEach((p, i) => { p.index = i; });

  const restingZ = (i) => 10 + (COUNT - i); // under the window buttons (z 45)
  const liftedZ = (i) => 60 + (COUNT - i); // over everything while flipping

  /* ---------- Build the tabs and pages ---------- */

  const tablist = document.querySelector('.tabs');
  const pad = document.querySelector('.pad');
  const padShade = pad.querySelector('.pad-shade');

  const weekHTML = () => `
    <ol class="week">
      ${days.map((d) => `
        <li>
          <button type="button" class="week-day${d.isToday ? ' is-today' : ''}" data-go="${d.index}">
            <span class="week-date">
              <span class="wd-name">${d.label}</span>
              <span class="wd-num">${d.date.getDate()}</span>
            </span>
            <span class="wd-body">
              <span class="wd-due" data-due="${d.id}"></span>
              <span class="wd-preview" data-preview="${d.id}"></span>
            </span>
          </button>
        </li>`).join('')}
    </ol>`;

  const writeHTML = (p) =>
    `<textarea class="write" aria-label="${p.title}" spellcheck="true"${p.kind === 'notes' ? ' placeholder="Jot anything down…"' : ''}></textarea>`;

  for (const p of pages) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab' + (p.isToday ? ' is-today' : '');
    tab.id = `tab-${p.id}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `page-${p.id}`);
    tab.style.setProperty('--tab-color', `var(--tab-${p.id})`);
    tab.innerHTML = `<span class="tab-label">${p.label}</span>${p.isToday ? '<span class="sr-only">, today</span>' : ''}`;
    tab.addEventListener('click', () => goTo(p.index));
    tablist.append(tab);

    const page = document.createElement('section');
    page.className = `page page--${p.kind}`;
    page.id = `page-${p.id}`;
    page.setAttribute('role', 'tabpanel');
    page.setAttribute('aria-labelledby', tab.id);
    page.style.zIndex = restingZ(p.index);
    page.innerHTML = `
      <div class="face face--front">
        <div class="drag-strip" aria-hidden="true"></div>
        <header class="page-head">
          <h2 class="page-title">${p.title}</h2>
          <p class="page-sub"><span>${p.sub}</span>${p.isToday ? '<span class="stamp">Today</span>' : ''}</p>
        </header>
        ${p.kind === 'week' ? weekHTML() : `${p.kind === 'day' ? '<div class="due" hidden></div>' : ''}${writeHTML(p)}`}
        ${p.index < COUNT - 1 ? '<button type="button" class="corner" tabindex="-1" aria-label="Next page"></button>' : ''}
        <div class="face-shade"></div>
      </div>
      <div class="face face--back"><div class="face-shade"></div></div>`;
    pad.insertBefore(page, padShade);

    Object.assign(p, {
      tab,
      el: page,
      front: page.querySelector('.face--front'),
      back: page.querySelector('.face--back'),
      shades: page.querySelectorAll('.face-shade'),
      textarea: page.querySelector('textarea'),
    });
  }

  /* ---------- Writing + saving ---------- */

  const updatePreview = (p) => {
    if (p.kind !== 'day') return;
    const lines = p.textarea.value.split('\n').map((s) => s.trim()).filter(Boolean);
    pad.querySelector(`[data-preview="${p.id}"]`).textContent = lines.join(' · ');
  };

  for (const p of pages) {
    if (!p.textarea) continue;
    const key = `page:${p.id}`;
    p.textarea.value = store.get(key) ?? '';
    updatePreview(p);

    let timer = 0;
    const save = () => {
      clearTimeout(timer);
      store.set(key, p.textarea.value);
    };
    p.textarea.addEventListener('input', () => {
      updatePreview(p);
      clearTimeout(timer);
      timer = setTimeout(save, 300);
    });
    p.textarea.addEventListener('blur', save);
    window.addEventListener('pagehide', save);
  }

  /* ---------- Flipping ---------- */

  const saved = pages.findIndex((p) => p.id === store.get('current'));
  let current = saved >= 0 ? saved : 0;
  let busy = false;
  let queued = null;

  function selectTab(index) {
    for (const p of pages) {
      const on = p.index === index;
      p.tab.classList.toggle('is-active', on);
      p.tab.setAttribute('aria-selected', String(on));
      p.tab.tabIndex = on ? 0 : -1;
    }
  }

  // Put every sheet in its resting place for the current page.
  function settle() {
    for (const p of pages) {
      p.el.classList.toggle('is-flipped', p.index < current);
      p.el.inert = p.index !== current;
    }
    selectTab(current);
    store.set('current', pages[current].id);
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
    if (target < 0 || target >= COUNT) return;
    if (busy) {
      queued = target;
      selectTab(target);
      return;
    }
    if (target === current) return;
    if (!shouldAnimate()) {
      current = target;
      settle();
      return;
    }

    busy = true;
    selectTab(target);

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

  /* ---------- Input ---------- */

  tablist.addEventListener('keydown', (e) => {
    const from = pages.findIndex((p) => p.tab === document.activeElement);
    if (from < 0) return;
    let to = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') to = Math.min(COUNT - 1, from + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') to = Math.max(0, from - 1);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = COUNT - 1;
    if (to === null) return;
    e.preventDefault();
    pages[to].tab.focus();
    goTo(to);
  });

  pad.addEventListener('click', (e) => {
    const day = e.target.closest('[data-go]');
    if (day) {
      goTo(Number(day.dataset.go));
      return;
    }
    if (e.target.closest('.corner')) goTo(current + 1);
  });

  /* ---------- Desktop window: buttons, click-through, resize grip ---------- */

  const bridge = isDesktop ? window.notepad : null;
  let canvasUI = null; // set up below when the desktop bridge exists
  if (bridge) {
    document.querySelector('.win-controls').addEventListener('click', (e) => {
      const button = e.target.closest('[data-win]');
      if (button) bridge.window(button.dataset.win);
    });

    // Clicks on the empty, transparent space around the clipboard fall through to the desktop.
    let passThrough = null;
    const setPassThrough = (on) => {
      if (on === passThrough) return;
      passThrough = on;
      bridge.setPassThrough(on);
    };
    document.addEventListener('mousemove', (e) => setPassThrough(!e.target.closest('.clipboard')), { passive: true });
    setPassThrough(true);

    const root = document.documentElement;
    let pinned = false;
    const pinButton = document.querySelector('[data-pin]');
    pinButton.addEventListener('click', () => bridge.setPinned(!pinned));
    bridge.onPinned((on) => {
      pinned = on;
      root.classList.toggle('is-pinned', on);
      pinButton.setAttribute('aria-pressed', String(on));
      pinButton.title = on ? 'Unpin (let it move again)' : 'Pin in place, in front of other apps';
      pinButton.setAttribute('aria-label', pinButton.title);
    });

    const grip = document.querySelector('.resize-grip');
    const endResize = () => bridge.resize('end');
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || pinned) return;
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
    const MOVE_THRESHOLD = 4;
    let press = null;
    let justMoved = false;
    let frame = 0;
    const sendMove = () => {
      frame = 0;
      if (press?.moving === 'self') bridge.moveBy(press.dx, press.dy);
    };
    const finish = () => {
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
        finish();
      }
      // 'native': Windows is moving it; onMoved below tidies up when it's done
      press = null;
    };
    bridge.onMoved(finish);
    document.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || pinned) return;
      if (!e.target.closest('.tabs, .week')) return;
      press = { x: e.screenX, y: e.screenY, dx: 0, dy: 0, moving: false, target: e.target, id: e.pointerId };
    });
    document.addEventListener('pointermove', (e) => {
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

  setupSettings();

  /* ---------- Settings: appearance, writing font, Canvas entry point ---------- */

  function setupSettings() {
    const root = document.documentElement;
    const FONTS = {
      hand: { label: 'Handwritten', family: 'var(--hand)', ratio: 0.82 },
      serif: { label: 'Serif', family: 'var(--serif)', ratio: 0.6 },
      sans: { label: 'Sans', family: '"Segoe UI", system-ui, sans-serif', ratio: 0.58 },
      mono: { label: 'Mono', family: '"Cascadia Mono", Consolas, monospace', ratio: 0.55 },
    };
    const THEMES = { system: 'System', light: 'Light', dark: 'Dark' };
    const SCALE = { min: 70, max: 160, step: 10 };
    const defaults = { theme: 'system', font: 'hand', scale: 100 };

    let prefs = { ...defaults };
    try {
      prefs = { ...defaults, ...JSON.parse(store.get('prefs') ?? '{}') };
    } catch { /* keep defaults */ }
    if (!FONTS[prefs.font]) prefs.font = defaults.font;
    if (!THEMES[prefs.theme]) prefs.theme = defaults.theme;
    prefs.scale = Math.min(SCALE.max, Math.max(SCALE.min, Number(prefs.scale) || 100));

    const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

    function apply() {
      const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && systemDark.matches);
      root.dataset.theme = dark ? 'dark' : 'light';
      const font = FONTS[prefs.font];
      root.style.setProperty('--write-font', font.family);
      root.style.setProperty('--write-ratio', String(font.ratio));
      root.style.setProperty('--text-scale', String(prefs.scale / 100));
    }
    systemDark.addEventListener('change', apply);
    apply();

    const panel = document.querySelector('.settings-panel');
    const body = panel.querySelector('.cp-body');
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const seg = (name, options, current) =>
      `<span class="cp-seg" role="group">${Object.entries(options).map(([k, label]) =>
        `<button type="button" data-set="${name}" data-value="${k}" aria-pressed="${k === current}">${esc(label)}</button>`).join('')}</span>`;

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
          <span class="cp-label">Canvas assignments</span>
          ${canvasUI
            ? `<span class="cp-stepper"><span class="cp-muted">${esc(canvasUI.summary())}</span><button type="button" class="cp-btn" data-canvas>Open…</button></span>`
            : '<span class="cp-muted">Available in the desktop app</span>'}
        </div>`;
    }

    function set(patch) {
      prefs = { ...prefs, ...patch };
      store.set('prefs', JSON.stringify(prefs));
      apply();
      render();
    }

    body.addEventListener('click', (e) => {
      const choice = e.target.closest('[data-set]');
      if (choice) {
        set({ [choice.dataset.set]: choice.dataset.value });
        return;
      }
      const step = e.target.closest('[data-step]');
      if (step) {
        set({ scale: Math.min(SCALE.max, Math.max(SCALE.min, prefs.scale + Number(step.dataset.step) * SCALE.step)) });
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
  }

  /* ---------- Canvas assignments (desktop app only; see canvas.js) ---------- */

  function setupCanvas(cv) {
    const root = document.documentElement;
    const bar = document.querySelector('.canvas-bar');
    const check = bar.querySelector('.canvas-check');
    const hint = bar.querySelector('.canvas-hint');
    const panel = document.querySelector('.canvas-panel');
    const body = panel.querySelector('.cp-body');
    const timeFmt = fmt({ hour: 'numeric', minute: '2-digit' });

    let cs = null; // latest state from canvas.js
    let view = 'auto'; // which card to show: auto | host | token
    let notice = ''; // error shown in the card

    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
      for (const d of days) {
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
        row.innerHTML = list.slice(0, 3).map((i) => `<span class="wd-item${i.done ? ' is-done' : ''}"><i class="dot" style="--c:${esc(colorOf(i))}"></i>${esc(i.title)}</span>`).join('')
          + (list.length > 3 ? `<span class="wd-more">+${list.length - 3} more</span>` : '');
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
    return { openPanel, summary: () => (!cs ? '' : !cs.mode ? 'Not connected' : cs.status === 'signed-out' ? 'Session expired' : `${cs.userName || 'Connected'} · ${cs.host}`) };
  }

  settle();
})();
