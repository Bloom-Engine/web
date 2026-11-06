/**
 * Stylesheets: parsing CSS text into style rules (one per selector of a
 * list, with its specificity), @media and @supports blocks (kept with their
 * condition), @keyframes, @font-face, @layer (flattened); and expanding
 * shorthand properties into longhands.
 */
import { parseDeclarations } from "../dom/tokens.ts";
import { specificity } from "../dom/selectors.ts";
import { parseColor, split } from "./values.ts";

export interface Declaration { name: string; value: string; important: boolean }

export interface StyleRule {
  selector: string;
  specificity: [number, number, number];
  declarations: Declaration[];
  /** The @media condition it sits in ("" for none) */
  media: string;
  order: number;
  /** 0: the user agent's stylesheet, 1: the page's */
  origin: number;
}

export interface Keyframe { offset: number; declarations: Declaration[] }

export interface FontFace { family: string; src: string; weight: string; style: string }

export interface Sheet { rules: StyleRule[]; keyframes: Map<string, Keyframe[]>; fonts: FontFace[] }

let order = 0;

/** Split a selector list at top-level commas. */
function selectors(list: string): string[] {
  return split(list, true);
}

/** Read the block at `i` (just after "{"): its text and where it ends. */
function block(css: string, i: number): { body: string; end: number } {
  let depth = 1, quote = "";
  const start = i;
  for (; i < css.length; i++) {
    const c = css.charAt(i);
    if (quote !== "") { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === "\"" || c === "'") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return { body: css.slice(start, i), end: i + 1 };
  }
  return { body: css.slice(start), end: css.length };
}

function declarations(text: string): Declaration[] {
  const out: Declaration[] = [];
  for (const [name, value, important] of parseDeclarations(text)) for (const [n, v] of expand(name, value)) out.push({ name: n, value: v, important });
  return out;
}

