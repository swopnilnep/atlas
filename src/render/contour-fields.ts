// Contour Fields: filled elevation bands, contour lines, soft hillshade, glaciers as negative space.
import { fillPolygons, strokeLines, strokePolygons, type Canvas2D } from "./canvas";
import { makeBands, rasterContours, smoothGrid, upsampleBSpline, type Bands } from "./contours";
import { visibleQuantBox, type Projection } from "./projection";
import { hexToRgb, type Palette } from "./palettes";
import type { DecodedView, RoadClass } from "./types";

export const CONTOUR_LAYERS = ["bands", "contours", "hillshade", "glaciers", "water", "waterways", "roads"] as const;
export type ContourLayer = (typeof CONTOUR_LAYERS)[number];

/** Upsampling factor for the smooth elevation field (grid cell -> 4 × 4 field cells). */
export const FIELD_UPSAMPLE = 4;
/** Light pre-smoothing removes tile stair-steps before the B-spline. */
const SMOOTH_PASSES = 1;

interface FieldCache { field: { values: Float32Array; columns: number; rows: number }; bands: Bands }
const fieldCache = new WeakMap<DecodedView, FieldCache>();

export function contourField(view: DecodedView): FieldCache {
  let cached = fieldCache.get(view);
  if (!cached) {
    const { columns, rows, values, min, max } = view.elevation;
    const field = upsampleBSpline(smoothGrid(values, columns, rows, SMOOTH_PASSES), columns, rows, FIELD_UPSAMPLE);
    cached = { field, bands: makeBands(min, max) };
    fieldCache.set(view, cached);
  }
  return cached;
}

const MAJOR: RoadClass[] = ["tertiary", "secondary", "primary", "trunk", "motorway"];

export function drawContourFields(ctx: Canvas2D, view: DecodedView, palette: Palette, p: Projection, layers: Record<ContourLayer, boolean>, scale: number, afterRaster?: () => void): void {
  const { field, bands } = contourField(view);
  const box = visibleQuantBox(p);
  // Glaciers as a tint: rasterise their coverage into a mask first (the canvas is scratch here;
  // the raster below replaces every pixel), then the bands and lines are tinted under them.
  const tinted = layers.glaciers && palette.iceTint && !palette.iceOutline && view.polygons.glacier.polygonOffsets.length > 1;
  let mask: Uint8Array | undefined;
  if (tinted) {
    ctx.clearRect(0, 0, p.width, p.height);
    fillPolygons(ctx, p, view.polygons.glacier, box, "#ffffff", scale);
    const data = ctx.getImageData(0, 0, p.width, p.height).data;
    mask = new Uint8Array(p.width * p.height);
    for (let i = 0; i < mask.length; i += 1) mask[i] = data[i * 4 + 3];
  }
  const pixels = rasterContours({
    field, rect: p.rect, width: p.width, height: p.height, pxPerMeter: p.pxPerMeter,
    min: view.elevation.min, max: view.elevation.max, bands, style: palette.contour,
    background: hexToRgb(palette.background), scale,
    layers: { fill: layers.bands, lines: layers.contours, hillshade: layers.hillshade },
    mask, tint: tinted && palette.iceTint ? { color: hexToRgb(palette.ice), ...palette.iceTint } : undefined
  });
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer), p.width, p.height), 0, 0);
  // The label fade softens the bands only; water and lines drawn after it keep their colour.
  afterRaster?.();

  if (layers.glaciers && !tinted) {
    if (palette.iceOutline) {
      strokePolygons(ctx, p, view.polygons.glacier, box, { color: palette.iceOutline.color, width: palette.iceOutline.width * 2 }, scale, view.quant);
      fillPolygons(ctx, p, view.polygons.glacier, box, palette.ice, scale, false);
    } else fillPolygons(ctx, p, view.polygons.glacier, box, palette.ice, scale);
  }
  if (layers.water) {
    if (palette.waterMode === "outline") {
      strokePolygons(ctx, p, view.polygons.water, box, { color: palette.water, width: palette.waterOutlineWidth * 2 }, scale, view.quant, palette.outlineMinAreaPx * scale * scale);
      fillPolygons(ctx, p, view.polygons.water, box, palette.waterTint, scale, false);
    } else fillPolygons(ctx, p, view.polygons.water, box, palette.water, scale);
  }
  if (layers.waterways) {
    // Mountain streams are dense; draw them lighter than in cities so they do not mesh over the bands.
    ctx.save();
    ctx.globalAlpha = 0.6;
    strokeLines(ctx, p, view.lines.stream, box, { color: palette.stream.color, width: palette.stream.width * 0.85 }, scale);
    ctx.restore();
    strokeLines(ctx, p, view.lines.river, box, palette.river, scale);
  }
  if (layers.roads) for (const name of MAJOR) strokeLines(ctx, p, view.lines[name], box, palette.terrainRoad, scale);
}
