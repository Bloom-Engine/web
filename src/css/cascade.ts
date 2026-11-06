/**
 * The cascade: for each element, the declarations of the rules that match
 * it (stylesheets whose @media matches, and its style attribute), ordered by
 * importance, specificity and source order; custom properties and var();
 * inheritance; font sizes resolved against the parent's. The result is
 * every property's computed value as a string, read by layout and paint.
 */
import { matchesSelector } from "../dom/selectors.ts";
import type { Element } from "../dom/node.ts";
import { expand, inlineDeclarations, isShorthand, type Declaration, type Sheet, type StyleRule } from "./sheet.ts";
import { length, parseColor, split, type LengthContext, type Rgba } from "./values.ts";

export const INHERITED = new Set([
  "color", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "word-spacing", "text-align",
  "text-transform", "text-indent", "white-space", "visibility", "cursor", "text-shadow", "direction", "pointer-events",
  "overflow-wrap", "word-break", "list-style-type", "font-variant", "tab-size", "caret-color", "text-rendering",
]);

const INITIAL: Record<string, string> = {
  display: "inline", position: "static", "box-sizing": "content-box", float: "none", clear: "none",
  "font-size": "16px", "font-weight": "400", "font-style": "normal", "font-family": "serif", "line-height": "normal",
  color: "#000", "letter-spacing": "normal", "word-spacing": "normal", "text-align": "start", "text-transform": "none",
  "white-space": "normal", visibility: "visible", opacity: "1", "z-index": "auto", overflow: "visible", "overflow-x": "visible", "overflow-y": "visible",
  "background-color": "transparent", "background-image": "none", "background-size": "auto", "background-position": "0% 0%", "background-repeat": "repeat",
  width: "auto", height: "auto", "min-width": "auto", "min-height": "auto", "max-width": "none", "max-height": "none",
  top: "auto", right: "auto", bottom: "auto", left: "auto",
  "flex-direction": "row", "flex-wrap": "nowrap", "flex-grow": "0", "flex-shrink": "1", "flex-basis": "auto",
  "justify-content": "normal", "align-items": "normal", "align-self": "auto", "align-content": "normal", "justify-items": "normal", "justify-self": "auto",
  "row-gap": "normal", "column-gap": "normal", "grid-template-columns": "none", "grid-template-rows": "none", "grid-auto-flow": "row",
  "grid-auto-rows": "auto", "grid-auto-columns": "auto", order: "0",
  transform: "none", "transform-origin": "50% 50%", "box-shadow": "none", "text-shadow": "none", "text-overflow": "clip",
  "outline-style": "none", "outline-width": "medium", "outline-color": "currentcolor", "outline-offset": "0",
  "pointer-events": "auto", cursor: "auto", "text-decoration-line": "none", "vertical-align": "baseline", "text-indent": "0",
  "object-fit": "fill", "list-style-type": "disc", "overflow-wrap": "normal", "word-break": "normal",
  "transition-property": "all", "transition-duration": "0s", "transition-timing-function": "ease", "transition-delay": "0s",
  "animation-name": "none", "animation-duration": "0s", "animation-timing-function": "ease", "animation-delay": "0s",
  "animation-iteration-count": "1", "animation-direction": "normal", "animation-fill-mode": "none", "animation-play-state": "running",
  content: "normal", "aspect-ratio": "auto",
};
for (const side of ["top", "right", "bottom", "left"]) {
  INITIAL[`margin-${side}`] = "0"; INITIAL[`padding-${side}`] = "0";
  INITIAL[`border-${side}-width`] = "medium"; INITIAL[`border-${side}-style`] = "none"; INITIAL[`border-${side}-color`] = "currentcolor";
}
for (const c of ["top-left", "top-right", "bottom-right", "bottom-left"]) INITIAL[`border-${c}-radius`] = "0";

const FONT_KEYWORDS: Record<string, number> = { "xx-small": 9, "x-small": 10, small: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32, "xxx-large": 48 };

/** An element's computed style: every property's value as a string, plus the font size and color resolved. */
export class Computed {
  readonly values: Record<string, string>;
  readonly custom: Map<string, string>;
  fontSize: number;
  color: Rgba;
  constructor(values: Record<string, string>, custom: Map<string, string>, fontSize: number, color: Rgba) {
    this.values = values; this.custom = custom; this.fontSize = fontSize; this.color = color;
  }
  get(name: string): string { return this.values[name] ?? INITIAL[name] ?? ""; }
}

