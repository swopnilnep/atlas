// View config loading and validation. Shared by the page generator, the Vite
// config, validate-build, and tests. Types live in src/types.ts.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadCatalogViews } from "./catalog.mjs";

/** @typedef {import("../../src/types").ViewConfig} ViewConfig */
/** @typedef {import("../../src/types").ViewCatalogEntry} ViewCatalogEntry */
/** @typedef {import("../../src/types").ViewPaletteId} ViewPaletteId */

/** @type {readonly import("../../src/types").ViewCategory[]} */
export const CATEGORIES = ["cities", "terrain", "hydrology", "coasts", "formations"];
/** @type {readonly import("../../src/types").ViewStyle[]} */
export const STYLES = ["urban-relief", "contour-fields", "ridgelines", "water-shapes"];
/** @type {readonly import("../../src/types").ViewLayer[]} */
export const LAYERS = ["hillshade", "elevation", "contours", "water", "glaciers", "parks", "roads"];
/** @type {readonly ViewPaletteId[]} */
export const PALETTES = ["ink-and-river", "paper", "night-river", "black"];
/** @type {readonly import("../../src/types").ViewStatus[]} */
export const STATUSES = ["draft", "published"];

/** @type {Record<ViewPaletteId, string>} */
export const PALETTE_NAMES = {
  "ink-and-river": "Ink and River",
  paper: "Paper",
  "night-river": "Night River",
  black: "Black"
};

/** @type {Record<string, string>} */
export const CATEGORY_NAMES = { cities: "Cities", terrain: "Terrain", hydrology: "Hydrology", coasts: "Coasts & Islands", formations: "Formations" };
/** @type {Record<string, string>} */
export const STYLE_NAMES = { "urban-relief": "Urban Relief", "contour-fields": "Contour Fields", ridgelines: "Ridgelines", "water-shapes": "Water Shapes" };

/** Top-level paths that a place slug must not shadow. */
export const RESERVED_SLUGS = ["create", "about", "sources", "cities", "terrain", "hydrology", "coasts", "formations", "deltas", "assets", "data", "artwork", "downloads", "src", "views", "tools", "docs", "public"];

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEYS = ["place", "placeTitle", "category", "view", "title", "subtitle", "bounds", "style", "layers", "defaultPalette", "palettes", "dataFile", "status", "summary", "notes"];

/**
 * @param {unknown} value
 * @param {string} [label] used in error messages, usually the file name
 * @returns {ViewConfig}
 */
