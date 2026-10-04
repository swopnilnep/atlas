// Browser helpers shared by Create and the view pages: render, encode PNG with metadata, download.
import { pngMetadata, renderArtwork, type RenderOptions } from "../renderer";
import { loadFonts } from "./label";
import type { LoadedView } from "./load";
import { insertPngText } from "./png-text";

/** Waits for the bundled font, then renders into `canvas` (resized to the options). Returns ms spent drawing. */
export async function renderInto(canvas: HTMLCanvasElement, loaded: LoadedView, options: RenderOptions): Promise<number> {
  await loadFonts(undefined, loaded.view.label);
  canvas.width = options.width;
  canvas.height = options.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable in this browser.");
  const start = performance.now();
  renderArtwork(ctx, loaded.view, { ...options, attribution: loaded.attribution });
  return performance.now() - start;
}

export async function encodePng(canvas: HTMLCanvasElement, metadata: Record<string, string>): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("This browser could not encode the PNG.");
  const bytes = insertPngText(new Uint8Array(await blob.arrayBuffer()), metadata);
  return new Blob([bytes.buffer as ArrayBuffer], { type: "image/png" });
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Drawing time of the last renderPng call (ms, excludes PNG encoding). */
export let lastExportRenderMs = 0;

/** Renders off-screen at full size, encodes with metadata, and returns the PNG. */
export async function renderPng(loaded: LoadedView, options: RenderOptions, title: string): Promise<Blob> {
  const canvas = document.createElement("canvas");
  try {
    lastExportRenderMs = await renderInto(canvas, loaded, options);
    return await encodePng(canvas, pngMetadata(loaded.view, options, title, loaded.attribution));
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
