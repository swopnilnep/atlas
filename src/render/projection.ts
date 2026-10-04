// Projection from quantized view coordinates to canvas pixels.
// Local equirectangular around the centre latitude, aspect-preserving "cover" fit:
// the view fills the canvas and the overflow is cropped equally on both sides.
import type { Bounds } from "../types";

export const EARTH_RADIUS_M = 6371008.8;
export const METERS_PER_DEGREE = (Math.PI * EARTH_RADIUS_M) / 180;

export interface Projection {
  width: number;
  height: number;
  /** canvas x = ax * qx + bx; canvas y = ay * qy + by (ay < 0 because y grows north in the data). */
  ax: number; bx: number; ay: number; by: number;
  /** Where the full view bounds land on the canvas (may extend past the edges). */
  rect: { x: number; y: number; width: number; height: number };
  /** Canvas pixels per metre on the ground. */
  pxPerMeter: number;
}

/** Ground size of the bounds in metres, using the same approximation as the pipeline. */
export function boundsMeters(bounds: Bounds): { width: number; height: number } {
  const [west, south, east, north] = bounds;
  const cos = Math.cos((((south + north) / 2) * Math.PI) / 180);
  return { width: (east - west) * cos * METERS_PER_DEGREE, height: (north - south) * METERS_PER_DEGREE };
}

export function makeProjection(bounds: Bounds, quant: number, width: number, height: number): Projection {
  const ground = boundsMeters(bounds);
  const scale = Math.max(width / ground.width, height / ground.height);
  const contentWidth = ground.width * scale;
  const contentHeight = ground.height * scale;
  const x = (width - contentWidth) / 2;
  const y = (height - contentHeight) / 2;
  return {
    width, height,
    ax: contentWidth / quant, bx: x,
    ay: -contentHeight / quant, by: y + contentHeight,
    rect: { x, y, width: contentWidth, height: contentHeight },
    pxPerMeter: scale
  };
}

export function projectPoint(p: Projection, qx: number, qy: number): [number, number] {
  return [p.ax * qx + p.bx, p.ay * qy + p.by];
}

/** Quantized coordinates of a lon/lat point. */
export function quantize(bounds: Bounds, quant: number, lon: number, lat: number): [number, number] {
  const [west, south, east, north] = bounds;
  return [Math.round(((lon - west) / (east - west)) * quant), Math.round(((lat - south) / (north - south)) * quant)];
}

/**
 * The visible part of the view in quantized coordinates, padded by `marginPx`, for culling.
 * Returns [minX, minY, maxX, maxY].
 */
export function visibleQuantBox(p: Projection, marginPx = 4): [number, number, number, number] {
  const x0 = (-marginPx - p.bx) / p.ax;
  const x1 = (p.width + marginPx - p.bx) / p.ax;
  const yTop = (-marginPx - p.by) / p.ay;
  const yBottom = (p.height + marginPx - p.by) / p.ay;
  return [x0, Math.min(yTop, yBottom), x1, Math.max(yTop, yBottom)];
}
