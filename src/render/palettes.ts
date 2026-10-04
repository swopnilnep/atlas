// The four Atlas palettes. Every palette defines every key (checked by tests).
// Widths are CSS pixels at the 1280 × 800 reference size; the renderer scales them
// with the output resolution (see resolutionScale in renderer.ts).
import type { RGB, RoadClass } from "./types";

export const PALETTE_IDS = ["ink-and-river", "paper", "night-river", "black"] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];

export interface Stroke {
  /** Any CSS color; rgba() alpha is applied once per class (one path per class, so crossings do not darken). */
  color: string;
  width: number;
}

export interface TerrainStyle {
  /** Auto-exposed elevation tint: low and high ends, mixed over the background by `tint`. */
  low: RGB;
  high: RGB;
  tint: number;
  gamma: number;
  /** Slopes facing away from the sun move toward `shadowColor` by up to `shadow`. */
  shadowColor: RGB;
  shadow: number;
  /** Slopes facing the sun move toward `highlightColor` by up to `highlight`. */
  highlightColor: RGB;
  highlight: number;
}

export interface ContourStyle {
  /** Band ramp from the lowest to the highest band (auto-exposed). Empty: no band fill (background shows). */
  ramp: RGB[];
  gamma: number;
  line: RGB;
  lineAlpha: number;
  lineWidth: number;
  /** Every `indexEvery`-th contour is drawn `indexWidth` wide. */
  indexEvery: number;
  indexWidth: number;
  /** Hillshade over the bands (same meaning as TerrainStyle). */
  shadowColor: RGB;
  shadow: number;
  highlightColor: RGB;
  highlight: number;
}

export interface RidgeStyle {
  /** Sky gradient above the horizon, top to horizon. */
  skyTop: RGB;
  skyHorizon: RGB;
  /** Band fill of the nearest and the farthest profile (bands in between mix by depth). */
  near: RGB;
  far: RGB;
  /** Valley mist: how far each band's lower part moves toward the sky horizon colour (0..1). */
  mist: number;
  /** Crest line on top of each band; alpha fades with distance down to `crestFarAlpha`. */
  crest: RGB;
  crestAlpha: number;
  crestFarAlpha: number;
  width: number;
  /** Label block colours over the near bands. */
  label: { title: string; muted: string };
}

export interface Palette {
  id: PaletteId;
  name: string;
  background: string;
  /** Urban Relief terrain; null turns terrain off. */
  terrain: TerrainStyle | null;
  wood: string | null;
  park: string | null;
  /** How wood and park fills combine with the terrain below ("multiply" on light, "screen" on dark keeps the hillshade). */
  landCoverBlend: "multiply" | "screen" | "source-over";
  water: string;
  /** "fill": solid polygons. "outline": shoreline strokes over a dark `waterTint` fill (keeps dark palettes dark). */
  waterMode: "fill" | "outline";
  /** Outline mode: fill colour inside the shoreline. */
  waterTint: string;
  waterOutlineWidth: number;
  /** Outline mode: water polygons smaller than this area (reference px²) get no shoreline (ponds, creek channels). */
  outlineMinAreaPx: number;
  /** Glacier fill for Contour Fields (the "negative space"). */
  ice: string;
  /** Optional glacier edge (outer half of a stroke, so shared edges between glaciers stay hidden). */
  iceOutline: Stroke | null;
  /** Contour Fields glaciers as a tint over the bands (contour lines continue, lighter); null: opaque fill. */
  iceTint: { amount: number; lineAlpha: number } | null;
  river: Stroke;
  stream: Stroke;
  canal: Stroke;
  rail: Stroke;
  roads: Record<RoadClass, Stroke | null>;
  /** Roads in Contour Fields (major classes only). */
  terrainRoad: Stroke;
  contour: ContourStyle;
  /** Ridgelines style. */
  ridge: RidgeStyle;
  /** Water Shapes (deltas): wetland fill, and how strongly the terrain shows (0..1). */
  wetland: string;
  waterShapesTerrain: number;
  label: string;
  labelMuted: string;
  /** Label colours used when the label block sits mostly on water (water is often the label colour). */
  labelOnWater: { title: string; muted: string };
  attribution: string;
  attributionOnWater: string;
  /** Urban Relief: how strongly line layers fade out behind the label and attribution (0 = off, 1 = erased at the centre). */
  fade: number;
  /** Contour Fields: opacity of the background fade over the bands behind the label. */
  contourFade: number;
  /** Pixels whose channels are all at or below this value become exactly #000000 (0 = off). For OLED black. */
  crushBlack: number;
}

