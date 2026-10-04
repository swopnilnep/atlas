// Web Worker: fetches, parses, and decodes view files off the main thread.
import { fetchAndDecode, transferables } from "./fetch-decode";

export type WorkerRequest = { id: number; url: string };
export type WorkerResponse =
  | { id: number; type: "progress"; loaded: number; total?: number }
  | { id: number; type: "done"; view: import("./types").DecodedView; timings: import("./fetch-decode").DecodeTimings }
  | { id: number; type: "error"; message: string };

const scope = self as unknown as { onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null; postMessage(message: WorkerResponse, transfer?: Transferable[]): void };

scope.onmessage = async (event) => {
  const { id, url } = event.data;
  try {
    let last = 0;
    const { view, timings } = await fetchAndDecode(url, (loaded, total) => {
      const now = performance.now();
      if (now - last > 80) { last = now; scope.postMessage({ id, type: "progress", loaded, total }); }
    });
    scope.postMessage({ id, type: "done", view, timings }, transferables(view));
  } catch (error) {
    scope.postMessage({ id, type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
