/**
 * CSS values: splitting a value into components, colors, lengths with
 * calc()/min()/max()/clamp(), and the length units a page uses.
 */

export type Rgba = [number, number, number, number];   // 0..255, alpha 0..1

/** Split a value at top-level separators (whitespace, or commas with `commas`), keeping functions and strings whole. */
export function split(value: string, commas = false): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", quote = "";
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    if (quote !== "") { cur += c; if (c === quote) quote = ""; continue; }
    if (c === "\"" || c === "'") { quote = c; cur += c; continue; }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (depth === 0 && (commas ? c === "," : /\s/.test(c))) {
      if (cur.trim() !== "") out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** The arguments of `name(args)`, or null when the value isn't that function. */
export function fnArgs(value: string, name?: string): { name: string; args: string } | null {
  const m = /^([-a-zA-Z]+)\((.*)\)$/s.exec(value.trim());
  if (m === null || (name !== undefined && m[1]?.toLowerCase() !== name)) return null;
  return { name: (m[1] ?? "").toLowerCase(), args: m[2] ?? "" };
}

// ---------------------------------------------------------------- colors

const NAMED: Record<string, string> = {
  black: "#000", white: "#fff", red: "#f00", green: "#008000", blue: "#00f", yellow: "#ff0", cyan: "#0ff", aqua: "#0ff",
  magenta: "#f0f", fuchsia: "#f0f", gray: "#808080", grey: "#808080", silver: "#c0c0c0", maroon: "#800000", olive: "#808000",
  lime: "#0f0", navy: "#000080", purple: "#800080", teal: "#008080", orange: "#ffa500", pink: "#ffc0cb", brown: "#a52a2a",
  gold: "#ffd700", indigo: "#4b0082", violet: "#ee82ee", coral: "#ff7f50", salmon: "#fa8072", tomato: "#ff6347",
  crimson: "#dc143c", darkgray: "#a9a9a9", darkgrey: "#a9a9a9", lightgray: "#d3d3d3", lightgrey: "#d3d3d3", dimgray: "#696969",
  whitesmoke: "#f5f5f5", gainsboro: "#dcdcdc", skyblue: "#87ceeb", steelblue: "#4682b4", royalblue: "#4169e1",
  dodgerblue: "#1e90ff", deepskyblue: "#00bfff", lightblue: "#add8e6", darkblue: "#00008b", darkgreen: "#006400",
  limegreen: "#32cd32", forestgreen: "#228b22", seagreen: "#2e8b57", darkred: "#8b0000", orangered: "#ff4500",
  darkorange: "#ff8c00", khaki: "#f0e68c", beige: "#f5f5dc", ivory: "#fffff0", tan: "#d2b48c", chocolate: "#d2691e",
  sienna: "#a0522d", slategray: "#708090", lightslategray: "#778899", darkslategray: "#2f4f4f", midnightblue: "#191970",
  hotpink: "#ff69b4", deeppink: "#ff1493", plum: "#dda0dd", orchid: "#da70d6", turquoise: "#40e0d0", lavender: "#e6e6fa",
  rebeccapurple: "#663399", canvas: "#fff", canvastext: "#000", buttonface: "#efefef", buttontext: "#000", field: "#fff", fieldtext: "#000",
};

function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function channel(v: string, max: number): number {
  return v.endsWith("%") ? (parseFloat(v) / 100) * max : parseFloat(v);
}

/** A CSS color, or null when the value isn't one. `current` is currentColor. */
export function parseColor(value: string, current: Rgba = [0, 0, 0, 1]): Rgba | null {
  const v = value.trim().toLowerCase();
  if (v === "transparent") return [0, 0, 0, 0];
  if (v === "currentcolor") return current;
  const named = NAMED[v];
  if (named !== undefined) return parseColor(named);
  if (v.startsWith("#")) {
    let h = v.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number): number => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const f = fnArgs(v);
  if (f === null) return null;
  const parts = f.args.replace(/\//g, " / ").split(/[\s,]+/).filter((p) => p !== "" && p !== "/");
  const alpha = (p: string | undefined): number => (p === undefined ? 1 : Math.max(0, Math.min(1, channel(p, 1))));
  if (f.name === "rgb" || f.name === "rgba") {
    if (parts.length < 3) return null;
    return [channel(parts[0] ?? "0", 255), channel(parts[1] ?? "0", 255), channel(parts[2] ?? "0", 255), alpha(parts[3])].map((x, i) => (i < 3 ? Math.round(Math.max(0, Math.min(255, x))) : x)) as Rgba;
  }
  if (f.name === "hsl" || f.name === "hsla") {
    if (parts.length < 3) return null;
    const [r, g, b] = hsl(parseFloat(parts[0] ?? "0"), parseFloat(parts[1] ?? "0") / 100, parseFloat(parts[2] ?? "0") / 100);
    return [r, g, b, alpha(parts[3])];
  }
  return null;
}

export function mixColor(a: Rgba, b: Rgba, t: number): Rgba {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}

// ---------------------------------------------------------------- lengths

/** What a length resolves against. */
export interface LengthContext {
  em: number;          // the element's font size
  rem: number;         // the root's font size
  vw: number; vh: number;
  /** What a percentage is a percentage of (NaN: percentages don't resolve here) */
  percent: number;
  /** env(safe-area-inset-*) */
  env: (name: string) => number;
}

/** A length in px, NaN for auto/none/unresolvable. Handles calc(), min(), max(), clamp() and env(). */
export function length(value: string, ctx: LengthContext): number {
  const v = value.trim().toLowerCase();
  if (v === "" || v === "auto" || v === "none" || v === "normal" || v === "initial") return NaN;
  if (v === "0") return 0;
  const f = fnArgs(v);
  if (f !== null) {
    if (f.name === "calc") return calc(f.args, ctx);
    if (f.name === "min" || f.name === "max") {
      const vals = split(f.args, true).map((a) => calc(a, ctx));
      return f.name === "min" ? Math.min(...vals) : Math.max(...vals);
    }
    if (f.name === "clamp") {
      const [lo, mid, hi] = split(f.args, true).map((a) => calc(a, ctx));
      return Math.max(lo ?? 0, Math.min(mid ?? 0, hi ?? 0));
    }
    if (f.name === "env") {
      const [name, fallback] = split(f.args, true);
      const n = ctx.env(name ?? "");
      return Number.isFinite(n) ? n : fallback === undefined ? 0 : length(fallback, ctx);
    }
    return NaN;
  }
  const m = /^(-?[\d.]+(?:e-?\d+)?)([a-z%]*)$/.exec(v);
  if (m === null) return NaN;
  const n = parseFloat(m[1] ?? "0");
  switch (m[2]) {
    case "": case "px": return n;
    case "%": return (n / 100) * ctx.percent;
    case "em": return n * ctx.em;
    case "rem": return n * ctx.rem;
    case "vw": return (n / 100) * ctx.vw;
    case "vh": case "dvh": case "svh": case "lvh": return (n / 100) * ctx.vh;
    case "vmin": return (n / 100) * Math.min(ctx.vw, ctx.vh);
    case "vmax": return (n / 100) * Math.max(ctx.vw, ctx.vh);
    case "pt": return (n * 4) / 3;
    case "pc": return n * 16;
    case "in": return n * 96;
    case "cm": return (n * 96) / 2.54;
    case "mm": return (n * 96) / 25.4;
    case "ch": return n * ctx.em * 0.6;
    case "ex": return n * ctx.em * 0.5;
    default: return NaN;
  }
}

/** A calc() expression: + - * / with parentheses, over lengths and numbers. */
function calc(expr: string, ctx: LengthContext): number {
  const tokens = expr.match(/-?[\d.]+(?:e-?\d+)?[a-z%]*|[a-z-]+\([^()]*(?:\([^()]*\))*[^()]*\)|[()+\-*/]/gi) ?? [];
  let i = 0;
  const peek = (): string | undefined => tokens[i];
  const primary = (): number => {
    const t = tokens[i++];
    if (t === undefined) return NaN;
    if (t === "(") { const v = sum(); i++; return v; }
    if (t === "-") return -primary();
    if (/^[a-z-]+\(/i.test(t)) return length(t, ctx);
    if (/^-?[\d.]+(?:e-?\d+)?$/.test(t)) return parseFloat(t);
    return length(t, ctx);
  };
  const product = (): number => {
    let v = primary();
    while (peek() === "*" || peek() === "/") { const op = tokens[i++]; const r = primary(); v = op === "*" ? v * r : v / r; }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === "+" || peek() === "-") { const op = tokens[i++]; const r = product(); v = op === "+" ? v + r : v - r; }
    return v;
  };
  return sum();
}

/** A time in seconds ("200ms", ".2s"). */
export function time(value: string): number {
  const v = value.trim().toLowerCase();
  if (v.endsWith("ms")) return parseFloat(v) / 1000;
  if (v.endsWith("s")) return parseFloat(v);
  return parseFloat(v) || 0;
}

// ---------------------------------------------------------------- easing

function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const at = (a: number, b: number, t: number): number => 3 * a * t * (1 - t) * (1 - t) + 3 * b * t * t * (1 - t) + t * t * t;
  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, t = x;
    for (let k = 0; k < 24; k++) { t = (lo + hi) / 2; if (at(x1, x2, t) < x) lo = t; else hi = t; }
    return at(y1, y2, t);
  };
}