export interface CascadeContext {
  vw: number; vh: number;
  env: (name: string) => number;
  mediaMatches: (query: string) => boolean;
}

/** Replace var(--x, fallback) with custom property values (nested, with fallbacks). */
export function substitute(value: string, custom: Map<string, string>, depth = 0): string {
  if (!value.includes("var(") || depth > 16) return value;
  let out = "", i = 0;
  while (i < value.length) {
    const at = value.indexOf("var(", i);
    if (at < 0) { out += value.slice(i); break; }
    out += value.slice(i, at);
    let d = 1, j = at + 4;
    for (; j < value.length && d > 0; j++) { const c = value.charAt(j); if (c === "(") d++; else if (c === ")") d--; }
    const inner = value.slice(at + 4, j - 1);
    const comma = inner.indexOf(",");
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? "" : inner.slice(comma + 1).trim();
    const v = custom.get(name);
    out += substitute(v !== undefined && v !== "" ? v : fallback, custom, depth + 1);
    i = j;
  }
  return out;
}

interface Matched { decl: Declaration; important: boolean; spec: number; order: number; origin: number }

/** Cascade precedence: UA normal, author normal (inline last), author important, UA important. */
const rank = (m: Matched): number => (m.important ? (m.origin === 0 ? 3 : 2) : m.origin === 0 ? 0 : 1);

const specValue = (s: [number, number, number]): number => s[0] * 1e6 + s[1] * 1e3 + s[2];

/**
 * The bucket a selector goes in, from its rightmost compound: "#id", ".class", a tag name, or
 * "*" (a browser's rule hash: an element only tests the rules in its buckets).
 */
function bucket(selector: string): string {
  // the rightmost compound: after the last combinator outside brackets and parentheses
  let depth = 0, start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector.charAt(i);
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && (c === " " || c === ">" || c === "+" || c === "~")) start = i + 1;
  }
  const compound = selector.slice(start).trim();
  // only the parts outside :not(...)/[...]
  let plain = "";
  depth = 0;
  for (const c of compound) {
    if (c === "(" || c === "[") depth++;
    if (depth === 0) plain += c;
    if (c === ")" || c === "]") depth--;
  }
  const id = /#([-\w]+)/.exec(plain);
  if (id !== null) return "#" + id[1];
  const cls = /\.([-\w]+)/.exec(plain);
  if (cls !== null) return "." + cls[1];
  const tag = /^([a-zA-Z][-\w]*)/.exec(plain);
  if (tag !== null) return (tag[1] ?? "").toLowerCase();
  return "*";
}

export class Cascade {
  private sheets: Sheet[] = [];
  private rules: StyleRule[] = [];
  readonly styles = new Map<Element, Computed>();

  private buckets = new Map<string, StyleRule[]>();
  setSheets(sheets: Sheet[]): void {
    this.sheets = sheets;
    this.rules = sheets.flatMap((s) => s.rules);
    this.buckets.clear();
  }
  keyframes(name: string): Sheet["keyframes"] extends Map<string, infer K> ? K | undefined : never {
    for (let i = this.sheets.length - 1; i >= 0; i--) { const k = this.sheets[i]?.keyframes.get(name); if (k !== undefined) return k as never; }
    return undefined as never;
  }

  /** Compute the styles of `root` and everything under it. */
  run(root: Element, ctx: CascadeContext): void {
    this.styles.clear();
    const active = this.rules.filter((r) => r.media === "" || ctx.mediaMatches(r.media));
    this.buckets.clear();
    for (const r of active) {
      const k = bucket(r.selector);
      const list = this.buckets.get(k);
      if (list === undefined) this.buckets.set(k, [r]); else list.push(r);
    }
    const rules = active;
    const rootFont = { size: 16 };
    const walk = (e: Element, parent: Computed | null): void => {
      const style = this.compute(e, parent, rules, ctx, rootFont);
      this.styles.set(e, style);
      if (e === root) rootFont.size = style.fontSize;
      for (const c of e.children) walk(c, style);
    };
    walk(root, null);
  }

