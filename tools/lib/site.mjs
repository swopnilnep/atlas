// Static page templates and route generation from view configs.
// Plain template strings; every interpolated value goes through esc().
import { CATEGORIES, CATEGORY_NAMES, PALETTE_NAMES, STYLE_NAMES, previewPath, titleFromSlug, viewCatalog } from "./views.mjs";

/** @typedef {import("../../src/types").ViewConfig} ViewConfig */
/** @typedef {(publicPath: string) => boolean} AssetExists */
/** @typedef {(view: ViewConfig) => string} AttributionFor */

/** Used when a manifest has no requiredAttribution. */
export const GENERIC_ATTRIBUTION = "© OpenStreetMap contributors · Protomaps · Elevation: AWS Terrain Tiles (USGS 3DEP, SRTM, GMTED2010 and others)";
/** @type {AttributionFor} */
const genericAttribution = () => GENERIC_ATTRIBUTION;

export const SITE_ORIGIN = "https://atlas.swopnil.com";
export const GENERATED_DIR = ".generated";
/** Hand-written pages. Their header, footer, and card lists are filled in by the Vite plugin. */
export const AUTHORED_ROUTES = ["/", "/create/", "/about/", "/sources/"];

const NAV = [
  { href: "/", label: "Atlas" },
  { href: "/cities/", label: "Cities" },
  { href: "/terrain/", label: "Terrain" },
  { href: "/hydrology/", label: "Hydrology" },
  { href: "/coasts/", label: "Coasts & Islands" },
  { href: "/formations/", label: "Formations" },
  { href: "/create/", label: "Create" },
  { href: "/about/", label: "About" }
];

/** @param {unknown} value */
export function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c] ?? c);
}

/** Pre-paint theme script, stylesheet, and theme toggle module. */
export function renderHeadAssets() {
  return [
    `<script>(function(){try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}})();</script>`,
    `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`,
    `<link rel="stylesheet" href="/src/style.css">`,
    `<script type="module" src="/src/theme.ts"></script>`
  ].join("\n  ");
}

/**
 * @param {string} path current route, e.g. "/austin/metro/"
 * @param {string} [section] nav href that contains this page, e.g. "/cities/"
 */
export function renderHeader(path, section) {
  const links = NAV.map(({ href, label }) => {
    const current = href === path ? ` aria-current="page"` : href === section ? ` aria-current="true"` : "";
    return `<a href="${href}"${current}>${label}</a>`;
  }).join("");
  return `<header class="container site-nav"><nav class="nav-links" aria-label="Main navigation">${links}</nav>`
    + `<button class="theme-toggle" type="button" data-theme-toggle aria-label="Toggle light / dark theme" title="Toggle theme">`
    + `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/></svg>`
    + `</button></header>`;
}

/** @param {string} path */
export function renderFooter(path) {
  const sources = path === "/sources/" ? ` aria-current="page"` : "";
  return `<footer class="site-footer"><div class="container"><span>Map data © OpenStreetMap contributors · Protomaps · Elevation: AWS Terrain Tiles</span>`
    + `<span class="footer-links"><a href="/sources/"${sources}>Sources</a><a href="https://github.com/swopnilnep/atlas">Source code</a><a href="https://swopnil.com">swopnil.com</a></span></div></footer>`;
}

/** @param {ViewConfig} view */
export const viewRoute = (view) => `/${view.place}/${view.view}/`;
/** @param {ViewConfig} view */
const viewName = (view) => titleFromSlug(view.view);

/**
 * True when the view may show its preview for this palette.
 * @param {ViewConfig} view @param {string} palette @param {AssetExists} assetExists
 */
export function hasPreview(view, palette, assetExists) {
  return view.status === "published" && assetExists(previewPath(view, palette));
}

/**
 * A 16:10 preview image, or a placeholder of the same size.
 * @param {ViewConfig} view @param {string} palette @param {AssetExists} assetExists
 * @param {{ lazy?: boolean, attrs?: string }} [options]
 */
