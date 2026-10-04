// Water Shapes (Rivers & Deltas): faint terrain, wetlands, water polygons, and waterways by size. No roads.
import { fillPolygons, strokeLines, strokePolygons, type Canvas2D } from "./canvas";
import { visibleQuantBox, type Projection } from "./projection";
import type { Palette } from "./palettes";
import type { DecodedView } from "./types";
import { drawTerrain } from "./urban-relief";

export const WATER_LAYERS = ["terrain", "wetlands", "water", "waterways"] as const;
export type WaterLayer = (typeof WATER_LAYERS)[number];

/** Rivers read as the main channels at delta scale; streams stay a fine mesh behind them. */
const RIVER_WIDTH = 1.25;
const STREAM_WIDTH = 0.9;
const STREAM_ALPHA = 0.75;
const CANAL_WIDTH = 0.55;
const CANAL_ALPHA = 0.6;

export function drawWaterShapes(ctx: Canvas2D, view: DecodedView, palette: Palette, p: Projection, layers: Record<WaterLayer, boolean>, scale: number): void {
  const box = visibleQuantBox(p);
  if (layers.terrain && palette.terrain && palette.waterShapesTerrain > 0) {
    ctx.save();
    ctx.globalAlpha = palette.waterShapesTerrain;
    drawTerrain(ctx, view, palette, p);
    ctx.restore();
  }
  if (layers.wetlands) fillPolygons(ctx, p, view.polygons.wetland, box, palette.wetland, scale, false);
  const outline = palette.waterMode === "outline";
  if (layers.water && outline) {
    strokePolygons(ctx, p, view.polygons.water, box, { color: palette.water, width: palette.waterOutlineWidth * 2 }, scale, view.quant, palette.outlineMinAreaPx * scale * scale);
  }
  if (layers.waterways) {
    ctx.save();
    ctx.globalAlpha = STREAM_ALPHA;
    strokeLines(ctx, p, view.lines.stream, box, { color: palette.stream.color, width: palette.stream.width * STREAM_WIDTH }, scale);
    ctx.restore();
    // Delta canals are dense irrigation grids; keep them finer than the rivers.
    ctx.save();
    ctx.globalAlpha = CANAL_ALPHA;
    strokeLines(ctx, p, view.lines.canal, box, { color: palette.canal.color, width: palette.canal.width * CANAL_WIDTH }, scale);
    ctx.restore();
    strokeLines(ctx, p, view.lines.river, box, { color: palette.river.color, width: palette.river.width * RIVER_WIDTH }, scale);
  }
  if (layers.water) fillPolygons(ctx, p, view.polygons.water, box, outline ? palette.waterTint : palette.water, scale, !outline);
}
