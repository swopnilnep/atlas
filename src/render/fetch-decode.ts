// Fetch + parse + decode of a view file. Runs inside the worker (render/worker.ts) or, as a
// fallback, on the main thread. Pure apart from fetch.
import { decodeView } from "./decode";
import type { DecodedView, RawViewData } from "./types";

export type Progress = (loaded: number, total: number | undefined) => void;

export interface DecodeTimings { fetchMs: number; parseMs: number; decodeMs: number; bytes: number }

export async function fetchText(url: string, onProgress?: Progress): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Map data request failed (${response.status}).`);
  const header = response.headers.get("content-length");
  // With compression, content-length is the compressed size; still useful as a rough total.
  const total = header ? Number(header) : undefined;
  if (!response.body || !onProgress) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const all = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.length; }
  return new TextDecoder().decode(all);
}

export async function fetchAndDecode(url: string, onProgress?: Progress): Promise<{ view: DecodedView; timings: DecodeTimings }> {
  const t0 = performance.now();
  const text = await fetchText(url, onProgress);
  const t1 = performance.now();
  const raw = JSON.parse(text) as RawViewData;
  const t2 = performance.now();
  const view = decodeView(raw);
  const t3 = performance.now();
  return { view, timings: { fetchMs: t1 - t0, parseMs: t2 - t1, decodeMs: t3 - t2, bytes: text.length } };
}

/** Every ArrayBuffer inside a decoded view, for zero-copy transfer from the worker. */
export function transferables(view: DecodedView): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [view.elevation.values.buffer as ArrayBuffer];
  for (const set of Object.values(view.lines)) buffers.push(set.coords.buffer as ArrayBuffer, set.offsets.buffer as ArrayBuffer, set.boxes.buffer as ArrayBuffer);
  for (const set of Object.values(view.polygons)) buffers.push(set.coords.buffer as ArrayBuffer, set.ringOffsets.buffer as ArrayBuffer, set.polygonOffsets.buffer as ArrayBuffer, set.boxes.buffer as ArrayBuffer);
  return buffers;
}
