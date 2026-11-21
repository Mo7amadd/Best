'use strict';
// Draws the Best logo (a lowercase "b" on a rounded square) into PNG / ICO files.
// Pure Node (zlib) – no image libraries needed.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT_ICONS = path.join(ROOT, 'resources', 'icons');
const OUT_BUILD = path.join(ROOT, 'build');
fs.mkdirSync(OUT_ICONS, { recursive: true });
fs.mkdirSync(OUT_BUILD, { recursive: true });

function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function roundedRectDist(px, py, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(px, x1 - r));
  const cy = Math.max(y0 + r, Math.min(py, y1 - r));
  return Math.hypot(px - cx, py - cy) - r; // <0 inside
}

function draw(size, { fg, bg = '#151A21', border = '#2A313B', plain = false, dot = null, alpha = 1, onlyDot = false, pad = 0 }) {
  const D = dot ? hex(dot) : null; const RING = hex('#0B0E12');
  const S = 4; // supersampling
  const out = Buffer.alloc(size * size * 4);
  const F = hex(fg); const B = hex(bg); const BR = hex(border);
  const u = (size - 2 * pad) / 32; // pad: empty margin around the tile (macOS app icon)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = (x - pad + (sx + 0.5) / S) / u;
          const py = (y - pad + (sy + 0.5) / S) / u;
          let col = null; let al = 0;
          if (!plain && !onlyDot) {
            const d = roundedRectDist(px, py, 1, 1, 31, 31, 9);
            if (d < 0) { col = d > -1 ? BR : B; al = 1; }
          }
          // Lowercase "b": a stem plus a round bowl.
          const w = plain ? 3.6 : 3;
          const stem = distToSeg(px, py, 11.2, 7.5, 11.2, 24.5);
          const bowl = Math.abs(Math.hypot(px - 17, py - 18.5) - 5.8);
          if (!onlyDot && Math.min(stem, bowl) < w / 2) { col = F; al = 1; }
          if (D) {
            // Status badge in the bottom-right corner, with a dark ring so it reads on any taskbar.
            const c = onlyDot ? 16 : 24.5; const dd = Math.hypot(px - c, py - c);
            if (dd < (onlyDot ? 15 : 7.4)) { col = onlyDot && dd >= 11.5 ? RING : !onlyDot && dd >= 5.6 ? RING : D; al = 1; }
          }
          if (col) { r += col[0] * al; g += col[1] * al; b += col[2] * al; a += al; }
        }
      }
      const n = S * S;
      const i = (y * size + x) * 4;
      out[i] = a ? Math.round(r / a) : 0;
      out[i + 1] = a ? Math.round(g / a) : 0;
      out[i + 2] = a ? Math.round(b / a) : 0;
      out[i + 3] = Math.round((a / n) * 255 * alpha);
    }
  }
  return png(size, out);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size; e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const GREEN = '#3DD68C';
fs.writeFileSync(path.join(OUT_ICONS, 'app.png'), draw(256, { fg: GREEN }));
// Tray icons at 16/24/32 px (Electron picks @1.5x / @2x on high-DPI screens).
const TRAY = {
  on: { fg: GREEN, dot: GREEN },
  tun: { fg: '#5AA9FF', dot: '#5AA9FF' },
  off: { fg: '#8B95A3', bg: '#1A1F27', border: '#2A313B', alpha: 0.75 },
};
for (const [name, opt] of Object.entries(TRAY)) {
  fs.writeFileSync(path.join(OUT_ICONS, `tray-${name}.png`), draw(16, opt));
  fs.writeFileSync(path.join(OUT_ICONS, `tray-${name}@1.5x.png`), draw(24, opt));
  fs.writeFileSync(path.join(OUT_ICONS, `tray-${name}@2x.png`), draw(32, opt));
}
// Taskbar overlay badges (shown on the Best button in the taskbar).
fs.writeFileSync(path.join(OUT_ICONS, 'overlay-on.png'), draw(32, { fg: GREEN, dot: GREEN, onlyDot: true }));
fs.writeFileSync(path.join(OUT_ICONS, 'overlay-tun.png'), draw(32, { fg: GREEN, dot: '#5AA9FF', onlyDot: true }));
// macOS menu bar: black "template" images (macOS colours them for a light or dark menu bar).
// Off: an outline; on: a filled tile with the "b" cut out; TUN: the same with a dot in the corner.
function drawTemplate(size, kind) {
  const S = 4;
  const out = Buffer.alloc(size * size * 4);
  const u = size / 32;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = (x + (sx + 0.5) / S) / u;
          const py = (y + (sy + 0.5) / S) / u;
          const box = roundedRectDist(px, py, 2, 2, 30, 30, 8);
          const glyph = Math.min(distToSeg(px, py, 11.2, 7.5, 11.2, 24.5), Math.abs(Math.hypot(px - 17, py - 18.5) - 5.8)) < 1.7;
          let on = false;
          if (kind === 'off') on = (box < 0 && box > -2.2) || glyph;
          else on = box < 0 && !glyph;
          if (kind === 'tun') {
            const d = Math.hypot(px - 26.5, py - 26.5);
            if (d < 5.8) on = d < 3.9; // a cut-out ring around a solid dot, clear of the "b"
          }
          if (on) a += 1;
        }
      }
      out[(y * size + x) * 4 + 3] = Math.round((a / (S * S)) * 255 * (kind === 'off' ? 0.6 : 1));
    }
  }
  return png(size, out);
}
for (const kind of ['off', 'on', 'tun']) {
  fs.writeFileSync(path.join(OUT_ICONS, `mac-${kind}Template.png`), drawTemplate(18, kind));
  fs.writeFileSync(path.join(OUT_ICONS, `mac-${kind}Template@2x.png`), drawTemplate(36, kind));
}
// macOS app icon: the tile inside Apple's usual margin (824 of 1024 px).
fs.writeFileSync(path.join(OUT_BUILD, 'icon-mac.png'), draw(1024, { fg: GREEN, pad: 100 }));

fs.writeFileSync(path.join(OUT_BUILD, 'icon.png'), draw(512, { fg: GREEN }));
fs.writeFileSync(path.join(OUT_BUILD, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: draw(size, { fg: GREEN }) }))));
fs.writeFileSync(path.join(ROOT, 'renderer', 'logo.png'), draw(64, { fg: GREEN }));
console.log('icons written');
