// Draws the app icon (a little notepad with index tabs) at every size Windows asks for,
// then writes assets/icon.ico (taskbar, tray, installer) and assets/icon.png.
// Run with: npm run icons
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const OUT_DIR = path.join(__dirname, '..', 'assets');

/* ---------- Shapes (signed distance, in a 256-unit design square) ---------- */

function roundRect(px, py, x0, y0, x1, y1, r) {
  const qx = Math.abs(px - (x0 + x1) / 2) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(py - (y0 + y1) / 2) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function capsule(px, py, ax, ay, bx, by, halfWidth) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) - halfWidth;
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function layersFor(size) {
  const u = 256 / size; // design units per pixel
  const small = size <= 24;
  const line = (minUnits, minPx) => Math.max(minUnits, minPx * u) / 2;
  const layers = [];

  const PAPER = [62, 26, 230, 236]; // x0, y0, x1, y1
  const edge = Math.max(4, 1.1 * u); // outline so the paper reads on light and dark taskbars

  if (size >= 48) {
    layers.push({
      alpha: (x, y) => 0.3 * (1 - smoothstep(-10, 18, roundRect(x, y - 8, ...PAPER, 10))),
      color: () => [40, 25, 10],
    });
  }

  // Index tabs peeking out on the left
  const tabColors = ['#e8957a', '#ecc477', '#bccb8f'];
  const tabs = small ? [[100, 150], [164, 214]] : [[92, 128], [136, 172], [180, 216]];
  tabs.forEach(([y0, y1], i) => {
    layers.push({ sd: (x, y) => roundRect(x, y, 22, y0, 80, y1, 8), color: () => hex(tabColors[i]) });
  });

  // Pad: stacked sheets underneath, an outline, then the top sheet
  const [x0, y0, x1, y1] = PAPER;
  layers.push({ sd: (x, y) => roundRect(x, y, x0 - edge, y0 - edge, x1 + edge, y1 + edge + 8, 12), color: () => hex('#bdb29e') });
  layers.push({ sd: (x, y) => roundRect(x, y, x0, y0 + 4, x1, y1 + 8, 10), color: () => hex('#e4dccd') });
  layers.push({ sd: (x, y) => roundRect(x, y, x0, y0, x1, y1, 10), color: () => hex('#fbf8f1') });

  // Heading stroke, double red rule under it, margin line
  layers.push({ sd: (x, y) => capsule(x, y, 94, 56, 168, 56, line(13, 1.8)), color: () => hex('#2b3348') });
  if (!small) {
    layers.push({ sd: (x, y) => capsule(x, y, x0, 80, x1, 80, line(3, 0.8)), color: () => hex('#df8a7c') });
    layers.push({ sd: (x, y) => capsule(x, y, x0, 86, x1, 86, line(3, 0.8)), color: () => hex('#df8a7c') });
    layers.push({ sd: (x, y) => capsule(x, y, 88, 86, 88, y1, line(3, 0.8)), color: () => hex('#df8a7c') });
  }

  // Ruled lines
  const rules = small ? [126, 176] : [116, 146, 176, 206];
  for (const ry of rules) {
    layers.push({ sd: (x, y) => capsule(x, y, small ? 84 : 100, ry, 212, ry, line(5, 1.1)), color: () => hex('#8fa8c4') });
  }

  return { layers, u };
}

function render(size) {
  const { layers, u } = layersFor(size);
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) * u;
      const y = (py + 0.5) * u;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0; // premultiplied accumulators
      for (const layer of layers) {
        const cover = layer.alpha ? layer.alpha(x, y) : Math.max(0, Math.min(1, 0.5 - layer.sd(x, y) / u));
        if (cover <= 0) continue;
        const [cr, cg, cb] = layer.color(x, y);
        r = cr * cover + r * (1 - cover);
        g = cg * cover + g * (1 - cover);
        b = cb * cover + b * (1 - cover);
        a = cover + a * (1 - cover);
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round(a * 255);
      }
    }
  }
  return out;
}

/* ---------- PNG + ICO encoding ---------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + entries.length;
  images.forEach(({ size, png }, i) => {
    const e = i * 16;
    entries[e] = size >= 256 ? 0 : size;
    entries[e + 1] = size >= 256 ? 0 : size;
    entries.writeUInt16LE(1, e + 4); // planes
    entries.writeUInt16LE(32, e + 6); // bits per pixel
    entries.writeUInt32LE(png.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...images.map((img) => img.png)]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const images = SIZES.map((size) => ({ size, png: encodePNG(size, render(size)) }));
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeICO(images));
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), images.at(-1).png);
console.log(`Wrote assets/icon.ico (${SIZES.join(', ')} px) and assets/icon.png`);
