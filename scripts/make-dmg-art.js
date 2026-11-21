'use strict';
// Renders the background of the macOS disk image (600x400, and @2x for Retina screens) from HTML
// with Electron, so the four languages use real fonts. The two icons sit on top of it at the
// places given in package.json › build.dmg.contents (Best at x 170, Applications at x 430, y 175).
// Usage: npx electron scripts/make-dmg-art.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'mac');
const font = (f) => pathToFileURL(path.join(ROOT, 'renderer', 'fonts', f)).toString();

const page = (scale) => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Inter; src: url('${font('Inter-500.woff2')}'); font-weight: 500; }
@font-face { font-family: Inter; src: url('${font('Inter-cyr-500.woff2')}'); font-weight: 500; unicode-range: U+0400-045F; }
@font-face { font-family: Inter; src: url('${font('Inter-600.woff2')}'); font-weight: 600; }
@font-face { font-family: Vazirmatn; src: url('${font('Vazirmatn.woff2')}'); font-weight: 100 900; }
* { margin: 0; box-sizing: border-box; }
html { zoom: ${scale}; }
html, body { width: 600px; height: 400px; overflow: hidden; }
body { background: #F5F6F8; font-family: Inter, sans-serif; -webkit-font-smoothing: antialiased; color: #2E3440; position: relative; }
.arrow { position: absolute; left: 248px; top: 160px; }
.hint { position: absolute; left: 0; right: 0; top: 258px; text-align: center; font-size: 13px; line-height: 1.7; color: #4E5664; font-weight: 500; }
.fa { font-family: Vazirmatn, sans-serif; direction: rtl; }
.zh { font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif; }
.foot { position: absolute; left: 0; right: 0; bottom: 14px; text-align: center; font-size: 11px; color: #5F6876; }
</style></head><body>
<svg class="arrow" width="104" height="30" viewBox="0 0 104 30" fill="none" stroke="#8B95A3" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15h92M84 5l12 10-12 10"/></svg>
<div class="hint">
  <div>Drag Best to Applications</div>
  <div>Перетащите Best в Applications</div>
  <div class="fa">Best را روی Applications بکشید</div>
  <div class="zh">将 Best 拖到 Applications</div>
</div>
<div class="foot">github.com/Mo7amadd/Best</div>
</body></html>`;

async function render(scale, out) {
  const tmp = path.join(OUT, `.dmg-${scale}.html`);
  fs.writeFileSync(tmp, page(scale));
  // Drawn at the final size (CSS zoom), so the Retina copy is sharp, not an enlarged 600x400 one.
  const win = new BrowserWindow({ width: 600 * scale, height: 400 * scale, show: false, useContentSize: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL(pathToFileURL(tmp).toString());
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 300)))');
  let img = await win.webContents.capturePage({ x: 0, y: 0, width: 600 * scale, height: 400 * scale });
  const s = img.getSize();
  if (s.width !== 600 * scale || s.height !== 400 * scale) img = img.resize({ width: 600 * scale, height: 400 * scale, quality: 'best' });
  fs.writeFileSync(out, img.toPNG());
  win.destroy();
  fs.unlinkSync(tmp);
}

app.on('window-all-closed', () => { /* keep running until both images are written */ });
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await render(1, path.join(OUT, 'dmg-background.png'));
  await render(2, path.join(OUT, 'dmg-background@2x.png'));
  console.log('disk image background written');
  app.quit();
});
