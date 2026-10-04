// Checks the production output in dist/ after `npm run build`.
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AUTHORED_ROUTES, buildPages, hasPreview } from "./lib/site.mjs";
import { loadViews, previewPath } from "./lib/views.mjs";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const errors = [];
const fail = (message) => errors.push(message);

// 1. Configs (loadViews validates each file and the set).
const views = await loadViews(resolve(root, "views"));
const assetExists = (publicPath) => existsSync(join(root, "public", publicPath));
const generatedRoutes = buildPages(views, assetExists).map((p) => p.route);
const routes = [...AUTHORED_ROUTES, ...generatedRoutes];

// 2. Every route exists and is a complete page with nav and footer.
for (const route of routes) {
  const file = resolve(dist, route.slice(1), "index.html");
  if (!existsSync(file)) { fail(`${route}: missing ${file}`); continue; }
  const html = await readFile(file, "utf8");
  if (!/<title>[^<]+<\/title>/.test(html)) fail(`${route}: missing <title>.`);
  if (!html.includes(`aria-label="Main navigation"`)) fail(`${route}: missing main navigation.`);
  if (!html.includes(`data-theme-toggle`)) fail(`${route}: missing theme toggle.`);
  if (!html.includes(`localStorage.getItem("theme")`)) fail(`${route}: missing pre-paint theme script.`);
  if (!/<footer class="site-footer">[\s\S]*href="\/sources\/"/.test(html)) fail(`${route}: footer is missing the Sources link.`);
  if (html.includes("<!--atlas:")) fail(`${route}: unfilled <!--atlas:*--> placeholder.`);
  if (html.includes("/src/")) fail(`${route}: references unbuilt /src/ files.`);
  if (html.includes("/austin/urban-relief")) fail(`${route}: links to the removed /austin/urban-relief/ page.`);
  const nav = html.match(/<nav class="nav-links"[\s\S]*?<\/nav>/)?.[0] ?? "";
  const navHrefs = ["/", "/cities/", "/terrain/", "/hydrology/", "/coasts/", "/formations/", "/create/", "/about/"];
  for (const href of navHrefs) if (!nav.includes(`href="${href}"`)) fail(`${route}: nav is missing ${href}.`);
  if (navHrefs.includes(route) && !nav.includes(`href="${route}" aria-current="page"`)) fail(`${route}: nav does not mark the current page.`);
}

// 3. Published views need their default-palette preview and data; nothing else is pre-rendered.
for (const view of views) {
  const html = await readFile(resolve(dist, view.place, view.view, "index.html"), "utf8").catch(() => "");
  if (view.status === "published") {
    const webp = join(dist, previewPath(view, view.defaultPalette));
    if (!existsSync(webp)) fail(`${view.place}/${view.view}: missing preview ${previewPath(view, view.defaultPalette)}.`);
    else {
      const bytes = await readFile(webp);
      if (bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP") fail(`${previewPath(view, view.defaultPalette)} is not a WebP file.`);
    }
    if (!existsSync(join(dist, view.dataFile.replace(/\.json$/, ".manifest.json")))) fail(`${view.place}/${view.view}: missing manifest for ${view.dataFile}.`);
    if (!existsSync(join(dist, view.dataFile))) fail(`${view.place}/${view.view}: missing data file ${view.dataFile}.`);
    // The download renders locally; without JS it links to Create with this preset at 3840 × 2400.
    if (!html.includes(`data-download data-default-palette="${view.defaultPalette}" href="/create/?place=${view.place}&amp;view=${view.view}&amp;palette=${view.defaultPalette}&amp;size=3840x2400"`)) fail(`${view.place}/${view.view}: download button does not fall back to Create.`);
    if (!html.includes("OpenStreetMap contributors")) fail(`${view.place}/${view.view}: page is missing the attribution next to the download.`);
  } else {
    if (html.includes(" download") || html.includes("data-download")) fail(`${view.place}/${view.view}: draft view shows download links.`);
    if (!html.includes("preview-placeholder")) fail(`${view.place}/${view.view}: draft view should show the preview placeholder.`);
  }
  if (!html.includes(`/create/?place=${view.place}&amp;view=${view.view}&amp;palette=${view.defaultPalette}`)) fail(`${view.place}/${view.view}: missing "Customize this" link.`);
  if (view.status === "published" && !hasPreview(view, view.defaultPalette, assetExists)) fail(`${view.place}/${view.view}: default preview is not shown.`);
}
if (existsSync(join(dist, "downloads"))) fail("dist/downloads/ exists; 4K PNGs are no longer stored.");

// 4. Create page: catalog embedded, renderable fixture shipped, single attribution.
const create = await readFile(resolve(dist, "create/index.html"), "utf8");
const catalogJson = create.match(/<script type="application\/json" id="view-catalog">([\s\S]*?)<\/script>/)?.[1];
if (!catalogJson) fail("/create/: missing embedded view catalog.");
else if (JSON.parse(catalogJson).length !== views.length) fail("/create/: view catalog does not list every view.");
if (create.includes("Render preview")) fail("/create/: still has a manual Render preview button.");
if (create.includes("OpenStreetMap contributors · Elevation: U.S. Geological Survey")) fail("/create/: duplicate attribution text below the canvas.");
for (const file of ["CNAME", "fonts/inter-latin-400.woff2", "fonts/inter-latin-600.woff2", "fonts/Inter-OFL.txt"]) if (!existsSync(join(dist, file))) fail(`missing ${file}.`);
for (const file of ["data/austin-v1.json", "data/austin-v1.manifest.json"]) if (existsSync(join(dist, file))) fail(`the removed v1 POC file ${file} is still shipped.`);
const sources = await readFile(resolve(dist, "sources/index.html"), "utf8").catch(() => "");
for (const view of views) if (view.status === "published" && !sources.includes(view.dataFile.replace(/\.json$/, ".manifest.json"))) fail(`/sources/: missing manifest link for ${view.place}/${view.view}.`);

// 5. Sitemap lists exactly the routes.
const sitemap = await readFile(resolve(dist, "sitemap.xml"), "utf8").catch(() => "");
for (const route of routes) if (!sitemap.includes(`<loc>https://atlas.swopnil.com${route}</loc>`)) fail(`sitemap.xml is missing ${route}.`);
if ((sitemap.match(/<loc>/g) ?? []).length !== routes.length) fail("sitemap.xml lists routes that do not exist.");

// 6. No stray HTML pages outside the known routes (e.g. a leftover .generated/ prefix).
async function htmlFiles(directory, prefix = "") {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...await htmlFiles(join(directory, entry.name), `${prefix}${entry.name}/`));
    else if (entry.name.endsWith(".html")) found.push(`/${prefix}${entry.name}`.replace(/index\.html$/, ""));
  }
  return found;
}
for (const page of await htmlFiles(dist)) if (!routes.includes(page)) fail(`unexpected page in dist: ${page}`);

if (errors.length) {
  console.error(`Build validation failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
const published = views.filter((v) => v.status === "published").length;
let assetBytes = 0;
let dataBytes = 0;
for (const view of views) {
  assetBytes += (await stat(join(dist, previewPath(view, view.defaultPalette))).catch(() => ({ size: 0 }))).size;
  dataBytes += (await stat(join(dist, view.dataFile)).catch(() => ({ size: 0 }))).size;
}
console.log(`Validated ${routes.length} routes (${generatedRoutes.length} generated), ${views.length} view configs (${published} published); previews ${(assetBytes / 1e6).toFixed(2)} MB, data ${(dataBytes / 1e6).toFixed(1)} MB.`);
