// Decoder for the v2 view format: quantized, delta-encoded lines and polygons.
import { LINE_CLASSES, POLYGON_CLASSES } from "./types";
import type { DecodedView, LineClass, LineSet, PolygonClass, PolygonSet, RawViewData } from "./types";

/** Decodes one delta-encoded flat array [x0, y0, dx1, dy1, ...] into absolute pairs, appended to `out` at `at`. */
export function decodeDelta(encoded: ArrayLike<number>, out: Int32Array, at: number): void {
  let x = 0;
  let y = 0;
  for (let i = 0; i < encoded.length; i += 2) {
    x += encoded[i];
    y += encoded[i + 1];
    out[at + i] = x;
    out[at + i + 1] = y;
  }
}

function boxOf(coords: Int32Array, from: number, to: number, boxes: Int32Array, index: number) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let p = from; p < to; p += 1) {
    const x = coords[p * 2], y = coords[p * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  boxes.set([minX, minY, maxX, maxY], index * 4);
}

export function decodeLines(lines: number[][]): LineSet {
  let points = 0;
  for (const line of lines) {
    if (line.length < 4 || line.length % 2) throw new Error("A line must have at least two [x, y] points.");
    points += line.length / 2;
  }
  const coords = new Int32Array(points * 2);
  const offsets = new Uint32Array(lines.length + 1);
  const boxes = new Int32Array(lines.length * 4);
  let at = 0;
  lines.forEach((line, i) => {
    decodeDelta(line, coords, at * 2);
    offsets[i] = at;
    at += line.length / 2;
    boxOf(coords, offsets[i], at, boxes, i);
  });
  offsets[lines.length] = at;
  return { coords, offsets, boxes };
}

export function decodePolygons(polygons: number[][][]): PolygonSet {
  let points = 0;
  let rings = 0;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      if (ring.length < 6 || ring.length % 2) throw new Error("A ring must have at least three [x, y] points.");
      points += ring.length / 2;
      rings += 1;
    }
  }
  const coords = new Int32Array(points * 2);
  const ringOffsets = new Uint32Array(rings + 1);
  const polygonOffsets = new Uint32Array(polygons.length + 1);
  const boxes = new Int32Array(polygons.length * 4);
  let at = 0;
  let ringIndex = 0;
  polygons.forEach((polygon, p) => {
    polygonOffsets[p] = ringIndex;
    const start = at;
    for (const ring of polygon) {
      decodeDelta(ring, coords, at * 2);
      ringOffsets[ringIndex++] = at;
      at += ring.length / 2;
    }
    boxOf(coords, start, at, boxes, p);
  });
  ringOffsets[rings] = at;
  polygonOffsets[polygons.length] = ringIndex;
  return { coords, ringOffsets, polygonOffsets, boxes };
}

/** Validates the top-level shape and decodes every class. Throws on anything outside the contract. */
export function decodeView(raw: RawViewData): DecodedView {
  if (!raw || raw.version !== 2) throw new Error("Unsupported map data version (expected 2).");
  const { bounds, quant, elevation } = raw;
  if (!Array.isArray(bounds) || bounds.length !== 4 || !(bounds[0] < bounds[2] && bounds[1] < bounds[3])) throw new Error("Map data has invalid bounds.");
  if (!Number.isInteger(quant) || quant <= 0) throw new Error("Map data has an invalid quantization.");
  if (elevation.values.length !== elevation.columns * elevation.rows) throw new Error("Elevation grid size does not match its values.");
  const lines = {} as Record<LineClass, LineSet>;
  for (const name of LINE_CLASSES) lines[name] = decodeLines(raw.lines[name] ?? []);
  const polygons = {} as Record<PolygonClass, PolygonSet>;
  for (const name of POLYGON_CLASSES) polygons[name] = decodePolygons(raw.polygons[name] ?? []);
  return {
    id: raw.id, bounds, quant, lines, polygons,
    elevation: { columns: elevation.columns, rows: elevation.rows, min: elevation.min, max: elevation.max, values: Float32Array.from(elevation.values) },
    label: raw.label
  };
}
