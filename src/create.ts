import { LAYER_NAMES, STYLE_LAYERS, type LayerId, type RenderOptions } from "./renderer";
import { lastExportRenderMs, renderInto, renderPng, saveBlob, nextFrame } from "./render/export";
import { loadView, type LoadedView } from "./render/load";
import { isPaletteId, PALETTES, type PaletteId } from "./render/palettes";
import type { ViewCatalogEntry, ViewStyle } from "./types";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Generator markup is missing ${selector}.`);
  return element;
}

const form = requiredElement<HTMLFormElement>("#generator-form");
const canvas = requiredElement<HTMLCanvasElement>("#artwork-canvas");
const status = requiredElement<HTMLElement>("#render-status");
const download = requiredElement<HTMLButtonElement>("#download-button");
const viewSelect = requiredElement<HTMLSelectElement>("#view");
const paletteSelect = requiredElement<HTMLSelectElement>("#palette");
const size = requiredElement<HTMLSelectElement>("#output-size");
const layerChecks = requiredElement<HTMLElement>("#layer-checks");
const labelToggle = requiredElement<HTMLInputElement>("#label-toggle");

const PREVIEW_DELAY_MS = 150;
const PREVIEW_BOX = 1280;

const catalog = readCatalog();
/** Layer toggles per style, kept when switching between views of the same style. */
const layerState: Record<ViewStyle, Record<string, boolean>> = { "urban-relief": {}, "contour-fields": {}, ridgelines: {}, "water-shapes": {} };
let current: ViewCatalogEntry | undefined;
let loaded: LoadedView | undefined;
let exporting = false;
let timer: number | undefined;
let renderToken = 0;

function readCatalog(): ViewCatalogEntry[] {
  const script = document.getElementById("view-catalog");
  if (!script?.textContent) return [];
  try {
    const parsed: unknown = JSON.parse(script.textContent);
    return Array.isArray(parsed) ? parsed as ViewCatalogEntry[] : [];
  } catch {
    return [];
  }
}

const key = (entry: ViewCatalogEntry) => `${entry.place}/${entry.view}`;
const findEntry = (value: string) => catalog.find((entry) => key(entry) === value);

const CATEGORY_LABELS: Record<string, string> = { cities: "Cities", terrain: "Terrain", hydrology: "Hydrology", coasts: "Coasts & Islands", formations: "Formations" };

function populateViews() {
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const entry of catalog) {
    let group = groups.get(entry.category);
    if (!group) {
      group = document.createElement("optgroup");
      group.label = CATEGORY_LABELS[entry.category] ?? entry.category;
      groups.set(entry.category, group);
    }
    const sameTitle = catalog.filter((e) => e.placeTitle === entry.placeTitle).length > 1;
    group.append(new Option(entry.category !== "terrain" && !sameTitle ? entry.placeTitle : `${entry.placeTitle} · ${entry.viewTitle}`, key(entry)));
  }
  viewSelect.replaceChildren(...groups.values());
}

function buildLayerChecks(style: ViewStyle) {
  const state = layerState[style];
  layerChecks.replaceChildren(...STYLE_LAYERS[style].map((layer) => {
    const label = document.createElement("label");
    const input = Object.assign(document.createElement("input"), { type: "checkbox", name: `layer-${layer}`, checked: state[layer] !== false });
    input.dataset.layer = layer;
    label.append(input, ` ${LAYER_NAMES[layer]}`);
    return label;
  }));
}

function readLayers(): Partial<Record<LayerId, boolean>> {
  const layers: Partial<Record<LayerId, boolean>> = {};
  for (const input of layerChecks.querySelectorAll<HTMLInputElement>("input[data-layer]")) layers[input.dataset.layer as LayerId] = input.checked;
  if (current) layerState[current.style] = { ...layers };
  return layers;
}

function outputSize(): { width: number; height: number } {
  const [width, height] = size.value.split("x").map(Number);
  return { width, height };
}

/** The preview has the download's shape, fitted in a 1280 px box. */
function previewSize(): { width: number; height: number } {
  const { width, height } = outputSize();
  const f = Math.min(1, PREVIEW_BOX / Math.max(width, height * 1.6));
  return { width: Math.round(width * f), height: Math.round(height * f) };
}

function optionsFor(width: number, height: number): RenderOptions {
  if (!current) throw new Error("No view selected.");
  return { style: current.style, palette: paletteSelect.value as PaletteId, layers: readLayers(), label: labelToggle.checked, width, height };
}

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}

async function preview() {
  if (!loaded || exporting) return;
  const token = ++renderToken;
  try {
    const { width, height } = previewSize();
    const ms = await renderInto(canvas, loaded, optionsFor(width, height));
    if (token !== renderToken) return;
    canvas.style.aspectRatio = `${width} / ${height}`;
    canvas.dataset.portrait = String(height > width);
    canvas.dataset.renderMs = ms.toFixed(1);
    canvas.dataset.rendered = `${current?.place}/${current?.view}/${paletteSelect.value}/${width}x${height}/${labelToggle.checked ? "label" : "nolabel"}`;
    setStatus("Preview ready.");
    download.disabled = false;
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Rendering failed.", true);
  }
}

function schedulePreview() {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void preview(), PREVIEW_DELAY_MS);
}

async function selectView(value: string) {
  const entry = findEntry(value);
  if (!entry) return;
  current = entry;
  buildLayerChecks(entry.style);
  loaded = undefined;
  download.disabled = true;
  setStatus(`Loading ${entry.placeTitle} · ${entry.viewTitle}…`);
  try {
    const result = await loadView(entry.dataFile, (bytes) => {
      if (current === entry) setStatus(`Loading ${entry.placeTitle} · ${entry.viewTitle}… ${(bytes / 1e6).toFixed(1)} MB`);
    });
    if (current !== entry) return;
    loaded = result;
    canvas.dataset.loadMs = result.timings.totalMs.toFixed(1);
    canvas.dataset.worker = String(result.timings.worker);
    setStatus("Rendering preview…");
    await nextFrame();
    await preview();
  } catch (error) {
    if (current === entry) setStatus(error instanceof Error ? error.message : "Map data could not be loaded.", true);
  }
}

form.addEventListener("submit", (event) => event.preventDefault());
form.addEventListener("change", (event) => {
  if (event.target === viewSelect) void selectView(viewSelect.value);
  else schedulePreview();
});
form.addEventListener("reset", () => {
  // Form reset restores HTML defaults after this event; restore the view's defaults, then re-render.
  setTimeout(() => {
    for (const style of Object.keys(layerState) as ViewStyle[]) layerState[style] = {};
    if (current) {
      viewSelect.value = key(current);
      paletteSelect.value = current.defaultPalette;
      buildLayerChecks(current.style);
    }
    schedulePreview();
  });
});

download.addEventListener("click", async () => {
  if (!loaded || !current) return;
  const { width, height } = outputSize();
  exporting = true;
  download.disabled = true;
  let message = "PNG downloaded.";
  let failed = false;
  try {
    setStatus(`Rendering ${width} × ${height} locally…`);
    await nextFrame();
    const start = performance.now();
    const options = optionsFor(width, height);
    const title = `${current.title} · ${current.viewTitle} · ${PALETTES[options.palette].name}`;
    const blob = await renderPng(loaded, options, title);
    canvas.dataset.exportMs = (performance.now() - start).toFixed(1);
    canvas.dataset.exportRenderMs = lastExportRenderMs.toFixed(1);
    canvas.dataset.exportBytes = String(blob.size);
    saveBlob(blob, `atlas-${current.place}-${current.view}-${options.palette}-${width}x${height}.png`);
  } catch (error) {
    failed = true;
    message = error instanceof Error ? error.message : "Export failed.";
  } finally {
    exporting = false;
    setStatus(message, failed);
    download.disabled = !loaded;
  }
});

/** Applies ?place=&view=&palette= from view pages. */
function applyParams() {
  const params = new URLSearchParams(location.search);
  const place = params.get("place");
  const view = params.get("view");
  const entry = (place && view && findEntry(`${place}/${view}`)) || catalog[0];
  if (!entry) return undefined;
  viewSelect.value = key(entry);
  const palette = params.get("palette");
  paletteSelect.value = isPaletteId(palette) ? palette : entry.defaultPalette;
  const requestedSize = params.get("size");
  if (requestedSize && [...size.options].some((o) => o.value === requestedSize)) size.value = requestedSize;
  return entry;
}

populateViews();
const first = applyParams();
if (first) void selectView(key(first));
else setStatus("No views are configured.", true);
