// Atlas production renderer (data format v2). Deterministic Canvas 2D drawing of one view.
// Modules: render/decode (data), render/projection, render/palettes, render/terrain,
// render/contours (math), render/urban-relief and render/contour-fields (styles), render/label.
import type { ViewStyle } from "./types";
import { drawContourFields, CONTOUR_LAYERS, type ContourLayer } from "./render/contour-fields";
import { crushBlacks, drawAttribution, drawLabel, fillFade, formatCoordinates, layoutOverlay, rgbList, textBoxes, type FadeRegion } from "./render/label";
import { blackPalette, hexToRgb, isPaletteId, PALETTES, type BlackAccent, type Palette, type PaletteId } from "./render/palettes";
import { makeProjection } from "./render/projection";
import { drawUrbanBase, drawUrbanLines, URBAN_LAYERS, type UrbanLayer } from "./render/urban-relief";
import { drawRidgelines, drawSummit, RIDGE_LAYERS, type RidgeLayer } from "./render/ridgelines";
import { drawWaterShapes, WATER_LAYERS, type WaterLayer } from "./render/water-shapes";
import type { DecodedView } from "./render/types";
import { makeCanvas, type Canvas2D } from "./render/canvas";

export const RENDERER_VERSION = "2.2.0";
export const DEFAULT_ATTRIBUTION = "© OpenStreetMap contributors · Protomaps · Elevation: AWS Terrain Tiles (USGS 3DEP, SRTM, GMTED2010 and others)";
export const REFERENCE_SIZE = { width: 1280, height: 800 } as const;
export const MAX_SIDE = 7680;
export const MAX_SIZE = 7680 * 4800;

export type LayerId = UrbanLayer | ContourLayer | RidgeLayer | WaterLayer;

export const STYLE_LAYERS: Record<ViewStyle, readonly LayerId[]> = {
  "urban-relief": URBAN_LAYERS,
  "contour-fields": CONTOUR_LAYERS,
  ridgelines: RIDGE_LAYERS,
  "water-shapes": WATER_LAYERS
};

export const LAYER_NAMES: Record<LayerId, string> = {
  terrain: "Terrain", wood: "Woods", parks: "Parks", water: "Water", waterways: "Rivers and streams",
  rail: "Rail", minorRoads: "Minor roads", majorRoads: "Major roads",
  bands: "Elevation bands", contours: "Contour lines", hillshade: "Hillshade", glaciers: "Glaciers", roads: "Roads",
  ridgelines: "Ridgelines", summit: "Summit label", wetlands: "Wetlands"
};

export interface RenderOptions {
  style: ViewStyle;
  palette: PaletteId;
  /** Missing layers default to on. */
  layers?: Partial<Record<LayerId, boolean>>;
  width: number;
  height: number;
  label?: boolean;
  /** Text for the PNG metadata. Images no longer draw it (see drawAttributionLine). */
  attribution?: string;
  /** Draw the attribution line in the image corner (off by default). */
  drawAttributionLine?: boolean;
  /** Palette-study override for Black's accent. */
  blackAccent?: BlackAccent;
}

/** Line widths and text scale with the output's resolution relative to 1280 × 800. */
export function resolutionScale(width: number, height: number): number {
  return Math.sqrt((width * height) / (REFERENCE_SIZE.width * REFERENCE_SIZE.height));
}

export function validateOptions(options: RenderOptions): RenderOptions {
  if (!(options.style in STYLE_LAYERS)) throw new Error(`Unknown style "${String(options.style)}".`);
  if (!isPaletteId(options.palette)) throw new Error(`Unknown palette "${String(options.palette)}".`);
  const { width, height } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 200 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_SIZE) {
    throw new Error("Output dimensions are outside the supported range.");
  }
  return options;
}

export function resolvePalette(options: Pick<RenderOptions, "palette" | "blackAccent">): Palette {
  return options.palette === "black" && options.blackAccent ? blackPalette(options.blackAccent) : PALETTES[options.palette];
}

