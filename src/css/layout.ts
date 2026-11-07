/**
 * Layout: the box tree for the page, and the CSS formatting it needs for a
 * game's HTML overlay:
 *
 *  - block flow: widths from the containing block, box-sizing, margins
 *    (auto centering, adjacent sibling margins collapse), min/max sizes,
 *    percentage heights against definite ones
 *  - inline flow: text broken into lines (white-space, overflow-wrap),
 *    text-align, line-height, letter-spacing, text-transform, inline
 *    elements' runs, inline-blocks and replaced elements on the line,
 *    text-overflow: ellipsis
 *  - flex: direction, wrap, gap, grow/shrink/basis, auto margins,
 *    justify-content, align-items/self/content
 *  - grid: template columns and rows (px, %, fr, auto, minmax(),
 *    repeat() with counts and auto-fill/auto-fit), auto placement and spans,
 *    gaps, justify/align-items and -self, stretching auto rows
 *  - position: relative offsets; absolute against the nearest positioned
 *    ancestor, fixed against the viewport, from their static position when
 *    insets are auto; z-index for paint order
 *  - intrinsic sizes (min-content, max-content) for shrink-to-fit widths
 *
 * Coordinates are CSS pixels from the viewport's top left. Not here: floats,
 * tables (laid out as blocks), writing modes, ::before/::after.
 */
import type { Element, Node, Text } from "../dom/node.ts";
import { Computed, INHERITED } from "./cascade.ts";
import { faceFor, fallbackFor, type Face } from "./fonts.ts";
import { emojiFace } from "./emoji.ts";
import { length, split, type LengthContext } from "./values.ts";

export interface Edges { t: number; r: number; b: number; l: number }
const ZERO: Edges = { t: 0, r: 0, b: 0, l: 0 };

export interface Fragment { text: string; x: number; y: number; w: number; style: Computed; face: Face; size: number; spacing: number }

export class Box {
  el: Element | null;
  style: Computed;
  /** block | inline | inline-block | flex | inline-flex | grid | inline-grid | text | replaced | anonymous */
  kind: string;
  children: Box[] = [];
  text = "";
  x = 0; y = 0; w = 0; h = 0;
  margin: Edges = ZERO; border: Edges = ZERO; padding: Edges = ZERO;
  /** Text drawn by this box (its inline content) */
  fragments: Fragment[] = [];
  /** An inline element's boxes per line (for its background, border and hit area) */
  inlineRects: { x: number; y: number; w: number; h: number }[] = [];
  position = "static";
  outOfFlow = false;
  /** A list item: its marker ("•", "3.") goes left of its first line */
  marker = "";
  markerY = NaN;
  /** Static position, for absolute boxes with auto insets */
  staticX = 0; staticY = 0;
  /** Content height, for scrolling */
  contentH = 0;
  /** Laid out for an intrinsic size only (no fragments kept) */
  constructor(el: Element | null, style: Computed, kind: string) { this.el = el; this.style = style; this.kind = kind; }
  get isBlockLevel(): boolean { return this.kind === "block" || this.kind === "flex" || this.kind === "grid" || this.kind === "anonymous" || this.kind === "list-item"; }
  get isInlineLevel(): boolean { return this.kind === "inline" || this.kind === "text" || this.kind === "inline-block" || this.kind === "inline-flex" || this.kind === "inline-grid" || this.kind === "replaced"; }
  get isAtomic(): boolean { return this.kind === "inline-block" || this.kind === "inline-flex" || this.kind === "inline-grid" || this.kind === "replaced"; }
  get display(): string { return this.kind === "inline-flex" ? "flex" : this.kind === "inline-grid" ? "grid" : this.kind; }
}

export interface LayoutEnv {
  vw: number; vh: number; rem: number;
  env: (name: string) => number;
  /** Natural size of a replaced element (img, canvas, video), or null */
  natural: (e: Element) => { w: number; h: number } | null;
}

let ENV: LayoutEnv = { vw: 0, vh: 0, rem: 16, env: () => 0, natural: () => null };

function lc(s: Computed, percent: number): LengthContext {
  return { em: s.fontSize, rem: ENV.rem, vw: ENV.vw, vh: ENV.vh, percent, env: ENV.env };
}
/** A length property in px (NaN: auto, or a percentage of an unknown size). */
function len(s: Computed, name: string, percent: number): number { return length(s.get(name), lc(s, percent)); }
function lenOr(s: Computed, name: string, percent: number, fallback: number): number { const v = len(s, name, percent); return Number.isFinite(v) ? v : fallback; }

function edges(s: Computed, prefix: string, suffix: string, cbWidth: number): Edges {
  const g = (side: string): number => lenOr(s, `${prefix}${side}${suffix}`, cbWidth, 0);
  return { t: g("top"), r: g("right"), b: g("bottom"), l: g("left") };
}
function borderEdges(s: Computed): Edges {
  const side = (n: string): number => {
    const style = s.get(`border-${n}-style`);
    if (style === "none" || style === "hidden") return 0;
    const w = s.get(`border-${n}-width`);
    if (w === "thin") return 1;
    if (w === "medium") return 3;
    if (w === "thick") return 5;
    return lenOr(s, `border-${n}-width`, 0, 0);
  };
  return { t: side("top"), r: side("right"), b: side("bottom"), l: side("left") };
}

// ---------------------------------------------------------------- the box tree

const anonStyles = new WeakMap<Computed, Computed>();
/** An anonymous box's style: only what it inherits from its parent (CSS 2.1 §9.2.1.1). */
function anonymous(s: Computed): Computed {
  let a = anonStyles.get(s);
  if (a === undefined) {
    const values: Record<string, string> = { display: "block" };
    for (const k of INHERITED) { const v = s.values[k]; if (v !== undefined) values[k] = v; }
    a = new Computed(values, s.custom, s.fontSize, s.color);
    anonStyles.set(s, a);
  }
  return a;
}

const REPLACED = new Set(["img", "canvas", "video", "svg", "iframe", "embed", "object", "input", "textarea", "select", "meter", "progress"]);

