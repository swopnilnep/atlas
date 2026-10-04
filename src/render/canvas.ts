// Canvas drawing helpers shared by both styles.
import type { Projection } from "./projection";
import type { LineSet, PolygonSet } from "./types";
import type { Stroke } from "./palettes";

export type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type Box = readonly [number, number, number, number];

/** An offscreen canvas (OffscreenCanvas when available, else a detached <canvas>). */
export function makeCanvas(width: number, height: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Canvas2D } {
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d") as Canvas2D | null;
  if (!ctx) throw new Error("Canvas 2D is unavailable in this browser.");
  return { canvas, ctx };
}

const visible = (boxes: Int32Array, i: number, box: Box) =>
  boxes[i * 4 + 2] >= box[0] && boxes[i * 4] <= box[2] && boxes[i * 4 + 3] >= box[1] && boxes[i * 4 + 1] <= box[3];

/** Minimum distance (px) between emitted vertices; shorter steps are skipped (except the last point). */
const MIN_STEP_PX = 0.35;

function addLine(ctx: Canvas2D, p: Projection, coords: Int32Array, from: number, to: number, close: boolean) {
  let lastX = p.ax * coords[from * 2] + p.bx;
  let lastY = p.ay * coords[from * 2 + 1] + p.by;
  ctx.moveTo(lastX, lastY);
  for (let i = from + 1; i < to; i += 1) {
    const x = p.ax * coords[i * 2] + p.bx;
    const y = p.ay * coords[i * 2 + 1] + p.by;
    if (i < to - 1 && Math.abs(x - lastX) + Math.abs(y - lastY) < MIN_STEP_PX) continue;
    ctx.lineTo(x, y);
    lastX = x; lastY = y;
  }
  if (close) ctx.closePath();
}

/** Strokes every line of a class as one path, so a translucent colour is applied once (crossings do not darken). */
export function strokeLines(ctx: Canvas2D, p: Projection, set: LineSet, box: Box, stroke: Stroke, scale: number): void {
  const count = set.offsets.length - 1;
  if (!count || stroke.width <= 0) return;
  ctx.beginPath();
  for (let i = 0; i < count; i += 1) if (visible(set.boxes, i, box)) addLine(ctx, p, set.coords, set.offsets[i], set.offsets[i + 1], false);
  ctx.lineWidth = stroke.width * scale;
  ctx.strokeStyle = stroke.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
}

function polygonPath(ctx: Canvas2D, p: Projection, set: PolygonSet, index: number) {
  for (let r = set.polygonOffsets[index]; r < set.polygonOffsets[index + 1]; r += 1) addLine(ctx, p, set.coords, set.ringOffsets[r], set.ringOffsets[r + 1], true);
}

/**
 * Width of the seam stroke that closes anti-aliasing gaps between adjacent polygons, in reference
 * px (scaled with the output). Neighbouring polygons are simplified separately (8 m tolerance), so
 * shared edges can be up to about a pixel apart at 4K.
 */
const SEAM_PX = 0.9;

/**
 * Fills each polygon on its own with the even-odd rule (holes and islands), in one solid colour.
 * Then strokes all rings once with the same colour at SEAM_PX, so polygons that share an edge
 * (glacier tongues, river pieces) do not show a faint anti-aliased seam between them.
 */
export function fillPolygons(ctx: Canvas2D, p: Projection, set: PolygonSet, box: Box, color: string, scale = 1, seam = true): void {
  const count = set.polygonOffsets.length - 1;
  if (!count) return;
  ctx.fillStyle = color;
  for (let i = 0; i < count; i += 1) {
    if (!visible(set.boxes, i, box)) continue;
    ctx.beginPath();
    polygonPath(ctx, p, set, i);
    ctx.fill("evenodd");
  }
  if (!seam) return;
  ctx.beginPath();
  for (let i = 0; i < count; i += 1) if (visible(set.boxes, i, box)) polygonPath(ctx, p, set, i);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.8, SEAM_PX * scale);
  ctx.lineJoin = "round";
  ctx.stroke();
}

const areaCache = new WeakMap<PolygonSet, Float64Array>();

/**
 * Area of each polygon in quantized units², taken as its largest ring (shoelace). Long thin
 * polygons such as creek channels come out small even when their bounding box is large.
 */
export function polygonAreas(set: PolygonSet): Float64Array {
  let areas = areaCache.get(set);
  if (areas) return areas;
  const count = set.polygonOffsets.length - 1;
  areas = new Float64Array(count);
  const c = set.coords;
  for (let i = 0; i < count; i += 1) {
    let best = 0;
    for (let r = set.polygonOffsets[i]; r < set.polygonOffsets[i + 1]; r += 1) {
      const from = set.ringOffsets[r], to = set.ringOffsets[r + 1];
      let sum = 0;
      for (let k = from; k < to; k += 1) {
        const j = k + 1 < to ? k + 1 : from;
        sum += c[k * 2] * c[j * 2 + 1] - c[j * 2] * c[k * 2 + 1];
      }
      best = Math.max(best, Math.abs(sum) / 2);
    }
    areas[i] = best;
  }
  areaCache.set(set, areas);
  return areas;
}

const onSameBorder = (x0: number, y0: number, x1: number, y1: number, quant: number) =>
  (x0 === x1 && (x0 <= 0 || x0 >= quant)) || (y0 === y1 && (y0 <= 0 || y0 >= quant));

/**
 * Strokes every ring of a class (shorelines) as one path. Ring edges that run along the view
 * border (from clipping) are skipped, so the frame edge does not get a line.
 */
export function strokePolygons(ctx: Canvas2D, p: Projection, set: PolygonSet, box: Box, stroke: Stroke, scale: number, quant: number, minAreaPx2 = 0): void {
  const count = set.polygonOffsets.length - 1;
  const c = set.coords;
  const areas = minAreaPx2 > 0 ? polygonAreas(set) : null;
  const pxPerQ2 = p.ax * -p.ay;
  ctx.beginPath();
  for (let i = 0; i < count; i += 1) {
    if (!visible(set.boxes, i, box)) continue;
    if (areas && areas[i] * pxPerQ2 < minAreaPx2) continue;
    for (let r = set.polygonOffsets[i]; r < set.polygonOffsets[i + 1]; r += 1) {
      const from = set.ringOffsets[r], to = set.ringOffsets[r + 1];
      let px = c[from * 2], py = c[from * 2 + 1];
      ctx.moveTo(p.ax * px + p.bx, p.ay * py + p.by);
      for (let k = 1; k <= to - from; k += 1) {
        const j = from + (k % (to - from));
        const x = c[j * 2], y = c[j * 2 + 1];
        if (onSameBorder(px, py, x, y, quant)) ctx.moveTo(p.ax * x + p.bx, p.ay * y + p.by);
        else ctx.lineTo(p.ax * x + p.bx, p.ay * y + p.by);
        px = x; py = y;
      }
    }
  }
  ctx.lineWidth = stroke.width * scale;
  ctx.strokeStyle = stroke.color;
  ctx.lineJoin = "round";
  ctx.stroke();
}
