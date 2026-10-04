export type Bounds = [west: number, south: number, east: number, north: number];

/** One entry of views/catalog.json. Bounds: 16:10 from center + widthKm (tools/lib/catalog.mjs). */
export interface CatalogPiece {
  id: string;
  place: string;
  view: string;
  title: string;
  region: string;
  category: ViewCategory;
  style: ViewStyle;
  center: [lon: number, lat: number];
  widthKm: number;
  defaultPalette: ViewPaletteId;
  summary: string;
  peak?: { name: string; elevationM: number };
}

// View configs, built from the catalog and validated by tools/lib/views.mjs.
export type ViewCategory = "cities" | "terrain" | "hydrology" | "coasts" | "formations";
export type ViewStyle = "urban-relief" | "contour-fields" | "ridgelines" | "water-shapes";
export type ViewLayer = "hillshade" | "elevation" | "contours" | "water" | "glaciers" | "parks" | "roads";
export type ViewPaletteId = "ink-and-river" | "paper" | "night-river" | "black";
export type ViewStatus = "draft" | "published";

export interface ViewConfig {
  /** URL slug of the place, e.g. "austin". Route: /<place>/ */
  place: string;
  placeTitle: string;
  category: ViewCategory;
  /** URL slug of the view, e.g. "metro". Route: /<place>/<view>/ */
  view: string;
  title: string;
  subtitle: string;
  bounds: Bounds;
  style: ViewStyle;
  layers: ViewLayer[];
  defaultPalette: ViewPaletteId;
  palettes: ViewPaletteId[];
  /** Root-relative path of the prepared data file, e.g. "/data/austin-metro-v1.json". */
  dataFile: string;
  status: ViewStatus;
  /** One line, shown on cards. */
  summary: string;
  /** Short plain facts about what the view shows. */
  notes: string[];
}

/** Subset of ViewConfig embedded in the Create page at build time. */
export interface ViewCatalogEntry {
  place: string;
  placeTitle: string;
  category: ViewCategory;
  view: string;
  viewTitle: string;
  title: string;
  subtitle: string;
  bounds: Bounds;
  style: ViewStyle;
  status: ViewStatus;
  defaultPalette: ViewPaletteId;
  palettes: ViewPaletteId[];
  dataFile: string;
}
