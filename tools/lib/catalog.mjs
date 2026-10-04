// The piece catalog (views/catalog.json) -> view configs. One entry per piece; bounds are a 16:10
// rectangle from center + widthKm, computed exactly like tools/data/catalog.py.
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

/** @typedef {import("../../src/types").CatalogPiece} CatalogPiece */
/** @typedef {import("../../src/types").ViewConfig} ViewConfig */

export const EARTH_RADIUS_M = 6371008.8;
export const M_PER_DEG = (Math.PI * EARTH_RADIUS_M) / 180;
export const ASPECT = 16 / 10;
const PIECE_KEYS = ["id", "place", "view", "title", "region", "category", "style", "center", "widthKm", "defaultPalette", "summary"];
const OPTIONAL_KEYS = ["peak", "nativeName", "nativeLang"];

/** Python-compatible round(x, 5) for the values we produce (no exact .5 ties in practice). */
const round5 = (/** @type {number} */ x) => Math.round(x * 1e5) / 1e5;

/**
 * [west, south, east, north] of a widthKm × widthKm / 1.6 rectangle centred on [lon, lat].
 * @param {[number, number]} center @param {number} widthKm
 * @returns {[number, number, number, number]}
 */
export function pieceBounds(center, widthKm) {
  const [lon, lat] = center;
  const widthM = widthKm * 1000;
  const heightM = widthM / ASPECT;
  const halfLat = heightM / 2 / M_PER_DEG;
  const halfLon = widthM / 2 / M_PER_DEG / Math.cos((lat * Math.PI) / 180);
  return [round5(lon - halfLon), round5(lat - halfLat), round5(lon + halfLon), round5(lat + halfLat)];
}

export const STYLE_LAYERS = {
  "urban-relief": ["hillshade", "water", "parks", "roads"],
  "contour-fields": ["contours", "glaciers", "water"],
  ridgelines: ["elevation"],
  "water-shapes": ["water", "hillshade"]
};

/**
 * @param {unknown} value @param {number} index
 * @returns {CatalogPiece}
 */
export function validatePiece(value, index) {
  const label = `views/catalog.json pieces[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: must be an object.`);
  const p = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(p)) if (!PIECE_KEYS.includes(key) && !OPTIONAL_KEYS.includes(key)) throw new Error(`${label}: unknown field "${key}".`);
  for (const key of PIECE_KEYS) if (!(key in p)) throw new Error(`${label}: missing field "${key}".`);
  if (p.id !== `${p.place}-${p.view}`) throw new Error(`${label}: id must be "<place>-<view>".`);
  const c = p.center;
  if (!Array.isArray(c) || c.length !== 2 || c.some((n) => typeof n !== "number" || !Number.isFinite(n))) throw new Error(`${label}: center must be [lon, lat].`);
  if (typeof p.widthKm !== "number" || !(p.widthKm >= 2 && p.widthKm <= 250)) throw new Error(`${label}: widthKm must be 2..250.`);
  for (const key of ["nativeName", "nativeLang"]) if (p[key] !== undefined && (typeof p[key] !== "string" || !String(p[key]).trim())) throw new Error(`${label}: ${key} must be a non-empty string.`);
  if (p.peak !== undefined) {
    const peak = /** @type {Record<string, unknown>} */ (p.peak);
    if (!peak || typeof peak.name !== "string" || typeof peak.elevationM !== "number") throw new Error(`${label}: peak must be { name, elevationM }.`);
  }
  return /** @type {CatalogPiece} */ (/** @type {unknown} */ (p));
}

/**
 * Converts one catalog piece to a view config. Optional notes ({ subtitle?, notes? }) add page text.
 * `published` is true when the prepared data file exists.
 * @param {CatalogPiece} piece @param {{ subtitle?: string, notes?: string[] }} extra @param {boolean} published
 * @returns {ViewConfig}
 */
export function pieceToView(piece, extra, published) {
  return {
    place: piece.place,
    placeTitle: piece.title,
    category: piece.category,
    view: piece.view,
    title: piece.title,
    subtitle: extra.subtitle ?? piece.summary,
    bounds: pieceBounds(piece.center, piece.widthKm),
    style: piece.style,
    layers: /** @type {ViewConfig["layers"]} */ ([...STYLE_LAYERS[piece.style]]),
    defaultPalette: piece.defaultPalette,
    palettes: ["ink-and-river", "paper", "night-river", "black"],
    dataFile: `/data/${piece.id}-v1.json`,
    status: published ? "published" : "draft",
    summary: piece.summary,
    notes: extra.notes ?? []
  };
}

/**
 * Reads views/catalog.json and optional views/notes/<id>.json.
 * @param {string} directory the views/ folder
 * @param {(dataFile: string) => boolean} [dataExists] defaults to checking ../public
 * @returns {Promise<ViewConfig[]>}
 */
export async function loadCatalogViews(directory, dataExists) {
  const exists = dataExists ?? ((/** @type {string} */ f) => existsSync(resolve(directory, "..", "public", f.slice(1))));
  const raw = JSON.parse(await readFile(resolve(directory, "catalog.json"), "utf8"));
  if (!raw || !Array.isArray(raw.pieces)) throw new Error("views/catalog.json: must have a pieces array.");
  const notesDir = resolve(directory, "notes");
  const noteFiles = existsSync(notesDir) ? new Set(await readdir(notesDir)) : new Set();
  const views = [];
  for (const [i, value] of raw.pieces.entries()) {
    const piece = validatePiece(value, i);
    const extra = noteFiles.has(`${piece.id}.json`) ? JSON.parse(await readFile(resolve(notesDir, `${piece.id}.json`), "utf8")) : {};
    views.push(pieceToView(piece, extra, exists(`/data/${piece.id}-v1.json`)));
  }
  return views;
}
