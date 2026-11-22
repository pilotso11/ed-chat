// Renders each panel in a scenes file (from scripts/hud-scenes.ts) in the app's own panel page,
// over a dark space background, to a PNG at 2x for the README.
// Usage: npm run build && npx electron --force-device-scale-factor=2 scripts/hud-screenshots.cjs out/hud-scenes.json docs/images
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const [scenesFile, outDir] = process.argv.slice(-2).map((a) => path.resolve(a));
const root = path.join(__dirname, "..", "out");
const PAD = 24;
const BACKGROUND = `
  html, body {
    background:
      radial-gradient(circle at 80% 30%, rgba(255, 190, 120, 0.35), transparent 30%),
      radial-gradient(circle at 15% 80%, rgba(90, 120, 200, 0.25), transparent 40%),
      #05060a !important;
  }
  #root { display: inline-block; padding: ${PAD}px; }
`;

app.whenReady().then(async () => {
  const scenes = JSON.parse(fs.readFileSync(scenesFile, "utf8"));
  const win = new BrowserWindow({
    width: 1200,
    height: 1600,
    show: false,
    webPreferences: {
      preload: path.join(root, "preload", "index.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // The panel reports its size after each render, as it does to the app.
  let sized = null;
  ipcMain.on("hud:size", (_e, w, h) => sized?.({ width: w, height: h }));
  await win.loadFile(path.join(root, "renderer", "hud.html"));
  await win.webContents.insertCSS(BACKGROUND);
  fs.mkdirSync(outDir, { recursive: true });
  for (const { name, view } of scenes) {
    const size = new Promise((r) => (sized = r));
    win.webContents.send("hud:view", view);
    const { width, height } = await size;
    // Fonts and layout settle a frame after the size is reported.
    await new Promise((r) => setTimeout(r, 300));
    const img = await win.webContents.capturePage({
      x: 0,
      y: 0,
      width: Math.ceil(width) + 2 * PAD,
      height: Math.ceil(height) + 2 * PAD,
    });
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
    console.log(name, img.getSize());
  }
  app.quit();
});
