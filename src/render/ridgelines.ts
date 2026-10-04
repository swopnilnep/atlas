// Ridgelines: layered mountain silhouettes from the elevation grid, full bleed. Horizontal profiles
// are sampled from north (far, near the horizon) to south (near, bottom of the canvas) and placed
// with a perspective depth scale, so near bands are few and tall and far bands are dense and low.
// Every profile spans the whole canvas width and is drawn as a filled band (colour mixed from the
// near tone toward a hazy far tone, with a little valley mist), then a thin crest line on top.
// A soft sky gradient sits above the horizon. Pure arithmetic on the grid: deterministic.
import type { Canvas2D } from "./canvas";
import { smoothGrid } from "./contours";
import { FONT_FAMILY, spacedText } from "./label";
import type { Palette, RidgeStyle } from "./palettes";
import { boundsMeters } from "./projection";
import { mix } from "./terrain";
import type { DecodedView, ElevationGrid, RGB } from "./types";
import type { Bounds } from "../types";

export const RIDGE_LAYERS = ["ridgelines", "summit"] as const;
export type RidgeLayer = (typeof RIDGE_LAYERS)[number];

export const RIDGE = {
  /** Number of profiles (bands), far to near. */
  profiles: 26,
  /** Ground distance of the farthest row relative to the nearest (perspective strength). */
  depthRatio: 3.2,
  /** Horizon (screen y of the farthest ground line) and nearest ground line, as shares of the height. */
  horizon: 0.56,
  nearBase: 1.03,
  /** The highest crest may rise to this share of the height from the top. */
  topMargin: 0.05,
  /** Target relief of the nearest band as a share of the height, before the fit. */
  reliefShare: 0.8,
  minExaggeration: 1,
  maxExaggeration: 7
} as const;

export interface RidgeProfile {
  /** Screen y of the ground line (elevation = grid minimum). Increases from far to near. */
  base: number;
  /** 0 nearest .. 1 farthest. */
  depth: number;
  xs: Float32Array;
  ys: Float32Array;
  /** Highest point (smallest y) of the profile. */
  top: number;
}

export interface RidgeLayout {
  profiles: RidgeProfile[];
  exaggeration: number;
  horizon: number;
  summit: { x: number; y: number } | null;
}

const layoutCache = new WeakMap<ElevationGrid, Map<string, RidgeLayout>>();

/** Profile layout for a canvas of width × height. Cached per grid and size. */
export function ridgelineLayout(elevation: ElevationGrid, bounds: Bounds, width: number, height: number): RidgeLayout {
  const key = `${width}x${height}`;
  let byGrid = layoutCache.get(elevation);
  const hit = byGrid?.get(key);
  if (hit) return hit;
  const layout = computeLayout(elevation, bounds, width, height);
  if (!byGrid) layoutCache.set(elevation, (byGrid = new Map()));
  byGrid.set(key, layout);
  return layout;
}

function computeLayout(elevation: ElevationGrid, bounds: Bounds, width: number, height: number): RidgeLayout {
  const { columns, rows } = elevation;
  const grid = smoothGrid(elevation.values, columns, rows, 1);
  let min = Infinity, max = -Infinity, maxAt = 0;
  for (let i = 0; i < grid.length; i += 1) {
    const v = grid[i];
    if (v < min) min = v;
    if (v > max) { max = v; maxAt = i; }
  }
  const relief = Math.max(1, max - min);
  const ground = boundsMeters(bounds);
  const n = Math.max(2, Math.min(RIDGE.profiles, rows));
  const horizon = height * RIDGE.horizon, nearBase = height * RIDGE.nearBase, top = height * RIDGE.topMargin;

  // Rows uniformly in ground distance; screen scale s = dNear / d (1 nearest .. 1 / depthRatio farthest).
  const sampled: { s: number; base: number; te: Float32Array; peak: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    const u = i / (n - 1); // 0 far .. 1 near
    const s = 1 / (RIDGE.depthRatio - (RIDGE.depthRatio - 1) * u);
    const base = horizon + (nearBase - horizon) * (s - 1 / RIDGE.depthRatio) / (1 - 1 / RIDGE.depthRatio);
    const r = ((i + 0.5) / n) * rows - 0.5;
    const r0 = Math.max(0, Math.min(rows - 1, Math.floor(r)));
    const r1 = Math.min(rows - 1, r0 + 1);
    const f = Math.max(0, Math.min(1, r - r0));
    const te = new Float32Array(columns);
    let peak = 0;
    for (let c = 0; c < columns; c += 1) {
      const e = grid[r0 * columns + c] * (1 - f) + grid[r1 * columns + c] * f;
      te[c] = (e - min) / relief;
      if (te[c] > peak) peak = te[c];
    }
    sampled.push({ s, base, te, peak });
  }

  // Relief in px at the nearest row: natural scale × exaggeration toward the target, then fitted so
  // every crest stays below the top margin.
  const natural = (relief / ground.width) * width;
  const exaggeration = Math.min(RIDGE.maxExaggeration, Math.max(RIDGE.minExaggeration, (RIDGE.reliefShare * height) / natural));
  let reliefPx = natural * exaggeration;
  for (const p of sampled) if (p.peak > 0) reliefPx = Math.min(reliefPx, (p.base - top) / (p.peak * p.s));

  const profiles: RidgeProfile[] = sampled.map((p, i) => {
    const xs = new Float32Array(columns), ys = new Float32Array(columns);
    let pTop = Infinity;
    for (let c = 0; c < columns; c += 1) {
      xs[c] = (c / (columns - 1)) * width;
      ys[c] = p.base - p.te[c] * reliefPx * p.s;
      if (ys[c] < pTop) pTop = ys[c];
    }
    return { base: p.base, depth: 1 - i / (n - 1), xs, ys, top: pTop };
  });

  // Summit: the profile nearest to the grid maximum, at its highest point near that column; the
  // annotation goes above the skyline at that x.
  const sr = Math.floor(maxAt / columns), sc = maxAt % columns;
  const si = Math.max(0, Math.min(n - 1, Math.round(((sr + 0.5) / rows) * n - 0.5)));
  const sp = profiles[si];
  let best = sc;
  for (let c = Math.max(0, sc - 4); c <= Math.min(columns - 1, sc + 4); c += 1) if (sp.ys[c] < sp.ys[best]) best = c;
  let y = sp.ys[best];
  for (const q of profiles) if (q.ys[best] < y) y = q.ys[best];
  return { profiles, exaggeration: reliefPx / natural, horizon, summit: { x: sp.xs[best], y } };
}

