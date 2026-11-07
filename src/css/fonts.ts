/**
 * Fonts for the page. A CSS font-family list, weight and style resolve to a
 * font file Bloom can load: @font-face rules with local url()s, configured
 * fonts, then the system's fonts for the generic families (and the common
 * names that mean them); else Bloom's built-in font. Within a family the
 * face nearest the weight wins (CSS font matching); a bold weight without a
 * bold face is drawn as faux bold.
 *
 * Each face knows its vertical metrics (ascender, descender and line gap
 * from the file's hhea table, in em), which place the baseline and give
 * `line-height: normal`, as in a browser.
 */
import { existsSync, readFileSync } from "node:fs";
import { drawText, measureText, loadFont, drawTextEx, measureTextEx } from "@bloomengine/engine/text";
import type { Font } from "@bloomengine/engine/core";
import { config, webRoot } from "../config.ts";
import { localPath } from "../fetch.ts";
import { split } from "./values.ts";
import { emojiFace } from "./emoji.ts";
import type { FontFace } from "./sheet.ts";

export interface Face {
  /** Draw text with its baseline at y + size, in device pixels (Bloom's convention). */
  draw(text: string, x: number, y: number, size: number, color: { r: number; g: number; b: number; a: number }): void;
  measure(text: string, size: number): number;
  /** Draw a bold weight twice over (no bold face) */
  synthBold: boolean;
  /** Vertical metrics in em */
  ascent: number;
  descent: number;
  lineGap: number;
  /** Whether the font has a glyph for a code point */
  has(cp: number): boolean;
}

/** Where the first font's table directory starts: 0, or in a collection (.ttc) the offset of its first font. */
export function faceStart(bytes: Uint8Array): number {
  if (bytes[0] === 0x74 && bytes[1] === 0x74 && bytes[2] === 0x63 && bytes[3] === 0x66) {
    return (bytes[12] ?? 0) * 16777216 + (((bytes[13] ?? 0) << 16) | ((bytes[14] ?? 0) << 8) | (bytes[15] ?? 0));
  }
  return 0;
}