/** Build boxes for an element and its subtree (display: none makes none). */
export function buildBoxes(e: Element, styles: Map<Element, Computed>): Box | null {
  const s = styles.get(e);
  if (s === undefined) return null;
  const display = s.get("display").trim().toLowerCase();
  if (display === "none") return null;
  const name = e.localName;
  // form controls without children draw as replaced boxes; <select> and buttons keep their content
  const replaced = REPLACED.has(name) && name !== "select";
  const kindOf = (d: string): string => {
    const parts = d.split(/\s+/);
    if (parts.includes("flex")) return parts.includes("inline") ? "inline-flex" : "flex";
    if (parts.includes("grid")) return parts.includes("inline") ? "inline-grid" : "grid";
    if (d === "inline-flex" || d === "inline-grid" || d === "inline-block") return d;
    if (d === "inline" || d === "contents" || d === "ruby") return "inline";
    if (d === "list-item") return "block";
    if (d.startsWith("table") && d !== "table" && d !== "inline-table") return d === "table-cell" ? "inline-block" : "block";
    if (d === "inline-table") return "inline-block";
    return "block";
  };
  let kind = replaced ? (display === "block" ? "replaced-block" : "replaced") : kindOf(display);
  const listItem = display === "list-item";
  if (kind === "replaced-block") kind = "replaced";
  const box = new Box(e, s, kind);
  if (replaced && kind === "replaced" && display !== "inline" && display !== "inline-block") box.kind = "replaced";
  box.position = s.get("position").trim();
  if (listItem) {
    const type = s.get("list-style-type");
    if (type === "decimal") {
      let n = 1;
      for (let p = e.previousElementSibling; p !== null; p = p.previousElementSibling) if (styles.get(p)?.get("display") === "list-item") n++;
      box.marker = String(n) + ".";
    } else box.marker = type === "none" ? "" : type === "circle" ? "◦" : type === "square" ? "▪" : "•";
  }
  box.outOfFlow = box.position === "absolute" || box.position === "fixed";
  // out-of-flow and flex/grid items are blockified
  if (box.outOfFlow && box.kind === "inline") box.kind = "block";
  if (replaced) return box;
  for (const n of e.childNodes) {
    if (n.nodeType === 3) {
      const t = new Box(null, s, "text");
      t.text = (n as Text).data;
      box.children.push(t);
    } else if (n.nodeType === 1) {
      const c = buildBoxes(n as Element, styles);
      if (c !== null) box.children.push(c);
    }
  }
  if (box.display === "flex" || box.display === "grid") {
    // items: blockified; whitespace-only text dropped; other text in anonymous blocks
    const items: Box[] = [];
    for (const c of box.children) {
      if (c.kind === "text") {
        if (/^\s*$/.test(c.text)) continue;
        const anon = new Box(null, anonymous(s), "anonymous");
        anon.children.push(c);
        items.push(anon);
      } else {
        if (c.kind === "inline") c.kind = "block";
        else if (c.kind === "inline-block") c.kind = "block";
        else if (c.kind === "inline-flex") c.kind = "flex";
        else if (c.kind === "inline-grid") c.kind = "grid";
        items.push(c);
      }
    }
    box.children = items;
  } else if (box.children.some((c) => c.isBlockLevel && !c.outOfFlow) && !box.children.some((c) => c.isInlineLevel && !c.outOfFlow && !(c.kind === "text" && /^\s*$/.test(c.text)))) {
    // blocks with only whitespace between them: the whitespace isn't rendered
    box.children = box.children.filter((c) => !(c.kind === "text" && /^\s*$/.test(c.text)));
  } else if (box.children.some((c) => c.isBlockLevel && !c.outOfFlow) && box.children.some((c) => c.isInlineLevel && !(c.kind === "text" && /^\s*$/.test(c.text)))) {
    // mixed: runs of inline content go into anonymous blocks
    const out: Box[] = [];
    let run: Box | null = null;
    for (const c of box.children) {
      if (c.isInlineLevel || c.outOfFlow) {
        if (c.outOfFlow && run === null) { out.push(c); continue; }
        if (run === null) { run = new Box(null, anonymous(s), "anonymous"); out.push(run); }
        run.children.push(c);
      } else { run = null; out.push(c); }
    }
    box.children = out.filter((c) => !(c.kind === "anonymous" && c.children.every((k) => k.kind === "text" && /^\s*$/.test(k.text))));
  }
  return box;
}

// ---------------------------------------------------------------- text

interface Piece {
  kind: "text" | "atomic" | "open" | "close" | "break";
  text: string;
  style: Computed;
  /** The face for text the style's font lacks (font fallback) */
  face?: Face;
  box: Box | null;      // the atomic box, or the inline element opened/closed
  w: number;
}

function transform(t: string, s: Computed): string {
  const tt = s.get("text-transform");
  if (tt === "uppercase") return t.toUpperCase();
  if (tt === "lowercase") return t.toLowerCase();
  if (tt === "capitalize") return t.replace(/(^|\s)(\S)/g, (_m, a: string, b: string) => a + b.toUpperCase());
  return t;
}

function fontOf(s: Computed): { face: Face; size: number; spacing: number } {
  const size = s.fontSize;
  const ls = s.get("letter-spacing");
  const spacing = ls === "normal" ? 0 : length(ls, lc(s, size)) || 0;
  return { face: faceFor(s.get("font-family"), Number(s.get("font-weight")) || 400, s.get("font-style")), size, spacing };
}

const widths = new Map<string, number>();
/** Width of text in CSS px (cached: text, font, size). */
export function measure(t: string, s: Computed, own?: Face): number {
  const { face: primary, size, spacing } = fontOf(s);
  const face = own ?? primary;
  const key = t + "\u0000" + s.get("font-family") + s.get("font-weight") + s.get("font-style") + String(size) + (own === undefined ? "" : "f");
  let w = widths.get(key);
  if (w === undefined) {
    w = face.measure(t, size);
    if (widths.size > 20000) widths.clear();
    widths.set(key, w);
  }
  return w + spacing * [...t].length;
}

/** Split text into runs by the face that has its characters: the style's font, else a fallback. */
function byFace(t: string, s: Computed): { text: string; face: Face | undefined }[] {
  const primary = fontOf(s).face;
  const weight = Number(s.get("font-weight")) || 400;
  const out: { text: string; face: Face | undefined }[] = [];
  const chars = [...t];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    const cp = ch.codePointAt(0) ?? 0;
    // U+FE0F after a character asks for its emoji (color) form, as in ❤️
    const emoji = chars[i + 1] === "\uFE0F" ? emojiFace() : null;
    let face = emoji !== null && emoji.has(cp) ? emoji
      : cp < 0x80 || cp === 0x20 || primary.has(cp) ? undefined : fallbackFor(primary, cp, weight) ?? undefined;
    // the selector and a zero-width joiner stay with the character before them (👨‍👩‍👧)
    if ((cp === 0xfe0f || cp === 0x200d) && out.length > 0) face = (out[out.length - 1] as { face: Face | undefined }).face;
    const last = out[out.length - 1];
    if (last !== undefined && last.face === face) last.text += ch; else out.push({ text: ch, face });
  }
  return out;
}

/** Where the baseline sits in a line box of the style's line-height: the half-leading plus the font's ascent. */
function ascentIn(s: Computed, lh: number): number {
  const f = fontOf(s).face;
  return (lh - (f.ascent + f.descent) * s.fontSize) / 2 + f.ascent * s.fontSize;
}

function lineHeight(s: Computed): number {
  const v = s.get("line-height").trim();
  if (v === "normal") { const f = fontOf(s).face; return (f.ascent + f.descent + f.lineGap) * s.fontSize; }
  if (/^[\d.]+$/.test(v)) return parseFloat(v) * s.fontSize;
  const px = length(v, lc(s, s.fontSize));
  return Number.isFinite(px) ? px : s.fontSize * 1.2;
}

/** The inline content of a block container as pieces: words, spaces, atomic boxes, inline element edges. */
function pieces(container: Box, out: Piece[], prevSpace: { v: boolean }): void {
  for (const c of container.children) {
    if (c.outOfFlow) { out.push({ kind: "atomic", text: "", style: c.style, box: c, w: 0 }); continue; }
    if (c.kind === "text") {
      const s = c.style;
      const ws = s.get("white-space");
      const pre = ws === "pre" || ws === "pre-wrap" || ws === "break-spaces";
      const preLine = ws === "pre-line";
      let t = c.text;
      if (!pre) t = preLine ? t.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n") : t.replace(/\s+/g, " ");
      t = transform(t, s);
      const lines = pre || preLine ? t.split("\n") : [t];
      lines.forEach((line, li) => {
        if (li > 0) { out.push({ kind: "break", text: "", style: s, box: null, w: 0 }); prevSpace.v = true; }
        // words and the spaces after them
        const parts = pre ? [line] : line.split(/( )/);
        for (const p of parts) {
          if (p === "") continue;
          if (p === " " && !pre) {
            if (prevSpace.v) continue;
            prevSpace.v = true;
          } else prevSpace.v = false;
          for (const run of byFace(p, s)) out.push({ kind: "text", text: run.text, style: s, box: null, w: measure(run.text, s, run.face), face: run.face });
        }
      });
    } else if (c.isAtomic) {
      out.push({ kind: "atomic", text: "", style: c.style, box: c, w: 0 });
      prevSpace.v = false;
    } else if (c.kind === "inline") {
      out.push({ kind: "open", text: "", style: c.style, box: c, w: 0 });
      pieces(c, out, prevSpace);
      out.push({ kind: "close", text: "", style: c.style, box: c, w: 0 });
    } else if (c.kind === "block" || c.kind === "anonymous") {
      // a block inside inline content (an <a> around a <div>): its own line
      out.push({ kind: "break", text: "", style: c.style, box: null, w: 0 });
      out.push({ kind: "atomic", text: "", style: c.style, box: c, w: 0 });
      out.push({ kind: "break", text: "", style: c.style, box: null, w: 0 });
    }
  }
}

