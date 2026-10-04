// View pages. Without JS: the default palette's preview, and the download links to Create with
// this preset. With JS: other palettes are re-rendered locally into a canvas (lazy: the data is
// fetched on first use), and the download renders 3840 × 2400 locally in the chosen palette.
import type { ViewStyle } from "./types";
import { nextFrame, renderInto, renderPng, saveBlob } from "./render/export";
import { loadView, type LoadedView } from "./render/load";
import { isPaletteId, PALETTES, type PaletteId } from "./render/palettes";

const view = document.querySelector<HTMLElement>("[data-view]");

if (view) {
  const switcher = view.querySelector<HTMLElement>("[data-palette-switcher]");
  const image = view.querySelector<HTMLImageElement>("[data-preview-image]");
  const canvas = view.querySelector<HTMLCanvasElement>("[data-preview-canvas]");
  const buttons = [...(switcher?.querySelectorAll<HTMLButtonElement>("button[data-palette]") ?? [])];
  const customize = view.querySelector<HTMLAnchorElement>("[data-customize]");
  const download = view.querySelector<HTMLAnchorElement>("[data-download]");
  const statusLine = view.querySelector<HTMLElement>("[data-download-status]");
  const defaultPalette = download?.dataset.defaultPalette ?? "";
  const { dataFile, style, title, viewTitle, place, viewSlug } = view.dataset;
  let palette = defaultPalette;
  let busy = false;
  let token = 0;

  const say = (text: string) => { if (statusLine) statusLine.textContent = text; };
  const load = (): Promise<LoadedView> => {
    if (!dataFile) return Promise.reject(new Error("This page is missing its view data."));
    return loadView(dataFile, (bytes) => say(`Loading map data… ${(bytes / 1e6).toFixed(1)} MB`));
  };

  const select = async (next: string) => {
    if (!isPaletteId(next)) return;
    palette = next;
    for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset.palette === next));
    if (customize) {
      const url = new URL(customize.href, location.href);
      url.searchParams.set("palette", next);
      customize.href = `${url.pathname}${url.search}`;
    }
    const mine = ++token;
    if (next === defaultPalette || !canvas || !image || !style) {
      if (image) image.hidden = false;
      if (canvas) canvas.hidden = true;
      say("");
      return;
    }
    try {
      say("Loading map data…");
      const loaded = await load();
      if (mine !== token) return;
      say(`Drawing ${PALETTES[next].name}…`);
      await nextFrame();
      await renderInto(canvas, loaded, { style: style as ViewStyle, palette: next as PaletteId, width: 1280, height: 800 });
      if (mine !== token) return;
      image.hidden = true;
      canvas.hidden = false;
      say("");
    } catch (error) {
      say(error instanceof Error ? error.message : "Rendering failed.");
    }
  };

  download?.addEventListener("click", async (event) => {
    if (!isPaletteId(palette) || !style) return; // no-JS style fallback: follow the link to Create
    event.preventDefault();
    if (busy) return;
    busy = true;
    download.setAttribute("aria-disabled", "true");
    try {
      const loaded = await load();
      say(`Rendering in ${PALETTES[palette].name}…`);
      await nextFrame();
      const blob = await renderPng(loaded, { style: style as ViewStyle, palette, width: 3840, height: 2400 }, `${title} · ${viewTitle} · ${PALETTES[palette].name}`);
      saveBlob(blob, `atlas-${place}-${viewSlug}-${palette}-3840x2400.png`);
      say("PNG downloaded.");
    } catch (error) {
      say(error instanceof Error ? error.message : "Export failed.");
    } finally {
      busy = false;
      download.removeAttribute("aria-disabled");
    }
  });

  for (const button of buttons) button.addEventListener("click", () => { void select(button.dataset.palette ?? ""); });
  if (switcher) switcher.hidden = false;
}
