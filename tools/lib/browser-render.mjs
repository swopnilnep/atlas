// Helpers for rendering with the real renderer in headless Chromium (Playwright).
// Used by tools/palette-study.mjs and for local inspection; tools/render-curated.mjs drives the
// production Create page instead.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "../..");

/** @param {string} origin */
export async function waitForServer(origin, attempts = 300) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server at ${origin} did not start.`);
}

/**
 * Starts `vite` (dev, so /src modules can be imported in the page) or `vite preview` (production build).
 * @param {{ mode: "dev" | "preview", port: number }} options
 */
export async function startServer({ mode, port }) {
  const args = mode === "dev" ? ["--host", "127.0.0.1", "--port", String(port), "--strictPort"] : ["preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"];
  const server = spawn(process.execPath, [resolve(root, "node_modules/vite/bin/vite.js"), ...args], { cwd: root, stdio: "ignore" });
  const origin = `http://127.0.0.1:${port}`;
  await waitForServer(origin);
  return { origin, stop: () => server.kill("SIGTERM") };
}

export async function launch() {
  return chromium.launch({ headless: true });
}

/**
 * Renders in a dev-server page by importing the renderer modules directly.
 * Returns PNG bytes plus the fraction of pixels that are exactly #000000.
 * @param {import("playwright").Page} page
 * @param {{ dataFile: string, options: Record<string, unknown> }} job
 */
export async function renderInDevPage(page, job) {
  const result = await page.evaluate(async ({ dataFile, options }) => {
    // Module paths are served by the Vite dev server (not resolvable by tsc, hence the variables).
    const paths = ["/src/renderer.ts", "/src/render/load.ts", "/src/render/label.ts"];
    const [{ renderArtwork }, { loadView }, { loadFonts }] = await Promise.all(paths.map((path) => import(path)));
    const loaded = await loadView(dataFile);
    await loadFonts("/fonts/", loaded.view.label);
    const canvas = document.createElement("canvas");
    canvas.width = /** @type {number} */ (options.width);
    canvas.height = /** @type {number} */ (options.height);
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
    const start = performance.now();
    renderArtwork(ctx, loaded.view, { ...options, attribution: loaded.attribution });
    const ms = performance.now() - start;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let black = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0) black += 1;
    const url = canvas.toDataURL("image/png");
    return { url, ms, blackFraction: black / (canvas.width * canvas.height) };
  }, job);
  return { png: Buffer.from(result.url.split(",")[1], "base64"), ms: result.ms, blackFraction: result.blackFraction };
}
