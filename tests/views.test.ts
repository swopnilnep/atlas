import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPages, fillAuthoredPage, renderHeader, renderSitemap, AUTHORED_ROUTES } from "../tools/lib/site.mjs";
import { loadViews, validateViewConfig, validateViewSet, viewCatalog } from "../tools/lib/views.mjs";
import type { ViewConfig } from "../src/types";

const base: ViewConfig = {
  place: "austin", placeTitle: "Austin", category: "cities", view: "metro", title: "Austin",
  subtitle: "Balcones Escarpment and the Highland Lakes", bounds: [-98.01, 30.16, -97.49, 30.44],
  style: "urban-relief", layers: ["hillshade", "water", "parks", "roads"], defaultPalette: "ink-and-river",
  palettes: ["ink-and-river", "paper", "night-river", "black"], dataFile: "/data/austin-metro-v1.json",
  status: "draft", summary: "About 50 km across.", notes: ["A plain fact."]
};
const withChange = (change: Record<string, unknown>) => ({ ...base, ...change });
const noAssets = () => false;
const allAssets = () => true;

describe("view config validation", () => {
  it("accepts a valid config", () => expect(validateViewConfig(base)).toEqual(base));
  it("loads and validates the shipped configs", async () => {
    const views = await loadViews(resolve(import.meta.dirname, "../views"));
    const routes = views.map((v) => `${v.place}/${v.view}`);
    expect(routes.length).toBeGreaterThanOrEqual(30);
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes).toEqual(expect.arrayContaining(["austin/metro", "seattle/metro", "mount-rainier/summit", "mount-rainier/ridgelines", "everest/ridgelines"]));
    expect(views.filter((v) => ["cities", "terrain", "hydrology", "coasts", "formations"].includes(v.category)).length).toBe(views.length);
    expect(views.find((v) => v.place === "mount-rainier")?.category).toBe("terrain");
    // Owner preference: at least half of the pieces default to Ink and River or Paper.
    expect(views.filter((v) => v.defaultPalette === "ink-and-river" || v.defaultPalette === "paper").length * 2).toBeGreaterThanOrEqual(views.length);
    // Hand-written notes are merged in.
    expect(views.find((v) => v.place === "austin")?.notes.length).toBeGreaterThan(0);
  });
  it.each([
    [{ bounds: [-97.49, 30.16, -98.01, 30.44] }, /west < east/],
    [{ bounds: [-98, 30, -97] }, /bounds/],
    [{ bounds: [-200, 30, -97, 31] }, /outside/],
    [{ bounds: [-110, 30, -97, 31] }, /8 degrees/],
    [{ palettes: ["ink-and-river", "amoled-violet"] }, /palettes/],
    [{ palettes: ["paper", "paper"] }, /duplicates/],
    [{ defaultPalette: "black", palettes: ["paper"] }, /defaultPalette/],
    [{ dataFile: "data/austin-metro-v1.json" }, /dataFile/],
    [{ dataFile: "/data/seattle-metro-v1.json" }, /dataFile/],
    [{ dataFile: "/data/austin-metro.json" }, /dataFile/],
    [{ category: "mountains" }, /category/],
    [{ status: "live" }, /status/],
    [{ style: "neon" }, /style/],
    [{ layers: [] }, /layers/],
    [{ place: "Austin TX" }, /slug/],
    [{ place: "create" }, /reserved/],
    [{ summary: "two\nlines" }, /single line/],
    [{ notes: [""] }, /notes/],
    [{ extra: true }, /unknown field/]
  ])("rejects %j", (change, message) => {
    expect(() => validateViewConfig(withChange(change), "test")).toThrow(message);
  });
  it("rejects missing fields", () => {
    const { notes: _notes, ...missing } = base;
    expect(() => validateViewConfig(missing)).toThrow(/missing field "notes"/);
  });
  it("rejects duplicate routes and inconsistent places", () => {
    expect(() => validateViewSet([base, base])).toThrow(/Duplicate/);
    expect(() => validateViewSet([base, { ...base, view: "city", dataFile: "/data/austin-city-v1.json", placeTitle: "ATX" }])).toThrow(/disagree/);
  });
});

