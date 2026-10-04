import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { groupFades } from "../src/renderer";
import { bandColors, bandIndex, chooseInterval, makeBands, upsampleBSpline } from "../src/render/contours";
import { decodeDelta, decodeLines, decodePolygons, decodeView } from "../src/render/decode";
import { formatCoordinates, isLatinText, toeCurve, type FadeRegion } from "../src/render/label";
import { BLACK_ACCENTS, blackPalette, PALETTE_IDS, PALETTES } from "../src/render/palettes";
import { crc32, insertPngText, readPngChunks } from "../src/render/png-text";
import { boundsMeters, makeProjection, projectPoint, quantize } from "../src/render/projection";
import { autoExpose, cellSize, hillshade, relativeShade } from "../src/render/terrain";
import { ROAD_CLASSES, type RawViewData } from "../src/render/types";
import { loadViews } from "../tools/lib/views.mjs";

const root = resolve(import.meta.dirname, "..");

/** The tiny example from docs/DATA_PIPELINE.md. */
const example: RawViewData = {
  version: 2, id: "example", bounds: [0, 0, 1, 1], quant: 65535,
  lines: { motorway: [], trunk: [], primary: [], secondary: [], tertiary: [], residential: [[100, 200, 50, 0, 0, -30]], service: [], rail: [], river: [], stream: [], canal: [] },
  polygons: { water: [[[1000, 1000, 500, 0, -250, 400]]], park: [], wood: [], glacier: [], wetland: [] },
  elevation: { columns: 2, rows: 1, min: 5, max: 9, values: [5, 9] },
  label: { name: "X", region: "Y", regionCode: "YY", source: "OSM node 1 (place=city)" }
};

describe("v2 decoder", () => {
  it("decodes delta-encoded points", () => {
    const out = new Int32Array(6);
    decodeDelta([100, 200, 50, 0, 0, -30], out, 0);
    expect([...out]).toEqual([100, 200, 150, 200, 150, 170]);
  });

  it("decodes the documented example", () => {
    const view = decodeView(example);
    const street = view.lines.residential;
    expect([...street.coords]).toEqual([100, 200, 150, 200, 150, 170]);
    expect([...street.offsets]).toEqual([0, 3]);
    expect([...street.boxes]).toEqual([100, 170, 150, 200]);
    const lake = view.polygons.water;
    expect([...lake.coords]).toEqual([1000, 1000, 1500, 1000, 1250, 1400]);
    expect([...lake.ringOffsets]).toEqual([0, 3]);
    expect([...lake.polygonOffsets]).toEqual([0, 1]);
    expect([...view.elevation.values]).toEqual([5, 9]);
  });

  it("keeps several lines, rings, and polygons apart", () => {
    const lines = decodeLines([[0, 0, 1, 1], [10, 10, 1, 0, 1, 0]]);
    expect([...lines.offsets]).toEqual([0, 2, 5]);
    expect([...lines.coords.slice(4)]).toEqual([10, 10, 11, 10, 12, 10]);
    const polygons = decodePolygons([[[0, 0, 10, 0, 0, 10], [2, 2, 1, 0, 0, 1]], [[50, 50, 5, 0, 0, 5]]]);
    expect([...polygons.ringOffsets]).toEqual([0, 3, 6, 9]);
    expect([...polygons.polygonOffsets]).toEqual([0, 2, 3]);
    expect([...polygons.boxes.slice(4)]).toEqual([50, 50, 55, 55]);
  });

  it("rejects other versions and malformed data", () => {
    expect(() => decodeView({ ...example, version: 1 as 2 })).toThrow(/version/);
    expect(() => decodeLines([[1, 2]])).toThrow();
    expect(() => decodePolygons([[[1, 2, 3, 4]]])).toThrow();
    expect(() => decodeView({ ...example, elevation: { ...example.elevation, values: [1] } })).toThrow(/Elevation/);
  });
});