interface LineItem { piece: Piece; x: number; w: number }

/**
 * Lay out a block container's inline content in lines of width `avail` from (x, y). Returns the
 * height and the widest line. With `measureOnly`, nothing is placed.
 */
function layoutInline(box: Box, x: number, y: number, avail: number, measureOnly: boolean): { h: number; maxLine: number; minWord: number } {
  const s = box.style;
  const ps: Piece[] = [];
  pieces(box, ps, { v: true });
  const nowrap = (st: Computed): boolean => { const w = st.get("white-space"); return w === "nowrap" || w === "pre"; };
  const breakAll = s.get("overflow-wrap") === "anywhere" || s.get("overflow-wrap") === "break-word" || s.get("word-break") === "break-all";
  // atomic sizes
  for (const p of ps) {
    if (p.kind !== "atomic" || p.box === null) continue;
    const b = p.box;
    if (b.outOfFlow) continue;
    if (measureOnly) { p.w = maxContent(b) + b.margin.l + b.margin.r; continue; }
    layoutBox(b, avail, NaN, 0, 0, true);
    p.w = b.w + b.margin.l + b.margin.r;
  }
  let minWord = 0;
  for (const p of ps) if (p.kind === "text" && p.text !== " ") minWord = Math.max(minWord, breakAll ? measure(p.text.charAt(0), p.style) : p.w);
  for (const p of ps) if (p.kind === "atomic" && p.box !== null && !p.box.outOfFlow) minWord = Math.max(minWord, measureOnly ? minContent(p.box) + p.box.margin.l + p.box.margin.r : p.w);

  // break into lines
  const lines: LineItem[][] = [];
  let line: LineItem[] = [];
  let cx = 0;
  const indent = lenOr(s, "text-indent", avail, 0);
  cx = indent;
  const pushLine = (): void => {
    // trailing spaces don't count
    while (line.length > 0) { const l = line[line.length - 1] as LineItem; if (l.piece.kind === "text" && l.piece.text === " " && !nowrap(l.piece.style)) line.pop(); else break; }
    lines.push(line);
    line = [];
    cx = 0;
  };
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i] as Piece;
    if (p.kind === "break") { pushLine(); continue; }
    if (p.kind === "open" || p.kind === "close" || (p.kind === "atomic" && p.box?.outOfFlow === true)) {
      // an inline element's padding, border and margin take room at its edges
      let w = 0;
      if (p.box !== null && (p.kind === "open" || p.kind === "close")) {
        const b = borderEdges(p.style), pad = edges(p.style, "padding-", "", avail), m = edges(p.style, "margin-", "", avail);
        w = p.kind === "open" ? b.l + pad.l + m.l : b.r + pad.r + m.r;
      }
      line.push({ piece: p, x: cx, w });
      cx += w;
      continue;
    }
    if (p.kind === "text" && p.text === " " && line.length === 0) continue;   // no space at a line's start
    const fits = cx + p.w <= avail + 0.01;
    const canBreak = !nowrap(p.style) && line.some((l) => l.piece.kind === "text" || l.piece.kind === "atomic");
    if (!fits && canBreak && p.text !== " ") {
      pushLine();
      if (p.kind === "text" && p.text === " ") continue;
    }
    if (p.kind === "text" && breakAll && p.w > avail && !nowrap(p.style)) {
      // a word longer than the line, broken anywhere
      let rest = p.text;
      while (rest !== "") {
        let k = rest.length;
        while (k > 1 && cx + measure(rest.slice(0, k), p.style) > avail) k--;
        const part = rest.slice(0, k), w = measure(part, p.style);
        line.push({ piece: { ...p, text: part, w }, x: cx, w });
        cx += w;
        rest = rest.slice(k);
        if (rest !== "") pushLine();
      }
      continue;
    }
    line.push({ piece: p, x: cx, w: p.w });
    cx += p.w;
  }
  if (line.length > 0 || lines.length === 0) pushLine();

  let maxLine = 0;
  for (const l of lines) { let w = 0; for (const it of l) w = Math.max(w, it.x + it.w); maxLine = Math.max(maxLine, w); }
  // heights: the strut (the container's own line-height) and each piece's
  const strutLh = lineHeight(s);
  let cy = y;
  const align = s.get("text-align");
  const lastLine = lines.length - 1;
  lines.forEach((l, li) => {
    let ascent = ascentIn(s, strutLh), descent = strutLh - ascent;
    for (const it of l) {
      const p = it.piece;
      if (p.kind === "text") {
        const lh = lineHeight(p.style), a = ascentIn(p.style, lh);
        ascent = Math.max(ascent, a); descent = Math.max(descent, lh - a);
      } else if (p.kind === "atomic" && p.box !== null && !p.box.outOfFlow) {
        const b = p.box;
        const mh = (measureOnly ? 0 : b.h) + b.margin.t + b.margin.b;
        const va = b.style.get("vertical-align");
        if (va === "middle") { const mid = s.fontSize * 0.3; ascent = Math.max(ascent, mh / 2 + mid); descent = Math.max(descent, mh / 2 - mid); }
        else if (va === "top" || va === "text-top") descent = Math.max(descent, mh - ascent);
        else ascent = Math.max(ascent, mh);
      }
    }
    const lineH = ascent + descent;
    if (!measureOnly) {
      let width = 0;
      for (const it of l) width = Math.max(width, it.x + it.w);
      const free = avail - width;
      let shift = 0;
      if (align === "center" || align === "-webkit-center") shift = free / 2;
      else if (align === "right" || align === "end") shift = free;
      else if (align === "justify" && li !== lastLine) shift = 0;
      const baseline = cy + ascent;
      // inline elements open across the line: their rects
      const open = new Map<Box, number>();
      for (const it of l) {
        const p = it.piece;
        const px = x + shift + it.x;
        if (p.kind === "open" && p.box !== null) open.set(p.box, px);
        else if (p.kind === "close" && p.box !== null) {
          const start = open.get(p.box) ?? x + shift;
          open.delete(p.box);
          addInlineRect(p.box, start, px + it.w, baseline);
        } else if (p.kind === "text") {
          if (p.text === " " && it === l[l.length - 1]) continue;
          const f = fontOf(p.style);
          const face = p.face ?? f.face;
          const y = baseline - p.style.fontSize;   // Bloom draws the baseline at y + size
          // runs of the same style and face on a line are one fragment: fewer draws, and spacing the font's own
          const prev = box.fragments[box.fragments.length - 1];
          if (prev !== undefined && prev.style === p.style && prev.face === face && Math.abs(prev.y - y) < 0.01 && Math.abs(prev.x + prev.w - px) < 0.5) {
            prev.text += p.text;
            prev.w += it.w;
          } else box.fragments.push({ text: p.text, x: px, y, w: it.w, style: p.style, face, size: f.size, spacing: f.spacing });
        } else if (p.kind === "atomic" && p.box !== null) {
          const b = p.box;
          if (b.outOfFlow) { b.staticX = px; b.staticY = cy; continue; }
          const va = b.style.get("vertical-align");
          const top = va === "middle" ? baseline - s.fontSize * 0.3 - (b.h + b.margin.t + b.margin.b) / 2 : va === "top" ? cy : baseline - (b.h + b.margin.t + b.margin.b);
          shiftBox(b, px + b.margin.l - b.x, top + b.margin.t - b.y);
        }
      }
      // elements still open at the line's end continue on the next line
      for (const [b, start] of open) addInlineRect(b, start, x + shift + (l.length > 0 ? (l[l.length - 1] as LineItem).x + (l[l.length - 1] as LineItem).w : 0), baseline);
      if (open.size > 0) for (const b of open.keys()) {
        // re-open at the next line's start
        const nextLine = lines[li + 1];
        if (nextLine !== undefined) nextLine.unshift({ piece: { kind: "open", text: "", style: b.style, box: b, w: 0 }, x: 0, w: 0 });
      }
    }
    cy += lineH;
  });
  return { h: cy - y, maxLine, minWord };
}