export function renderPreview(view, palette, assetExists, options = {}) {
  const attrs = options.attrs ?? "";
  const label = `${view.title} ${viewName(view)}`;
  if (hasPreview(view, palette, assetExists)) {
    const alt = `${label} in the ${PALETTE_NAMES[/** @type {keyof typeof PALETTE_NAMES} */ (palette)]} palette: ${view.subtitle}`;
    return `<img src="${previewPath(view, palette)}" width="1280" height="800" alt="${esc(alt)}"${options.lazy ? ` loading="lazy"` : ""} decoding="async"${attrs}>`;
  }
  return `<div class="preview-placeholder" role="img" aria-label="${esc(`${label}: preview in progress`)}"${attrs}><span>Preview in progress</span></div>`;
}

/** Cities show the place name; terrain pieces add the style, since one peak can have several. */
export const cardTitle = (/** @type {ViewConfig} */ view) => view.category !== "terrain" ? view.title : `${view.title} · ${STYLE_NAMES[view.style]}`;

/**
 * @param {ViewConfig} view @param {AssetExists} assetExists
 * @param {{ showPlace?: boolean, heading?: "h2" | "h3" }} [options]
 */
export function renderCard(view, assetExists, options = {}) {
  const heading = options.heading ?? "h3";
  const title = options.showPlace ? cardTitle(view) : viewName(view);
  return `<article class="card"><a class="card-link" href="${viewRoute(view)}"><div class="artwork-frame">${renderPreview(view, view.defaultPalette, assetExists, { lazy: true })}</div>`
    + `<${heading}>${esc(title)}</${heading}></a><p>${esc(view.summary)}</p></article>`;
}

/** @param {ViewConfig[]} views @param {AssetExists} assetExists @param {{ showPlace?: boolean }} [options] */
export function renderCardGrid(views, assetExists, options = {}) {
  if (!views.length) return `<p class="note">No views yet.</p>`;
  return `<div class="card-grid compact">${views.map((v) => renderCard(v, assetExists, options)).join("")}</div>`;
}

/**
 * @param {{ path: string, title: string, description: string, image?: string, scripts?: string[] }} meta
 */
function renderHead(meta) {
  const url = `${SITE_ORIGIN}${meta.path}`;
  const og = [`<meta property="og:title" content="${esc(meta.title)}">`, `<meta property="og:description" content="${esc(meta.description)}">`,
    `<meta property="og:type" content="website">`, `<meta property="og:url" content="${url}">`];
  if (meta.image) og.push(`<meta property="og:image" content="${SITE_ORIGIN}${meta.image}">`);
  return `<meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(meta.title)}</title>
  <meta name="description" content="${esc(meta.description)}">
  <link rel="canonical" href="${url}">
  ${og.join("")}
  ${renderHeadAssets()}${(meta.scripts ?? []).map((src) => `\n  <script type="module" src="${src}"></script>`).join("")}`;
}

/**
 * @param {{ path: string, section?: string, title: string, description: string, image?: string, scripts?: string[], main: string }} page
 */
function renderDocument(page) {
  return `<!doctype html>
<!-- Generated by tools/build-pages.mjs from views/*.json. Do not edit. -->
<html lang="en"><head>
  ${renderHead(page)}
</head><body>
${renderHeader(page.path, page.section)}
<main class="site-main">${page.main}</main>
${renderFooter(page.path)}
</body></html>
`;
}

/** @param {number[]} bounds */
export function extentKm(bounds) {
  const [w, s, e, n] = bounds;
  const lat = ((s + n) / 2) * Math.PI / 180;
  return { width: (e - w) * 111.32 * Math.cos(lat), height: (n - s) * 110.57 };
}