describe("projection", () => {
  const bounds: [number, number, number, number] = [-98.01, 30.16, -97.49, 30.44];

  it("flips y: north (qy = quant) is at the top, south at the bottom", () => {
    const p = makeProjection(bounds, 65535, 1280, 800);
    const [, top] = projectPoint(p, 0, 65535);
    const [, bottom] = projectPoint(p, 0, 0);
    expect(top).toBeCloseTo(p.rect.y, 6);
    expect(bottom).toBeCloseTo(p.rect.y + p.rect.height, 6);
    expect(top).toBeLessThan(bottom);
  });

  it("uses cos(centre latitude) so a 16:10 ground rectangle fills a 16:10 canvas", () => {
    const ground = boundsMeters(bounds);
    expect(ground.width / ground.height).toBeCloseTo((0.52 * Math.cos((30.3 * Math.PI) / 180)) / 0.28, 9);
    const rainier: [number, number, number, number] = [-122.07561, 46.7181, -121.44439, 46.9879];
    const g = boundsMeters(rainier);
    expect(g.width).toBeCloseTo(48000, -2);
    expect(g.height).toBeCloseTo(30000, -2);
    const p = makeProjection(rainier, 65535, 3840, 2400);
    expect(p.rect.x).toBeCloseTo(0, 0);
    expect(p.rect.width).toBeCloseTo(3840, 0);
  });

  it("cover-fits: the view fills the canvas and is centre-cropped, same scale on both axes", () => {
    const p = makeProjection(bounds, 65535, 1320, 2868);
    expect(p.rect.height).toBeCloseTo(2868, 6);
    expect(p.rect.width).toBeGreaterThan(1320);
    expect(p.rect.x).toBeCloseTo(-(p.rect.width - 1320) / 2, 6);
    const ground = boundsMeters(bounds);
    expect(p.rect.width / ground.width).toBeCloseTo(p.rect.height / ground.height, 9);
    // The view centre lands on the canvas centre.
    const [cx, cy] = projectPoint(p, 65535 / 2, 65535 / 2);
    expect(cx).toBeCloseTo(660, 6);
    expect(cy).toBeCloseTo(1434, 6);
  });

  it("quantizes like the pipeline", () => {
    expect(quantize(bounds, 65535, -98.01, 30.16)).toEqual([0, 0]);
    expect(quantize(bounds, 65535, -97.49, 30.44)).toEqual([65535, 65535]);
  });
});

describe("terrain", () => {
  it("auto-exposes the grid range to 0..1 with optional gamma", () => {
    expect([...autoExpose([110, 247.5, 385])]).toEqual([0, 0.5, 1]);
    const g = autoExpose([0, 50, 100], 2);
    expect(g[1]).toBeCloseTo(0.25, 6);
    expect([...autoExpose([7, 7, 7])]).toEqual([0, 0, 0]);
    expect([...autoExpose([0, 200], 1, { min: 0, max: 100 })]).toEqual([0, 1]);
  });

  it("computes cell size in metres", () => {
    const cell = cellSize([0, 0, 1, 1], 10, 10);
    expect(cell.y).toBeCloseTo(11119.5, 0);
    expect(cell.x).toBeCloseTo(11119.5 * Math.cos((0.5 * Math.PI) / 180), 0);
  });

  /** A 9 × 9 grid with a plane z = ax * east + ay * north (row 0 is north). */
  const plane = (ax: number, ay: number) => {
    const values: number[] = [];
    for (let r = 0; r < 9; r += 1) for (let c = 0; c < 9; c += 1) values.push(ax * c * 30 + ay * (8 - r) * 30);
    return hillshade(values, 9, 9, { x: 30, y: 30 })[4 * 9 + 4];
  };

  it("lights slopes facing the north-west sun and shades slopes facing away", () => {
    const flat = plane(0, 0);
    expect(flat).toBeCloseTo(Math.sin((40 * Math.PI) / 180), 6);
    // Ground rising to the south-east faces north-west, toward the sun (azimuth 315°).
    expect(plane(-0.5, 0.5)).toBeLessThan(flat); // rises to the north-west: faces south-east, away
    expect(plane(0.5, -0.5)).toBeGreaterThan(flat);
    // Rising to the east faces west (lit); rising to the west faces east (shaded).
    expect(plane(0.5, 0)).toBeGreaterThan(flat);
    expect(plane(-0.5, 0)).toBeLessThan(flat);
    // Rising to the south faces north (lit); rising to the north faces south (shaded).
    expect(plane(0, -0.5)).toBeGreaterThan(flat);
    expect(plane(0, 0.5)).toBeLessThan(flat);
  });

  it("vertical exaggeration steepens the shading", () => {
    const values: number[] = [];
    for (let r = 0; r < 5; r += 1) for (let c = 0; c < 5; c += 1) values.push(-c * 3);
    const a = hillshade(values, 5, 5, { x: 30, y: 30 }, undefined, 1)[12];
    const b = hillshade(values, 5, 5, { x: 30, y: 30 }, undefined, 4)[12];
    expect(relativeShade(b)).toBeLessThan(relativeShade(a));
    expect(relativeShade(a)).toBeLessThan(0);
  });
});