function addInlineRect(b: Box, x0: number, x1: number, baseline: number): void {
  const s = b.style;
  const pad = edges(s, "padding-", "", 0), bd = borderEdges(s);
  // the content area is the font's ascent and descent around the baseline
  const f = fontOf(s).face;
  const top = baseline - f.ascent * s.fontSize - pad.t - bd.t;
  const h = (f.ascent + f.descent) * s.fontSize + pad.t + pad.b + bd.t + bd.b;
  const m = edges(s, "margin-", "", 0);
  b.inlineRects.push({ x: x0 + m.l, y: top, w: Math.max(0, x1 - x0 - m.l - m.r), h });
  if (b.inlineRects.length === 1) { b.x = x0; b.y = top; b.w = x1 - x0; b.h = h; }
  else {
    const minX = Math.min(b.x, x0), minY = Math.min(b.y, top), maxX = Math.max(b.x + b.w, x1), maxY = Math.max(b.y + b.h, top + h);
    b.x = minX; b.y = minY; b.w = maxX - minX; b.h = maxY - minY;
  }
  b.padding = pad; b.border = bd; b.margin = m;
}

/** Move a laid-out box and everything in it. */
export function shiftBox(b: Box, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  b.x += dx; b.y += dy;
  b.staticX += dx; b.staticY += dy;
  for (const f of b.fragments) { f.x += dx; f.y += dy; }
  for (const r of b.inlineRects) { r.x += dx; r.y += dy; }
  for (const c of b.children) if (!(c.outOfFlow && c.position === "fixed")) shiftBox(c, dx, dy);
}

// ---------------------------------------------------------------- intrinsic sizes

const intrinsicCache = new Map<Box, { min: number; max: number }>();
export function clearIntrinsic(): void { intrinsicCache.clear(); }

function specifiedWidth(b: Box): number {
  const w = len(b.style, "width", NaN);
  if (!Number.isFinite(w)) return NaN;
  const pb = horizontalPB(b);
  return b.style.get("box-sizing") === "border-box" ? Math.max(w, pb) : w + pb;
}

function horizontalPB(b: Box): number {
  const pad = edges(b.style, "padding-", "", 0), bd = borderEdges(b.style);
  return pad.l + pad.r + bd.l + bd.r;
}

function intrinsic(b: Box): { min: number; max: number } {
  const hit = intrinsicCache.get(b);
  if (hit !== undefined) return hit;
  let min = 0, max = 0;
  const fixed = specifiedWidth(b);
  if (b.kind === "replaced") {
    const n = b.el !== null ? ENV.natural(b.el) : null;
    const w = Number.isFinite(fixed) ? fixed : (n?.w ?? 300) + horizontalPB(b);
    min = max = w;
  } else if (Number.isFinite(fixed)) {
    min = max = fixed;
  } else {
    const pb = horizontalPB(b);
    const inflow = b.children.filter((c) => !c.outOfFlow);
    const d = b.display;
    const gap = lenOr(b.style, "column-gap", 0, 0);
    if (d === "flex") {
      const row = !b.style.get("flex-direction").startsWith("column");
      const wrap = b.style.get("flex-wrap") !== "nowrap";
      const sizes = inflow.map((c) => { const i = intrinsic(c); const m = edges(c.style, "margin-", "", 0); return { min: i.min + m.l + m.r, max: i.max + m.l + m.r }; });
      if (row) {
        max = sizes.reduce((n, x) => n + x.max, 0) + gap * Math.max(0, sizes.length - 1);
        min = wrap ? Math.max(0, ...sizes.map((x) => x.min)) : sizes.reduce((n, x) => n + x.min, 0) + gap * Math.max(0, sizes.length - 1);
      } else {
        max = Math.max(0, ...sizes.map((x) => x.max));
        min = Math.max(0, ...sizes.map((x) => x.min));
      }
    } else if (d === "grid") {
      const cols = Math.max(1, columnCountGuess(b));
      const sizes = inflow.map((c) => intrinsic(c));
      const colMax = Math.max(0, ...sizes.map((x) => x.max)), colMin = Math.max(0, ...sizes.map((x) => x.min));
      const n = Math.min(cols, Math.max(1, sizes.length));
      max = colMax * n + gap * (n - 1);
      min = colMin * n + gap * (n - 1);
    } else if (inflow.some((c) => c.isInlineLevel)) {
      const r = layoutInline(b, 0, 0, Infinity, true);
      max = r.maxLine;
      min = r.minWord;
    } else {
      for (const c of inflow) {
        const i = intrinsic(c);
        const m = edges(c.style, "margin-", "", 0);
        max = Math.max(max, i.max + m.l + m.r);
        min = Math.max(min, i.min + m.l + m.r);
      }
    }
    max += pb; min += pb;
    const minW = len(b.style, "min-width", NaN), maxW = len(b.style, "max-width", NaN);
    if (Number.isFinite(minW)) { max = Math.max(max, minW); min = Math.max(min, minW); }
    if (Number.isFinite(maxW)) { max = Math.min(max, maxW + pb); min = Math.min(min, maxW + pb); }
  }
  const r = { min, max: Math.max(min, max) };
  intrinsicCache.set(b, r);
  return r;
}
export function maxContent(b: Box): number { return intrinsic(b).max; }
export function minContent(b: Box): number { return intrinsic(b).min; }

function columnCountGuess(b: Box): number {
  const t = b.style.get("grid-template-columns");
  if (t === "none" || t === "") return 1;
  return expandTracks(t, 0, 0, b.style).length;
}

// ---------------------------------------------------------------- block layout

/**
 * Lay out a box at (x, y) (its margin edge) in a containing block `cbW` wide (and `cbH` tall when
 * definite, else NaN). `shrink` sizes an auto width to fit its content (inline-blocks, floats,
 * absolute boxes, flex items).
 */