/** The code point ranges a font's cmap maps (format 4 and 12 subtables). */
export function fontCoverage(bytes: Uint8Array): [number, number][] {
  const u16 = (i: number): number => ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
  const u32 = (i: number): number => (bytes[i] ?? 0) * 16777216 + (((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0));
  let cmap = -1;
  const base = faceStart(bytes);
  for (let t = 0; t < u16(base + 4); t++) {
    const r = base + 12 + t * 16;
    if (String.fromCharCode(bytes[r] ?? 0, bytes[r + 1] ?? 0, bytes[r + 2] ?? 0, bytes[r + 3] ?? 0) === "cmap") cmap = u32(r + 8);
  }
  if (cmap < 0) return [];
  // the best subtable: full Unicode (format 12) over BMP (format 4)
  let best = -1, bestFormat = 0;
  for (let k = 0; k < u16(cmap + 2); k++) {
    const rec = cmap + 4 + k * 8;
    const platform = u16(rec), enc = u16(rec + 2), off = cmap + u32(rec + 4);
    const format = u16(off);
    const unicode = platform === 0 || (platform === 3 && (enc === 1 || enc === 10));
    if (!unicode) continue;
    if (format === 12 && bestFormat !== 12) { best = off; bestFormat = 12; }
    else if (format === 4 && bestFormat === 0) { best = off; bestFormat = 4; }
  }
  const ranges: [number, number][] = [];
  if (bestFormat === 12) {
    const groups = u32(best + 12);
    for (let g = 0; g < groups; g++) { const o = best + 16 + g * 12; ranges.push([u32(o), u32(o + 4)]); }
  } else if (bestFormat === 4) {
    const segs = u16(best + 6) / 2;
    for (let s = 0; s < segs; s++) {
      const end = u16(best + 14 + s * 2), start = u16(best + 16 + segs * 2 + s * 2);
      if (start !== 0xffff) ranges.push([start, end]);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

function coverageTest(ranges: [number, number][]): (cp: number) => boolean {
  return (cp) => {
    let lo = 0, hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = ranges[mid] as [number, number];
      if (cp < r[0]) hi = mid - 1; else if (cp > r[1]) lo = mid + 1; else return true;
    }
    return false;
  };
}

interface Candidate { file: string; weight: number; italic: boolean }

const SF_MONO = "/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts/";
/** iOS, iPadOS and tvOS keep the system's fonts in these folders (other names than macOS). */
const IOS = "/System/Library/Fonts/";
const SUPP = "/System/Library/Fonts/Supplemental/";
function sfMono(): Candidate[] {
  const w: [string, number][] = [["Light", 300], ["Regular", 400], ["Medium", 500], ["Semibold", 600], ["Bold", 700], ["Heavy", 800]];
  return w.flatMap(([n, weight]): Candidate[] => [
    { file: `${SF_MONO}SF-Mono-${n}.otf`, weight, italic: false },
    { file: `${SF_MONO}SF-Mono-${n}Italic.otf`, weight, italic: true },
  ]);
}

/** System fonts for the generic families: the first family whose files exist is used. */
const SYSTEM: Record<string, Candidate[][]> = {
  monospace: [
    sfMono(),
    [{ file: IOS + "CoreUI/Menlo.ttc", weight: 400, italic: false }],
    [{ file: IOS + "Core/CourierNew.ttf", weight: 400, italic: false }, { file: IOS + "Core/CourierNewBold.ttf", weight: 700, italic: false }, { file: IOS + "Core/CourierNewItalic.ttf", weight: 400, italic: true }],
    [{ file: "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", weight: 400, italic: false }, { file: "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", weight: 700, italic: false }],
    [{ file: "C:\\Windows\\Fonts\\consola.ttf", weight: 400, italic: false }, { file: "C:\\Windows\\Fonts\\consolab.ttf", weight: 700, italic: false }],
  ],
  "sans-serif": [
    [{ file: "/System/Library/Fonts/SFNS.ttf", weight: 400, italic: false }, { file: "/System/Library/Fonts/SFNSItalic.ttf", weight: 400, italic: true }],
    [{ file: IOS + "Core/SFUI.ttf", weight: 400, italic: false }, { file: IOS + "Core/SFUIItalic.ttf", weight: 400, italic: true }],
    [{ file: SUPP + "Arial.ttf", weight: 400, italic: false }, { file: SUPP + "Arial Bold.ttf", weight: 700, italic: false }, { file: SUPP + "Arial Italic.ttf", weight: 400, italic: true }],
    [{ file: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", weight: 400, italic: false }, { file: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", weight: 700, italic: false }],
    [{ file: "C:\\Windows\\Fonts\\segoeui.ttf", weight: 400, italic: false }, { file: "C:\\Windows\\Fonts\\segoeuib.ttf", weight: 700, italic: false }],
  ],
  serif: [
    [{ file: IOS + "Core/NewYork.ttf", weight: 400, italic: false }, { file: IOS + "Core/NewYorkItalic.ttf", weight: 400, italic: true }],
    [{ file: SUPP + "Times New Roman.ttf", weight: 400, italic: false }, { file: SUPP + "Times New Roman Bold.ttf", weight: 700, italic: false }, { file: SUPP + "Times New Roman Italic.ttf", weight: 400, italic: true }],
    [{ file: "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf", weight: 400, italic: false }],
    [{ file: "C:\\Windows\\Fonts\\times.ttf", weight: 400, italic: false }, { file: "C:\\Windows\\Fonts\\timesbd.ttf", weight: 700, italic: false }],
  ],
  rounded: [[{ file: "/System/Library/Fonts/SFNSRounded.ttf", weight: 400, italic: false }], [{ file: IOS + "CoreUI/SFUIRounded.ttf", weight: 400, italic: false }]],
};
const ALIASES: Record<string, string> = {
  "ui-monospace": "monospace", "sf mono": "monospace", "sfmono-regular": "monospace", menlo: "monospace", monaco: "monospace", consolas: "monospace",
  courier: "monospace", "courier new": "monospace", "jetbrains mono": "monospace", "liberation mono": "monospace", "dejavu sans mono": "monospace",
  "system-ui": "sans-serif", "-apple-system": "sans-serif", blinkmacsystemfont: "sans-serif", "ui-sans-serif": "sans-serif",
  "segoe ui": "sans-serif", roboto: "sans-serif", helvetica: "sans-serif", "helvetica neue": "sans-serif", arial: "sans-serif", inter: "sans-serif",
  "ui-serif": "serif", times: "serif", "times new roman": "serif", georgia: "serif",
  "ui-rounded": "rounded", "sf pro rounded": "rounded",
};

let faces: FontFace[] = [];
export function setFontFaces(f: FontFace[]): void { faces = f; cache.clear(); }

/** Ascender, descender and line gap (em) from a TrueType/OpenType file's hhea and head tables. */
export function fontMetrics(bytes: Uint8Array): { ascent: number; descent: number; lineGap: number } | null {
  const u16 = (i: number): number => ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
  const i16 = (i: number): number => { const v = u16(i); return v >= 0x8000 ? v - 0x10000 : v; };
  const u32 = (i: number): number => (bytes[i] ?? 0) * 16777216 + (((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0));
  const base = faceStart(bytes);
  const tables = u16(base + 4);
  let head = -1, hhea = -1;
  for (let t = 0; t < tables; t++) {
    const r = base + 12 + t * 16;
    const tag = String.fromCharCode(bytes[r] ?? 0, bytes[r + 1] ?? 0, bytes[r + 2] ?? 0, bytes[r + 3] ?? 0);
    if (tag === "head") head = u32(r + 8);
    else if (tag === "hhea") hhea = u32(r + 8);
  }
  if (head < 0 || hhea < 0) return null;
  const upem = u16(head + 18) || 1000;
  return { ascent: i16(hhea + 4) / upem, descent: -i16(hhea + 6) / upem, lineGap: i16(hhea + 8) / upem };
}

interface Loaded { font: Font; ascent: number; descent: number; lineGap: number; has: (cp: number) => boolean }
const loaded = new Map<string, Loaded | null>();
function load(path: string): Loaded | null {
  let f = loaded.get(path);
  if (f === undefined) {
    f = null;
    try {
      const font = loadFont(path, 32);
      if (font.handle !== 0) {
        const bytes = readFileSync(path);
        const m = fontMetrics(bytes) ?? { ascent: 0.8, descent: 0.2, lineGap: 0 };
        const cov = fontCoverage(bytes);
        f = { font, ...m, has: cov.length > 0 ? coverageTest(cov) : () => true };
      }
    } catch { f = null; }
    loaded.set(path, f);
  }
  return f;
}

const builtin: Face = {
  draw: (t, x, y, size, c) => drawText(t, x, y, size, c),
  measure: (t, size) => measureText(t, size),
  synthBold: false, ascent: 0.8, descent: 0.2, lineGap: 0,
  has: (cp) => cp < 0x250 || (cp >= 0x2000 && cp < 0x2070),
};

/** CSS font matching: the italic faces if asked (else the upright ones), then the nearest weight. */
function pick(cands: Candidate[], weight: number, italic: boolean): Candidate | null {
  const present = cands.filter((c) => existsSync(c.file));
  if (present.length === 0) return null;
  const styled = present.filter((c) => c.italic === italic);
  const pool = styled.length > 0 ? styled : present;
  const dist = (w: number): number => {
    if (w === weight) return 0;
    // heavier first for bold requests, lighter first for light ones (CSS's order, simplified)
    if (weight >= 400) return w > weight ? w - weight : 1000 + weight - w;
    return w < weight ? weight - w : 1000 + w - weight;
  };
  return pool.reduce((best, c) => (dist(c.weight) < dist(best.weight) ? c : best));
}

function candidates(family: string): Candidate[] | null {
  const name = family.replace(/["']/g, "").trim();
  const lower = name.toLowerCase();
  const own = config().fonts[name] ?? config().fonts[lower];
  if (own !== undefined) return [{ file: own.startsWith("/") ? own : webRoot() + own, weight: 400, italic: false }];
  const ff = faces.filter((f) => f.family.toLowerCase() === lower);
  if (ff.length > 0) {
    const out: Candidate[] = [];
    for (const f of ff) {
      for (const m of f.src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
        const p = localPath(m[1] ?? "");
        if (p !== null && existsSync(p) && /\.(ttf|otf)$/i.test(p)) {
          const w = f.weight === "bold" ? 700 : f.weight === "normal" ? 400 : parseInt(f.weight, 10) || 400;
          out.push({ file: p, weight: w, italic: /italic|oblique/.test(f.style) });
          break;
        }
      }
    }
    if (out.length > 0) return out;
  }
  const generic = ALIASES[lower] ?? lower;
  for (const set of SYSTEM[generic] ?? []) if (set.some((c) => existsSync(c.file))) return set;
  return null;
}

const cache = new Map<string, Face>();

/** Fonts for characters the page's fonts don't have, in order (a browser's fallback list). */
const FALLBACK = [
  "/System/Library/Fonts/Apple Symbols.ttf", IOS + "Core/AppleSymbols.ttf", IOS + "CoreAddition/STIXGeneral.otf", "/System/Library/Fonts/Supplemental/Arial Unicode.ttf", "/System/Library/Fonts/SFNS.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/noto/NotoSansSymbols-Regular.ttf", "C:\\Windows\\Fonts\\seguisym.ttf",
];
const fallbackFaces = new Map<string, Face | null>();

/** The face that draws a code point when `face` lacks it (null: none does). */
export function fallbackFor(face: Face, cp: number, weight: number): Face | null {
  void face;
  // emoji (U+1F000 and up) prefer color, as in a browser; other symbols are text first
  const emojiFirst = cp >= 0x1f000;
  if (emojiFirst) { const e = emojiFace(); if (e !== null && e.has(cp)) return e; }
  const f = textFallback(cp, weight);
  if (f !== null || emojiFirst) return f;
  const e = emojiFace();
  return e !== null && e.has(cp) ? e : null;
}

function textFallback(cp: number, weight: number): Face | null {
  for (const file of FALLBACK) {
    let f = fallbackFaces.get(file);
    if (f === undefined) {
      f = null;
      if (existsSync(file)) {
        const l = load(file);
        if (l !== null) {
          const font = l.font;
          f = { draw: (t, x, y, size, col) => drawTextEx(font, t, { x, y }, size, 0, col), measure: (t, size) => measureTextEx(font, t, size, 0).x,
            synthBold: false, ascent: l.ascent, descent: l.descent, lineGap: l.lineGap, has: l.has };
        }
      }
      fallbackFaces.set(file, f);
    }
    if (f !== null && f.has(cp)) return weight >= 600 ? { ...f, synthBold: true } : f;
  }
  return null;
}

/** The face for a computed font-family, font-weight and font-style. */
export function faceFor(family: string, weight: number, style = "normal"): Face {
  const italic = style === "italic" || style.startsWith("oblique");
  const key = family + "|" + String(weight) + "|" + String(italic);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let face: Face = { ...builtin, synthBold: weight >= 600 };
  for (const fam of split(family, true)) {
    const cands = candidates(fam);
    if (cands === null) continue;
    const c = pick(cands, weight, italic);
    if (c === null) continue;
    const f = load(c.file);
    if (f === null) continue;
    const font = f.font;
    face = {
      draw: (t, x, y, size, col) => drawTextEx(font, t, { x, y }, size, 0, col),
      measure: (t, size) => measureTextEx(font, t, size, 0).x,
      synthBold: weight >= 600 && c.weight < 600,
      ascent: f.ascent, descent: f.descent, lineGap: f.lineGap, has: f.has,
    };
    break;
  }
  cache.set(key, face);
  return face;
}
