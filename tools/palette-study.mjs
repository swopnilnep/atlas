// Black palette study: renders Seattle and Austin metro in Black with each accent candidate,
// measures the fraction of pixels that are exactly #000000 at 1280 × 800, and writes
// docs/palette-study/black-<view>-<accent>.png plus black-contact-sheet.png.
// Usage: node tools/palette-study.mjs   (starts the Vite dev server itself; needs Playwright Chromium)
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { launch, startServer } from "./lib/browser-render.mjs";

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(root, "docs/palette-study");
const VIEWS = [
  { id: "seattle-metro", title: "Seattle metro", dataFile: "/data/seattle-metro-v1.json" },
  { id: "austin-metro", title: "Austin metro", dataFile: "/data/austin-metro-v1.json" }
];
const ACCENTS = ["cobalt", "amber", "coral"];

execFileSync(process.execPath, [resolve(root, "tools/build-pages.mjs")], { stdio: "inherit" });
const server = await startServer({ mode: "dev", port: 5192 });
const browser = await launch();
try {
  const page = await browser.newPage();
  await page.goto(`${server.origin}/about/`);
  const result = await page.evaluate(async ({ views, accents }) => {
    const paths = ["/src/renderer.ts", "/src/render/load.ts", "/src/render/label.ts", "/src/render/palettes.ts"];
    const [{ renderArtwork }, { loadView }, { loadFonts }, { BLACK_ACCENTS, PALETTES }] = await Promise.all(paths.map((path) => import(path)));
    await loadFonts();
    const W = 1280, H = 800;
    const measure = (/** @type {CanvasRenderingContext2D} */ ctx, /** @type {(r: number, g: number, b: number) => boolean} */ test) => {
      const d = ctx.getImageData(0, 0, W, H).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (test(d[i], d[i + 1], d[i + 2])) n += 1;
      return n / (W * H);
    };
    const render = (/** @type {any} */ loaded, /** @type {Record<string, unknown>} */ options) => {
      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d", { willReadFrequently: true }));
      renderArtwork(ctx, loaded.view, { style: "urban-relief", width: W, height: H, attribution: loaded.attribution, ...options });
      return { canvas, ctx };
    };
    const isBlack = (/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b) => r === 0 && g === 0 && b === 0;
    const rows = [];
    const sheet = document.createElement("canvas");
    const cell = { w: 640, h: 400, gap: 16, caption: 34 };
    sheet.width = accents.length * cell.w + (accents.length + 1) * cell.gap;
    sheet.height = views.length * (cell.h + cell.caption) + (views.length + 1) * cell.gap;
    const s = /** @type {CanvasRenderingContext2D} */ (sheet.getContext("2d"));
    s.fillStyle = "#1a1a1a";
    s.fillRect(0, 0, sheet.width, sheet.height);
    const images = [];
    for (const [vi, view] of views.entries()) {
      const loaded = await loadView(view.dataFile);
      // Share of the frame covered by water (exact water colour in Ink and River, no label).
      const ink = render(loaded, { palette: "ink-and-river", label: false, layers: { waterways: false, rail: false, minorRoads: false, majorRoads: false } });
      const [wr, wg, wb] = [1, 3, 5].map((i) => Number.parseInt(PALETTES["ink-and-river"].water.slice(i, i + 2), 16));
      const waterShare = measure(ink.ctx, (r, g, b) => r === wr && g === wg && b === wb);
      for (const [ai, accent] of accents.entries()) {
        const full = render(loaded, { palette: "black", blackAccent: accent });
        const black = measure(full.ctx, isBlack);
        const noMinor = measure(render(loaded, { palette: "black", blackAccent: accent, layers: { minorRoads: false } }).ctx, isBlack);
        const noMinorNoStreams = measure(render(loaded, { palette: "black", blackAccent: accent, layers: { minorRoads: false, waterways: false } }).ctx, isBlack);
        // Same artwork at the 3840 × 2400 download size.
        const big = document.createElement("canvas");
        big.width = 3840; big.height = 2400;
        const bctx = /** @type {CanvasRenderingContext2D} */ (big.getContext("2d", { willReadFrequently: true }));
        renderArtwork(bctx, loaded.view, { style: "urban-relief", palette: "black", blackAccent: accent, width: 3840, height: 2400, attribution: loaded.attribution });
        const bd = bctx.getImageData(0, 0, 3840, 2400).data;
        let bn = 0;
        for (let i = 0; i < bd.length; i += 4) if (bd[i] === 0 && bd[i + 1] === 0 && bd[i + 2] === 0) bn += 1;
        const black4k = bn / (3840 * 2400);
        big.width = 0;
        rows.push({ view: view.id, accent, hex: BLACK_ACCENTS[accent], black, black4k, noMinor, noMinorNoStreams, waterShare });
        images.push({ name: `black-${view.id}-${accent}.png`, url: full.canvas.toDataURL("image/png") });
        const x = cell.gap + ai * (cell.w + cell.gap);
        const y = cell.gap + vi * (cell.h + cell.caption + cell.gap);
        s.drawImage(full.canvas, x, y, cell.w, cell.h);
        s.fillStyle = "#e6e6e3";
        s.font = "15px system-ui, sans-serif";
        s.fillText(`${view.title} · ${accent} ${BLACK_ACCENTS[accent]} · exact black ${(black * 100).toFixed(1)}%`, x, y + cell.h + 23);
      }
    }
    images.push({ name: "black-contact-sheet.png", url: sheet.toDataURL("image/png") });
    return { rows, images };
  }, { views: VIEWS, accents: ACCENTS });

  for (const image of result.images) await writeFile(resolve(outDir, image.name), Buffer.from(image.url.split(",")[1], "base64"));
  const pct = (/** @type {number} */ x) => `${(x * 100).toFixed(1)}%`;
  console.log("| View | Accent | Exact black 1280×800 | Exact black 3840×2400 | 1280, no minor roads | 1280, no minor roads or streams | Water share of frame |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of result.rows) console.log(`| ${r.view} | ${r.accent} \`${r.hex}\` | ${pct(r.black)} | ${pct(r.black4k)} | ${pct(r.noMinor)} | ${pct(r.noMinorNoStreams)} | ${pct(r.waterShare)} |`);
} finally {
  await browser.close();
  server.stop();
}
