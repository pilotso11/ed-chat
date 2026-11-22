// Renders each panel in a scenes file (from scripts/hud-scenes.ts) in the app's own panel page,
// over a dark space background, to a PNG at 2x for the README.
// Usage: npm run build && npx electron --force-device-scale-factor=2 scripts/hud-screenshots.cjs out/hud-scenes.json docs/images
const { app, BrowserWindow } = require("electron");
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
  await win.loadFile(path.join(root, "renderer", "hud.html"));
  await win.webContents.insertCSS(BACKGROUND);
  fs.mkdirSync(outDir, { recursive: true });
  for (const { name, view } of scenes) {
    win.webContents.send("hud:view", view);
    // Rendered and laid out, then measured: the panel's own size report comes only on a change.
    await new Promise((r) => setTimeout(r, 500));
    // The padded root, where it is: the panel and the background around it.
    const r = await win.webContents.executeJavaScript(
      `(() => { const r = document.getElementById("root").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
    );
    const [winW, winH] = win.getContentSize();
    if (r.x + r.width > winW || r.y + r.height > winH)
      throw new Error(`${name}: the panel (${r.width}x${r.height}) does not fit the window`);
    const img = await win.webContents.capturePage({
      x: Math.floor(r.x),
      y: Math.floor(r.y),
      width: Math.ceil(r.width),
      height: Math.ceil(r.height),
    });
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
    console.log(name, img.getSize());
  }
  app.quit();
});