export function validateViewConfig(value, label = "view config") {
  const fail = (/** @type {string} */ message) => { throw new Error(`${label}: ${message}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("must be a JSON object.");
  const config = /** @type {Record<string, unknown>} */ (value);

  for (const key of Object.keys(config)) if (!KEYS.includes(key)) fail(`unknown field "${key}".`);
  for (const key of KEYS) if (!(key in config)) fail(`missing field "${key}".`);

  const text = (/** @type {string} */ key, single = true) => {
    const v = config[key];
    if (typeof v !== "string" || !v.trim()) fail(`"${key}" must be a non-empty string.`);
    if (single && /[\r\n]/.test(/** @type {string} */ (v))) fail(`"${key}" must be a single line.`);
    return /** @type {string} */ (v);
  };
  const oneOf = (/** @type {string} */ key, /** @type {readonly string[]} */ allowed) => {
    const v = config[key];
    if (typeof v !== "string" || !allowed.includes(v)) fail(`"${key}" must be one of ${allowed.join(", ")}.`);
  };
  const list = (/** @type {string} */ key, /** @type {readonly string[]} */ allowed) => {
    const v = config[key];
    if (!Array.isArray(v) || v.length === 0) fail(`"${key}" must be a non-empty array.`);
    const items = /** @type {unknown[]} */ (v);
    for (const item of items) if (typeof item !== "string" || !allowed.includes(item)) fail(`"${key}" contains "${String(item)}"; allowed: ${allowed.join(", ")}.`);
    if (new Set(items).size !== items.length) fail(`"${key}" contains duplicates.`);
  };

  for (const key of ["place", "view"]) if (!SLUG.test(text(key))) fail(`"${key}" must be a lowercase slug like "mount-rainier".`);
  if (RESERVED_SLUGS.includes(/** @type {string} */ (config.place))) fail(`"place" cannot be the reserved path "${config.place}".`);
  for (const key of ["placeTitle", "title", "subtitle", "summary"]) text(key);
  if (/** @type {string} */ (config.summary).length > 200) fail(`"summary" must be one short line (200 characters or fewer).`);
  oneOf("category", CATEGORIES);
  oneOf("style", STYLES);
  oneOf("status", STATUSES);
  list("layers", LAYERS);
  list("palettes", PALETTES);
  oneOf("defaultPalette", PALETTES);
  if (!(/** @type {string[]} */ (config.palettes)).includes(/** @type {string} */ (config.defaultPalette))) fail(`"defaultPalette" must be listed in "palettes".`);

  const bounds = config.bounds;
  if (!Array.isArray(bounds) || bounds.length !== 4 || bounds.some((n) => typeof n !== "number" || !Number.isFinite(n))) fail(`"bounds" must be [west, south, east, north] numbers.`);
  const [west, south, east, north] = /** @type {number[]} */ (bounds);
  if (west < -180 || east > 180 || south < -90 || north > 90) fail(`"bounds" is outside valid longitude/latitude ranges.`);
  if (west >= east || south >= north) fail(`"bounds" must have west < east and south < north.`);
  if (east - west > 8 || north - south > 5) fail(`"bounds" spans more than 8 degrees of longitude or 5 of latitude; views are city, landform, or delta scale.`);

  const dataFile = text("dataFile");
  const dataPattern = new RegExp(`^/data/${config.place}-${config.view}-v[1-9][0-9]*\\.json$`);
  if (!dataPattern.test(dataFile)) fail(`"dataFile" must look like /data/${config.place}-${config.view}-v1.json.`);

  const notes = config.notes;
  if (!Array.isArray(notes) || notes.some((n) => typeof n !== "string" || !n.trim())) fail(`"notes" must be an array of non-empty strings.`);

  return /** @type {ViewConfig} */ (/** @type {unknown} */ (config));
}

/**
 * Cross-config checks: unique routes and consistent place metadata.
 * @param {ViewConfig[]} views
 * @returns {ViewConfig[]}
 */
export function validateViewSet(views) {
  const routes = new Set();
  /** @type {Map<string, ViewConfig>} */
  const places = new Map();
  for (const view of views) {
    const route = `${view.place}/${view.view}`;
    if (routes.has(route)) throw new Error(`Duplicate view config for /${route}/.`);
    routes.add(route);
    const first = places.get(view.place);
    if (!first) places.set(view.place, view);
    else if (first.placeTitle !== view.placeTitle || first.category !== view.category) {
      throw new Error(`Views of "${view.place}" disagree on placeTitle or category.`);
    }
  }
  return views;
}

/**
 * Builds and validates the view configs from views/catalog.json (plus views/notes/<id>.json).
 * A piece is published when its prepared data file exists in public/data/.
 * @param {string} [directory]
 * @param {(dataFile: string) => boolean} [dataExists]
 * @returns {Promise<ViewConfig[]>}
 */
export async function loadViews(directory = resolve("views"), dataExists) {
  const views = (await loadCatalogViews(directory, dataExists)).map((v) => validateViewConfig(v, `views/catalog.json ${v.place}-${v.view}`));
  // Alphabetical by place title within each category; views of one place keep catalog order.
  const order = new Map(views.map((v, i) => [v, i]));
  views.sort((a, b) => a.placeTitle.localeCompare(b.placeTitle, "en") || (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return validateViewSet(views);
}

/** "mount-rainier" -> "Mount Rainier" */
export function titleFromSlug(/** @type {string} */ slug) {
  return slug.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

/**
 * @param {ViewConfig[]} views
 * @returns {ViewCatalogEntry[]}
 */
export function viewCatalog(views) {
  return views.map((v) => ({
    place: v.place, placeTitle: v.placeTitle, category: v.category, view: v.view, viewTitle: titleFromSlug(v.view),
    title: v.title, subtitle: v.subtitle, bounds: [...v.bounds],
    style: v.style, status: v.status, defaultPalette: v.defaultPalette, palettes: [...v.palettes], dataFile: v.dataFile
  }));
}

/** Asset paths for a view and palette. */
export const previewPath = (/** @type {ViewConfig} */ v, /** @type {string} */ palette) => `/artwork/${v.place}-${v.view}-${palette}.webp`;

/**
 * requiredAttribution from each view's prepared manifest (public/data/<id>-v1.manifest.json).
 * @param {string} publicDir
 * @param {string} fallback
 * @returns {(view: ViewConfig) => string}
 */
export function manifestAttribution(publicDir, fallback) {
  return (view) => {
    const file = resolve(publicDir, view.dataFile.slice(1).replace(/\.json$/, ".manifest.json"));
    if (!existsSync(file)) return fallback;
    try {
      const text = JSON.parse(readFileSync(file, "utf8")).requiredAttribution;
      return typeof text === "string" && text.trim() ? text : fallback;
    } catch {
      return fallback;
    }
  };
}
