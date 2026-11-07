/**
 * Color emoji, drawn as images (Bloom's text renderer draws outlines only). Each emoji cluster
 * (with its skin tone or ZWJ parts) is drawn once by the system where Bloom can (Core Text on Apple
 * platforms, through renderEmoji) into a PNG; elsewhere the picture comes from the emoji font's
 * `sbix` table (PNG glyphs, the base character only). Pictures are drawn as textures scaled to
 * the font size on the baseline; coverage (cmap) and advances (hmtx) come from the font file.
 *
 * The font is large (a few hundred MB on macOS), so only the tables and glyphs used are read, at
 * their offsets, never the whole file.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { drawTexturePro, loadTexture } from "@bloomengine/engine/textures";
import type { Texture } from "@bloomengine/engine/core";
import { renderEmoji } from "@bloomengine/engine/text";
import { tempDir } from "../blob.ts";
import type { Face } from "./fonts.ts";

/** The emoji font: macOS, then iOS (whose file name carries its pixel size). */
function emojiFile(): string | null {
  const mac = "/System/Library/Fonts/Apple Color Emoji.ttc";
  if (existsSync(mac)) return mac;
  for (const dir of ["/System/Library/Fonts/CoreAddition/", "/System/Library/Fonts/Core/"]) {
    try {
      const names = readdirSync(dir).filter((n) => /^AppleColorEmoji.*\.tt[cf]$/.test(n)).sort();
      const name = names[names.length - 1];
      if (name !== undefined) return dir + name;
    } catch { /* no such folder */ }
  }
  return null;
}

class Reader {
  private fd: number;
  constructor(path: string) { this.fd = openSync(path, "r"); }
  bytes(at: number, n: number): Uint8Array {
    const b = new Uint8Array(n);
    readSync(this.fd, b, 0, n, at);
    return b;
  }
  u16(at: number): number { const b = this.bytes(at, 2); return ((b[0] ?? 0) << 8) | (b[1] ?? 0); }
  i16(at: number): number { const v = this.u16(at); return v >= 0x8000 ? v - 0x10000 : v; }
  u32(at: number): number { const b = this.bytes(at, 4); return (b[0] ?? 0) * 16777216 + (((b[1] ?? 0) << 16) | ((b[2] ?? 0) << 8) | (b[3] ?? 0)); }
  close(): void { closeSync(this.fd); }
}

/** A picture of an emoji cluster: its size in pixels at `ppem`, and its bottom-left from the pen on the baseline. */
interface Glyph { file: string; w: number; h: number; ox: number; oy: number; ppem: number }

/** The pixel size the system renderer draws emoji at (scaled down to the text size). */
const NATIVE_PX = 128;
let nativeWorks: boolean | undefined;
let clusterCount = 0;

/** PNG width and height from its IHDR. */
function pngSize(png: Uint8Array): [number, number] {
  const at = (i: number): number => ((png[i] ?? 0) * 16777216) + ((png[i + 1] ?? 0) << 16) + ((png[i + 2] ?? 0) << 8) + (png[i + 3] ?? 0);
  return [at(16), at(20)];
}

/** An emoji cluster drawn by the system (Core Text on Apple platforms), or null where there is none. */
function nativeGlyph(cluster: string): Glyph | null {
  if (nativeWorks === undefined && process.env["BLOOM_NO_NATIVE_EMOJI"] !== undefined) nativeWorks = false;
  if (nativeWorks === false) return null;
  const file = tempDir() + "emoji-c" + String(++clusterCount) + ".png";
  let ascent = 0;
  try { ascent = renderEmoji(cluster, NATIVE_PX, file); } catch { ascent = 0; }
  if (nativeWorks === undefined) nativeWorks = ascent > 0;
  if (ascent <= 0 || !existsSync(file)) return null;
  const [w, h] = pngSize(readFileSync(file).subarray(0, 32));
  return { file, w, h, ox: 0, oy: -(h - ascent), ppem: NATIVE_PX };
}

/**
 * The clusters of a run of emoji: a base character with the presentation selectors, skin-tone
 * modifiers and ZWJ-joined characters that belong to it (👍🏽, 👨‍👩‍👧, ❤️).
 */
