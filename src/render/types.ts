// Shared types for the v2 renderer. The data contract is docs/DATA_PIPELINE.md.
import type { Bounds } from "../types";

export const ROAD_CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "service"] as const;
export const LINE_CLASSES = [...ROAD_CLASSES, "rail", "river", "stream", "canal"] as const;
export const POLYGON_CLASSES = ["water", "park", "wood", "glacier", "wetland"] as const;

export type RoadClass = (typeof ROAD_CLASSES)[number];
export type LineClass = (typeof LINE_CLASSES)[number];
export type PolygonClass = (typeof POLYGON_CLASSES)[number];

/** The view JSON as written by tools/data/prepare.py (format version 2). */
export interface RawViewData {
  version: 2;
  id: string;
  bounds: Bounds;
  quant: number;
  lines: Record<LineClass, number[][]>;
  polygons: Record<PolygonClass, number[][][]>;
  elevation: { columns: number; rows: number; min: number; max: number; values: number[] };
  label: { name: string; nativeName?: string; nativeLang?: string; region: string; regionCode: string; source: string; summit?: { name: string; elevationM: number } };
}

/**
 * Decoded lines of one class. `coords` holds absolute quantized [x, y] pairs (y grows north).
 * Line i uses points offsets[i] .. offsets[i + 1] - 1. `boxes` holds [minX, minY, maxX, maxY] per line.
 */
export interface LineSet {
  coords: Int32Array;
  offsets: Uint32Array;
  boxes: Int32Array;
}

/**
 * Decoded polygons of one class. Ring r uses points ringOffsets[r] .. ringOffsets[r + 1] - 1 (not closed).
 * Polygon p uses rings polygonOffsets[p] .. polygonOffsets[p + 1] - 1. `boxes` is per polygon.
 */
export interface PolygonSet {
  coords: Int32Array;
  ringOffsets: Uint32Array;
  polygonOffsets: Uint32Array;
  boxes: Int32Array;
}

export interface ElevationGrid {
  columns: number;
  rows: number;
  min: number;
  max: number;
  /** Row 0 is the north edge, column 0 the west edge. */
  values: Float32Array;
}

export interface DecodedView {
  id: string;
  bounds: Bounds;
  quant: number;
  lines: Record<LineClass, LineSet>;
  polygons: Record<PolygonClass, PolygonSet>;
  elevation: ElevationGrid;
  label: RawViewData["label"];
}

export type RGB = readonly [number, number, number];