export function layoutBox(b: Box, cbW: number, cbH: number, x: number, y: number, shrink = false, forcedW = NaN, forcedH = NaN): void {
  const s = b.style;
  b.fragments = [];
  b.inlineRects = [];
  b.margin = edges(s, "margin-", "", cbW);
  b.padding = edges(s, "padding-", "", cbW);
  b.border = borderEdges(s);
  const pb = b.padding.l + b.padding.r + b.border.l + b.border.r;
  const pbv = b.padding.t + b.padding.b + b.border.t + b.border.b;
  const borderBox = s.get("box-sizing") === "border-box";
  const autoL = s.get("margin-left") === "auto", autoR = s.get("margin-right") === "auto";

  // width (border box)
  let w: number;
  const specW = len(s, "width", cbW);
  if (Number.isFinite(forcedW)) w = forcedW;
  else if (Number.isFinite(specW)) w = borderBox ? Math.max(specW, pb) : specW + pb;
  else if (b.kind === "replaced") {
    const n = b.el !== null ? ENV.natural(b.el) : null;
    const specH = len(s, "height", cbH);
    w = (n === null ? 300 : Number.isFinite(specH) && n.h > 0 ? (specH * n.w) / n.h : n.w) + pb;
  } else if (shrink) {
    const avail = cbW - b.margin.l - b.margin.r;
    const i = intrinsic(b);
    w = Math.min(Math.max(i.min, avail), i.max);
  } else w = cbW - b.margin.l - b.margin.r;
  const minW = len(s, "min-width", cbW), maxW = len(s, "max-width", cbW);
  if (Number.isFinite(maxW)) w = Math.min(w, borderBox ? maxW : maxW + pb);
  if (Number.isFinite(minW)) w = Math.max(w, borderBox ? minW : minW + pb);
  w = Math.max(w, pb);

  // auto horizontal margins center a block in normal flow
  if (!shrink && !b.outOfFlow && Number.isFinite(cbW) && b.isBlockLevel) {
    const free = cbW - w - (autoL ? 0 : b.margin.l) - (autoR ? 0 : b.margin.r);
    if (autoL && autoR) { b.margin = { ...b.margin, l: Math.max(0, free / 2), r: Math.max(0, free / 2) }; }
    else if (autoL) b.margin = { ...b.margin, l: Math.max(0, free) };
  }

  b.x = x + b.margin.l;
  b.y = y + b.margin.t;
  b.w = w;
  const cx = b.x + b.border.l + b.padding.l, cy = b.y + b.border.t + b.padding.t;
  const cw = w - pb;

  // height, if definite
  const specH = len(s, "height", cbH);
  let fixedH = Number.isFinite(forcedH) ? forcedH : Number.isFinite(specH) ? (borderBox ? Math.max(specH, pbv) : specH + pbv) : NaN;
  const minH = len(s, "min-height", cbH), maxH = len(s, "max-height", cbH);
  if (Number.isFinite(fixedH)) {
    if (Number.isFinite(maxH)) fixedH = Math.min(fixedH, borderBox ? maxH : maxH + pbv);
    if (Number.isFinite(minH)) fixedH = Math.max(fixedH, borderBox ? minH : minH + pbv);
  }
  const contentCbH = Number.isFinite(fixedH) ? fixedH - pbv : NaN;

  let contentH = 0;
  if (b.kind === "replaced") {
    const n = b.el !== null ? ENV.natural(b.el) : null;
    contentH = n === null || n.w === 0 ? 150 : (cw * n.h) / n.w;
  } else {
    const d = b.display;
    if (d === "flex") contentH = layoutFlex(b, cx, cy, cw, contentCbH);
    else if (d === "grid") contentH = layoutGrid(b, cx, cy, cw, contentCbH);
    else contentH = layoutFlow(b, cx, cy, cw, contentCbH);
  }
  b.contentH = contentH;
  // A scroll container scrolls as far as its children reach: a grid or flex container of a fixed
  // height reports that height as its content, though an item may be taller.
  const oy = s.get("overflow-y");
  if (oy === "auto" || oy === "scroll") {
    let bottom = cy + contentH;
    for (const c of b.children) if (!c.outOfFlow) bottom = Math.max(bottom, c.y + c.h + c.margin.b);
    b.contentH = Math.max(contentH, bottom - cy);
  }
  let h = Number.isFinite(fixedH) ? fixedH : contentH + pbv;
  if (!Number.isFinite(fixedH)) {
    if (Number.isFinite(maxH)) h = Math.min(h, borderBox ? maxH : maxH + pbv);
    if (Number.isFinite(minH)) h = Math.max(h, borderBox ? minH : minH + pbv);
  }
  b.h = Math.max(h, pbv);
  // content that shrank (another screen in the same scroll box) pulls the scroll position back, as in a browser
  if ((oy === "auto" || oy === "scroll") && b.el !== null && b.el.scrollTop > 0) {
    const max = Math.max(0, b.contentH - (b.h - pbv));
    if (b.el.scrollTop > max) b.el.scrollTop = max;
  }

  // relative positioning
  if (b.position === "relative" || b.position === "sticky") {
    const l = len(s, "left", cbW), r = len(s, "right", cbW), t = len(s, "top", cbH), bo = len(s, "bottom", cbH);
    const dx = Number.isFinite(l) ? l : Number.isFinite(r) ? -r : 0;
    const dy = Number.isFinite(t) ? t : Number.isFinite(bo) ? -bo : 0;
    shiftBox(b, dx, dy);
  }
}

/** Normal flow: blocks stacked (adjacent margins collapse), or the box's inline content in lines. */
function layoutFlow(b: Box, cx: number, cy: number, cw: number, ch: number): number {
  const inflow = b.children.filter((c) => !c.outOfFlow);
  if (inflow.some((c) => c.isInlineLevel)) {
    const r = layoutInline(b, cx, cy, cw, false);
    for (const c of b.children) if (c.outOfFlow && c.staticY === 0 && c.staticX === 0) { c.staticX = cx; c.staticY = cy; }
    return r.h;
  }
  let y = cy, prevMargin = 0, first = true;
  for (const c of b.children) {
    if (c.outOfFlow) { c.staticX = cx; c.staticY = y + (first ? 0 : prevMargin); continue; }
    const mt = lenOr(c.style, "margin-top", cw, 0);
    const collapsed = first ? mt : Math.max(prevMargin, mt) - prevMargin;   // the gap between siblings is the larger margin
    layoutBox(c, cw, ch, cx, y + collapsed - mt);
    y = c.y + c.h;
    prevMargin = c.margin.b;
    y += prevMargin;
    first = false;
  }
  return y - cy;
}

// ---------------------------------------------------------------- flex