export function emojiClusters(text: string): string[] {
  const cps = [...text];
  const out: string[] = [];
  for (let i = 0; i < cps.length; i++) {
    let c = cps[i] as string;
    while (i + 1 < cps.length) {
      const next = (cps[i + 1] as string).codePointAt(0) ?? 0;
      if (next === 0xfe0f || next === 0xfe0e || (next >= 0x1f3fb && next <= 0x1f3ff)) { c += cps[++i] as string; continue; }
      if (next === 0x200d && i + 2 < cps.length) { c += (cps[i + 1] as string) + (cps[i + 2] as string); i += 2; continue; }
      break;
    }
    out.push(c);
  }
  return out;
}

class EmojiFont {
  private r: Reader;
  private tables = new Map<string, number>();
  private upem = 1000;
  private hmetrics = 0;
  private cmap12 = -1;
  private cmap4 = -1;
  private strike = -1;
  private ppem = 160;
  private glyphs = new Map<number, Glyph | null>();
  private clusters = new Map<string, Glyph | null>();
  private textures = new Map<string, Texture | null>();
  private gids = new Map<number, number>();
  ascent = 0.95;
  descent = 0.25;

  constructor(path: string) {
    this.r = new Reader(path);
    const r = this.r;
    const tag = String.fromCharCode(...r.bytes(0, 4));
    const base = tag === "ttcf" ? r.u32(12) : 0;
    const n = r.u16(base + 4);
    for (let t = 0; t < n; t++) {
      const rec = base + 12 + t * 16;
      this.tables.set(String.fromCharCode(...r.bytes(rec, 4)), r.u32(rec + 8));
    }
    const head = this.tables.get("head"), hhea = this.tables.get("hhea"), cmap = this.tables.get("cmap"), sbix = this.tables.get("sbix");
    if (head === undefined || hhea === undefined || cmap === undefined || sbix === undefined) throw new Error("not a color emoji font");
    this.upem = r.u16(head + 18) || 1000;
    this.ascent = r.i16(hhea + 4) / this.upem;
    this.descent = -r.i16(hhea + 6) / this.upem;
    this.hmetrics = r.u16(hhea + 34);
    for (let k = 0; k < r.u16(cmap + 2); k++) {
      const rec = cmap + 4 + k * 8;
      const platform = r.u16(rec), enc = r.u16(rec + 2), off = cmap + r.u32(rec + 4);
      if (!(platform === 0 || (platform === 3 && (enc === 1 || enc === 10)))) continue;
      const format = r.u16(off);
      if (format === 12 && this.cmap12 < 0) this.cmap12 = off;
      if (format === 4 && this.cmap4 < 0) this.cmap4 = off;
    }
    // the largest strike: the sharpest picture, scaled down to the text size
    const strikes = r.u32(sbix + 4);
    for (let s = 0; s < strikes; s++) {
      const off = sbix + r.u32(sbix + 8 + s * 4);
      const ppem = r.u16(off);
      if (this.strike < 0 || ppem > this.ppem) { this.strike = off; this.ppem = ppem; }
    }
  }

