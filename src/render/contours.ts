// Contour Fields math: band intervals, smooth field upsampling, and the anti-aliased band raster.
// Pure functions on typed arrays; no DOM.
import { mix, relativeShade, shadeFromGradient, sunVector, DEFAULT_SUN, type Sun } from "./terrain";
import type { ContourStyle } from "./palettes";
import type { RGB } from "./types";

const NICE_INTERVALS = [1, 2, 5, 10, 20, 25, 50, 100, 150, 200, 250, 500, 1000];

/** Smallest "nice" interval that gives at most `maxBands` bands over min..max. */
export function chooseInterval(min: number, max: number, maxBands = 35): number {
  const span = Math.max(1, max - min);
  for (const interval of NICE_INTERVALS) if (span / interval <= maxBands) return interval;
  return NICE_INTERVALS[NICE_INTERVALS.length - 1];
}

export interface Bands {
  interval: number;
  /** Elevation of the bottom of band 0 (a multiple of interval at or below min). */
  base: number;
  count: number;
}

export function makeBands(min: number, max: number, interval = chooseInterval(min, max)): Bands {
  const base = Math.floor(min / interval) * interval;
  const count = Math.max(1, Math.ceil((max - base) / interval));
  return { interval, base, count };
}

/** Band of an elevation: 0 for [base, base + interval), clamped to 0..count-1. */
export function bandIndex(value: number, bands: Bands): number {
  const b = Math.floor((value - bands.base) / bands.interval);
  return b < 0 ? 0 : b >= bands.count ? bands.count - 1 : b;
}

/** Samples a multi-stop ramp at t in 0..1. */
export function sampleRamp(ramp: readonly RGB[], t: number): [number, number, number] {
  if (ramp.length === 1) return [...ramp[0]] as [number, number, number];
  const x = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const f = x - i;
  return [mix(ramp[i][0], ramp[i + 1][0], f), mix(ramp[i][1], ramp[i + 1][1], f), mix(ramp[i][2], ramp[i + 1][2], f)];
}

/** One colour per band, from the auto-exposed range min..max. */
export function bandColors(bands: Bands, min: number, max: number, ramp: readonly RGB[], gamma: number): Float32Array {
  const out = new Float32Array(bands.count * 3);
  for (let b = 0; b < bands.count; b += 1) {
    const middle = bands.base + (b + 0.5) * bands.interval;
    const t = Math.min(1, Math.max(0, (middle - min) / Math.max(1, max - min)));
    out.set(sampleRamp(ramp, t ** gamma), b * 3);
  }
  return out;
}

/** 3 × 3 binomial blur, `passes` times. Removes the stair-steps of the resampled tiles. */
export function smoothGrid(values: Float32Array, columns: number, rows: number, passes = 1): Float32Array {
  let src = values;
  for (let pass = 0; pass < passes; pass += 1) {
    const tmp = new Float32Array(src.length);
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < columns; c += 1) {
        const l = src[r * columns + Math.max(0, c - 1)], m = src[r * columns + c], rr = src[r * columns + Math.min(columns - 1, c + 1)];
        tmp[r * columns + c] = (l + 2 * m + rr) / 4;
      }
    }
    const out = new Float32Array(src.length);
    for (let r = 0; r < rows; r += 1) {
      const up = Math.max(0, r - 1) * columns, mid = r * columns, down = Math.min(rows - 1, r + 1) * columns;
      for (let c = 0; c < columns; c += 1) out[mid + c] = (tmp[up + c] + 2 * tmp[mid + c] + tmp[down + c]) / 4;
    }
    src = out;
  }
  return src;
}

