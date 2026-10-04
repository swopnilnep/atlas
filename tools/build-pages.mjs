// Generates static HTML for every catalog piece (views/catalog.json) before `vite build`.
// Output: .generated/<route>/index.html, .generated/routes.json, .generated/sitemap.xml.
// The folder is gitignored and rebuilt from scratch on every run.
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AUTHORED_ROUTES, GENERATED_DIR, GENERIC_ATTRIBUTION, buildPages, renderSitemap } from "./lib/site.mjs";
import { loadViews, manifestAttribution } from "./lib/views.mjs";

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(root, GENERATED_DIR);
const assetExists = (/** @type {string} */ publicPath) => existsSync(join(root, "public", publicPath));

const views = await loadViews(resolve(root, "views"));
const pages = buildPages(views, assetExists, manifestAttribution(join(root, "public"), GENERIC_ATTRIBUTION));

await rm(outDir, { recursive: true, force: true });
for (const page of pages) {
  const file = resolve(outDir, page.file);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, page.html);
}
const generatedRoutes = pages.map((p) => p.route);
await writeFile(resolve(outDir, "routes.json"), `${JSON.stringify(generatedRoutes, null, 2)}\n`);
await writeFile(resolve(outDir, "sitemap.xml"), renderSitemap([...AUTHORED_ROUTES, ...generatedRoutes]));

const drafts = views.filter((v) => v.status === "draft").length;
console.log(`Generated ${pages.length} pages from ${views.length} view configs (${drafts} draft) into ${GENERATED_DIR}/.`);
