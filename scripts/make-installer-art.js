'use strict';
// Renders the NSIS installer artwork (sidebar 164x314, header 150x57) from HTML with Electron,
// so text uses the real fonts, then writes 24-bit BMP files that NSIS understands.
// Usage: npx electron scripts/make-installer-art.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build');
const font = (f) => pathToFileURL(path.join(ROOT, 'renderer', 'fonts', f)).toString();
const logo = pathToFileURL(path.join(ROOT, 'resources', 'icons', 'app.png')).toString();

const FONTS = `
@font-face { font-family: Inter; src: url('${font('Inter-700.woff2')}'); font-weight: 700; }
@font-face { font-family: Inter; src: url('${font('Inter-500.woff2')}'); font-weight: 500; }
@font-face { font-family: Inter; src: url('${font('Inter-400.woff2')}'); font-weight: 400; }
* { margin: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; font-family: Inter, sans-serif; -webkit-font-smoothing: antialiased; }`;

const SIDEBAR = `<!doctype html><html><head><meta charset="utf-8"><style>${FONTS}
body { background: #0E1116; color: #E6E9EE; display: flex; flex-direction: column; padding: 26px 20px 22px; }
img { width: 58px; height: 58px; }
h1 { margin-top: 18px; font-size: 30px; font-weight: 700; letter-spacing: -.02em; }
p { margin-top: 6px; font-size: 12px; line-height: 1.5; color: #A7B0BC; }
.rule { margin-top: auto; height: 3px; width: 36px; border-radius: 2px; background: #3DD68C; }
.foot { margin-top: 12px; font-size: 10.5px; color: #8B95A3; line-height: 1.6; }
</style></head><body>
<img src="${logo}" alt="">
<h1>Best</h1>
<p>Fast, private connections for Windows.</p>
<div class="rule"></div>
<div class="foot">Xray · sing-box<br>VLESS · VMess · Trojan · Hysteria2</div>
</body></html>`;

const HEADER = `<!doctype html><html><head><meta charset="utf-8"><style>${FONTS}
body { background: #FFFFFF; display: flex; align-items: center; justify-content: flex-end; gap: 9px; padding-right: 12px; }
img { width: 34px; height: 34px; }
span { font-size: 19px; font-weight: 700; color: #161A21; letter-spacing: -.02em; }
</style></head><body><span>Best</span><img src="${logo}" alt=""></body></html>`;

function writeBmp(file, image) {
  const { width, height } = image.getSize();
  const bgra = image.toBitmap();
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + rowSize * height;
  const buf = Buffer.alloc(size);
  buf.write('BM', 0); buf.writeUInt32LE(size, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(width, 18); buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(rowSize * height, 34);
  buf.writeInt32LE(2835, 38); buf.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4; // BMP rows are bottom-up
    const dst = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      buf[dst + x * 3] = bgra[src + x * 4];
      buf[dst + x * 3 + 1] = bgra[src + x * 4 + 1];
      buf[dst + x * 3 + 2] = bgra[src + x * 4 + 2];
    }
  }
  fs.writeFileSync(file, buf);
}

async function render(html, width, height, out) {
  const tmp = path.join(OUT, `.art-${width}.html`);
  fs.writeFileSync(tmp, html);
  const win = new BrowserWindow({ width, height, show: false, useContentSize: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL(pathToFileURL(tmp).toString());
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 300)))');
  let img = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  const s = img.getSize();
  if (s.width !== width || s.height !== height) img = img.resize({ width, height, quality: 'best' });
  writeBmp(out, img);
  fs.writeFileSync(out.replace(/\.bmp$/, '.preview.png'), img.toPNG());
  win.destroy();
  fs.unlinkSync(tmp);
}

app.on('window-all-closed', () => { /* keep running until both images are written */ });
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await render(SIDEBAR, 164, 314, path.join(OUT, 'installerSidebar.bmp'));
  await render(HEADER, 150, 57, path.join(OUT, 'installerHeader.bmp'));
  fs.copyFileSync(path.join(OUT, 'installerSidebar.bmp'), path.join(OUT, 'uninstallerSidebar.bmp'));
  console.log('installer art written');
  app.quit();
});
