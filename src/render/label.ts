// Label block (title, subtitle, coordinates) and attribution.
import type { Bounds } from "../types";
import type { Canvas2D } from "./canvas";

export const FONT_FAMILY = "Atlas Inter";
const FALLBACK = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/**
 * True when the text's letters are all Latin script (so letter-spacing suits it, as in maptoart).
 * Digits, punctuation, and spaces are neutral; at least one Latin letter is required.
 */
export function isLatinText(text: string): boolean {
  let latin = false;
  for (const char of text) {
    if (/\p{Script=Latin}/u.test(char)) latin = true;
    else if (/\p{L}/u.test(char)) return false;
  }
  return latin;
}

/** "30.30° N · 97.75° W" for the centre of the bounds. */
export function formatCoordinates(bounds: Bounds): string {
  const lat = (bounds[1] + bounds[3]) / 2;
  const lon = (bounds[0] + bounds[2]) / 2;
  return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? "N" : "S"} · ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? "E" : "W"}`;
}

/** Draws text with manual letter-spacing (ctx.letterSpacing is not available everywhere). Returns the advance width. */
export function spacedText(ctx: Canvas2D, text: string, x: number, y: number, spacing: number, draw = true): number {
  if (!spacing) {
    if (draw) ctx.fillText(text, x, y);
    return ctx.measureText(text).width;
  }
  let cursor = x;
  const chars = [...text];
  chars.forEach((char, i) => {
    if (draw) ctx.fillText(char, cursor, y);
    cursor += ctx.measureText(char).width + (i < chars.length - 1 ? spacing : 0);
  });
  return cursor - x;
}

export interface LabelText {
  title: string;
  subtitle: string;
  coordinates: string;
  /** BCP-47 tag of the title (picks the CJK glyph variant). */
  lang?: string;
}

/**
 * Bundled Noto subsets (SIL OFL, public/fonts/), one family per script, weight 600 (the title).
 * tools/data/subset_fonts.py writes them from the catalog's native names with the same ranges.
 */
export const SCRIPT_FONTS = [
  { family: "Atlas Inter Ext", file: "inter-ext", weights: ["400", "600"], test: /[\u0100-\u02ff\u0370-\u03ff\u0400-\u04ff\u1e00-\u1eff]/u },
  { family: "Atlas Tibetan", file: "noto-tibetan", weights: ["600"], test: /[\u0f00-\u0fff]/u },
  { family: "Atlas Devanagari", file: "noto-devanagari", weights: ["600"], test: /[\u0900-\u097f]/u },
  { family: "Atlas Bengali", file: "noto-bengali", weights: ["600"], test: /[\u0980-\u09ff]/u },
  { family: "Atlas Thai", file: "noto-thai", weights: ["600"], test: /[\u0e00-\u0e7f]/u },
  { family: "Atlas Myanmar", file: "noto-myanmar", weights: ["600"], test: /[\u1000-\u109f]/u },
  { family: "Atlas Arabic", file: "noto-arabic", weights: ["600"], test: /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/u },
  { family: "Atlas CJK SC", file: "noto-cjk-sc", weights: ["600"], test: /[\u3000-\u9fff]/u, lang: "sc" },
  { family: "Atlas CJK TC", file: "noto-cjk-tc", weights: ["600"], test: /[\u3000-\u9fff]/u, lang: "tc" },
  { family: "Atlas CJK JP", file: "noto-cjk-jp", weights: ["600"], test: /[\u3000-\u9fff]/u, lang: "ja" }
] as const;

/** "sc" | "tc" | "ja" for a BCP-47 tag (zh-Hant, zh-TW, zh-HK -> tc). */
export function cjkVariant(lang = ""): "sc" | "tc" | "ja" {
  const l = lang.toLowerCase();
  if (l.startsWith("ja")) return "ja";
  if (l.includes("hant") || l.endsWith("-tw") || l.endsWith("-hk") || l.endsWith("-mo")) return "tc";
  return "sc";
}

/** The bundled script fonts a text needs (CJK by language). */
export function scriptFonts(text: string, lang?: string): (typeof SCRIPT_FONTS)[number][] {
  const cjk = cjkVariant(lang);
  return SCRIPT_FONTS.filter((f) => f.test.test(text) && (!("lang" in f) || f.lang === cjk));
}

const font = (weight: number, size: number, families: readonly string[] = []) =>
  `${weight} ${size.toFixed(2)}px ${["Atlas Inter", ...families].map((f) => `"${f}"`).join(", ")}, ${FALLBACK}`;

/** An elliptical fade region (centre, radii) and its integer bounding box on the canvas. */
export interface FadeRegion {
  cx: number; cy: number; rx: number; ry: number;
  box: { x: number; y: number; width: number; height: number };
}

export interface OverlayLayout {
  label: {
    x: number; titleY: number; subtitleY: number; coordY: number; top: number;
    titleSize: number; subtitleSize: number; coordSize: number;
    title: string; subtitle: string; titleSpacing: number; subtitleSpacing: number;
    /** Font families after Inter for the title and the meta line (script fonts). */
    titleFamilies: string[]; metaFamilies: string[];
    width: number;
    /** Hairline rule between the name and the region/coordinates line. */
    ruleY: number; ruleWidth: number;
    /** Coordinates follow the region on the same line. */
    coordX: number;
  } | null;
  attribution: { x: number; y: number; size: number; width: number };
  fades: FadeRegion[];
}

function region(cx: number, cy: number, rx: number, ry: number, width: number, height: number): FadeRegion {
  const x0 = Math.max(0, Math.floor(cx - rx)), y0 = Math.max(0, Math.floor(cy - ry));
  const x1 = Math.min(width, Math.ceil(cx + rx)), y1 = Math.min(height, Math.ceil(cy + ry));
  return { cx, cy, rx, ry, box: { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) } };
}

/**
 * Places the label block (bottom-left) and the attribution (bottom-right). When both do not fit
 * on one baseline (narrow portrait sizes), the label moves up above the attribution line.
 */
/** Label block size relative to iteration 2 (owner feedback: about 55–60% of the old size). */
export const LABEL_SCALE = 0.58;

export function layoutOverlay(ctx: Canvas2D, text: LabelText | null, attribution: string | null, scale: number): OverlayLayout {
  const { width, height } = ctx.canvas;
  const short = Math.min(width, height);
  ctx.save();
  const size = Math.max(10, 9.5 * scale);
  const inset = Math.round(short * 0.03);
  ctx.font = font(400, size);
  // Images carry no attribution line by default (it is in the PNG metadata and on the pages).
  const attrWidth = attribution ? ctx.measureText(attribution).width : 0;
  const attr = { x: width - inset, y: height - inset, size, width: attrWidth };
  const fades: FadeRegion[] = attribution ? [region(width - inset - attrWidth / 2, height - inset - size * 0.35, attrWidth * 0.8 + inset, size * 1.9 + inset * 0.7, width, height)] : [];

  let label: OverlayLayout["label"] = null;
  if (text) {
    // A quiet cartographic title block: letter-spaced name, a hairline rule, then region and
    // coordinates on one smaller muted line. Same size and place in every style.
    const margin = Math.round(short * 0.05);
    const k = LABEL_SCALE * scale;
    const titleSize = 25 * k, metaSize = 10.5 * k;
    const latin = isLatinText(text.title);
    const subLatin = isLatinText(text.subtitle);
    const title = latin ? text.title.toUpperCase() : text.title;
    const subtitle = subLatin ? text.subtitle.toUpperCase() : text.subtitle;
    const titleSpacing = latin ? titleSize * 0.34 : 0;
    const subtitleSpacing = subLatin ? metaSize * 0.24 : 0;
    const titleFamilies = scriptFonts(title, text.lang).map((f) => f.family);
    const metaFamilies = scriptFonts(subtitle).map((f) => f.family);
    ctx.font = font(600, titleSize, titleFamilies);
    const titleWidth = spacedText(ctx, title, 0, 0, titleSpacing, false);
    ctx.font = font(400, metaSize, metaFamilies);
    const subtitleWidth = spacedText(ctx, subtitle, 0, 0, subtitleSpacing, false);
    const gap = metaSize * 1.6;
    const coordWidth = spacedText(ctx, text.coordinates, 0, 0, metaSize * 0.1, false);
    const metaWidth = subtitleWidth + gap + coordWidth;
    const labelWidth = Math.max(titleWidth, metaWidth);
    let coordY = height - margin;
    // Stack above the attribution when they would collide on the bottom line.
    if (attribution && margin + labelWidth + margin > width - inset - attrWidth) coordY = Math.min(coordY, height - inset - size * 2.6);
    const subtitleY = coordY;
    const ruleY = coordY - metaSize * 1.75;
    const titleY = ruleY - titleSize * 0.62;
    const top = titleY - titleSize * 0.75;
    label = {
      x: margin, titleY, subtitleY, coordY, top, titleSize, subtitleSize: metaSize, coordSize: metaSize, title, subtitle,
      titleSpacing, subtitleSpacing, titleFamilies, metaFamilies, width: labelWidth, ruleY, ruleWidth: labelWidth, coordX: margin + subtitleWidth + gap
    };
    const rx = Math.min(width, margin + labelWidth * 1.15 + margin * 1.5);
    const ry = (height - top) * 1.9;
    fades.push(region(margin * 0.5, height, rx, ry, width, height));
  }
  ctx.restore();
  return { label, attribution: attr, fades };
}

/** Text boxes of the label lines and the attribution, for the on-water colour check. */
export function textBoxes(layout: OverlayLayout): { label: [number, number, number, number] | null; attribution: [number, number, number, number] } {
  const a = layout.attribution;
  const l = layout.label;
  return {
    label: l ? [l.x, l.top, l.width, l.coordY + l.coordSize * 0.3 - l.top] : null,
    attribution: [a.x - a.width, a.y - a.size, a.width, a.size * 1.3]
  };
}

export function drawLabel(ctx: Canvas2D, layout: OverlayLayout, coordinates: string, colors: { title: string; muted: string }): void {
  const l = layout.label;
  if (!l) return;
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = colors.title;
  ctx.font = font(600, l.titleSize, l.titleFamilies);
  spacedText(ctx, l.title, l.x, l.titleY, l.titleSpacing);
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = colors.muted;
  ctx.fillRect(l.x, l.ruleY, l.ruleWidth, Math.max(0.75, l.titleSize * 0.035));
  ctx.globalAlpha = 1;
  ctx.font = font(400, l.subtitleSize, l.metaFamilies);
  spacedText(ctx, l.subtitle, l.x, l.subtitleY, l.subtitleSpacing);
  spacedText(ctx, coordinates, l.coordX, l.coordY, l.coordSize * 0.1);
  ctx.restore();
}

export function drawAttribution(ctx: Canvas2D, layout: OverlayLayout, text: string, color: string): void {
  const a = layout.attribution;
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = font(400, a.size);
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, a.x, a.y);
  ctx.restore();
}

/** Radial gradient for a fade region: `strength` at the centre to 0 at the ellipse edge. */
export function fillFade(ctx: Canvas2D, fade: FadeRegion, rgb: string, strength: number, offsetX = 0, offsetY = 0): void {
  if (strength <= 0) return;
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, `rgba(${rgb}, ${strength.toFixed(3)})`);
  gradient.addColorStop(0.6, `rgba(${rgb}, ${(strength * 0.92).toFixed(3)})`);
  gradient.addColorStop(0.85, `rgba(${rgb}, ${(strength * 0.45).toFixed(3)})`);
  gradient.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.save();
  ctx.translate(fade.cx - offsetX, fade.cy - offsetY);
  ctx.scale(fade.rx, fade.ry);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, 2 * Math.PI);
  ctx.fill();
  ctx.restore();
}

/** "r, g, b" from #rrggbb. */
export const rgbList = (hexColor: string) => [1, 3, 5].map((i) => Number.parseInt(hexColor.slice(i, i + 2), 16)).join(", ");

/**
 * Black-point toe for OLED black: a pixel whose brightest channel is at or below `threshold`
 * becomes exactly #000000; between threshold and 2 × threshold the brightness ramps back up
 * linearly (hue kept), so faint anti-aliasing fringes switch off without a hard step.
 */
export function toeCurve(max: number, threshold: number): number {
  if (max <= threshold) return 0;
  if (max >= 2 * threshold) return max;
  return (max - threshold) * 2;
}

export function crushBlacks(ctx: Canvas2D, threshold: number): void {
  if (threshold <= 0) return;
  const { width, height } = ctx.canvas;
  const image = ctx.getImageData(0, 0, width, height);
  const d = image.data;
  const knee = 2 * threshold;
  for (let i = 0; i < d.length; i += 4) {
    const max = Math.max(d[i], d[i + 1], d[i + 2]);
    if (max >= knee) continue;
    if (max <= threshold) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; continue; }
    const k = toeCurve(max, threshold) / max;
    d[i] = Math.round(d[i] * k); d[i + 1] = Math.round(d[i + 1] * k); d[i + 2] = Math.round(d[i + 2] * k);
  }
  ctx.putImageData(image, 0, 0);
}

let fontsLoading: Promise<void> | undefined;
const scriptLoading = new Map<string, Promise<void>>();

/**
 * Loads the bundled Inter (SIL OFL, public/fonts/) once, so text renders the same everywhere, plus
 * the script subsets the given label needs (native name in its own script; CJK variant by lang).
 */
export async function loadFonts(base = "/fonts/", label?: { nativeName?: string; nativeLang?: string; name?: string; region?: string }): Promise<void> {
  if (typeof document === "undefined" || typeof FontFace === "undefined") return;
  const text = label ? [label.nativeName, label.name, label.region].filter(Boolean).join(" ") : "";
  const needed = text ? scriptFonts(text, label?.nativeLang) : [];
  await Promise.all([loadInter(base), ...needed.map((f) => {
    let p = scriptLoading.get(f.family);
    if (!p) {
      p = (async () => {
        const faces = f.weights.map((w) => new FontFace(f.family, `url(${base}${f.file}-${w}.woff2) format("woff2")`, { weight: w }));
        for (const face of faces) document.fonts.add(face);
        // A missing subset (no catalog name uses the script) falls back to system fonts.
        await Promise.all(faces.map((face) => face.load().catch(() => undefined)));
      })();
      scriptLoading.set(f.family, p);
    }
    return p;
  })]);
}

function loadInter(base: string): Promise<void> {
  fontsLoading ??= (async () => {
    const faces = [
      new FontFace(FONT_FAMILY, `url(${base}inter-latin-400.woff2) format("woff2")`, { weight: "400" }),
      new FontFace(FONT_FAMILY, `url(${base}inter-latin-600.woff2) format("woff2")`, { weight: "600" })
    ];
    for (const face of faces) document.fonts.add(face);
    await Promise.all(faces.map((face) => face.load()));
    await document.fonts.ready;
  })();
  return fontsLoading;
}
