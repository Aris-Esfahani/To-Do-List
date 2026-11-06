// The only things the page can ask of the desktop window.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notepad', {
  // 'minimize' (to the taskbar) or 'hide' (to the tray)
  window: (action) => ipcRenderer.send('notepad:window', String(action)),
  // true while the mouse is over empty, transparent space, so clicks fall through to the desktop
  setPassThrough: (on) => ipcRenderer.send('notepad:pass-through', Boolean(on)),
  // The mouse button is down and has started to drag: hand the move to the operating system,
  // which then moves the window itself until the button is released. Resolves to false if the
  // OS can't take over (then the page falls back to moveBy below).
  dragWindow: () => ipcRenderer.invoke('notepad:drag-window'),
  // Fallback drag: 'start' / 'end', with moveBy(dx, dy) in between (how far the pointer has
  // travelled since the start, in screen pixels)
  move: (phase) => ipcRenderer.send('notepad:move', String(phase)),
  moveBy: (dx, dy) => ipcRenderer.send('notepad:move-by', Number(dx) || 0, Number(dy) || 0),
  // Called once the OS has finished moving the window
  onMoved: (callback) => ipcRenderer.on('notepad:moved', () => callback()),
  // 'start' / 'end' of dragging the resize grip
  resize: (phase) => ipcRenderer.send('notepad:resize', String(phase)),
  // Pinned = kept in front of other apps and locked in place
  setPinned: (on) => ipcRenderer.send('notepad:pin', Boolean(on)),
  onPinned: (callback) => ipcRenderer.on('notepad:pinned', (_event, on) => callback(Boolean(on))),

  // Canvas integration (see canvas.js). Each call resolves with the result or rejects with a
  // plain message to show the user. onState delivers the full state after every change.
  canvas: {
    getState: () => ipcRenderer.invoke('canvas:get-state'),
    setEnabled: (on) => ipcRenderer.invoke('canvas:set-enabled', Boolean(on)),
    searchSchools: (query) => ipcRenderer.invoke('canvas:search-schools', String(query ?? '')),
    setHost: (input) => ipcRenderer.invoke('canvas:set-host', String(input ?? '')),
    signIn: () => ipcRenderer.invoke('canvas:sign-in'),
    useToken: (token) => ipcRenderer.invoke('canvas:use-token', String(token ?? '')),
    refresh: () => ipcRenderer.invoke('canvas:refresh'),
    disconnect: () => ipcRenderer.invoke('canvas:disconnect'),
    setCourseHidden: (id, hidden) => ipcRenderer.invoke('canvas:set-course-hidden', Number(id), Boolean(hidden)),
    open: (url) => ipcRenderer.invoke('canvas:open', String(url ?? '')),
    onState: (callback) => ipcRenderer.on('canvas:state', (_event, state) => callback(state)),
  },
});