const css = (c: readonly number[], alpha = 1) => alpha >= 1
  ? `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`
  : `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${alpha.toFixed(3)})`;
const mixRGB = (a: RGB, b: RGB, t: number): RGB => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

/** Band fill colour at a depth (0 near .. 1 far): eased toward the haze so most bands stay distinct. */
export function bandColor(style: RidgeStyle, depth: number): RGB {
  return mixRGB(style.near, style.far, depth ** 1.9);
}

/** Sky gradient, then the bands back to front: filled silhouette with valley mist and a crest line. */
export function drawRidgelines(ctx: Canvas2D, view: DecodedView, palette: Palette, layers: Record<RidgeLayer, boolean>, scale: number): RidgeLayout {
  const { width, height } = ctx.canvas;
  const layout = ridgelineLayout(view.elevation, view.bounds, width, height);
  const style = palette.ridge;
  const sky = ctx.createLinearGradient(0, 0, 0, layout.horizon + height * 0.12);
  sky.addColorStop(0, css(style.skyTop));
  sky.addColorStop(1, css(style.skyHorizon));
  ctx.save();
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  if (!layers.ridgelines) { ctx.restore(); return layout; }
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const bottom = height + 2;
  for (const p of layout.profiles) {
    const n = p.xs.length;
    const outline = new Path2D();
    outline.moveTo(p.xs[0] - 2, p.ys[0]);
    for (let c = 0; c < n; c += 1) outline.lineTo(p.xs[c], p.ys[c]);
    outline.lineTo(p.xs[n - 1] + 2, p.ys[n - 1]);
    const band = new Path2D(outline);
    band.lineTo(width + 2, bottom);
    band.lineTo(-2, bottom);
    band.closePath();
    const fill = bandColor(style, p.depth);
    const gradient = ctx.createLinearGradient(0, p.top, 0, Math.max(p.top + 1, p.base));
    gradient.addColorStop(0, css(fill));
    gradient.addColorStop(1, css(mixRGB(fill, style.skyHorizon, style.mist * (1 - 0.6 * p.depth))));
    ctx.fillStyle = gradient;
    ctx.fill(band);
    ctx.strokeStyle = css(style.crest, mix(style.crestAlpha, style.crestFarAlpha, p.depth));
    ctx.lineWidth = style.width * scale * mix(1.15, 0.6, p.depth);
    ctx.stroke(outline);
  }
  ctx.restore();
  return layout;
}

/** "EVEREST  8,849 m" above the highest ridge, small. */
export function drawSummit(ctx: Canvas2D, layout: RidgeLayout, summit: { name: string; elevationM: number } | undefined, palette: Palette, scale: number): void {
  if (!summit || !layout.summit) return;
  const { x, y } = layout.summit;
  const size = 7.5 * scale;
  const name = summit.name.toUpperCase();
  const ele = `${summit.elevationM.toLocaleString("en-US")} m`;
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.font = `600 ${size.toFixed(2)}px "${FONT_FAMILY}", system-ui, sans-serif`;
  const spacing = size * 0.18;
  const nameW = spacedText(ctx, name, 0, 0, spacing, false);
  ctx.font = `400 ${size.toFixed(2)}px "${FONT_FAMILY}", system-ui, sans-serif`;
  const gap = size * 0.7;
  const eleW = ctx.measureText(ele).width;
  const total = nameW + gap + eleW;
  const tx = Math.max(size, Math.min(ctx.canvas.width - size - total, x - total / 2));
  const ty = Math.max(size * 1.5, y - 9 * scale);
  ctx.strokeStyle = palette.labelMuted;
  ctx.lineWidth = 0.6 * scale;
  ctx.beginPath();
  ctx.moveTo(x, y - 2.5 * scale);
  ctx.lineTo(x, ty + size * 0.35);
  ctx.stroke();
  ctx.fillStyle = palette.label;
  ctx.font = `600 ${size.toFixed(2)}px "${FONT_FAMILY}", system-ui, sans-serif`;
  spacedText(ctx, name, tx, ty - size * 0.2, spacing);
  ctx.fillStyle = palette.labelMuted;
  ctx.font = `400 ${size.toFixed(2)}px "${FONT_FAMILY}", system-ui, sans-serif`;
  ctx.fillText(ele, tx + nameW + gap, ty - size * 0.2);
  ctx.restore();
}
