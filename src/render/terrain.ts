// Terrain math: auto-expose, hillshade, and the Urban Relief terrain image.
// Pure functions on typed arrays; no DOM.
import { boundsMeters } from "./projection";
import type { RGB } from "./types";
import type { TerrainStyle } from "./palettes";
import type { Bounds } from "../types";

export interface Sun {
  /** Degrees clockwise from north (315 = north-west). */
  azimuth: number;
  /** Degrees above the horizon. */
  altitude: number;
}

export const DEFAULT_SUN: Sun = { azimuth: 315, altitude: 40 };

/** Maps values to 0..1 using their own min..max (heightmapper's auto-expose), then applies gamma. */
export function autoExpose(values: ArrayLike<number>, gamma = 1, range?: { min: number; max: number }): Float32Array {
  let min = range?.min ?? Infinity;
  let max = range?.max ?? -Infinity;
  if (!range) for (let i = 0; i < values.length; i += 1) { if (values[i] < min) min = values[i]; if (values[i] > max) max = values[i]; }
  const out = new Float32Array(values.length);
  const span = max - min;
  if (!(span > 0)) return out;
  for (let i = 0; i < values.length; i += 1) {
    const t = Math.min(1, Math.max(0, (values[i] - min) / span));
    out[i] = gamma === 1 ? t : t ** gamma;
  }
  return out;
}

/** Ground size of one elevation cell in metres. */
export function cellSize(bounds: Bounds, columns: number, rows: number): { x: number; y: number } {
  const ground = boundsMeters(bounds);
  return { x: ground.width / columns, y: ground.height / rows };
}

/** Light direction as a unit vector (x east, y north, z up). */
export function sunVector(sun: Sun): [number, number, number] {
  const az = (sun.azimuth * Math.PI) / 180;
  const alt = (sun.altitude * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), Math.sin(alt)];
}

/** Lambertian shade of a surface with the given gradient (dz/dEast, dz/dNorth, unitless). */
export function shadeFromGradient(dzdx: number, dzdy: number, light: readonly [number, number, number]): number {
  const length = Math.hypot(dzdx, dzdy, 1);
  const s = (-dzdx * light[0] - dzdy * light[1] + light[2]) / length;
  return s > 0 ? s : 0;
}

/**
 * Hillshade with Horn's 3 × 3 gradient. Row 0 is north. Returns n·L in 0..1 per cell
 * (flat ground = sin(altitude)). `exaggeration` multiplies elevation (vertical exaggeration).
 */
export function hillshade(values: ArrayLike<number>, columns: number, rows: number, cell: { x: number; y: number }, sun: Sun = DEFAULT_SUN, exaggeration = 1): Float32Array {
  const light = sunVector(sun);
  const out = new Float32Array(columns * rows);
  const at = (r: number, c: number) => values[Math.min(rows - 1, Math.max(0, r)) * columns + Math.min(columns - 1, Math.max(0, c))];
  const kx = exaggeration / (8 * cell.x);
  const ky = exaggeration / (8 * cell.y);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const a = at(r - 1, c - 1), b = at(r - 1, c), cc = at(r - 1, c + 1);
      const d = at(r, c - 1), f = at(r, c + 1);
      const g = at(r + 1, c - 1), h = at(r + 1, c), i = at(r + 1, c + 1);
      const dzdx = ((cc + 2 * f + i) - (a + 2 * d + g)) * kx;
      const dzdy = ((a + 2 * b + cc) - (g + 2 * h + i)) * ky; // north minus south
      out[r * columns + c] = shadeFromGradient(dzdx, dzdy, light);
    }
  }
  return out;
}

/**
 * Signed relief relative to flat ground: -1 (fully away from the sun) .. 0 (flat) .. +1 (facing the sun).
 */
export function relativeShade(shade: number, sun: Sun = DEFAULT_SUN): number {
  const flat = Math.sin((sun.altitude * Math.PI) / 180);
  return shade < flat ? (shade - flat) / flat : (shade - flat) / (1 - flat);
}

/**
 * Vertical exaggeration so the steeper slopes of the view read clearly: the 95th percentile
 * slope is scaled toward `targetSlope`, clamped to 1..maxExaggeration. Flat cities get more,
 * mountains get none.
 */
export function autoExaggeration(values: ArrayLike<number>, columns: number, rows: number, cell: { x: number; y: number }, targetSlope = 0.6, maxExaggeration = 6): number {
  const slopes: number[] = [];
  for (let r = 1; r < rows - 1; r += 2) {
    for (let c = 1; c < columns - 1; c += 2) {
      const dx = (values[r * columns + c + 1] - values[r * columns + c - 1]) / (2 * cell.x);
      const dy = (values[(r - 1) * columns + c] - values[(r + 1) * columns + c]) / (2 * cell.y);
      slopes.push(Math.hypot(dx, dy));
    }
  }
  if (!slopes.length) return 1;
  slopes.sort((a, b) => a - b);
  const p95 = slopes[Math.floor(slopes.length * 0.95)];
  if (!(p95 > 0)) return 1;
  return Math.min(maxExaggeration, Math.max(1, targetSlope / p95));
}

export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Colour of one terrain cell: tint over the background, then shadow/highlight from relief. */
export function terrainColor(style: TerrainStyle, background: RGB, t: number, relief: number, out: number[] | Uint8ClampedArray, at = 0): void {
  const tt = style.gamma === 1 ? t : t ** style.gamma;
  let r = mix(background[0], mix(style.low[0], style.high[0], tt), style.tint);
  let g = mix(background[1], mix(style.low[1], style.high[1], tt), style.tint);
  let b = mix(background[2], mix(style.low[2], style.high[2], tt), style.tint);
  if (relief < 0) {
    const k = -relief * style.shadow;
    r = mix(r, style.shadowColor[0], k); g = mix(g, style.shadowColor[1], k); b = mix(b, style.shadowColor[2], k);
  } else if (relief > 0) {
    const k = relief * style.highlight;
    r = mix(r, style.highlightColor[0], k); g = mix(g, style.highlightColor[1], k); b = mix(b, style.highlightColor[2], k);
  }
  out[at] = Math.round(r); out[at + 1] = Math.round(g); out[at + 2] = Math.round(b);
  if (out.length > at + 3) out[at + 3] = 255;
}

/** RGBA pixels (grid resolution) for the Urban Relief terrain layer. */
export function terrainImage(exposed: Float32Array, shade: Float32Array, style: TerrainStyle, background: RGB, sun: Sun = DEFAULT_SUN): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(exposed.length * 4);
  for (let i = 0; i < exposed.length; i += 1) terrainColor(style, background, exposed[i], relativeShade(shade[i], sun), pixels, i * 4);
  return pixels;
}