/** @param {number[]} bounds */
function centerLabel(bounds) {
  const lat = (bounds[1] + bounds[3]) / 2;
  const lon = (bounds[0] + bounds[2]) / 2;
  return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? "N" : "S"} · ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? "E" : "W"}`;
}

/** @param {ViewConfig} view @param {string} [palette] @param {string} [size] */
function createHref(view, palette = view.defaultPalette, size) {
  return `/create/?place=${encodeURIComponent(view.place)}&view=${encodeURIComponent(view.view)}&palette=${encodeURIComponent(palette)}${size ? `&size=${size}` : ""}`;
}

/**
 * One pre-rendered preview (default palette). With JS, view.ts re-renders other palettes and the
 * 3840 × 2400 download locally; without JS the download links to Create with this preset.
 * @param {ViewConfig} view @param {AssetExists} assetExists @param {AttributionFor} [attributionFor]
 */
export function renderViewPage(view, assetExists, attributionFor = genericAttribution) {
  const path = viewRoute(view);
  const category = `/${view.category}/`;
  const published = hasPreview(view, view.defaultPalette, assetExists);
  const { width, height } = extentKm(view.bounds);

  const figure = renderPreview(view, view.defaultPalette, assetExists, { attrs: published ? ` data-preview-image` : "" })
    + (published ? `<canvas class="artwork-canvas" data-preview-canvas width="1280" height="800" hidden></canvas>` : "");
  const switcher = published && view.palettes.length > 1
    ? `<div class="palette-switcher" role="group" aria-label="Palette" data-palette-switcher hidden>`
      + view.palettes.map((p) => `<button type="button" class="chip" data-palette="${p}" aria-pressed="${p === view.defaultPalette}">${esc(PALETTE_NAMES[p])}</button>`).join("")
      + `</div>`
    : "";
  const downloadButton = published
    ? `<a class="button secondary" data-download data-default-palette="${esc(view.defaultPalette)}" href="${esc(createHref(view, view.defaultPalette, "3840x2400"))}">Download PNG</a>`
    : "";
  const status = published ? `<p class="download-status" data-download-status role="status" aria-live="polite"></p>` : "";
  const attribution = `<p class="attribution note">${esc(attributionFor(view))}. OpenStreetMap data is available under the <a href="https://www.openstreetmap.org/copyright">ODbL</a>; see <a href="/sources/">sources</a>.</p>`;

  const draftNote = view.status === "draft" ? `<p class="note">This piece is still being prepared.</p>` : "";
  const notes = view.notes.length ? `<h2>What the map shows</h2><ul>${view.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";

  const main = `<section class="container page-head"><p class="eyebrow"><a href="${category}">${CATEGORY_NAMES[view.category]}</a> · <a href="/${view.place}/">${esc(view.placeTitle)}</a> · ${esc(viewName(view))}</p>`
    + `<h1>${esc(view.title)}</h1><p class="lede">${esc(view.subtitle)}</p></section>`
    + `<article class="container view" data-view data-place="${esc(view.place)}" data-view-slug="${esc(view.view)}" data-style="${esc(view.style)}" data-data-file="${esc(view.dataFile)}" data-title="${esc(view.title)}" data-view-title="${esc(viewName(view))}">`
    + `<figure class="artwork-frame">${figure}</figure>`
    + `<div class="view-toolbar">${switcher}<div class="actions"><a class="button" data-customize href="${esc(createHref(view))}">Customize this</a>${downloadButton}</div></div>${status}${attribution}`
    + `<dl class="facts"><div class="fact"><dt>Extent</dt><dd>About ${Math.round(width)} × ${Math.round(height)} km</dd></div>`
    + `<div class="fact"><dt>Center</dt><dd>${centerLabel(view.bounds)}</dd></div>`
    + `<div class="fact"><dt>Style</dt><dd>${STYLE_NAMES[view.style]}</dd></div></dl>`
    + `<div class="prose">${notes}${draftNote}`
    + `<p class="note">Palettes: ${view.palettes.map((p) => esc(PALETTE_NAMES[p])).join(", ")}. Layers: ${view.layers.join(", ")}.</p></div>`
    + `</article>`;

  return renderDocument({
    path, section: category, title: `${view.title} · ${viewName(view)} · Atlas`, description: view.summary,
    image: published ? previewPath(view, view.defaultPalette) : undefined,
    scripts: published ? ["/src/view.ts"] : [], main
  });
}

/** @param {ViewConfig[]} placeViews @param {AssetExists} assetExists */
export function renderPlacePage(placeViews, assetExists) {
  const [first] = placeViews;
  const path = `/${first.place}/`;
  const category = `/${first.category}/`;
  const main = `<section class="container page-head"><p class="eyebrow"><a href="${category}">${CATEGORY_NAMES[first.category]}</a></p>`
    + `<h1>${esc(first.placeTitle)}</h1><p class="lede">${esc(first.subtitle)}</p></section>`
    + `<section class="container section" aria-labelledby="views-heading"><h2 id="views-heading" class="section-title">Views</h2>${renderCardGrid(placeViews, assetExists)}</section>`;
  return renderDocument({ path, section: category, title: `${first.placeTitle} · Atlas`, description: `${first.placeTitle}: ${first.subtitle}.`, main });
}

