import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { boundsMeters } from "../src/render/projection";
import { drawRidgelines, ridgelineLayout, RIDGE } from "../src/render/ridgelines";
import { PALETTES } from "../src/render/palettes";
import type { DecodedView, ElevationGrid } from "../src/render/types";
import type { Bounds } from "../src/types";
import { pieceBounds, validatePiece } from "../tools/lib/catalog.mjs";

const root = resolve(import.meta.dirname, "..");
const python = resolve(root, ".venv/bin/python");

describe("catalog", () => {
  const catalog = JSON.parse(readFileSync(resolve(root, "views/catalog.json"), "utf8")) as { pieces: Record<string, unknown>[] };

  it("computes 16:10 bounds centred on the catalog point", () => {
    for (const [lon, lat, km] of [[-97.75, 30.3, 50], [86.925, 27.988, 30], [18.45, -34, 40], [-151.0074, 63.0692, 50]]) {
      const b = pieceBounds([lon, lat], km) as Bounds;
      const ground = boundsMeters(b);
      expect(ground.width / ground.height).toBeCloseTo(1.6, 3);
      expect(ground.width / 1000).toBeCloseTo(km, 1);
      expect((b[0] + b[2]) / 2).toBeCloseTo(lon, 4);
      expect((b[1] + b[3]) / 2).toBeCloseTo(lat, 4);
    }
  });

  it("validates every piece and keeps ids unique", () => {
    const pieces = catalog.pieces.map((p, i) => validatePiece(p, i));
    expect(new Set(pieces.map((p) => p.id)).size).toBe(pieces.length);
    expect(() => validatePiece({ ...pieces[0], id: "wrong" }, 0)).toThrow(/id/);
    expect(() => validatePiece({ ...pieces[0], widthKm: 0 }, 0)).toThrow(/widthKm/);
  });

  it("agrees with the bounds written by the Python pipeline", () => {
    for (const p of catalog.pieces.map((v, i) => validatePiece(v, i))) {
      const file = resolve(root, "public/data", `${p.id}-v1.json`);
      if (!existsSync(file)) continue;
      const data = JSON.parse(readFileSync(file, "utf8")) as { bounds: number[] };
      expect(data.bounds).toEqual(pieceBounds(p.center, p.widthKm));
    }
  });
});

describe("protomaps class mapping", () => {
  const table = JSON.parse(readFileSync(resolve(root, "tools/data/protomaps_classes.json"), "utf8"));

  it("maps road kind_detail values onto the Atlas road classes", () => {
    const d = table.roads.byKindDetail as Record<string, string>;
    expect(d.motorway_link).toBe("motorway");
    expect(d.unclassified).toBe("residential");
    expect(d.living_street).toBe("residential");
    expect(d.service).toBe("service");
    expect(d.light_rail).toBe("rail");
    expect(d.footway).toBeUndefined();
    expect(table.roads.kinds).not.toContain("path");
  });

  it("maps water, park, wood, and glacier", () => {
    expect(table.waterLines.byKind).toEqual({ river: "river", stream: "stream", canal: "canal" });
    expect(table.waterPolygons.class).toBe("water");
    expect(table.waterPolygons.excludeKinds).toContain("swimming_pool");
    expect(table.landuse.byKind.forest).toBe("wood");
    expect(table.landuse.byKind.glacier).toBe("glacier");
    expect(table.landuse.byKind.national_park).toBe("park");
  });

  it.skipIf(!existsSync(python))("classify() in tools/data/protomaps.py follows the table (ocean is filled water)", () => {
    const script = `
import json, sys
sys.path.insert(0, "tools/data")
from protomaps import classify
cases = [("roads", {"kind": "highway", "kind_detail": "motorway"}, "line"),
         ("roads", {"kind": "minor_road", "kind_detail": "residential"}, "line"),
         ("roads", {"kind": "path", "kind_detail": "footway"}, "line"),
         ("roads", {"kind": "rail", "kind_detail": "subway"}, "line"),
         ("water", {"kind": "ocean"}, "polygon"),
         ("water", {"kind": "water", "kind_detail": "lake"}, "polygon"),
         ("water", {"kind": "swimming_pool"}, "polygon"),
         ("water", {"kind": "river"}, "line"),
         ("landuse", {"kind": "wood"}, "polygon"),
         ("landuse", {"kind": "glacier"}, "polygon"),
         ("landuse", {"kind": "residential"}, "polygon")]
print(json.dumps([classify(*c) for c in cases]))`;
    const out = JSON.parse(execFileSync(python, ["-c", script], { cwd: root, encoding: "utf8" }));
    expect(out).toEqual(["motorway", "residential", null, null, "water", "water", null, "river", "wood", "glacier", null]);
  });
});