function layerFlags<T extends string>(names: readonly T[], layers: Partial<Record<string, boolean>> = {}): Record<T, boolean> {
  return Object.fromEntries(names.map((name) => [name, layers[name] !== false])) as Record<T, boolean>;
}

type Region = FadeRegion["box"];
const overlaps = (a: Region, b: Region) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Groups fade regions whose boxes overlap, so each canvas pixel belongs to at most one group box. */
export function groupFades(fades: FadeRegion[]): { box: Region; fades: FadeRegion[] }[] {
  let groups = fades.filter((f) => f.box.width > 0 && f.box.height > 0).map((f) => ({ box: { ...f.box }, fades: [f] }));
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        if (!overlaps(groups[i].box, groups[j].box)) continue;
        const a = groups[i].box, b = groups[j].box;
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        const box = { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
        groups = [...groups.filter((_, k) => k !== i && k !== j), { box, fades: [...groups[i].fades, ...groups[j].fades] }];
        merged = true;
        break outer;
      }
    }
  }
  return groups;
}

/**
 * Draws line layers with a local fade behind the label and attribution: outside the fade boxes
 * the lines go straight onto the canvas; inside each box they are drawn on a small offscreen
 * canvas, erased with a radial gradient, and composited. Only the lines thin out, so water and
 * terrain under the label keep their colour (no halo).
 */
export function drawWithFades(ctx: Canvas2D, fades: FadeRegion[], strength: number, draw: (target: Canvas2D) => void): void {
  const groups = strength > 0 ? groupFades(fades) : [];
  if (!groups.length) { draw(ctx); return; }
  const { width, height } = ctx.canvas;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  for (const g of groups) ctx.rect(g.box.x, g.box.y, g.box.width, g.box.height);
  ctx.clip("evenodd");
  draw(ctx);
  ctx.restore();
  for (const g of groups) {
    const { x, y, width: w, height: h } = g.box;
    const layer = makeCanvas(w, h);
    layer.ctx.translate(-x, -y);
    draw(layer.ctx);
    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    layer.ctx.globalCompositeOperation = "destination-out";
    for (const fade of g.fades) fillFade(layer.ctx, fade, "0, 0, 0", strength, x, y);
    ctx.drawImage(layer.canvas, x, y);
    layer.canvas.width = 0;
  }
}

/** Share of pixels in a box that are exactly the given colour. */
export function colorShare(ctx: Canvas2D, box: readonly [number, number, number, number], color: string): number {
  const x = Math.max(0, Math.floor(box[0])), y = Math.max(0, Math.floor(box[1]));
  const w = Math.min(ctx.canvas.width - x, Math.ceil(box[2])), h = Math.min(ctx.canvas.height - y, Math.ceil(box[3]));
  if (w <= 0 || h <= 0) return 0;
  const [r, g, b] = hexToRgb(color);
  const d = ctx.getImageData(x, y, w, h).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] === r && d[i + 1] === g && d[i + 2] === b) n += 1;
  return n / (w * h);
}

/** Above this share of water behind a text block, the text switches to the palette's on-water colours. */
export const ON_WATER_SHARE = 0.4;

