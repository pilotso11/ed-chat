// Compares two renders of the panel scenes, such as main's and a branch's, for a change that must
// not change how the panels look. For each scene it compares the view (the panel's rows, header
// and footer, and the route rows) from scripts/hud-scenes.ts, and the PNGs from
// scripts/hud-screenshots.cjs pixel by pixel, and says which scenes differ. A PNG that differs
// gets a copy with the changed pixels in red, in the after folder, named <scene>.diff.png.
//
// Usage: npx electron scripts/hud-compare.cjs <before.json> <before dir> <after.json> <after dir>
//          [after-scene=before-scene ...]
// Each pair compares an after scene with another before scene, such as a plan with stop actions
// against the same plan with cargo only: hud-trade-actions=hud-trade.
// Exits 1 when a scene differs.
const { app, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith("hud-compare.cjs")) + 1);
const [beforeFile, beforeDir, afterFile, afterDir, ...pairs] = args;

/** The view as JSON with its keys in order, so two views with the same content compare equal. */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .filter((k) => v[k] !== undefined)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  return v;
}

/** The lines of a view, for showing what differs: the header, each row, the footer, the route. */
function lines(view) {
  const p = view.panel;
  const out = [];
  if (p) {
    out.push(`header: ${JSON.stringify(canonical({ ...p, rows: undefined, footer: undefined }))}`);
    for (const r of p.rows ?? []) out.push(`row: ${JSON.stringify(canonical(r))}`);
    for (const f of p.footer ?? []) out.push(`footer: ${JSON.stringify(canonical(f))}`);
  } else out.push("panel: null");
  for (const r of view.route ?? []) out.push(`route: ${JSON.stringify(canonical(r))}`);
  return out;
}

/** The lines only in a, and only in b, in order. */
function diffLines(a, b) {
  const only = (x, y) => x.filter((l) => !y.includes(l));
  return { removed: only(a, b), added: only(b, a) };
}

/** Pixels that differ between two PNGs, with a copy of the after one marking them red. */
function pixels(beforePng, afterPng, diffPng) {
  const a = nativeImage.createFromPath(beforePng);
  const b = nativeImage.createFromPath(afterPng);
  if (a.isEmpty() || b.isEmpty()) return { error: `missing ${a.isEmpty() ? beforePng : afterPng}` };
  const sa = a.getSize();
  const sb = b.getSize();
  if (sa.width !== sb.width || sa.height !== sb.height)
    return { error: `size ${sa.width}x${sa.height} → ${sb.width}x${sb.height}` };
  const pa = a.toBitmap();
  const pb = b.toBitmap();
  const marked = Buffer.from(pb);
  let n = 0;
  for (let i = 0; i < pa.length; i += 4) {
    if (
      pa[i] === pb[i] &&
      pa[i + 1] === pb[i + 1] &&
      pa[i + 2] === pb[i + 2] &&
      pa[i + 3] === pb[i + 3]
    )
      continue;
    n++;
    // BGRA: red.
    marked[i] = 0;
    marked[i + 1] = 0;
    marked[i + 2] = 255;
    marked[i + 3] = 255;
  }
  if (n) {
    const img = nativeImage.createFromBitmap(marked, { width: sb.width, height: sb.height });
    fs.writeFileSync(diffPng, img.toPNG());
  }
  return { differ: n, total: pa.length / 4 };
}

app
  .whenReady()
  .then(() => {
    if (!beforeFile || !beforeDir || !afterFile || !afterDir) {
      console.error(
        "usage: electron scripts/hud-compare.cjs <before.json> <before dir> <after.json> <after dir> [after=before ...]",
      );
      app.exit(2);
      return;
    }
    const read = (f) =>
      new Map(JSON.parse(fs.readFileSync(f, "utf8")).map((s) => [s.name, s.view]));
    const before = read(beforeFile);
    const after = read(afterFile);
    const compared = [...after.keys()].filter((n) => before.has(n)).map((n) => [n, n]);
    for (const p of pairs) {
      const [a, b] = p.split("=");
      compared.push([a, b]);
    }
    let differ = 0;
    for (const [a, b] of compared) {
      const name = a === b ? a : `${a} (after) vs ${b} (before)`;
      const va = after.get(a);
      const vb = before.get(b);
      if (!va || !vb) {
        console.log(`${name}: MISSING ${!va ? `${a} in after` : `${b} in before`}`);
        differ++;
        continue;
      }
      const same = JSON.stringify(canonical(vb)) === JSON.stringify(canonical(va));
      const px = pixels(
        path.join(beforeDir, `${b}.png`),
        path.join(afterDir, `${a}.png`),
        path.join(afterDir, `${a === b ? a : `${a}-vs-${b}`}.diff.png`),
      );
      const pxText = px.error
        ? `PNG ${px.error}`
        : px.differ
          ? `PNG ${px.differ} of ${px.total} pixels differ`
          : "PNG identical";
      const ok = same && !px.error && !px.differ;
      if (!ok) differ++;
      console.log(
        `${name}: ${ok ? "SAME" : "DIFFERS"} · view ${same ? "identical" : "differs"} · ${pxText}`,
      );
      if (!same) {
        const d = diffLines(lines(vb), lines(va));
        for (const l of d.removed) console.log(`  - ${l}`);
        for (const l of d.added) console.log(`  + ${l}`);
        // The same lines in another order, or another difference no line shows.
        if (!d.removed.length && !d.added.length)
          console.log("  (the same lines; order or other fields differ)");
      }
    }
    const only = [...after.keys()].filter(
      (n) => !before.has(n) && !pairs.some((p) => p.startsWith(`${n}=`)),
    );
    if (only.length) console.log(`New scenes, not compared: ${only.join(", ")}`);
    console.log(differ ? `${differ} scene(s) differ` : "Every scene compared is the same");
    app.exit(differ ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    app.exit(2);
  });