function parseInto(css: string, sheet: Sheet, media: string): void {
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    const semi = css.indexOf(";", i);
    if (open < 0) break;
    // an at-rule without a block (@import, @charset, @layer a, b;)
    if (semi >= 0 && semi < open && css.slice(i, semi).trim().startsWith("@")) { i = semi + 1; continue; }
    const prelude = css.slice(i, open).trim();
    const { body, end } = block(css, open + 1);
    i = end;
    if (prelude.startsWith("@")) {
      const at = /^@([-a-z]+)\s*(.*)$/s.exec(prelude);
      const name = (at?.[1] ?? "").toLowerCase(), cond = (at?.[2] ?? "").trim();
      if (name === "media") parseInto(body, sheet, media === "" ? cond : media + " and " + cond);
      else if (name === "supports" || name === "layer" || name === "container" || name === "scope" || name === "document") parseInto(body, sheet, media);
      else if (name === "keyframes" || name === "-webkit-keyframes") sheet.keyframes.set(cond.replace(/["']/g, ""), keyframes(body));
      else if (name === "font-face") {
        const d = parseDeclarations(body);
        const get = (k: string): string => d.find((x) => x[0] === k)?.[1] ?? "";
        sheet.fonts.push({ family: get("font-family").replace(/["']/g, "").trim(), src: get("src"), weight: get("font-weight") || "400", style: get("font-style") || "normal" });
      }
      continue;
    }
    if (prelude === "") continue;
    const decls = declarations(body);
    for (const sel of selectors(prelude)) {
      let spec: [number, number, number];
      try { spec = specificity(sel); } catch { continue; }   // a selector this engine can't parse is skipped, as browsers skip invalid ones
      sheet.rules.push({ selector: sel, specificity: spec, declarations: decls, media, order: order++, origin: 1 });
    }
  }
}

function keyframes(body: string): Keyframe[] {
  const frames: Keyframe[] = [];
  let i = 0;
  while (i < body.length) {
    const open = body.indexOf("{", i);
    if (open < 0) break;
    const sel = body.slice(i, open).trim();
    const { body: inner, end } = block(body, open + 1);
    i = end;
    const decls = declarations(inner);
    for (const s of sel.split(",")) {
      const t = s.trim().toLowerCase();
      const offset = t === "from" ? 0 : t === "to" ? 1 : parseFloat(t) / 100;
      if (Number.isFinite(offset)) frames.push({ offset, declarations: decls });
    }
  }
  return frames.sort((a, b) => a.offset - b.offset);
}

export function parseSheet(css: string, origin = 1): Sheet {
  const sheet: Sheet = { rules: [], keyframes: new Map(), fonts: [] };
  parseInto(css.replace(/\/\*[\s\S]*?\*\//g, ""), sheet, "");
  for (const r of sheet.rules) r.origin = origin;
  return sheet;
}

/** Declarations of a style attribute. */
export function inlineDeclarations(text: string): Declaration[] { return declarations(text); }

// ---------------------------------------------------------------- shorthands

const SIDES = ["top", "right", "bottom", "left"];

/** 1-4 values over top, right, bottom, left. */
function boxSides(prefix: string, suffix: string, value: string): [string, string][] {
  const v = split(value);
  const t = v[0] ?? "0", r = v[1] ?? t, b = v[2] ?? t, l = v[3] ?? r;
  return [[`${prefix}top${suffix}`, t], [`${prefix}right${suffix}`, r], [`${prefix}bottom${suffix}`, b], [`${prefix}left${suffix}`, l]];
}

const BORDER_STYLES = new Set(["none", "hidden", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset"]);

/** A border shorthand's width, style and color. */
function borderParts(value: string): { width: string; style: string; color: string } {
  let width = "medium", style = "none", color = "currentcolor";
  for (const p of split(value)) {
    if (BORDER_STYLES.has(p.toLowerCase())) style = p;
    else if (parseColor(p) !== null) color = p;
    else width = p;
  }
  return { width, style, color };
}

const WIDE = new Set(["inherit", "initial", "unset", "revert"]);

/** A property and value as the longhands it sets (a longhand comes back alone). */
export function expand(name: string, value: string): [string, string][] {
  const v = value.trim();
  // var() in a shorthand resolves later: kept whole for the cascade to expand after substitution
  if (v.includes("var(") && SHORTHANDS.has(name)) return [[name, v]];
  // inherit, initial, unset on a shorthand apply to every longhand
  if (WIDE.has(v.toLowerCase()) && SHORTHANDS.has(name)) return longhands(name).map((n): [string, string] => [n, v]);
  switch (name) {
    case "margin": case "padding": return boxSides(name + "-", "", v);
    case "inset": return boxSides("", "", v);
    case "border-width": return boxSides("border-", "-width", v);
    case "border-style": return boxSides("border-", "-style", v);
    case "border-color": return boxSides("border-", "-color", v);
    case "border": {
      const p = borderParts(v);
      return SIDES.flatMap((s): [string, string][] => [[`border-${s}-width`, p.width], [`border-${s}-style`, p.style], [`border-${s}-color`, p.color]]);
    }
    case "border-top": case "border-right": case "border-bottom": case "border-left": {
      const p = borderParts(v);
      return [[`${name}-width`, p.width], [`${name}-style`, p.style], [`${name}-color`, p.color]];
    }
    case "border-radius": {
      const [h] = v.split("/");
      const r = split(h ?? "");
      const tl = r[0] ?? "0", tr = r[1] ?? tl, br = r[2] ?? tl, bl = r[3] ?? tr;
      return [["border-top-left-radius", tl], ["border-top-right-radius", tr], ["border-bottom-right-radius", br], ["border-bottom-left-radius", bl]];
    }
    case "outline": {
      const p = borderParts(v);
      return [["outline-width", p.width], ["outline-style", p.style], ["outline-color", p.color]];
    }
    case "background": {
      if (v === "none") return [["background-color", "transparent"], ["background-image", "none"]];
      const layers = split(v, true);
      const last = layers[layers.length - 1] ?? "";
      let color = "transparent";
      const images: string[] = [];
      for (const layer of layers) {
        const parts = split(layer);
        const img = parts.filter((p) => /^(url|linear-gradient|radial-gradient|repeating-linear-gradient|repeating-radial-gradient|conic-gradient)\(/i.test(p));
        images.push(img[0] ?? "none");
        if (layer === last) for (const p of parts) if (parseColor(p) !== null) color = p;
      }
      const out: [string, string][] = [["background-color", color], ["background-image", images.every((x) => x === "none") ? "none" : images.join(", ")]];
      const size = /\/\s*([^\s,]+(?:\s+[^\s,]+)?)/.exec(last);
      if (size !== null) out.push(["background-size", size[1] ?? "auto"]);
      return out;
    }
    case "font": {
      // [style] [variant] [weight] size[/line-height] family
      const parts = split(v);
      const sizeAt = parts.findIndex((p) => /^[\d.]+(px|em|rem|%|pt|vw|vh)?(\/.+)?$/.test(p) || /^(x?x-)?(small|medium|large)(\/.+)?$|^(smaller|larger)(\/.+)?$/.test(p) || p.startsWith("calc("));
      if (sizeAt < 0) return [["font-family", v]];
      const out: [string, string][] = [["font-style", "normal"], ["font-weight", "400"], ["line-height", "normal"]];
      for (const p of parts.slice(0, sizeAt)) {
        if (/^(italic|oblique)$/.test(p)) out[0] = ["font-style", p];
        else if (/^(bold|bolder|lighter|normal|\d{3})$/.test(p) && p !== "normal") out[1] = ["font-weight", p];
      }
      const [size, lh] = (parts[sizeAt] ?? "").split("/");
      out.push(["font-size", size ?? "medium"]);
      if (lh !== undefined) out[2] = ["line-height", lh];
      out.push(["font-family", parts.slice(sizeAt + 1).join(" ")]);
      return out;
    }
    case "flex": {
      const p = split(v);
      if (v === "none") return [["flex-grow", "0"], ["flex-shrink", "0"], ["flex-basis", "auto"]];
      if (v === "auto") return [["flex-grow", "1"], ["flex-shrink", "1"], ["flex-basis", "auto"]];
      if (p.length === 1 && /^[\d.]+$/.test(p[0] ?? "")) return [["flex-grow", p[0] ?? "1"], ["flex-shrink", "1"], ["flex-basis", "0%"]];
      if (p.length === 1) return [["flex-grow", "1"], ["flex-shrink", "1"], ["flex-basis", p[0] ?? "auto"]];
      const grow = p[0] ?? "1";
      const shrink = /^[\d.]+$/.test(p[1] ?? "") ? p[1] ?? "1" : "1";
      const basis = /^[\d.]+$/.test(p[1] ?? "") ? p[2] ?? "0%" : p[1] ?? "0%";
      return [["flex-grow", grow], ["flex-shrink", shrink], ["flex-basis", basis]];
    }
    case "flex-flow": {
      const out: [string, string][] = [];
      for (const p of split(v)) out.push([/wrap/.test(p) ? "flex-wrap" : "flex-direction", p]);
      return out;
    }
    case "gap": case "grid-gap": { const p = split(v); return [["row-gap", p[0] ?? "0"], ["column-gap", p[1] ?? p[0] ?? "0"]]; }
    case "place-items": { const p = split(v); return [["align-items", p[0] ?? "normal"], ["justify-items", p[1] ?? p[0] ?? "normal"]]; }
    case "place-content": { const p = split(v); return [["align-content", p[0] ?? "normal"], ["justify-content", p[1] ?? p[0] ?? "normal"]]; }
    case "place-self": { const p = split(v); return [["align-self", p[0] ?? "auto"], ["justify-self", p[1] ?? p[0] ?? "auto"]]; }
    case "overflow": { const p = split(v); return [["overflow-x", p[0] ?? "visible"], ["overflow-y", p[1] ?? p[0] ?? "visible"]]; }
    case "text-decoration": return [["text-decoration-line", split(v).find((p) => /underline|overline|line-through|none/.test(p)) ?? "none"]];
    case "grid-template": { const [rows, cols] = v.split("/"); return [["grid-template-rows", (rows ?? "none").trim()], ["grid-template-columns", (cols ?? "none").trim()]]; }
    case "grid-area": { const p = v.split("/").map((s) => s.trim()); return [["grid-row-start", p[0] ?? "auto"], ["grid-column-start", p[1] ?? "auto"], ["grid-row-end", p[2] ?? "auto"], ["grid-column-end", p[3] ?? "auto"]]; }
    case "grid-column": case "grid-row": { const p = v.split("/").map((s) => s.trim()); return [[name + "-start", p[0] ?? "auto"], [name + "-end", p[1] ?? "auto"]]; }
    case "transition": return listShorthand(v, ["transition-property", "transition-duration", "transition-timing-function", "transition-delay"]);
    case "animation": return listShorthand(v, ["animation-name", "animation-duration", "animation-timing-function", "animation-delay", "animation-iteration-count", "animation-direction", "animation-fill-mode", "animation-play-state"]);
    case "-webkit-backdrop-filter": return [["backdrop-filter", v]];
    case "word-wrap": return [["overflow-wrap", v]];
    default: return [[name, v]];
  }
}

const SHORTHANDS = new Set(["margin", "padding", "inset", "border", "border-width", "border-style", "border-color", "border-top", "border-right",
  "border-bottom", "border-left", "border-radius", "outline", "background", "font", "flex", "flex-flow", "gap", "grid-gap", "place-items",
  "place-content", "place-self", "overflow", "text-decoration", "grid-template", "grid-area", "grid-column", "grid-row", "transition", "animation"]);
export function isShorthand(name: string): boolean { return SHORTHANDS.has(name); }

const LONGHANDS: Record<string, string[]> = {
  font: ["font-style", "font-variant", "font-weight", "font-size", "line-height", "font-family"],
  background: ["background-color", "background-image", "background-size", "background-position", "background-repeat"],
  transition: ["transition-property", "transition-duration", "transition-timing-function", "transition-delay"],
  animation: ["animation-name", "animation-duration", "animation-timing-function", "animation-delay", "animation-iteration-count", "animation-direction", "animation-fill-mode", "animation-play-state"],
  "text-decoration": ["text-decoration-line"],
  "flex-flow": ["flex-direction", "flex-wrap"],
  "grid-template": ["grid-template-rows", "grid-template-columns"],
};
/** The longhands a shorthand sets. */
function longhands(name: string): string[] {
  return LONGHANDS[name] ?? expand(name, name === "border" || name === "outline" || name.startsWith("border-") ? "1px solid red" : "0 0 0 0").map(([n]) => n);
}

/** transition / animation: comma-separated lists of space-separated parts, sorted by what they look like. */
function listShorthand(v: string, names: string[]): [string, string][] {
  const lists: string[][] = names.map(() => []);
  for (const item of split(v, true)) {
    const parts = split(item);
    const out: (string | undefined)[] = names.map(() => undefined);
    let times = 0;
    for (const p of parts) {
      const lower = p.toLowerCase();
      if (/^-?[\d.]+m?s$/.test(lower)) { out[times === 0 ? 1 : 3] = p; times++; }
      else if (/^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/.test(lower) || /^(cubic-bezier|steps)\(/.test(lower)) out[2] = p;
      else if (names.length > 4 && (/^(infinite|[\d.]+)$/.test(lower))) out[4] = p;
      else if (names.length > 4 && /^(normal|reverse|alternate|alternate-reverse)$/.test(lower)) out[5] = p;
      else if (names.length > 4 && /^(none|forwards|backwards|both)$/.test(lower) && out[0] !== undefined) out[6] = p;
      else if (names.length > 4 && /^(running|paused)$/.test(lower)) out[7] = p;
      else out[0] = p;
    }
    const defaults = names.length > 4 ? ["none", "0s", "ease", "0s", "1", "normal", "none", "running"] : ["all", "0s", "ease", "0s"];
    names.forEach((_n, k) => (lists[k] as string[]).push(out[k] ?? defaults[k] ?? ""));
  }
  return names.map((n, k) => [n, (lists[k] as string[]).join(", ")]);
}