/** A cone on a plane: one clear summit. */
function coneGrid(columns = 60, rows = 38): ElevationGrid {
  const values = new Float32Array(columns * rows);
  let max = -Infinity, min = Infinity;
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < columns; c += 1) {
    const d = Math.hypot((c - columns * 0.6) / columns, (r - rows * 0.4) / rows);
    const v = 500 + Math.max(0, 3000 * (1 - d * 3));
    values[r * columns + c] = v;
    max = Math.max(max, v); min = Math.min(min, v);
  }
  return { columns, rows, min, max, values };
}

/** Records drawing calls in order. */
function recordingContext(width: number, height: number) {
  const ops: string[] = [];
  const ctx = {
    canvas: { width, height },
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() { ops.push(`fill:${String(ctx.fillStyle)}`); },
    stroke() { ops.push("stroke"); },
    fillStyle: "" as unknown, strokeStyle: "" as unknown, lineWidth: 1, lineJoin: "", lineCap: ""
  };
  return { ctx, ops };
}

describe("ridgelines", () => {
  const bounds: Bounds = pieceBounds([86.9, 28], 30) as Bounds;
  const grid = coneGrid();

  it("is deterministic", () => {
    const a = ridgelineLayout(grid, bounds, 1280, 800);
    const b = ridgelineLayout({ ...grid, values: new Float32Array(grid.values) }, bounds, 1280, 800);
    expect(b.profiles.length).toBe(a.profiles.length);
    for (let i = 0; i < a.profiles.length; i += 1) {
      expect(Array.from(b.profiles[i].ys)).toEqual(Array.from(a.profiles[i].ys));
      expect(Array.from(b.profiles[i].xs)).toEqual(Array.from(a.profiles[i].xs));
    }
    expect(b.summit).toEqual(a.summit);
  });

  it("orders profiles far (top) to near (bottom), spans the full width, and raises the summit", () => {
    const { profiles, summit, exaggeration } = ridgelineLayout(grid, bounds, 1280, 800);
    expect(profiles.length).toBe(Math.min(RIDGE.profiles, grid.rows));
    for (let i = 1; i < profiles.length; i += 1) expect(profiles[i].base).toBeGreaterThan(profiles[i - 1].base);
    // Perspective: screen spacing between bands grows toward the viewer.
    const gap = (i: number) => profiles[i + 1].base - profiles[i].base;
    expect(gap(profiles.length - 2)).toBeGreaterThan(gap(0));
    for (const p of profiles) {
      expect(p.xs[0]).toBe(0);
      expect(p.xs[p.xs.length - 1]).toBeCloseTo(1280, 3);
      for (let c = 0; c < p.ys.length; c += 1) expect(p.ys[c]).toBeGreaterThanOrEqual(800 * RIDGE.topMargin - 0.5);
    }
    expect(exaggeration).toBeLessThanOrEqual(RIDGE.maxExaggeration);
    expect(summit).not.toBeNull();
    expect(summit!.y).toBeLessThan(800 * 0.5);
  });

  it("draws the sky, then one filled band and one crest stroke per profile, back to front", () => {
    (globalThis as Record<string, unknown>).Path2D ??= class { moveTo() {} lineTo() {} closePath() {} };
    const { ctx, ops } = recordingContext(1280, 800);
    const gradient = { addColorStop() {} };
    Object.assign(ctx, { createLinearGradient: () => gradient, fillRect: () => ops.push("sky") });
    const view = { elevation: grid, bounds, label: { name: "X", region: "Y", regionCode: "Y", source: "" } } as unknown as DecodedView;
    drawRidgelines(ctx as unknown as CanvasRenderingContext2D, view, PALETTES.black, { ridgelines: true, summit: true }, 1);
    const n = Math.min(RIDGE.profiles, grid.rows);
    expect(ops[0]).toBe("sky");
    expect(ops.length).toBe(1 + 2 * n);
    for (let k = 0; k < n; k += 1) {
      expect(ops[1 + 2 * k].startsWith("fill:")).toBe(true);
      expect(ops[2 + 2 * k]).toBe("stroke");
    }
  });
});