function layoutFlex(b: Box, cx: number, cy: number, cw: number, ch: number): number {
  const s = b.style;
  const dir = s.get("flex-direction");
  const row = !dir.startsWith("column");
  const reverse = dir.endsWith("reverse");
  const wrap = s.get("flex-wrap") !== "nowrap";
  const mainSize = row ? cw : ch;
  const rowGap = lenOr(s, "row-gap", ch, 0), colGap = lenOr(s, "column-gap", cw, 0);
  const mainGap = row ? colGap : rowGap, crossGap = row ? rowGap : colGap;
  const items = b.children.filter((c) => !c.outOfFlow).sort((a, c) => (Number(a.style.get("order")) || 0) - (Number(c.style.get("order")) || 0));
  for (const c of b.children) if (c.outOfFlow) { c.staticX = cx; c.staticY = cy; }

  interface Item { box: Box; base: number; main: number; minMain: number; grow: number; shrink: number; marginMain: number; autoA: boolean; autoB: boolean; cross: number }
  const its: Item[] = items.map((c) => {
    const cs = c.style;
    const m = edges(cs, "margin-", "", cw);
    const basisV = cs.get("flex-basis");
    let base = NaN;
    if (basisV !== "auto" && basisV !== "content") {
      base = len(cs, "flex-basis", mainSize);
      if (Number.isFinite(base)) {
        const pbx = row ? horizontalPB(c) : verticalPB(c);
        base = cs.get("box-sizing") === "border-box" ? Math.max(base, pbx) : base + pbx;
      }
    }
    if (!Number.isFinite(base)) {
      if (row) base = Number.isFinite(specifiedWidth(c)) ? specifiedWidth(c) : maxContent(c);
      else {
        const h = len(cs, "height", ch);
        if (Number.isFinite(h)) base = cs.get("box-sizing") === "border-box" ? h : h + verticalPB(c);
        else { layoutBox(c, cw, NaN, 0, 0, true); base = c.h; }
      }
    }
    const minMain = row ? (cs.get("min-width") === "auto" ? (cs.get("overflow-x") === "visible" ? Math.min(minContent(c), base) : 0) : lenOr(cs, "min-width", cw, 0) + (cs.get("box-sizing") === "border-box" ? 0 : horizontalPB(c)))
      : (cs.get("min-height") === "auto" ? 0 : lenOr(cs, "min-height", ch, 0));
    return {
      box: c, base, main: base, minMain, grow: Number(cs.get("flex-grow")) || 0, shrink: Number(cs.get("flex-shrink")),
      marginMain: row ? (cs.get("margin-left") === "auto" ? 0 : m.l) + (cs.get("margin-right") === "auto" ? 0 : m.r) : (cs.get("margin-top") === "auto" ? 0 : m.t) + (cs.get("margin-bottom") === "auto" ? 0 : m.b),
      autoA: row ? cs.get("margin-left") === "auto" : cs.get("margin-top") === "auto",
      autoB: row ? cs.get("margin-right") === "auto" : cs.get("margin-bottom") === "auto",
      cross: 0,
    };
  });

  // lines
  const lines: Item[][] = [];
  let cur: Item[] = [], used = 0;
  for (const it of its) {
    const size = it.base + it.marginMain;
    if (wrap && cur.length > 0 && Number.isFinite(mainSize) && used + mainGap + size > mainSize + 0.01) { lines.push(cur); cur = []; used = 0; }
    used += (cur.length > 0 ? mainGap : 0) + size;
    cur.push(it);
  }
  if (cur.length > 0) lines.push(cur);

  // flexible lengths
  for (const line of lines) {
    const sum = line.reduce((n, it) => n + it.base + it.marginMain, 0) + mainGap * (line.length - 1);
    const free = Number.isFinite(mainSize) ? mainSize - sum : 0;
    if (free > 0) {
      const g = line.reduce((n, it) => n + it.grow, 0);
      for (const it of line) it.main = it.base + (g > 0 ? (free * it.grow) / g : 0);
    } else if (free < 0) {
      // shrink in proportion to shrink x base, not below the minimum (repeat once for those that hit it)
      let frozen = new Set<Item>();
      for (let pass = 0; pass < 3; pass++) {
        const active = line.filter((it) => !frozen.has(it));
        const weight = active.reduce((n, it) => n + it.shrink * it.base, 0);
        const fixed = line.filter((it) => frozen.has(it)).reduce((n, it) => n + it.main + it.marginMain, 0);
        const remaining = mainSize - mainGap * (line.length - 1) - fixed - active.reduce((n, it) => n + it.marginMain, 0);
        const over = active.reduce((n, it) => n + it.base, 0) - remaining;
        let clamped = false;
        for (const it of active) {
          it.main = weight > 0 ? it.base - (over * it.shrink * it.base) / weight : it.base;
          if (it.main < it.minMain) { it.main = it.minMain; frozen.add(it); clamped = true; }
        }
        if (!clamped) break;
      }
      frozen = new Set();
    } else for (const it of line) it.main = it.base;
    for (const it of line) {
      const c = it.box.style;
      const maxM = row ? len(c, "max-width", cw) : len(c, "max-height", ch);
      if (Number.isFinite(maxM)) it.main = Math.min(it.main, maxM + (c.get("box-sizing") === "border-box" ? 0 : row ? horizontalPB(it.box) : verticalPB(it.box)));
      it.main = Math.max(it.main, it.minMain);
    }
  }

  // cross sizes: lay out each item at its main size
  const alignItems = s.get("align-items");
  const lineCross: number[] = [];
  for (const line of lines) {
    let maxC = 0;
    for (const it of line) {
      if (row) layoutBox(it.box, cw, ch, 0, 0, false, it.main);
      else layoutBox(it.box, cw, ch, 0, 0, alignOf(it.box, alignItems) !== "stretch", NaN, it.main);
      const m = it.box.margin;
      it.cross = row ? it.box.h + m.t + m.b : it.box.w + m.l + m.r;
      maxC = Math.max(maxC, it.cross);
    }
    lineCross.push(maxC);
  }
  const crossSize = row ? ch : cw;
  if (!wrap && lines.length === 1 && Number.isFinite(crossSize)) lineCross[0] = crossSize;
  // align-content: stretch lines into a definite cross size
  const totalCross = lineCross.reduce((n, c) => n + c, 0) + crossGap * Math.max(0, lines.length - 1);
  let crossStart = 0, crossBetween = crossGap;
  if (wrap && Number.isFinite(crossSize) && lines.length > 0) {
    const free = crossSize - totalCross;
    const ac = s.get("align-content");
    if ((ac === "normal" || ac === "stretch") && free > 0) for (let i = 0; i < lineCross.length; i++) lineCross[i] = (lineCross[i] ?? 0) + free / lineCross.length;
    else if (ac === "center") crossStart = free / 2;
    else if (ac === "flex-end" || ac === "end") crossStart = free;
    else if (ac === "space-between" && lines.length > 1) crossBetween += free / (lines.length - 1);
    else if (ac === "space-around") { crossStart = free / lines.length / 2; crossBetween += free / lines.length; }
  }

  // place
  const justify = s.get("justify-content");
  let crossPos = crossStart;
  lines.forEach((line, li) => {
    const lc = lineCross[li] ?? 0;
    const used = line.reduce((n, it) => n + it.main + it.marginMain, 0) + mainGap * (line.length - 1);
    let free = Number.isFinite(mainSize) ? mainSize - used : 0;
    const autos = line.reduce((n, it) => n + (it.autoA ? 1 : 0) + (it.autoB ? 1 : 0), 0);
    let start = 0, between = mainGap, autoSize = 0;
    if (autos > 0 && free > 0) { autoSize = free / autos; free = 0; }
    if (free > 0 || (free < 0 && (justify === "center" || justify === "flex-end" || justify === "end"))) {
      switch (justify) {
        case "flex-end": case "end": case "right": start = free; break;
        case "center": start = free / 2; break;
        case "space-between": if (line.length > 1) between += free / (line.length - 1); else start = 0; break;
        case "space-around": start = free / line.length / 2; between += free / line.length; break;
        case "space-evenly": start = free / (line.length + 1); between += free / (line.length + 1); break;
      }
    }
    const order = reverse ? [...line].reverse() : line;
    let pos = reverse && Number.isFinite(mainSize) ? 0 : 0;
    pos = start;
    for (const it of order) {
      const box = it.box;
      const m = edges(box.style, "margin-", "", cw);
      const a = it.autoA ? autoSize : row ? m.l : m.t;
      const bm = it.autoB ? autoSize : row ? m.r : m.b;
      const align = alignOf(box, alignItems);
      // stretch: the item's cross size becomes the line's (when its own is auto)
      const crossAuto = row ? box.style.get("height") === "auto" : box.style.get("width") === "auto";
      const cm = row ? m.t + m.b : m.l + m.r;
      if (align === "stretch" && crossAuto) {
        const target = lc - cm;
        if (row) layoutBox(box, cw, ch, 0, 0, false, it.main, target);
        else layoutBox(box, cw, ch, 0, 0, false, target, it.main);
      }
      const itemCross = row ? box.h + cm : box.w + cm;
      let off = 0;
      if (align === "center") off = (lc - itemCross) / 2;
      else if (align === "flex-end" || align === "end" || align === "self-end") off = lc - itemCross;
      const mainOff = pos + a;
      const tx = row ? cx + mainOff : cx + crossPos + off + m.l;
      const ty = row ? cy + crossPos + off + m.t : cy + mainOff;
      shiftBox(box, tx - box.x, ty - box.y);
      pos += a + it.main + bm + between;
    }
    crossPos += lc + crossBetween;
  });
  if (row) return Number.isFinite(ch) ? ch : totalCross + (wrap ? 0 : 0);
  const usedMain = Math.max(0, ...lines.map((line) => line.reduce((n, it) => n + it.main + it.marginMain, 0) + mainGap * (line.length - 1)));
  return Number.isFinite(ch) ? ch : usedMain;
}