describe("contour bands", () => {
  it("chooses a nice interval giving at most 35 bands", () => {
    expect(chooseInterval(387, 4385)).toBe(150);
    expect(chooseInterval(0, 3000)).toBe(100);
    expect((4385 - 387) / chooseInterval(387, 4385)).toBeGreaterThanOrEqual(25);
  });

  it("assigns elevations to bands, clamped at both ends", () => {
    const bands = makeBands(387, 4385, 100);
    expect(bands).toEqual({ interval: 100, base: 300, count: 41 });
    expect(bandIndex(300, bands)).toBe(0);
    expect(bandIndex(399.9, bands)).toBe(0);
    expect(bandIndex(400, bands)).toBe(1);
    expect(bandIndex(4385, bands)).toBe(40);
    expect(bandIndex(-50, bands)).toBe(0);
    expect(bandIndex(99999, bands)).toBe(40);
  });

  it("ramps band colours from the lowest to the highest band", () => {
    const colors = bandColors(makeBands(0, 1000, 100), 0, 1000, [[0, 0, 0], [200, 200, 200]], 1);
    expect(colors[0]).toBeCloseTo(10, 6);
    expect(colors[9 * 3]).toBeCloseTo(190, 6);
  });

  it("upsamples smoothly and keeps a constant field constant", () => {
    const up = upsampleBSpline(new Float32Array(12).fill(7), 4, 3, 4);
    expect(up.columns).toBe(16);
    expect(up.rows).toBe(12);
    for (const v of up.values) expect(v).toBeCloseTo(7, 5);
  });
});

describe("palettes", () => {
  const keys = Object.keys(PALETTES["ink-and-river"]).sort();

  it("defines exactly the four palettes, each with every key", () => {
    expect(Object.keys(PALETTES)).toEqual([...PALETTE_IDS]);
    expect(PALETTE_IDS).toEqual(["ink-and-river", "paper", "night-river", "black"]);
    for (const id of PALETTE_IDS) {
      const palette = PALETTES[id];
      expect(palette.id).toBe(id);
      expect(Object.keys(palette).sort()).toEqual(keys);
      expect(Object.keys(palette.roads).sort()).toEqual([...ROAD_CLASSES].sort());
      for (const value of [palette.background, palette.water, palette.label, palette.labelMuted, palette.attribution, palette.ice]) expect(value).toMatch(/^(#[0-9a-f]{6}|rgba?\(.+\))$/);
      expect(palette.contour.indexEvery).toBeGreaterThan(0);
    }
  });

  it("matches the documented base colours", () => {
    expect([PALETTES["ink-and-river"].background, PALETTES["ink-and-river"].water, PALETTES["ink-and-river"].label]).toEqual(["#f6f5f1", "#2e4fa0", "#2e4fa0"]);
    expect([PALETTES.paper.background, PALETTES.paper.water, PALETTES.paper.label]).toEqual(["#eeeadd", "#8ba9b3", "#a8462a"]);
    expect([PALETTES["night-river"].background, PALETTES["night-river"].water, PALETTES["night-river"].label]).toEqual(["#0a1220", "#2f7fd1", "#ff7a59"]);
  });

  it("keeps Black true black with one accent for water and label", () => {
    for (const accent of Object.keys(BLACK_ACCENTS) as (keyof typeof BLACK_ACCENTS)[]) {
      const black = blackPalette(accent);
      expect(black.background).toBe("#000000");
      expect(black.terrain?.low).toEqual([0, 0, 0]);
      expect(black.water).toBe(BLACK_ACCENTS[accent]);
      expect(black.label).toBe(BLACK_ACCENTS[accent]);
      expect(black.crushBlack).toBeGreaterThan(0);
    }
  });

  it("applies a continuous black-point toe", () => {
    expect(toeCurve(48, 48)).toBe(0);
    expect(toeCurve(72, 48)).toBe(48);
    expect(toeCurve(96, 48)).toBe(96);
    expect(toeCurve(200, 48)).toBe(200);
  });
});

describe("label", () => {
  it("letter-spaces Latin script only", () => {
    expect(isLatinText("Austin")).toBe(true);
    expect(isLatinText("São Paulo")).toBe(true);
    expect(isLatinText("Mount Rainier 2")).toBe(true);
    expect(isLatinText("東京")).toBe(false);
    expect(isLatinText("Москва")).toBe(false);
    expect(isLatinText("القاهرة")).toBe(false);
    expect(isLatinText("Tokyo 東京")).toBe(false);
    expect(isLatinText("123")).toBe(false);
  });

  it("formats the view centre", () => {
    expect(formatCoordinates([-98.01, 30.16, -97.49, 30.44])).toBe("30.30° N · 97.75° W");
    expect(formatCoordinates([150, -34, 152, -33])).toBe("33.50° S · 151.00° E");
  });

  it("merges overlapping fade regions so every pixel belongs to one group", () => {
    const region = (x: number, y: number, w: number, h: number): FadeRegion => ({ cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2, box: { x, y, width: w, height: h } });
    expect(groupFades([region(0, 0, 10, 10), region(50, 0, 10, 10)])).toHaveLength(2);
    const merged = groupFades([region(0, 0, 10, 10), region(5, 5, 10, 10), region(100, 100, 1, 1)]);
    expect(merged).toHaveLength(2);
    expect(merged.find((g) => g.fades.length === 2)?.box).toEqual({ x: 0, y: 0, width: 15, height: 15 });
  });
});

/** A minimal valid 1 × 1 PNG. */
function tinyPng(): Uint8Array {
  const chunk = (type: string, data: number[]) => {
    const body = Uint8Array.from([...type].map((c) => c.charCodeAt(0)).concat(data));
    const length = data.length;
    const crc = crc32(body);
    return [length >>> 24, (length >>> 16) & 255, (length >>> 8) & 255, length & 255, ...body, crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255];
  };
  const ihdr = chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const idat = chunk("IDAT", [0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00]);
  const iend = chunk("IEND", []);
  return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...ihdr, ...idat, ...iend]);
}