const EASINGS: Record<string, (t: number) => number> = {
  linear: (t) => t,
  ease: bezier(0.25, 0.1, 0.25, 1),
  "ease-in": bezier(0.42, 0, 1, 1),
  "ease-out": bezier(0, 0, 0.58, 1),
  "ease-in-out": bezier(0.42, 0, 0.58, 1),
  "step-start": (t) => (t > 0 ? 1 : 0),
  "step-end": (t) => (t >= 1 ? 1 : 0),
};

export function easing(value: string): (t: number) => number {
  const v = value.trim().toLowerCase();
  const named = EASINGS[v];
  if (named !== undefined) return named;
  const f = fnArgs(v);
  if (f?.name === "cubic-bezier") {
    const [a, b, c, d] = f.args.split(",").map(Number);
    return bezier(a ?? 0, b ?? 0, c ?? 1, d ?? 1);
  }
  if (f?.name === "steps") {
    const [n, pos] = f.args.split(",").map((s) => s.trim());
    const k = Math.max(1, parseInt(n ?? "1", 10));
    return pos === "start" || pos === "jump-start" ? (t) => Math.min(1, Math.ceil(t * k) / k) : (t) => Math.floor(t * k) / k;
  }
  return EASINGS["ease"] as (t: number) => number;
}

export function isEasing(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v in EASINGS || v.startsWith("cubic-bezier(") || v.startsWith("steps(");
}