function bspline(t: number): [number, number, number, number] {
  const t2 = t * t, t3 = t2 * t;
  return [(1 - t) ** 3 / 6, (3 * t3 - 6 * t2 + 4) / 6, (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, t3 / 6];
}

function upsampleAxis(src: Float32Array, length: number, lines: number, stride: number, step: number, k: number, outLength: number, outStride: number, outStep: number): Float32Array {
  const out = new Float32Array(outLength);
  for (let j = 0; j < length * k; j += 1) {
    const x = (j + 0.5) / k - 0.5;
    const i = Math.floor(x);
    const w = bspline(x - i);
    const i0 = Math.max(0, i - 1), i1 = Math.max(0, Math.min(length - 1, i)), i2 = Math.min(length - 1, i + 1), i3 = Math.min(length - 1, i + 2);
    for (let line = 0; line < lines; line += 1) {
      const o = line * stride;
      out[line * outStride + j * outStep] = w[0] * src[o + i0 * step] + w[1] * src[o + i1 * step] + w[2] * src[o + i2 * step] + w[3] * src[o + i3 * step];
    }
  }
  return out;
}

/**
 * Upsamples a grid by an integer factor with a separable cubic B-spline (C2 smooth, so contour
 * lines have no kinks at cell edges). Cell centres stay registered: output cell j covers input
 * coordinate (j + 0.5) / k - 0.5.
 */
export function upsampleBSpline(values: Float32Array, columns: number, rows: number, k: number): { values: Float32Array; columns: number; rows: number } {
  const wide = columns * k;
  // Horizontal: each row of length `columns` -> `wide`.
  const horizontal = upsampleAxis(values, columns, rows, columns, 1, k, wide * rows, wide, 1);
  // Vertical: each column of length `rows` -> `rows * k`.
  const full = upsampleAxis(horizontal, rows, wide, 1, wide, k, wide * rows * k, 1, wide);
  return { values: full, columns: wide, rows: rows * k };
}

export interface ContourRasterInput {
  field: { values: Float32Array; columns: number; rows: number };
  /** Where the field's bounds land on the canvas. */
  rect: { x: number; y: number; width: number; height: number };
  width: number;
  height: number;
  pxPerMeter: number;
  min: number;
  max: number;
  bands: Bands;
  style: ContourStyle;
  background: RGB;
  /** Line widths are style widths × this (resolution scale). */
  scale: number;
  layers: { fill: boolean; lines: boolean; hillshade: boolean };
  sun?: Sun;
  exaggeration?: number;
  /**
   * Optional per-pixel coverage (0..255, width × height), e.g. glaciers: covered pixels are tinted
   * toward `tint.color` by `tint.amount` and their contour lines keep `tint.lineAlpha` of their ink.
   */
  mask?: Uint8Array;
  tint?: { color: RGB; amount: number; lineAlpha: number };
}

/**
 * Renders filled bands, contour lines, and hillshade into RGBA pixels at canvas size.
 * Per pixel: bilinear elevation and its analytic gradient; the distance to the nearest contour
 * level in pixels is (level distance) / |gradient|, which gives anti-aliased lines and band edges
 * at any output size.
 */
export function rasterContours(input: ContourRasterInput): Uint8ClampedArray {
  const { field, rect, width, height, bands, style, background, scale, layers } = input;
  const out = new Uint8ClampedArray(width * height * 4);
  const fill = layers.fill && style.ramp.length > 0;
  const colors = fill ? bandColors(bands, input.min, input.max, style.ramp, style.gamma) : null;
  const light = sunVector(input.sun ?? DEFAULT_SUN);
  const sun = input.sun ?? DEFAULT_SUN;
  const exaggeration = input.exaggeration ?? 1;
  const fx = field.columns / rect.width; // field cells per canvas px
  const fy = field.rows / rect.height;
  const halfLine = (style.lineWidth * scale) / 2;
  const halfIndex = (style.indexWidth * scale) / 2;
  const baseLevel = Math.round(bands.base / bands.interval);
  const lineAlpha = layers.lines ? style.lineAlpha : 0;
  const shading = layers.hillshade && (style.shadow > 0 || style.highlight > 0);
  const metersPerPx = 1 / input.pxPerMeter;
  const { columns, rows, values } = field;
  const [bgR, bgG, bgB] = background;
  const mask = input.mask && input.tint ? input.mask : null;
  const tint = input.tint;

  for (let py = 0; py < height; py += 1) {
    const gy = (py + 0.5 - rect.y) * fy - 0.5;
    let r0 = Math.floor(gy);
    let ty = gy - r0;
    if (r0 < 0) { r0 = 0; ty = 0; } else if (r0 >= rows - 1) { r0 = rows - 2; ty = 1; }
    const rowA = r0 * columns, rowB = rowA + columns;
    for (let px = 0; px < width; px += 1) {
      const gx = (px + 0.5 - rect.x) * fx - 0.5;
      let c0 = Math.floor(gx);
      let tx = gx - c0;
      if (c0 < 0) { c0 = 0; tx = 0; } else if (c0 >= columns - 1) { c0 = columns - 2; tx = 1; }
      const v00 = values[rowA + c0], v10 = values[rowA + c0 + 1], v01 = values[rowB + c0], v11 = values[rowB + c0 + 1];
      const top = v00 + (v10 - v00) * tx;
      const bottom = v01 + (v11 - v01) * tx;
      const v = top + (bottom - top) * ty;
      // Gradient in metres of elevation per canvas pixel (x east, y south).
      const dvx = ((v10 - v00) * (1 - ty) + (v11 - v01) * ty) * fx;
      const dvy = (bottom - top) * fy;
      const g = Math.hypot(dvx, dvy);

      const p = (v - bands.base) / bands.interval;
      let b = Math.floor(p);
      const f = p - b;
      if (b < 0) b = 0; else if (b >= bands.count) b = bands.count - 1;
      const spacing = g > 1e-9 ? bands.interval / g : Infinity; // px between contour lines
      const dLow = f * spacing, dHigh = (1 - f) * spacing;
      const nearLow = dLow <= dHigh;
      const d = nearLow ? dLow : dHigh;

      let r = bgR, gg = bgG, bb = bgB;
      if (colors) {
        r = colors[b * 3]; gg = colors[b * 3 + 1]; bb = colors[b * 3 + 2];
        if (d < 0.5) {
          const nb = nearLow ? Math.max(0, b - 1) : Math.min(bands.count - 1, b + 1);
          const k = 0.5 - d;
          r = mix(r, colors[nb * 3], k); gg = mix(gg, colors[nb * 3 + 1], k); bb = mix(bb, colors[nb * 3 + 2], k);
        }
      }
      if (shading) {
        const relief = relativeShade(shadeFromGradient((dvx * exaggeration) / metersPerPx, (-dvy * exaggeration) / metersPerPx, light), sun);
        if (relief < 0) {
          const k = -relief * style.shadow;
          r = mix(r, style.shadowColor[0], k); gg = mix(gg, style.shadowColor[1], k); bb = mix(bb, style.shadowColor[2], k);
        } else {
          const k = relief * style.highlight;
          r = mix(r, style.highlightColor[0], k); gg = mix(gg, style.highlightColor[1], k); bb = mix(bb, style.highlightColor[2], k);
        }
      }
      const m = mask ? mask[py * width + px] / 255 : 0;
      if (m > 0 && tint) {
        const k = m * tint.amount;
        r = mix(r, tint.color[0], k); gg = mix(gg, tint.color[1], k); bb = mix(bb, tint.color[2], k);
      }
      if (lineAlpha > 0 && spacing < 1e9) {
        const level = (nearLow ? Math.floor(p) : Math.floor(p) + 1) + baseLevel;
        const half = level % style.indexEvery === 0 ? halfIndex : halfLine;
        let a = half + 0.5 - d;
        if (a > 0) {
          if (a > 1) a = 1;
          // Where lines crowd together on cliffs, fade them so they do not merge into a solid mass.
          const crowd = (spacing - 2 * half - 0.75) / 2.5;
          a *= crowd <= 0 ? 0 : crowd >= 1 ? 1 : crowd;
          // Thin lines get proportionally less ink so 1280 px and 4K read the same.
          a *= lineAlpha * Math.min(1, half * 2);
          if (m > 0 && tint) a *= 1 - m * (1 - tint.lineAlpha);
          r = mix(r, style.line[0], a); gg = mix(gg, style.line[1], a); bb = mix(bb, style.line[2], a);
        }
      }
      const o = (py * width + px) * 4;
      out[o] = r; out[o + 1] = gg; out[o + 2] = bb; out[o + 3] = 255;
    }
  }
  return out;
}
