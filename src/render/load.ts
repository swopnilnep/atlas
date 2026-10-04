// Loads view data on demand, in a Web Worker when available, and caches it in memory.
import { DEFAULT_ATTRIBUTION } from "../renderer";
import { fetchAndDecode, type DecodeTimings, type Progress } from "./fetch-decode";
import type { DecodedView } from "./types";
import type { WorkerRequest, WorkerResponse } from "./worker";

export interface LoadedView { view: DecodedView; attribution: string; timings: DecodeTimings & { totalMs: number; worker: boolean } }

const cache = new Map<string, Promise<LoadedView>>();
let worker: Worker | undefined;
let workerFailed = false;
let nextId = 1;
const pending = new Map<number, { resolve: (value: { view: DecodedView; timings: DecodeTimings }) => void; reject: (error: Error) => void; onProgress?: Progress }>();

function getWorker(): Worker | undefined {
  if (workerFailed || typeof Worker === "undefined") return undefined;
  if (!worker) {
    try {
      worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        const entry = pending.get(message.id);
        if (!entry) return;
        if (message.type === "progress") entry.onProgress?.(message.loaded, message.total);
        else {
          pending.delete(message.id);
          if (message.type === "done") entry.resolve({ view: message.view, timings: message.timings });
          else entry.reject(new Error(message.message));
        }
      };
      worker.onerror = () => {
        workerFailed = true;
        for (const entry of pending.values()) entry.reject(new Error("worker failed"));
        pending.clear();
      };
    } catch {
      workerFailed = true;
      return undefined;
    }
  }
  return worker;
}

function decodeInWorker(url: string, onProgress?: Progress): Promise<{ view: DecodedView; timings: DecodeTimings }> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error("no worker"));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ id, url: new URL(url, location.href).href } satisfies WorkerRequest);
  });
}

async function requiredAttribution(dataFile: string): Promise<string> {
  try {
    const response = await fetch(dataFile.replace(/\.json$/, ".manifest.json"));
    if (!response.ok) return DEFAULT_ATTRIBUTION;
    const manifest = await response.json() as { requiredAttribution?: unknown };
    return typeof manifest.requiredAttribution === "string" && manifest.requiredAttribution.trim() ? manifest.requiredAttribution : DEFAULT_ATTRIBUTION;
  } catch {
    return DEFAULT_ATTRIBUTION;
  }
}

/** Loads and decodes a view file once; later calls return the cached result. */
export function loadView(dataFile: string, onProgress?: Progress): Promise<LoadedView> {
  let entry = cache.get(dataFile);
  if (!entry) {
    entry = (async () => {
      const start = performance.now();
      const attribution = requiredAttribution(dataFile);
      let result: { view: DecodedView; timings: DecodeTimings };
      let usedWorker = true;
      try {
        result = await decodeInWorker(dataFile, onProgress);
      } catch (error) {
        if (!workerFailed && error instanceof Error && error.message !== "no worker" && error.message !== "worker failed") throw error;
        usedWorker = false;
        result = await fetchAndDecode(dataFile, onProgress);
      }
      return { view: result.view, attribution: await attribution, timings: { ...result.timings, totalMs: performance.now() - start, worker: usedWorker } };
    })();
    entry.catch(() => cache.delete(dataFile));
    cache.set(dataFile, entry);
  }
  return entry;
}