const hex = (value: string): RGB => {
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const inkAndRiver: Palette = {
  id: "ink-and-river",
  name: "Ink and River",
  background: "#f6f5f1",
  terrain: {
    low: hex("#f6f5f1"), high: hex("#d6d0c1"), tint: 1, gamma: 0.85,
    shadowColor: hex("#3a372f"), shadow: 0.42, highlightColor: hex("#ffffff"), highlight: 0.6
  },
  wood: "#efeee8",
  park: "#e8e8e2",
  landCoverBlend: "multiply",
  water: "#2e4fa0",
  waterMode: "fill",
  waterTint: "#000000",
  waterOutlineWidth: 0.8,
  outlineMinAreaPx: 0,
  ice: "#e4ecf6",
  iceOutline: null,
  iceTint: { amount: 0.42, lineAlpha: 0.9 },
  river: { color: "#2e4fa0", width: 0.95 },
  stream: { color: "rgba(46, 79, 160, 0.5)", width: 0.3 },
  canal: { color: "#2e4fa0", width: 0.8 },
  rail: { color: "rgba(20, 20, 20, 0.32)", width: 0.5 },
  roads: {
    motorway: { color: "#141414", width: 1.7 },
    trunk: { color: "#141414", width: 1.45 },
    primary: { color: "rgba(20, 20, 20, 0.92)", width: 1.05 },
    secondary: { color: "rgba(20, 20, 20, 0.86)", width: 0.85 },
    tertiary: { color: "rgba(20, 20, 20, 0.78)", width: 0.68 },
    residential: { color: "rgba(20, 20, 20, 0.58)", width: 0.36 },
    service: { color: "rgba(20, 20, 20, 0.28)", width: 0.26 }
  },
  terrainRoad: { color: "rgba(20, 20, 20, 0.22)", width: 0.5 },
  contour: {
    ramp: [hex("#f1efe8"), hex("#dedacd"), hex("#bfb9a8"), hex("#8e8776")], gamma: 0.6,
    line: hex("#141414"), lineAlpha: 0.38, lineWidth: 0.45, indexEvery: 5, indexWidth: 0.9,
    shadowColor: hex("#2e2b25"), shadow: 0.14, highlightColor: hex("#ffffff"), highlight: 0.2
  },
  ridge: {
    skyTop: hex("#f6f5f1"), skyHorizon: hex("#e3e6ee"), near: hex("#1c2a52"), far: hex("#aab4cf"), mist: 0.08,
    crest: hex("#f6f5f1"), crestAlpha: 0.6, crestFarAlpha: 0.35, width: 0.8,
    label: { title: "#f6f5f1", muted: "rgba(246, 245, 241, 0.72)" }
  },
  wetland: "rgba(46, 79, 160, 0.16)",
  waterShapesTerrain: 0.55,
  label: "#2e4fa0",
  labelMuted: "#5f5d57",
  labelOnWater: { title: "#f6f5f1", muted: "rgba(246, 245, 241, 0.8)" },
  attribution: "#6f6d67",
  attributionOnWater: "rgba(246, 245, 241, 0.85)",
  fade: 0.92,
  contourFade: 0.55,
  crushBlack: 0
};

const paper: Palette = {
  id: "paper",
  name: "Paper",
  background: "#eeeadd",
  terrain: {
    low: hex("#eeeadd"), high: hex("#d2c4a2"), tint: 1, gamma: 0.85,
    shadowColor: hex("#4a3f2c"), shadow: 0.42, highlightColor: hex("#fbf8ef"), highlight: 0.55
  },
  wood: "#e3e4cd",
  park: "#d6dcbf",
  landCoverBlend: "multiply",
  water: "#8ba9b3",
  waterMode: "fill",
  waterTint: "#000000",
  waterOutlineWidth: 0.8,
  outlineMinAreaPx: 0,
  ice: "#f2f1ea",
  iceOutline: null,
  iceTint: { amount: 0.42, lineAlpha: 0.9 },
  river: { color: "#7d9ca7", width: 0.95 },
  stream: { color: "rgba(110, 145, 157, 0.65)", width: 0.3 },
  canal: { color: "#7d9ca7", width: 0.8 },
  rail: { color: "rgba(48, 46, 42, 0.32)", width: 0.5 },
  roads: {
    motorway: { color: "#302e2a", width: 1.7 },
    trunk: { color: "#302e2a", width: 1.45 },
    primary: { color: "rgba(48, 46, 42, 0.92)", width: 1.05 },
    secondary: { color: "rgba(48, 46, 42, 0.86)", width: 0.85 },
    tertiary: { color: "rgba(48, 46, 42, 0.78)", width: 0.68 },
    residential: { color: "rgba(48, 46, 42, 0.56)", width: 0.36 },
    service: { color: "rgba(48, 46, 42, 0.26)", width: 0.26 }
  },
  terrainRoad: { color: "rgba(48, 46, 42, 0.22)", width: 0.5 },
  contour: {
    ramp: [hex("#ebe5d2"), hex("#d8c9a4"), hex("#bba07a"), hex("#8e7253")], gamma: 0.6,
    line: hex("#302e2a"), lineAlpha: 0.36, lineWidth: 0.45, indexEvery: 5, indexWidth: 0.9,
    shadowColor: hex("#3b3022"), shadow: 0.14, highlightColor: hex("#fbf8ef"), highlight: 0.2
  },
  ridge: {
    skyTop: hex("#eeeadd"), skyHorizon: hex("#e2dccb"), near: hex("#3a352c"), far: hex("#b9ae93"), mist: 0.08,
    crest: hex("#f4efe1"), crestAlpha: 0.58, crestFarAlpha: 0.32, width: 0.8,
    label: { title: "#f4efe1", muted: "rgba(244, 239, 225, 0.72)" }
  },
  wetland: "rgba(110, 145, 157, 0.22)",
  waterShapesTerrain: 0.55,
  label: "#a8462a",
  labelMuted: "#5f594d",
  labelOnWater: { title: "#2b2a26", muted: "rgba(43, 42, 38, 0.78)" },
  attribution: "#6c665a",
  attributionOnWater: "rgba(43, 42, 38, 0.8)",
  fade: 0.92,
  contourFade: 0.55,
  crushBlack: 0
};

const nightRiver: Palette = {
  id: "night-river",
  name: "Night River",
  background: "#0a1220",
  terrain: {
    low: hex("#0a1220"), high: hex("#1a2a45"), tint: 1, gamma: 0.85,
    shadowColor: hex("#03070e"), shadow: 0.6, highlightColor: hex("#4a6a94"), highlight: 0.5
  },
  wood: "#020f0e",
  park: "#041716",
  landCoverBlend: "screen",
  water: "#2f7fd1",
  waterMode: "fill",
  waterTint: "#000000",
  waterOutlineWidth: 0.8,
  outlineMinAreaPx: 0,
  ice: "#dbe7f5",
  iceOutline: null,
  iceTint: { amount: 0.5, lineAlpha: 0.9 },
  river: { color: "#2f7fd1", width: 0.95 },
  stream: { color: "rgba(47, 127, 209, 0.55)", width: 0.3 },
  canal: { color: "#2f7fd1", width: 0.8 },
  rail: { color: "rgba(219, 231, 245, 0.28)", width: 0.5 },
  roads: {
    motorway: { color: "#dbe7f5", width: 1.5 },
    trunk: { color: "#dbe7f5", width: 1.3 },
    primary: { color: "rgba(219, 231, 245, 0.9)", width: 0.95 },
    secondary: { color: "rgba(219, 231, 245, 0.8)", width: 0.8 },
    tertiary: { color: "rgba(219, 231, 245, 0.7)", width: 0.62 },
    residential: { color: "rgba(219, 231, 245, 0.46)", width: 0.34 },
    service: { color: "rgba(219, 231, 245, 0.2)", width: 0.24 }
  },
  terrainRoad: { color: "rgba(219, 231, 245, 0.2)", width: 0.5 },
  contour: {
    ramp: [hex("#0a1322"), hex("#16294a"), hex("#2a4c7a"), hex("#5a80b0")], gamma: 0.6,
    line: hex("#dbe7f5"), lineAlpha: 0.26, lineWidth: 0.45, indexEvery: 5, indexWidth: 0.9,
    shadowColor: hex("#02050b"), shadow: 0.22, highlightColor: hex("#7d9cc4"), highlight: 0.08
  },
  ridge: {
    skyTop: hex("#050a14"), skyHorizon: hex("#1b2c48"), near: hex("#04080f"), far: hex("#24395a"), mist: 0.06,
    crest: hex("#cfe3fa"), crestAlpha: 0.95, crestFarAlpha: 0.5, width: 0.95,
    label: { title: "#ff7a59", muted: "#9aabc2" }
  },
  wetland: "rgba(47, 127, 209, 0.2)",
  waterShapesTerrain: 0.7,
  label: "#ff7a59",
  labelMuted: "#9aabc2",
  labelOnWater: { title: "#f4f8fc", muted: "rgba(244, 248, 252, 0.8)" },
  attribution: "#7f90a8",
  attributionOnWater: "rgba(244, 248, 252, 0.85)",
  fade: 0.92,
  contourFade: 0.6,
  crushBlack: 0
};

/** Accent candidates studied for Black (docs/palette-study/README.md). */
export const BLACK_ACCENTS = { cobalt: "#3a6cf4", amber: "#ffb04a", coral: "#ff7a59" } as const;
export type BlackAccent = keyof typeof BLACK_ACCENTS;
export const DEFAULT_BLACK_ACCENT: BlackAccent = "amber";

export function blackPalette(accentName: BlackAccent = DEFAULT_BLACK_ACCENT): Palette {
  const accent = BLACK_ACCENTS[accentName];
  const [r, g, b] = hex(accent);
  return {
    id: "black",
    name: "Black",
    background: "#000000",
    // Dark-grey hillshade: shadows stay at #000, sunlit slopes reach about #1e1e1e–#242424.
    terrain: {
      low: hex("#000000"), high: hex("#0b0b0b"), tint: 1, gamma: 0.85,
      shadowColor: hex("#000000"), shadow: 1, highlightColor: hex("#262626"), highlight: 0.85
    },
    wood: null,
    park: null,
    landCoverBlend: "source-over",
    water: accent,
    waterMode: "outline",
    waterTint: "#06121c",
    waterOutlineWidth: 0.5,
    outlineMinAreaPx: 80,
    ice: "#000000",
    iceOutline: { color: `rgba(${r}, ${g}, ${b}, 0.7)`, width: 0.5 },
    iceTint: null,
    river: { color: `rgba(${r}, ${g}, ${b}, 0.85)`, width: 0.75 },
    stream: { color: `rgba(${r}, ${g}, ${b}, 0.32)`, width: 0.28 },
    canal: { color: `rgba(${r}, ${g}, ${b}, 0.75)`, width: 0.65 },
    rail: { color: "rgba(90, 90, 90, 0.45)", width: 0.4 },
    // Darker grey gradient by class: lower contrast than white roads on black.
    roads: {
      motorway: { color: "#bdbdbd", width: 1.15 },
      trunk: { color: "#a8a8a8", width: 0.95 },
      primary: { color: "#8f8f8f", width: 0.75 },
      secondary: { color: "#777777", width: 0.6 },
      tertiary: { color: "#616161", width: 0.45 },
      residential: { color: "#474747", width: 0.3 },
      service: { color: "#363636", width: 0.24 }
    },
    terrainRoad: { color: "rgba(120, 120, 120, 0.35)", width: 0.45 },
    contour: {
      ramp: [hex("#000000"), hex("#060606"), hex("#0c0c0c"), hex("#141414")], gamma: 0.8,
      line: hex("#7a7a7a"), lineAlpha: 0.55, lineWidth: 0.45, indexEvery: 5, indexWidth: 0.9,
      shadowColor: hex("#000000"), shadow: 0.9, highlightColor: hex("#242424"), highlight: 0.6
    },
    ridge: {
      skyTop: hex("#000000"), skyHorizon: hex("#0e0e0e"), near: hex("#040404"), far: hex("#262626"), mist: 0.04,
      crest: hex("#e2e2e2"), crestAlpha: 0.95, crestFarAlpha: 0.5, width: 0.95,
      label: { title: accent, muted: "#8a8a8a" }
    },
    wetland: `rgba(${r}, ${g}, ${b}, 0.1)`,
    waterShapesTerrain: 1,
    label: accent,
    labelMuted: "#8f8a82",
    labelOnWater: { title: accent, muted: "#8f8a82" },
    attribution: "#7a756d",
    attributionOnWater: "#7a756d",
    fade: 1,
    contourFade: 0.9,
    // Only anti-aliasing fringes are snapped to #000; the grey hillshade must survive.
    crushBlack: 4
  };
}

export const PALETTES: Record<PaletteId, Palette> = {
  "ink-and-river": inkAndRiver,
  paper,
  "night-river": nightRiver,
  black: blackPalette()
};

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === "string" && (PALETTE_IDS as readonly string[]).includes(value);
}

export { hex as hexToRgb };