  private compute(e: Element, parent: Computed | null, rules: StyleRule[], ctx: CascadeContext, root: { size: number }): Computed {
    const matched: Matched[] = [];
    void rules;
    // the candidates: rules filed under the element's id, classes, tag, and "*"
    const candidates: StyleRule[] = [];
    const add = (k: string): void => { const l = this.buckets.get(k); if (l !== undefined) for (const r of l) candidates.push(r); };
    add("*");
    add(e.localName);
    if (e.id !== "") add("#" + e.id);
    const cls = e.getAttribute("class");
    if (cls !== null) for (const c of cls.split(/\s+/)) if (c !== "") add("." + c);
    const n = candidates.length;
    for (let i = 0; i < n; i++) {
      const r = candidates[i] as StyleRule;
      let hit = false;
      try { hit = matchesSelector(e, r.selector); } catch { hit = false; }
      if (!hit) continue;
      const spec = specValue(r.specificity);
      for (const d of r.declarations) matched.push({ decl: d, important: d.important, spec, order: r.order, origin: r.origin });
    }
    const inline = e.getAttribute("style");
    if (inline !== null && inline !== "") for (const d of inlineDeclarations(inline)) matched.push({ decl: d, important: d.important, spec: 1e9, order: 1e9, origin: 1 });
    matched.sort((a, b) => rank(a) - rank(b) || a.spec - b.spec || a.order - b.order);

    // custom properties: inherited, then this element's (the cascade's winner), with var() inside them resolved
    const custom = new Map<string, string>(parent?.custom ?? []);
    for (const m of matched) if (m.decl.name.startsWith("--")) custom.set(m.decl.name, m.decl.value.trim());
    for (const [k, v] of custom) if (v.includes("var(")) custom.set(k, substitute(v, custom));

    // declarations in cascade order, later ones winning; a shorthand that waited for var() expands
    // at its own place in that order
    const values: Record<string, string> = {};
    for (const m of matched) {
      const name = m.decl.name;
      if (name.startsWith("--")) continue;
      let v = m.decl.value;
      if (v.includes("var(")) v = substitute(v, custom);
      if (isShorthand(name)) for (const [k, x] of expand(name, v)) values[k] = x;
      else values[name] = v;
    }
    // inherit, initial, unset
    const pv = parent?.values ?? {};
    for (const name of Object.keys(values)) {
      const v = (values[name] ?? "").toLowerCase();
      if (v === "inherit") values[name] = pv[name] ?? INITIAL[name] ?? "";
      else if (v === "initial") values[name] = INITIAL[name] ?? "";
      else if (v === "unset" || v === "revert") values[name] = INHERITED.has(name) ? pv[name] ?? INITIAL[name] ?? "" : INITIAL[name] ?? "";
    }
    for (const name of INHERITED) if (values[name] === undefined && pv[name] !== undefined) values[name] = pv[name] as string;

    // font size against the parent's (em, %, keywords)
    const parentSize = parent?.fontSize ?? 16;
    const fs = (values["font-size"] ?? "").trim().toLowerCase();
    let size = parentSize;
    if (fs !== "" && fs !== pv["font-size"]) {
      if (fs in FONT_KEYWORDS) size = FONT_KEYWORDS[fs] as number;
      else if (fs === "smaller") size = parentSize / 1.2;
      else if (fs === "larger") size = parentSize * 1.2;
      else {
        const lc: LengthContext = { em: parentSize, rem: parent === null ? 16 : root.size, vw: ctx.vw, vh: ctx.vh, percent: parentSize, env: ctx.env };
        const px = length(fs, lc);
        if (Number.isFinite(px)) size = px;
      }
    } else if (parent === null) size = 16;
    values["font-size"] = size + "px";
    const parentColor = parent?.color ?? [0, 0, 0, 1];
    const color = parseColor(values["color"] ?? "", parentColor) ?? parentColor;
    // the computed value of a bold weight keyword, so bolder/lighter work from the parent
    const w = (values["font-weight"] ?? "").toLowerCase();
    if (w === "bold") values["font-weight"] = "700";
    else if (w === "normal") values["font-weight"] = "400";
    else if (w === "bolder") values["font-weight"] = String(Math.min(900, Number(pv["font-weight"] ?? "400") + 300));
    else if (w === "lighter") values["font-weight"] = String(Math.max(100, Number(pv["font-weight"] ?? "400") - 300));
    return new Computed(values, custom, size, color);
  }
}

/** A style's lengths resolved against a box. */
export function lengthContext(s: Computed, rem: number, vw: number, vh: number, percent: number, env: (n: string) => number): LengthContext {
  return { em: s.fontSize, rem, vw, vh, percent, env };
}

export { split };