describe("route generation", () => {
  const rainier: ViewConfig = { ...base, place: "mount-rainier", placeTitle: "Mount Rainier", category: "terrain", view: "summit", style: "contour-fields", dataFile: "/data/mount-rainier-summit-v1.json" };

  it("generates category, place, and view pages", () => {
    expect(buildPages([base, rainier], noAssets).map((p) => [p.route, p.file])).toEqual([
      ["/cities/", "cities/index.html"],
      ["/terrain/", "terrain/index.html"],
      ["/hydrology/", "hydrology/index.html"],
      ["/coasts/", "coasts/index.html"],
      ["/formations/", "formations/index.html"],
      ["/austin/", "austin/index.html"],
      ["/austin/metro/", "austin/metro/index.html"],
      ["/mount-rainier/", "mount-rainier/index.html"],
      ["/mount-rainier/summit/", "mount-rainier/summit/index.html"]
    ]);
  });

  it("lists each place only on its own category page", () => {
    const pages = buildPages([base, rainier], noAssets);
    const cities = pages.find((p) => p.route === "/cities/")!.html;
    const terrain = pages.find((p) => p.route === "/terrain/")!.html;
    expect(cities).toContain(`href="/austin/metro/"`);
    expect(cities).not.toContain("/mount-rainier/");
    expect(terrain).toContain(`href="/mount-rainier/summit/"`);
    expect(terrain).toContain(`href="/terrain/" aria-current="page"`);
  });

  it("shows a placeholder and no downloads for drafts, even if assets exist", () => {
    const html = buildPages([base], allAssets).find((p) => p.route === "/austin/metro/")!.html;
    expect(html).toContain("Preview in progress");
    expect(html).not.toContain("/artwork/");
    expect(html).not.toContain("data-download");
    expect(html).toContain(`href="/cities/" aria-current="true"`);
    expect(html).toContain("/create/?place=austin&amp;view=metro&amp;palette=ink-and-river");
  });

  it("shows one preview, a local palette switcher, a local download, and attribution for published views", () => {
    const html = buildPages([{ ...base, status: "published" }], allAssets, () => "© OpenStreetMap contributors · Test").find((p) => p.route === "/austin/metro/")!.html;
    expect(html).toContain(`src="/artwork/austin-metro-ink-and-river.webp" width="1280" height="800"`);
    expect(html).not.toContain("austin-metro-paper.webp");
    expect(html).toContain(`data-preview-canvas`);
    expect(html).toContain(`data-palette-switcher hidden`);
    expect(html).toContain(`data-download data-default-palette="ink-and-river" href="/create/?place=austin&amp;view=metro&amp;palette=ink-and-river&amp;size=3840x2400"`);
    expect(html).not.toContain("/downloads/");
    expect(html).toContain("© OpenStreetMap contributors · Test");
    expect(html).toContain(`<script type="module" src="/src/view.ts">`);
  });

  it("falls back to a placeholder when a published preview is missing", () => {
    const html = buildPages([{ ...base, status: "published" }], noAssets).find((p) => p.route === "/austin/metro/")!.html;
    expect(html).toContain("Preview in progress");
    expect(html).not.toContain("/downloads/");
  });

  it("escapes config text", () => {
    const html = buildPages([{ ...base, summary: `<script>"x"</script>` }], noAssets)[0].html;
    expect(html).toContain("&lt;script&gt;&quot;x&quot;&lt;/script&gt;");
  });

  it("fills authored page placeholders", () => {
    const html = fillAuthoredPage("<!--atlas:head--><!--atlas:header--><!--atlas:cards:cities--><!--atlas:footer--><!--atlas:view-catalog-->", "/", [base, rainier], noAssets);
    expect(html).not.toContain("<!--atlas:");
    expect(html).toContain(`<a href="/" aria-current="page">Atlas</a>`);
    expect(html).toContain("<h3>Austin</h3>");
    expect(html).toContain(`class="card-grid compact"`);
    expect(html).not.toContain(`href="/mount-rainier/summit/"`);
    expect(html).toContain(JSON.stringify(viewCatalog([base, rainier])));
  });

  it("builds the nav without place links and a sitemap with every route", () => {
    const nav = renderHeader("/about/");
    expect(nav.match(/<a /g)).toHaveLength(8);
    expect(nav).toContain(`aria-label="Toggle light / dark theme"`);
    expect(nav).not.toContain("/sources/");
    const routes = [...AUTHORED_ROUTES, ...buildPages([base], noAssets).map((p) => p.route)];
    expect(renderSitemap(routes).match(/<loc>/g)).toHaveLength(routes.length);
  });
});