describe("PNG text metadata", () => {
  it("computes standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("inserts tEXt chunks right after IHDR with valid CRCs", () => {
    const png = tinyPng();
    const entries = { Title: "Austin · Metro · Ink and River", Author: "Atlas · atlas.swopnil.com", Source: "© OpenStreetMap contributors", Description: "Test" };
    const out = insertPngText(png, entries);
    const chunks = readPngChunks(out);
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "tEXt", "tEXt", "tEXt", "tEXt", "IDAT", "IEND"]);
    expect(chunks.every((c) => c.crcOk)).toBe(true);
    const texts = chunks.filter((c) => c.type === "tEXt").map((c) => {
      const zero = c.data.indexOf(0);
      return [String.fromCharCode(...c.data.subarray(0, zero)), String.fromCharCode(...c.data.subarray(zero + 1))];
    });
    expect(Object.fromEntries(texts)).toEqual(entries);
    // The original chunks are unchanged.
    expect(out.subarray(out.length - png.length + 33)).toEqual(png.subarray(33));
  });

  it("uses iTXt (UTF-8) for text outside Latin-1", () => {
    const chunks = readPngChunks(insertPngText(tinyPng(), { Title: "東京" }));
    expect(chunks[1].type).toBe("iTXt");
    expect(chunks[1].crcOk).toBe(true);
    expect(new TextDecoder().decode(chunks[1].data.subarray(chunks[1].data.length - 6))).toBe("東京");
  });

  it("rejects non-PNG input and bad keywords", () => {
    expect(() => insertPngText(new Uint8Array(40), { Title: "x" })).toThrow(/PNG/);
    expect(() => insertPngText(tinyPng(), { "": "x" })).toThrow(/keyword/);
  });
});

describe("view configs and prepared data", async () => {
  const views = await loadViews(resolve(root, "views"));

  it.each(views.filter((v) => v.status === "published").map((v) => [`${v.place}/${v.view}`, v] as const))("%s matches its data file", (_, view) => {
    const file = resolve(root, "public", view.dataFile.slice(1));
    expect(existsSync(file)).toBe(true);
    expect(existsSync(file.replace(/\.json$/, ".manifest.json"))).toBe(true);
    const data = JSON.parse(readFileSync(file, "utf8")) as RawViewData;
    expect(data.version).toBe(2);
    expect(data.id).toBe(`${view.place}-${view.view}`);
    for (let i = 0; i < 4; i += 1) expect(Math.abs(data.bounds[i] - view.bounds[i])).toBeLessThan(1e-6);
    expect(data.label.name).toBe(view.title);
    const manifest = JSON.parse(readFileSync(file.replace(/\.json$/, ".manifest.json"), "utf8")) as { requiredAttribution: string };
    expect(manifest.requiredAttribution).toContain("OpenStreetMap contributors");
  });

  it("frames Mount Rainier as 16:10 around the summit", () => {
    const rainier = views.find((v) => v.place === "mount-rainier" && v.view === "summit");
    expect(rainier).toBeDefined();
    const [w, s, e, n] = rainier!.bounds;
    expect((s + n) / 2).toBeCloseTo(46.853, 4);
    expect((w + e) / 2).toBeCloseTo(-121.76, 4);
    const ground = boundsMeters(rainier!.bounds);
    expect(ground.width / ground.height).toBeCloseTo(1.6, 3);
  });

  it("ships the bundled font and its license", () => {
    for (const file of ["inter-latin-400.woff2", "inter-latin-600.woff2", "Inter-OFL.txt"]) expect(existsSync(resolve(root, "public/fonts", file))).toBe(true);
    expect(readFileSync(resolve(root, "public/fonts/Inter-OFL.txt"), "utf8")).toMatch(/SIL OPEN FONT LICENSE/i);
  });
});
