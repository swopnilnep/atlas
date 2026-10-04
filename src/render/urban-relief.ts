// Urban Relief: terrain, land cover, water, waterways, rail, and roads by class.
import { fillPolygons, makeCanvas, strokeLines, strokePolygons, type Box, type Canvas2D } from "./canvas";
import { visibleQuantBox, type Projection } from "./projection";
import { autoExaggeration, autoExpose, cellSize, hillshade, terrainImage, DEFAULT_SUN } from "./terrain";
import { hexToRgb, type Palette } from "./palettes";
import type { DecodedView, RoadClass } from "./types";

export const URBAN_LAYERS = ["terrain", "wood", "parks", "water", "waterways", "rail", "minorRoads", "majorRoads"] as const;
export type UrbanLayer = (typeof URBAN_LAYERS)[number];

/** Drawn in this order, so the strongest roads end up on top. */
const MINOR: RoadClass[] = ["service", "residential"];
const MAJOR: RoadClass[] = ["tertiary", "secondary", "primary", "trunk", "motorway"];

interface TerrainCache { exposed: Float32Array; shade: Float32Array; exaggeration: number }
const terrainCache = new WeakMap<DecodedView, TerrainCache>();

/** Palette-independent terrain fields for a view (auto-exposed elevation and hillshade), cached. */
export function urbanTerrain(view: DecodedView): TerrainCache {
  let cached = terrainCache.get(view);
  if (!cached) {
    const { columns, rows, values, min, max } = view.elevation;
    const cell = cellSize(view.bounds, columns, rows);
    const exaggeration = autoExaggeration(values, columns, rows, cell);
    cached = { exposed: autoExpose(values, 1, { min, max }), shade: hillshade(values, columns, rows, cell, DEFAULT_SUN, exaggeration), exaggeration };
    terrainCache.set(view, cached);
  }
  return cached;
}

export function drawTerrain(ctx: Canvas2D, view: DecodedView, palette: Palette, p: Projection) {
  if (!palette.terrain) return;
  const { columns, rows } = view.elevation;
  const { exposed, shade } = urbanTerrain(view);
  const pixels = terrainImage(exposed, shade, palette.terrain, hexToRgb(palette.background));
  const small = makeCanvas(columns, rows);
  small.ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer), columns, rows), 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(small.canvas, p.rect.x, p.rect.y, p.rect.width, p.rect.height);
  ctx.restore();
}

/**
 * Base layers: terrain, land cover, and water. In "outline" water mode (Black) the shorelines and
 * waterways are drawn here too, because the water fill that trims them must come after them.
 */
export function drawUrbanBase(ctx: Canvas2D, view: DecodedView, palette: Palette, p: Projection, layers: Record<UrbanLayer, boolean>, scale: number): void {
  const box = visibleQuantBox(p);
  if (layers.terrain) drawTerrain(ctx, view, palette, p);
  // Blended fills keep the hillshade visible; they skip the seam stroke, which would double-blend at edges.
  const blended = palette.landCoverBlend !== "source-over";
  ctx.save();
  ctx.globalCompositeOperation = palette.landCoverBlend;
  if (layers.wood && palette.wood) fillPolygons(ctx, p, view.polygons.wood, box, palette.wood, scale, !blended);
  if (layers.parks && palette.park) fillPolygons(ctx, p, view.polygons.park, box, palette.park, scale, !blended);
  ctx.restore();
  if (palette.waterMode === "fill") {
    if (layers.water) fillPolygons(ctx, p, view.polygons.water, box, palette.water, scale);
  } else {
    // Shorelines only: stroke every ring at twice the width (and the waterways), then fill the
    // water with the dark water tint. That keeps the outer half of each shoreline and erases
    // everything inside the water (bays overlapping the sea, clipped edges, river centre lines
    // through lakes), so only the land/water boundary and the streams on land remain.
    if (layers.water) strokePolygons(ctx, p, view.polygons.water, box, { color: palette.water, width: palette.waterOutlineWidth * 2 }, scale, view.quant, palette.outlineMinAreaPx * scale * scale);
    if (layers.waterways) drawWaterways(ctx, view, palette, p, box, scale);
    if (layers.water) fillPolygons(ctx, p, view.polygons.water, box, palette.waterTint, scale, false);
  }
}

export function drawWaterways(ctx: Canvas2D, view: DecodedView, palette: Palette, p: Projection, box: Box, scale: number) {
  strokeLines(ctx, p, view.lines.stream, box, palette.stream, scale);
  strokeLines(ctx, p, view.lines.canal, box, palette.canal, scale);
  strokeLines(ctx, p, view.lines.river, box, palette.river, scale);
}

/** Line layers drawn over the base: waterways (fill mode), rail, and roads by class. */
export function drawUrbanLines(ctx: Canvas2D, view: DecodedView, palette: Palette, p: Projection, layers: Record<UrbanLayer, boolean>, scale: number): void {
  const box = visibleQuantBox(p);
  if (palette.waterMode === "fill" && layers.waterways) drawWaterways(ctx, view, palette, p, box, scale);
  if (layers.rail) strokeLines(ctx, p, view.lines.rail, box, palette.rail, scale);
  for (const [on, classes] of [[layers.minorRoads, MINOR], [layers.majorRoads, MAJOR]] as const) {
    if (!on) continue;
    for (const name of classes) {
      const stroke = palette.roads[name];
      if (stroke) strokeLines(ctx, p, view.lines[name], box, stroke, scale);
    }
  }
}