function alignOf(box: Box, alignItems: string): string {
  const self = box.style.get("align-self");
  const a = self === "auto" ? alignItems : self;
  return a === "normal" ? "stretch" : a.replace(/^(safe|unsafe) /, "").replace("flex-start", "start").replace("self-start", "start").replace("baseline", "start").replace("first baseline", "start");
}

function verticalPB(b: Box): number {
  const pad = edges(b.style, "padding-", "", 0), bd = borderEdges(b.style);
  return pad.t + pad.b + bd.t + bd.b;
}

// ---------------------------------------------------------------- grid

interface Track { min: string; max: string }

/** A track list with repeat() expanded (auto-fill/auto-fit counted against `avail`). */
function expandTracks(list: string, avail: number, gap: number, s: Computed): Track[] {
  const out: Track[] = [];
  const track = (t: string): Track => {
    const mm = /^minmax\((.*)\)$/.exec(t);
    if (mm !== null) { const [a, b] = split(mm[1] ?? "", true); return { min: a ?? "auto", max: b ?? "auto" }; }
    const fc = /^fit-content\((.*)\)$/.exec(t);
    if (fc !== null) return { min: "auto", max: fc[1] ?? "auto" };
    return { min: t, max: t };
  };
  for (const part of split(list.replace(/\[[^\]]*\]/g, " "))) {
    const rep = /^repeat\((.*)\)$/.exec(part);
    if (rep === null) { out.push(track(part)); continue; }
    const args = rep[1] ?? "";
    const comma = args.indexOf(",");
    const countS = args.slice(0, comma).trim(), inner = split(args.slice(comma + 1).trim()).map(track);
    let count = parseInt(countS, 10);
    if (countS === "auto-fill" || countS === "auto-fit") {
      // as many as fit, sized by each track's minimum (or its maximum when that is fixed)
      const size = (t: Track): number => { const a = length(t.min, lc(s, avail)); const b = length(t.max, lc(s, avail)); return Number.isFinite(a) && a > 0 ? a : Number.isFinite(b) ? b : 0; };
      const one = inner.reduce((n, t) => n + size(t), 0) + gap * (inner.length - 1);
      count = one > 0 && Number.isFinite(avail) ? Math.max(1, Math.floor((avail + gap) / (one + gap))) : 1;
    }
    for (let i = 0; i < (Number.isFinite(count) ? count : 1); i++) out.push(...inner);
  }
  return out;
}

/** Sizes for tracks in `avail`: fixed and percentage tracks, then auto by content, then fr by the rest. */
function sizeTracks(tracks: Track[], avail: number, gap: number, s: Computed, content: (i: number) => { min: number; max: number }): number[] {
  const n = tracks.length;
  const sizes = new Array<number>(n).fill(0);
  const isFr = (v: string): boolean => /fr$/.test(v.trim());
  let fr = 0;
  for (let i = 0; i < n; i++) {
    const t = tracks[i] as Track;
    const fixedMax = length(t.max, lc(s, avail));
    const fixedMin = length(t.min, lc(s, avail));
    if (isFr(t.max)) { fr += parseFloat(t.max); sizes[i] = Number.isFinite(fixedMin) ? fixedMin : t.min === "auto" ? content(i).min : 0; }
    else if (Number.isFinite(fixedMax)) sizes[i] = Math.max(fixedMax, Number.isFinite(fixedMin) ? fixedMin : 0);
    else {
      const c = content(i);
      sizes[i] = t.max === "min-content" ? c.min : c.max;
      if (Number.isFinite(fixedMin)) sizes[i] = Math.max(sizes[i] ?? 0, fixedMin);
    }
  }
  const total = (): number => sizes.reduce((a, b) => a + b, 0) + gap * Math.max(0, n - 1);
  if (fr > 0 && Number.isFinite(avail)) {
    // fr tracks share what fixed and auto tracks leave, never below their minimum
    let free = avail - gap * Math.max(0, n - 1);
    for (let i = 0; i < n; i++) if (!isFr((tracks[i] as Track).max)) free -= sizes[i] ?? 0;
    const unit = Math.max(0, free) / fr;
    for (let i = 0; i < n; i++) {
      const t = tracks[i] as Track;
      if (isFr(t.max)) sizes[i] = Math.max(sizes[i] ?? 0, unit * parseFloat(t.max));
    }
  } else if (fr === 0 && Number.isFinite(avail) && total() < avail) {
    // auto tracks stretch into free space
    const autos = tracks.map((t, i) => (t.max === "auto" ? i : -1)).filter((i) => i >= 0);
    const free = avail - total();
    for (const i of autos) sizes[i] = (sizes[i] ?? 0) + free / autos.length;
  }
  return sizes;
}

