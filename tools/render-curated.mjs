// Renders one 1280 × 800 WebP preview per published piece, in its default palette, through the
// production build (vite preview of dist/) in headless Chromium, driving the real Create page:
//   public/artwork/<id>-<defaultPalette>.webp
// No PNGs are stored: view pages render 3840 × 2400 downloads locally.
// Usage: npm run render:curated [-- <id> ...] [-- --time4k]   (builds first; rebuild afterwards)
//   --time4k  also export each piece at 3840 × 2400 and report the drawing time (not stored).
import { execFileSync } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, startServer } from "./lib/browser-render.mjs";
import { loadViews, previewPath } from "./lib/views.mjs";

const root = resolve(import.meta.dirname, "..");
const scratch = join(tmpdir(), "atlas-render-curated");
const WEBP_QUALITY = 0.85;
const args = process.argv.slice(2);
const time4k = args.includes("--time4k");
const only = args.filter((a) => !a.startsWith("--"));

execFileSync("npm", ["run", "build", "--silent"], { cwd: root, stdio: "inherit" });
const views = (await loadViews(resolve(root, "views"))).filter((v) => v.status === "published" && (!only.length || only.includes(`${v.place}-${v.view}`)));
await mkdir(resolve(root, "public/artwork"), { recursive: true });
await mkdir(scratch, { recursive: true });

// Remove previews of non-default palettes (only the default one is stored).
const keep = new Set((await loadViews(resolve(root, "views"))).map((v) => previewPath(v, v.defaultPalette).slice("/artwork/".length)));
for (const file of await readdir(resolve(root, "public/artwork"))) if (file.endsWith(".webp") && !keep.has(file)) await rm(resolve(root, "public/artwork", file));

const server = await startServer({ mode: "preview", port: 4178 });
const browser = await launch();
/** @type {Record<string, unknown>[]} */
const report = [];
const t0 = Date.now();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: true });
  for (const view of views) {
    page.removeAllListeners("pageerror");
    page.on("pageerror", (error) => console.error(`[${view.place}/${view.view}] ${error.message}`));
    const start = Date.now();
    await page.goto(`${server.origin}/create/?place=${view.place}&view=${view.view}&palette=${view.defaultPalette}&size=3840x2400`);
    const canvas = page.locator("#artwork-canvas");
    const key = `${view.place}/${view.view}/${view.defaultPalette}/1280x800/label`;
    await page.waitForFunction((k) => document.querySelector("#artwork-canvas")?.getAttribute("data-rendered") === k, key, { timeout: 120000 });
    const renderMs = Number(await canvas.getAttribute("data-render-ms"));
    const loadMs = Number(await canvas.getAttribute("data-load-ms"));
    const webp = await canvas.evaluate((c, q) => /** @type {HTMLCanvasElement} */ (c).toDataURL("image/webp", q), WEBP_QUALITY);
    const bytes = Buffer.from(webp.split(",")[1], "base64");
    await writeFile(resolve(root, "public", previewPath(view, view.defaultPalette).slice(1)), bytes);
    const row = { id: `${view.place}-${view.view}`, style: view.style, webpBytes: bytes.length, loadMs, previewRenderMs: renderMs, wallMs: Date.now() - start };
    if (time4k) {
      const downloadPromise = page.waitForEvent("download", { timeout: 180000 });
      await page.click("#download-button");
      const download = await downloadPromise;
      await download.saveAs(join(scratch, "last.png"));
      await page.waitForFunction(() => !(/** @type {HTMLButtonElement} */ (document.querySelector("#download-button"))).disabled);
      Object.assign(row, { export4kRenderMs: Number(await canvas.getAttribute("data-export-render-ms")), export4kTotalMs: Number(await canvas.getAttribute("data-export-ms")) });
    }
    report.push(row);
    console.log(`${row.id}: webp ${(bytes.length / 1024).toFixed(0)} KB, load ${loadMs.toFixed(0)} ms, draw ${renderMs.toFixed(0)} ms${time4k ? `, 4K draw ${row.export4kRenderMs} ms (with PNG ${row.export4kTotalMs} ms)` : ""}`);
  }
  await page.close();
} finally {
  await browser.close();
  server.stop();
}
await writeFile(join(scratch, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.length} previews in ${((Date.now() - t0) / 1000).toFixed(0)} s. Report: ${join(scratch, "report.json")}. Run \`npm run build\` again so dist/ includes them.`);