/** Draws one artwork into a canvas of exactly options.width × options.height. */
export function renderArtwork(ctx: Canvas2D, view: DecodedView, input: RenderOptions): void {
  const options = validateOptions(input);
  const { width, height } = options;
  if (ctx.canvas.width !== width || ctx.canvas.height !== height) throw new Error("Canvas dimensions do not match the options.");
  const palette = resolvePalette(options);
  const scale = resolutionScale(width, height);
  const projection = makeProjection(view.bounds, view.quant, width, height);
  const attribution = options.attribution ?? DEFAULT_ATTRIBUTION;
  const text = options.label !== false ? labelText(view) : null;

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  const attributionLine = options.drawAttributionLine ? attribution : null;
  const layout = layoutOverlay(ctx, text, attributionLine, scale);
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, width, height);
  let labelColors = { title: palette.label, muted: palette.labelMuted };
  let labelOnWater = false;
  let attributionOnWater = false;
  if (options.style === "urban-relief") {
    const layers = layerFlags(URBAN_LAYERS, options.layers);
    drawUrbanBase(ctx, view, palette, projection, layers, scale);
    if (palette.waterMode === "fill" && layers.water) {
      const boxes = textBoxes(layout);
      labelOnWater = !!boxes.label && colorShare(ctx, boxes.label, palette.water) > ON_WATER_SHARE;
      attributionOnWater = colorShare(ctx, boxes.attribution, palette.water) > ON_WATER_SHARE;
    }
    drawWithFades(ctx, layout.fades, palette.fade, (target) => drawUrbanLines(target, view, palette, projection, layers, scale));
  } else if (options.style === "ridgelines") {
    const layers = layerFlags(RIDGE_LAYERS, options.layers);
    const ridge = drawRidgelines(ctx, view, palette, layers, scale);
    // Full bleed: the label sits on the near bands, so it uses the ridge label colours and no fade.
    if (layers.ridgelines) labelColors = palette.ridge.label;
    if (layers.summit) drawSummit(ctx, ridge, view.label.summit, palette, scale);
  } else if (options.style === "water-shapes") {
    const layers = layerFlags(WATER_LAYERS, options.layers);
    drawWaterShapes(ctx, view, palette, projection, layers, scale);
    if (palette.waterMode === "fill" && layers.water) {
      const boxes = textBoxes(layout);
      labelOnWater = !!boxes.label && colorShare(ctx, boxes.label, palette.water) > ON_WATER_SHARE;
      attributionOnWater = colorShare(ctx, boxes.attribution, palette.water) > ON_WATER_SHARE;
    }
  } else {
    const layers = layerFlags(CONTOUR_LAYERS, options.layers);
    const rgb = rgbList(palette.background);
    drawContourFields(ctx, view, palette, projection, layers, scale, () => {
      for (const fade of layout.fades) fillFade(ctx, fade, rgb, palette.contourFade);
    });
    if (palette.waterMode === "fill" && layers.water) {
      const boxes = textBoxes(layout);
      labelOnWater = !!boxes.label && colorShare(ctx, boxes.label, palette.water) > ON_WATER_SHARE;
      attributionOnWater = colorShare(ctx, boxes.attribution, palette.water) > ON_WATER_SHARE;
    }
  }
  crushBlacks(ctx, palette.crushBlack);
  drawLabel(ctx, layout, text?.coordinates ?? "", labelOnWater ? palette.labelOnWater : labelColors);
  if (attributionLine) drawAttribution(ctx, layout, attributionLine, attributionOnWater ? palette.attributionOnWater : palette.attribution);
  ctx.restore();
}

/** Native name (own script) as the title; the English name joins the region on the muted line. */
export function labelText(view: DecodedView) {
  const { name, nativeName, nativeLang, region } = view.label;
  const title = nativeName || name;
  const subtitle = title.toLocaleLowerCase() === name.toLocaleLowerCase() ? region : `${name} · ${region}`;
  return { title, subtitle, lang: nativeLang, coordinates: formatCoordinates(view.bounds) };
}

/** PNG text metadata for an export. */
export function pngMetadata(view: DecodedView, options: RenderOptions, title: string, attribution = options.attribution ?? DEFAULT_ATTRIBUTION): Record<string, string> {
  const palette = resolvePalette(options);
  return {
    Title: title,
    Author: "Atlas · atlas.swopnil.com",
    Description: `${view.label.name}, ${view.label.region} (${formatCoordinates(view.bounds)}). ${palette.name} palette, ${options.width} × ${options.height}.`,
    Source: attribution,
    Copyright: `Map data ${attribution}. OpenStreetMap data is available under the Open Database License (ODbL).`,
    Software: `Atlas renderer ${RENDERER_VERSION}`
  };
}

export { PALETTES } from "./render/palettes";
export type { PaletteId } from "./render/palettes";
