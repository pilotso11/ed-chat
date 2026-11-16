// Renders each .scene of docs/images/hud-mock.html to a PNG at 2x, for the README.
// Usage: npx electron --force-device-scale-factor=2 scripts/hud-screenshots.cjs docs/images/hud-mock.html docs/images hud-explore-arrival,hud-explore-unknown,hud-explore-scanned,hud-exobiology
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const [html, out, names] = process.argv.slice(-3).map((a, i) => (i < 2 ? path.resolve(a) : a));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 1400,
    show: false,
    webPreferences: { zoomFactor: 1, offscreen: false },
  });
  await win.loadFile(html);
  await win.webContents.insertCSS(
    ".cap{display:none} .scene{display:inline-block; padding:24px 28px; border-radius:0} body{margin:0}",
  );
  await new Promise((r) => setTimeout(r, 300));
  const rects = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.scene')].map(e=>{const r=e.getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})`,
  );
  const list = names.split(",");
  fs.mkdirSync(out, { recursive: true });
  for (let i = 0; i < rects.length && i < list.length; i++) {
    const img = await win.webContents.capturePage(rects[i]);
    fs.writeFileSync(path.join(out, `${list[i]}.png`), img.toPNG());
    console.log(list[i], img.getSize());
  }
  app.quit();
});