  gid(cp: number): number {
    const hit = this.gids.get(cp);
    if (hit !== undefined) return hit;
    const r = this.r;
    let g = 0;
    if (this.cmap12 >= 0) {
      let lo = 0, hi = r.u32(this.cmap12 + 12) - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, o = this.cmap12 + 16 + mid * 12;
        const start = r.u32(o), end = r.u32(o + 4);
        if (cp < start) hi = mid - 1; else if (cp > end) lo = mid + 1; else { g = r.u32(o + 8) + (cp - start); break; }
      }
    } else if (this.cmap4 >= 0 && cp <= 0xffff) {
      const t = this.cmap4, segs = r.u16(t + 6) / 2;
      for (let s = 0; s < segs; s++) {
        const end = r.u16(t + 14 + s * 2);
        if (cp > end) continue;
        const startAt = t + 16 + segs * 2 + s * 2, start = r.u16(startAt);
        if (cp < start) break;
        const delta = r.u16(startAt + segs * 2), rangeAt = startAt + segs * 4, range = r.u16(rangeAt);
        if (range === 0) g = (cp + delta) & 0xffff;
        else { const v = r.u16(rangeAt + range + (cp - start) * 2); g = v === 0 ? 0 : (v + delta) & 0xffff; }
        break;
      }
    }
    this.gids.set(cp, g);
    return g;
  }

  advance(gid: number): number {
    const hmtx = this.tables.get("hmtx");
    if (hmtx === undefined || this.hmetrics === 0) return 1;
    return this.r.u16(hmtx + Math.min(gid, this.hmetrics - 1) * 4) / this.upem;
  }

  glyph(gid: number): Glyph | null {
    const hit = this.glyphs.get(gid);
    if (hit !== undefined) return hit;
    let g: Glyph | null = null;
    if (gid > 0 && this.strike >= 0) {
      const r = this.r;
      const a = r.u32(this.strike + 4 + gid * 4), b = r.u32(this.strike + 8 + gid * 4);
      if (b - a > 8) {
        const at = this.strike + a;
        const type = String.fromCharCode(...r.bytes(at + 4, 4));
        if (type === "png ") {
          const png = r.bytes(at + 8, b - a - 8);
          const [w, h] = pngSize(png);
          const file = tempDir() + "emoji-" + String(gid) + ".png";
          writeFileSync(file, png);
          g = { file, w, h, ox: r.i16(at), oy: r.i16(at + 2), ppem: this.ppem };
        }
      }
    }
    this.glyphs.set(gid, g);
    return g;
  }

  texture(file: string): Texture | null {
    let t = this.textures.get(file);
    if (t === undefined) { try { t = loadTexture(file); } catch { t = null; } this.textures.set(file, t); }
    return t;
  }

  /** The picture of a cluster: the system's rendering, else the font's own image of its base character. */
  picture(cluster: string): Glyph | null {
    const hit = this.clusters.get(cluster);
    if (hit !== undefined) return hit;
    const g = nativeGlyph(cluster) ?? this.glyph(this.gid(cluster.codePointAt(0) ?? 0));
    this.clusters.set(cluster, g);
    return g;
  }

  /** Joiners, selectors and skin tones belong to the cluster before them. */
  static joining(cp: number): boolean { return cp === 0xfe0f || cp === 0xfe0e || cp === 0x200d || (cp >= 0x1f3fb && cp <= 0x1f3ff); }

  face(): Face {
    const self = this;
    const advance = (cluster: string, size: number): number => self.advance(self.gid(cluster.codePointAt(0) ?? 0)) * size;
    return {
      synthBold: false, ascent: this.ascent, descent: this.descent, lineGap: 0,
      has: (cp) => EmojiFont.joining(cp) || (self.gid(cp) > 0 && self.picture(String.fromCodePoint(cp)) !== null),
      measure(text, size) {
        let w = 0;
        for (const c of emojiClusters(text)) w += advance(c, size);
        return w;
      },
      draw(text, x, y, size, color) {
        const baseline = y + size;
        let pen = x;
        for (const c of emojiClusters(text)) {
          const g = self.picture(c);
          if (g !== null) {
            const tex = self.texture(g.file), scale = size / g.ppem;
            if (tex !== null) {
              const w = g.w * scale, h = g.h * scale;
              drawTexturePro(tex, { x: 0, y: 0, width: tex.width, height: tex.height },
                { x: pen + g.ox * scale, y: baseline - g.oy * scale - h, width: w, height: h }, { x: 0, y: 0 }, 0,
                { r: 255, g: 255, b: 255, a: color.a });
            }
          }
          pen += advance(c, size);
        }
      },
    };
  }
}

let emoji: Face | null | undefined;
/** The color emoji face, or null when the system has no emoji font this can read. */
export function emojiFace(): Face | null {
  if (emoji === undefined) {
    emoji = null;
    try { const file = emojiFile(); if (file !== null) emoji = new EmojiFont(file).face(); } catch { emoji = null; }
  }
  return emoji;
}