function layoutGrid(b: Box, cx: number, cy: number, cw: number, ch: number): number {
  const s = b.style;
  const colGap = lenOr(s, "column-gap", cw, 0), rowGap = lenOr(s, "row-gap", ch, 0);
  const items = b.children.filter((c) => !c.outOfFlow);
  for (const c of b.children) if (c.outOfFlow) { c.staticX = cx; c.staticY = cy; }
  const tc = s.get("grid-template-columns");
  const cols = tc === "none" || tc === "" ? [{ min: "auto", max: "1fr" }] : expandTracks(tc, cw, colGap, s);
  const nCols = Math.max(1, cols.length);

  // auto placement (row-major), with spans
  interface Cell { box: Box; row: number; col: number; span: number; rowSpan: number }
  const cells: Cell[] = [];
  const taken = new Set<string>();
  let r = 0, c = 0;
  const spanOf = (box: Box, axis: string): number => {
    const end = box.style.get(`grid-${axis}-end`), start = box.style.get(`grid-${axis}-start`);
    const m = /span\s+(\d+)/.exec(end) ?? /span\s+(\d+)/.exec(start);
    if (m !== null) return Math.max(1, parseInt(m[1] ?? "1", 10));
    const a = parseInt(start, 10), e = parseInt(end, 10);
    if (Number.isFinite(a) && Number.isFinite(e)) return Math.max(1, e - a);
    if (end === "-1" && Number.isFinite(a)) return Math.max(1, nCols + 1 - a);
    return 1;
  };
  for (const box of items) {
    const span = Math.min(nCols, spanOf(box, "column")), rowSpan = spanOf(box, "row");
    const startCol = parseInt(box.style.get("grid-column-start"), 10);
    if (Number.isFinite(startCol) && startCol > 0) { if (startCol - 1 < c) r++; c = startCol - 1; }
    for (;;) {
      if (c + span > nCols) { c = 0; r++; continue; }
      let free = true;
      for (let k = 0; k < span && free; k++) for (let q = 0; q < rowSpan && free; q++) if (taken.has(`${r + q},${c + k}`)) free = false;
      if (free) break;
      c++;
    }
    cells.push({ box, row: r, col: c, span, rowSpan });
    for (let k = 0; k < span; k++) for (let q = 0; q < rowSpan; q++) taken.add(`${r + q},${c + k}`);
    c += span;
  }
  const nRows = cells.reduce((n, x) => Math.max(n, x.row + x.rowSpan), 0);

  const colSizes = sizeTracks(cols, cw, colGap, s, (i) => {
    let min = 0, max = 0;
    for (const x of cells) if (x.col === i && x.span === 1) { const m = edges(x.box.style, "margin-", "", 0); min = Math.max(min, minContent(x.box) + m.l + m.r); max = Math.max(max, maxContent(x.box) + m.l + m.r); }
    return { min, max };
  });
  const colX: number[] = [];
  let acc = 0;
  for (let i = 0; i < nCols; i++) { colX.push(acc); acc += (colSizes[i] ?? 0) + colGap; }
  const width = (x: Cell): number => colSizes.slice(x.col, x.col + x.span).reduce((n, v) => n + v, 0) + colGap * (x.span - 1);

  // lay items out at their column width, then size rows
  const justifyItems = s.get("justify-items");
  for (const x of cells) {
    const js = x.box.style.get("justify-self") === "auto" ? justifyItems : x.box.style.get("justify-self");
    const stretch = (js === "normal" || js === "stretch" || js === "legacy") && x.box.kind !== "replaced";
    layoutBox(x.box, width(x), NaN, 0, 0, !stretch);
  }
  const tr = s.get("grid-template-rows");
  const rowTracks = tr === "none" || tr === "" ? [] : expandTracks(tr, ch, rowGap, s);
  const autoRow = s.get("grid-auto-rows");
  const rowsList: Track[] = [];
  for (let i = 0; i < nRows; i++) rowsList.push(rowTracks[i] ?? { min: autoRow, max: autoRow });
  const rowSizes = sizeTracks(rowsList, ch, rowGap, s, (i) => {
    let h = 0;
    for (const x of cells) if (x.row === i && x.rowSpan === 1) h = Math.max(h, x.box.h + x.box.margin.t + x.box.margin.b);
    return { min: h, max: h };
  });
  // align-content normal stretches auto rows into a definite height (sizeTracks did it for "auto")
  const rowY: number[] = [];
  acc = 0;
  for (let i = 0; i < nRows; i++) { rowY.push(acc); acc += (rowSizes[i] ?? 0) + rowGap; }
  const height = nRows === 0 ? 0 : acc - rowGap;

  const alignItems = s.get("align-items");
  for (const x of cells) {
    const box = x.box;
    const m = box.margin;
    const cellW = width(x), cellH = rowSizes.slice(x.row, x.row + x.rowSpan).reduce((n, v) => n + v, 0) + rowGap * (x.rowSpan - 1);
    const js = (box.style.get("justify-self") === "auto" ? justifyItems : box.style.get("justify-self")).replace("self-", "");
    const as = alignOf(box, alignItems);
    if (as === "stretch" && box.style.get("height") === "auto" && box.kind !== "replaced") layoutBox(box, cellW, NaN, 0, 0, !(js === "normal" || js === "stretch" || js === "legacy"), NaN, cellH - m.t - m.b);
    let ox = 0, oy = 0;
    const bw = box.w + m.l + m.r, bh = box.h + m.t + m.b;
    if (js === "center") ox = (cellW - bw) / 2; else if (js === "end" || js === "right" || js === "flex-end") ox = cellW - bw;
    if (as === "center") oy = (cellH - bh) / 2; else if (as === "end" || as === "flex-end" || as === "self-end") oy = cellH - bh;
    shiftBox(box, cx + (colX[x.col] ?? 0) + ox + m.l - box.x, cy + (rowY[x.row] ?? 0) + oy + m.t - box.y);
  }
  return Number.isFinite(ch) ? ch : height;
}

// ---------------------------------------------------------------- positioned boxes

/** Lay out absolute and fixed boxes, after the normal flow: each against its containing block. */
function layoutPositioned(root: Box, viewport: { w: number; h: number }): void {
  const visit = (b: Box, cb: Box | null): void => {
    for (const c of b.children) {
      if (c.outOfFlow) placeOutOfFlow(c, c.position === "fixed" ? null : cb, viewport);
      const nextCb = c.position !== "static" ? c : cb;
      visit(c, nextCb);
    }
  };
  visit(root, null);
}

function placeOutOfFlow(b: Box, cb: Box | null, viewport: { w: number; h: number }): void {
  const s = b.style;
  // the containing block's padding box (the viewport for fixed boxes and the root)
  const area = cb === null ? { x: 0, y: 0, w: viewport.w, h: viewport.h }
    : { x: cb.x + cb.border.l, y: cb.y + cb.border.t, w: cb.w - cb.border.l - cb.border.r, h: cb.h - cb.border.t - cb.border.b };
  const L = len(s, "left", area.w), R = len(s, "right", area.w), T = len(s, "top", area.h), B = len(s, "bottom", area.h);
  const m = edges(s, "margin-", "", area.w);
  // width: from both insets when width is auto, else shrink-to-fit
  let forcedW = NaN, forcedH = NaN;
  const autoW = !Number.isFinite(len(s, "width", area.w));
  const autoH = !Number.isFinite(len(s, "height", area.h));
  if (autoW && Number.isFinite(L) && Number.isFinite(R)) forcedW = Math.max(0, area.w - L - R - m.l - m.r);
  if (autoH && Number.isFinite(T) && Number.isFinite(B)) forcedH = Math.max(0, area.h - T - B - m.t - m.b);
  const availW = Number.isFinite(L) ? area.w - L - (Number.isFinite(R) ? R : 0) : area.w;
  layoutBox(b, Number.isFinite(forcedW) ? area.w : availW, area.h, 0, 0, true, forcedW, forcedH);
  const ww = b.w + b.margin.l + b.margin.r, hh = b.h + b.margin.t + b.margin.b;
  const autoML = s.get("margin-left") === "auto" && s.get("margin-right") === "auto" && Number.isFinite(L) && Number.isFinite(R);
  let x = Number.isFinite(L) ? area.x + L + (autoML ? (area.w - L - R - b.w) / 2 - b.margin.l : 0) : Number.isFinite(R) ? area.x + area.w - R - ww : b.staticX;
  let y = Number.isFinite(T) ? area.y + T : Number.isFinite(B) ? area.y + area.h - B - hh : b.staticY;
  const autoMT = s.get("margin-top") === "auto" && s.get("margin-bottom") === "auto" && Number.isFinite(T) && Number.isFinite(B);
  if (autoMT) y += (area.h - T - B - b.h) / 2 - b.margin.t;
  if (!Number.isFinite(x)) x = area.x;
  if (!Number.isFinite(y)) y = area.y;
  shiftBox(b, x + b.margin.l - b.x, y + b.margin.t - b.y);
}

// ---------------------------------------------------------------- entry

/** Lay out the whole page in a viewport. */
export function layoutPage(root: Box, env: LayoutEnv): void {
  ENV = env;
  clearIntrinsic();
  layoutBox(root, env.vw, env.vh, 0, 0);
  layoutPositioned(root, { w: env.vw, h: env.vh });
}

export function textNodeOf(n: Node): n is Text { return n.nodeType === 3; }