const CATEGORY_LEDES = {
  cities: "Cities from 15 to 50 km across, framed so the rivers, coasts, and hills they grew around fit in one image.",
  terrain: "Mountains and canyons drawn from elevation data, as layered ridgeline profiles and contour fields.",
  hydrology: "Rivers, deltas, and estuaries from 100 to 250 km across, drawn from water and wetland shapes over faint terrain.",
  coasts: "Fjords, atolls, bays, and islands where the land meets the sea, drawn as contour fields and water shapes.",
  formations: "Craters, calderas, rifts, dunes, and badlands: landforms shaped by impact, fire, wind, and water."
};

/** @param {import("../../src/types").ViewCategory} category @param {ViewConfig[]} views @param {AssetExists} assetExists */
export function renderCategoryPage(category, views, assetExists) {
  const path = `/${category}/`;
  const list = views.filter((v) => v.category === category);
  const grid = list.length ? renderCardGrid(list, assetExists, { showPlace: true }) : `<p class="note">No places yet.</p>`;
  const main = `<section class="container page-head"><h1>${CATEGORY_NAMES[category]}</h1><p class="lede">${esc(CATEGORY_LEDES[category])}</p></section>`
    + `<section class="container section">${grid}</section>`;
  return renderDocument({ path, title: `${CATEGORY_NAMES[category]} · Atlas`, description: CATEGORY_LEDES[category], main });
}

/** @param {ViewConfig[]} views @returns {ViewConfig[][]} */
export function groupByPlace(views) {
  /** @type {Map<string, ViewConfig[]>} */
  const map = new Map();
  for (const v of views) map.set(v.place, [...(map.get(v.place) ?? []), v]);
  return [...map.values()];
}

/**
 * All generated pages. `file` is relative to GENERATED_DIR.
 * @param {ViewConfig[]} views @param {AssetExists} assetExists @param {AttributionFor} [attributionFor]
 * @returns {{ route: string, file: string, html: string }[]}
 */
export function buildPages(views, assetExists, attributionFor = genericAttribution) {
  const page = (/** @type {string} */ route, /** @type {string} */ html) => ({ route, file: `${route.slice(1)}index.html`, html });
  const pages = CATEGORIES.map((c) => page(`/${c}/`, renderCategoryPage(c, views, assetExists)));
  for (const placeViews of groupByPlace(views)) {
    pages.push(page(`/${placeViews[0].place}/`, renderPlacePage(placeViews, assetExists)));
    for (const view of placeViews) pages.push(page(viewRoute(view), renderViewPage(view, assetExists, attributionFor)));
  }
  return pages;
}

/** @param {string[]} routes */
export function renderSitemap(routes) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes.map((r) => `  <url><loc>${SITE_ORIGIN}${r}</loc></url>`).join("\n")}
</urlset>
`;
}

/**
 * Fills placeholders in authored pages:
 * <!--atlas:head-->, <!--atlas:header-->, <!--atlas:footer-->,
 * <!--atlas:cards:cities|terrain|hydrology|coasts|formations-->, <!--atlas:view-catalog-->.
 * @param {string} html @param {string} path @param {ViewConfig[]} views @param {AssetExists} assetExists
 */
export function fillAuthoredPage(html, path, views, assetExists) {
  const catalog = JSON.stringify(viewCatalog(views)).replace(/</g, "\\u003c");
  return html
    .replace("<!--atlas:head-->", renderHeadAssets())
    .replace("<!--atlas:header-->", renderHeader(path))
    .replace("<!--atlas:footer-->", renderFooter(path))
    .replace(/<!--atlas:cards:(cities|terrain|hydrology|coasts|formations)-->/g, (_, category) => renderCardGrid(views.filter((v) => v.category === category), assetExists, { showPlace: true }))
    .replace("<!--atlas:manifest-list-->", `<ul class="manifest-list">${views.filter((v) => v.status === "published").map((v) => `<li><a href="${viewRoute(v)}">${esc(cardTitle(v))}</a>: <a href="${v.dataFile.replace(/\.json$/, ".manifest.json")}">manifest</a></li>`).join("")}</ul>`)
    .replace("<!--atlas:view-catalog-->", `<script type="application/json" id="view-catalog">${catalog}</script>`);
}
