// Draws assets/icon.png (1024x1024) with Electron's own canvas, so no image tools are needed.
//   npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, webPreferences: { offscreen: true } });
  const html = `<body style="margin:0;background:transparent"><canvas id=c width=1024 height=1024></canvas><script>
    const c = document.getElementById('c').getContext('2d');
    c.fillStyle = '#1f1e1d'; c.beginPath(); c.roundRect(64, 64, 896, 896, 200); c.fill();
    // an open book: two pages, a spine line, three text lines on each
    c.fillStyle = '#f6f5f3';
    c.beginPath(); c.moveTo(512, 300); c.quadraticCurveTo(380, 250, 230, 290); c.lineTo(230, 730); c.quadraticCurveTo(380, 690, 512, 740); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(512, 300); c.quadraticCurveTo(644, 250, 794, 290); c.lineTo(794, 730); c.quadraticCurveTo(644, 690, 512, 740); c.closePath(); c.fill();
    c.strokeStyle = '#1f1e1d'; c.lineWidth = 10; c.lineCap = 'round';
    for (const [x0, x1, s] of [[290, 470, 1], [554, 734, -1]]) for (let i = 0; i < 4; i++) { const y = 390 + i * 70; c.beginPath(); c.moveTo(x0, y); c.lineTo(i == 3 ? x0 + (x1 - x0) * 0.6 : x1, y + (s > 0 ? 8 : 8)); c.stroke(); }
    c.lineWidth = 12; c.beginPath(); c.moveTo(512, 306); c.lineTo(512, 736); c.stroke();
  <\/script>`;
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.mkdirSync(path.join(__dirname, "..", "assets"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "assets", "icon.png"), img.toPNG());
  app.quit();
});
