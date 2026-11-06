/**
 * Painting the laid-out page with Bloom 2D, in CSS paint order: a stacking
 * context paints its background and border, its in-flow content (block
 * backgrounds, inline decorations, text, inline-blocks), then its
 * positioned descendants by z-index. Opacity multiplies down the tree;
 * translate and scale transforms (about transform-origin) apply to a box and
 * its subtree; overflow other than visible clips the content (rounded when
 * the box is), and scrolls it by the element's scrollTop.
 *
 * What paints before the page's full-window canvas (the 3D view) is hidden
 * by it, as in the browser, so the page is recorded as a display list and
 * only what comes after the canvas is drawn.
 *
 * Bloom 2D draws rects, triangles and text: rounded shapes are drawn as rows
 * of device pixels, gradients as cells, blurred shadows as layers.
 */
import { drawRect } from "@bloomengine/engine/shapes";
import { drawTexturePro, loadTexture } from "@bloomengine/engine/textures";
import type { Texture } from "@bloomengine/engine/core";
import type { Element } from "../dom/node.ts";
import type { Box, Fragment } from "./layout.ts";
import { measure } from "./layout.ts";
import { fnArgs, length, mixColor, parseColor, split, type LengthContext, type Rgba } from "./values.ts";

/** An affine map from layout coordinates to CSS pixels on screen: scale then translate. */
export interface Xf { a: number; d: number; tx: number; ty: number }
const IDENTITY: Xf = { a: 1, d: 1, tx: 0, ty: 0 };
const apply = (m: Xf, x: number, y: number): [number, number] => [m.a * x + m.tx, m.d * y + m.ty];
const compose = (outer: Xf, inner: Xf): Xf => ({ a: outer.a * inner.a, d: outer.d * inner.d, tx: outer.a * inner.tx + outer.tx, ty: outer.d * inner.ty + outer.ty });

/** A clip in device pixels, with corner radii (device pixels). */
interface Clip { x0: number; y0: number; x1: number; y1: number; r: [number, number, number, number] }

export interface PaintEnv {
  /** Device pixels per CSS pixel */
  S: number;
  viewport: { w: number; h: number };
  rem: number;
  env: (name: string) => number;
  /** The 3D view's canvas: what paints before it is hidden */
  view: Element | null;
  /** Called for each box with an element: where it is on screen (CSS px), whether it takes pointer events, its paint order */
  place: (e: Element, rect: { x: number; y: number; w: number; h: number } | null, hit: boolean, order: number) => void;
  /** Text for a replaced form control (input value, selected option), and whether it is a placeholder */
  controlText: (e: Element) => { text: string; dim: boolean } | null;
}

type Cmd = () => void;

let env: PaintEnv;
let cmds: Cmd[] = [];
let viewAt = -1;
let order = 0;

// ---------------------------------------------------------------- primitives (device px, clipped)

let clip: Clip | null = null;

function rgba(c: Rgba, alpha: number): { r: number; g: number; b: number; a: number } {
  return { r: Math.round(c[0]), g: Math.round(c[1]), b: Math.round(c[2]), a: Math.max(0, Math.min(255, Math.round(c[3] * alpha * 255))) };
}

/** How far the clip's rounded corners cut into row y (device px): [from left, from right]. */
function clipInsets(c: Clip, y: number): [number, number] {
  const [tl, tr, br, bl] = c.r;
  const inset = (r: number, dy: number): number => (r <= 0 || dy >= r ? 0 : r - Math.sqrt(Math.max(0, r * r - (r - dy) * (r - dy))));
  const top = y + 0.5 - c.y0, bottom = c.y1 - (y + 0.5);
  let l = 0, r = 0;
  if (top < tl) l = Math.max(l, inset(tl, top)); if (bottom < bl) l = Math.max(l, inset(bl, bottom));
  if (top < tr) r = Math.max(r, inset(tr, top)); if (bottom < br) r = Math.max(r, inset(br, bottom));
  return [l, r];
}

function rectNow(x: number, y: number, w: number, h: number, color: { r: number; g: number; b: number; a: number }, c: Clip | null): void {
  if (color.a <= 0) return;
  let x0 = x, y0 = y, x1 = x + w, y1 = y + h;
  if (c !== null) {
    x0 = Math.max(x0, c.x0); y0 = Math.max(y0, c.y0); x1 = Math.min(x1, c.x1); y1 = Math.min(y1, c.y1);
    if (x1 <= x0 || y1 <= y0) return;
    if (c.r[0] + c.r[1] + c.r[2] + c.r[3] > 0) {
      // rows in the clip's corner bands, one device pixel each
      const band = Math.max(c.r[0], c.r[1], c.r[2], c.r[3]);
      const top = Math.min(y1, c.y0 + band), bottom = Math.max(y0, c.y1 - band);
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        if (yy >= top && yy < bottom) continue;
        const [l, r] = clipInsets(c, yy);
        const a = Math.max(x0, c.x0 + l), b = Math.min(x1, c.x1 - r);
        const ya = Math.max(y0, yy), yb = Math.min(y1, yy + 1);
        if (b > a && yb > ya) drawRect(Math.round(a), Math.round(ya), Math.round(b) - Math.round(a), Math.max(1, Math.round(yb) - Math.round(ya)), color);
      }
      const my0 = Math.max(y0, top), my1 = Math.min(y1, bottom);
      if (my1 > my0) drawRect(Math.round(x0), Math.round(my0), Math.round(x1) - Math.round(x0), Math.round(my1) - Math.round(my0), color);
      return;
    }
  }
  const X = Math.round(x0), Y = Math.round(y0);
  const W = Math.round(x1) - X, H = Math.round(y1) - Y;
  if (W > 0 && H > 0) drawRect(X, Y, W, H, color);
}

/** Queue a rect (device px). */
function rect(x: number, y: number, w: number, h: number, color: Rgba, alpha: number): void {
  const c = clip, col = rgba(color, alpha);
  if (col.a <= 0 || w <= 0 || h <= 0) return;
  cmds.push(() => rectNow(x, y, w, h, col, c));
}

/** How far a rounded rect's edge is inset on row dy (from its top) for radius r. */
function cornerInset(r: number, d: number): number { return r <= 0 || d >= r ? 0 : r - Math.sqrt(Math.max(0, r * r - (r - d) * (r - d))); }

/** A rounded rect (device px), radii [tl, tr, br, bl]. */
function roundRect(x: number, y: number, w: number, h: number, r: [number, number, number, number], color: Rgba, alpha: number): void {
  if (w <= 0 || h <= 0) return;
  const max = Math.min(w, h) / 2;
  const [tl, tr, br, bl] = r.map((v) => Math.min(v, max)) as [number, number, number, number];
  if (tl + tr + br + bl <= 0) { rect(x, y, w, h, color, alpha); return; }
  const top = Math.max(tl, tr), bottom = Math.max(bl, br);
  for (let i = 0; i < Math.ceil(top); i++) {
    const d = i + 0.5;
    const l = cornerInset(tl, d), rr = cornerInset(tr, d);
    rect(x + l, y + i, w - l - rr, 1, color, alpha);
  }
  rect(x, y + Math.ceil(top), w, h - Math.ceil(top) - Math.ceil(bottom), color, alpha);
  for (let i = 0; i < Math.ceil(bottom); i++) {
    const d = i + 0.5;
    const l = cornerInset(bl, d), rr = cornerInset(br, d);
    rect(x + l, y + h - 1 - i, w - l - rr, 1, color, alpha);
  }
}

/**
 * A border: the area between the outer rounded rect and the inner one (outer minus the border
 * widths), row by row, each side in its own color.
 */
function borderRing(x: number, y: number, w: number, h: number, r: [number, number, number, number], bw: [number, number, number, number], colors: [Rgba, Rgba, Rgba, Rgba], alpha: number, dashes: string | null = null): void {
  const [bt, br, bb, bl] = bw;
  if (bt + br + bb + bl <= 0) return;
  const max = Math.min(w, h) / 2;
  const R = r.map((v) => Math.min(v, max)) as [number, number, number, number];
  const ix = x + bl, iy = y + bt, iw = w - bl - br, ih = h - bt - bb;
  const IR: [number, number, number, number] = [Math.max(0, R[0] - Math.max(bl, bt)), Math.max(0, R[1] - Math.max(br, bt)), Math.max(0, R[2] - Math.max(br, bb)), Math.max(0, R[3] - Math.max(bl, bb))];
  const rows = Math.ceil(h);
  const rounded = R[0] + R[1] + R[2] + R[3] > 0;
  if (!rounded && dashes !== null) {
    // dashes (3x the width, dots 1x) along each side, with gaps the same length
    const along = (x0: number, y0: number, len: number, thick: number, horizontal: boolean, col: Rgba): void => {
      const seg = Math.max(1, thick * (dashes === "dotted" ? 1 : 3));
      for (let p = 0; p < len; p += seg * 2) {
        const l = Math.min(seg, len - p);
        if (horizontal) rect(x0 + p, y0, l, thick, col, alpha); else rect(x0, y0 + p, thick, l, col, alpha);
      }
    };
    along(x, y, w, bt, true, colors[0]);
    along(x, y + h - bb, w, bb, true, colors[2]);
    along(x, y + bt, h - bt - bb, bl, false, colors[3]);
    along(x + w - br, y + bt, h - bt - bb, br, false, colors[1]);
    return;
  }
  if (!rounded) {
    rect(x, y, w, bt, colors[0], alpha);
    rect(x, y + h - bb, w, bb, colors[2], alpha);
    rect(x, y + bt, bl, h - bt - bb, colors[3], alpha);
    rect(x + w - br, y + bt, br, h - bt - bb, colors[1], alpha);
    return;
  }
  for (let i = 0; i < rows; i++) {
    const d = i + 0.5;
    const fromBottom = h - d;
    const ol = Math.max(cornerInset(R[0], d), cornerInset(R[3], fromBottom));
    const or = Math.max(cornerInset(R[1], d), cornerInset(R[2], fromBottom));
    const yy = y + i;
    if (yy < iy || yy >= iy + ih || iw <= 0) {
      rect(x + ol, yy, w - ol - or, 1, yy < iy ? colors[0] : colors[2], alpha);
      continue;
    }
    const id = yy + 0.5 - iy, ifb = iy + ih - (yy + 0.5);
    const il = Math.max(cornerInset(IR[0], id), cornerInset(IR[3], ifb));
    const ir = Math.max(cornerInset(IR[1], id), cornerInset(IR[2], ifb));
    rect(x + ol, yy, ix + il - (x + ol), 1, colors[3], alpha);
    rect(ix + iw - ir, yy, x + w - or - (ix + iw - ir), 1, colors[1], alpha);
  }
}

function text(f: Fragment, s: string, x: number, y: number, size: number, color: Rgba, alpha: number, bold: boolean): void {
  const c = clip, col = rgba(color, alpha);
  if (col.a <= 0 || s === "") return;
  if (c !== null && (x > c.x1 || y > c.y1 || y + size < c.y0)) return;
  const spacing = f.spacing * env.S * (size / (f.size * env.S));
  const face = f.face;
  cmds.push(() => {
    // faux bold: the glyphs again, a little to the right (about what a bold face adds to the stems)
    const k = Math.max(0.6, size / 20);
    if (spacing === 0) {
      face.draw(s, x, y, size, col);
      if (bold) { face.draw(s, x + k / 2, y, size, col); face.draw(s, x + k, y, size, col); }
      return;
    }
    // letter-spacing: one glyph at a time
    let cx = x;
    for (const ch of s) {
      face.draw(ch, cx, y, size, col);
      if (bold) { face.draw(ch, cx + k / 2, y, size, col); face.draw(ch, cx + k, y, size, col); }
      cx += face.measure(ch, size) + spacing;
    }
  });
}

const textures = new Map<string, Texture | null>();
function image(file: string, x: number, y: number, w: number, h: number, alpha: number): void {
  let t = textures.get(file);
  if (t === undefined) { try { t = loadTexture(file); } catch { t = null; } textures.set(file, t); }
  if (t === null || w <= 0 || h <= 0) return;
  const tex = t, c = clip;
  cmds.push(() => {
    let sx = 0, sy = 0, sw = tex.width, sh = tex.height, dx = x, dy = y, dw = w, dh = h;
    if (c !== null) {
      // clip the destination and the matching part of the source
      const x0 = Math.max(dx, c.x0), y0 = Math.max(dy, c.y0), x1 = Math.min(dx + dw, c.x1), y1 = Math.min(dy + dh, c.y1);
      if (x1 <= x0 || y1 <= y0) return;
      sx = ((x0 - dx) / dw) * sw; sy = ((y0 - dy) / dh) * sh; sw = ((x1 - x0) / dw) * sw; sh = ((y1 - y0) / dh) * sh;
      dx = x0; dy = y0; dw = x1 - x0; dh = y1 - y0;
    }
    drawTexturePro(tex, { x: sx, y: sy, width: sw, height: sh }, { x: dx, y: dy, width: dw, height: dh }, { x: 0, y: 0 }, 0, { r: 255, g: 255, b: 255, a: Math.round(255 * alpha) });
  });
}

// ---------------------------------------------------------------- style helpers

function ctx(b: Box, percent: number): LengthContext {
  return { em: b.style.fontSize, rem: env.rem, vw: env.viewport.w, vh: env.viewport.h, percent, env: env.env };
}
function color(b: Box, name: string): Rgba { return parseColor(b.style.get(name), b.style.color) ?? [0, 0, 0, 0]; }

function radii(b: Box): [number, number, number, number] {
  const get = (corner: string, along: number): number => {
    const v = split(b.style.get(`border-${corner}-radius`))[0] ?? "0";
    const px = length(v, ctx(b, along));
    return Number.isFinite(px) ? Math.max(0, px) : 0;
  };
  return [get("top-left", b.w), get("top-right", b.w), get("bottom-right", b.w), get("bottom-left", b.w)];
}

/** Box transform (translate and scale about transform-origin), or null. */
function transformOf(b: Box): Xf | null {
  const t = b.style.get("transform").trim();
  if (t === "none" || t === "") return null;
  let a = 1, d = 1, tx = 0, ty = 0;
  for (const fn of split(t)) {
    const f = fnArgs(fn);
    if (f === null) continue;
    const args = split(f.args, true);
    const lx = (v: string | undefined): number => { const n = length(v ?? "0", ctx(b, b.w)); return Number.isFinite(n) ? n : 0; };
    const ly = (v: string | undefined): number => { const n = length(v ?? "0", ctx(b, b.h)); return Number.isFinite(n) ? n : 0; };
    switch (f.name) {
      case "translate": tx += lx(args[0]) * a; ty += ly(args[1]) * d; break;
      case "translatex": tx += lx(args[0]) * a; break;
      case "translatey": ty += ly(args[0]) * d; break;
      case "translate3d": tx += lx(args[0]) * a; ty += ly(args[1]) * d; break;
      case "scale": { const sx = parseFloat(args[0] ?? "1"), sy = args[1] === undefined ? sx : parseFloat(args[1]); a *= sx; d *= sy; break; }
      case "scalex": a *= parseFloat(args[0] ?? "1"); break;
      case "scaley": d *= parseFloat(args[0] ?? "1"); break;
      case "matrix": { const m = args.map(Number); a *= m[0] ?? 1; d *= m[3] ?? 1; tx += m[4] ?? 0; ty += m[5] ?? 0; break; }
      default: break;   // rotate and skew aren't drawn
    }
  }
  // about the origin (center by default)
  const o = split(b.style.get("transform-origin"));
  const pos = (v: string | undefined, size: number, fallback: number): number => {
    if (v === undefined) return fallback;
    if (v === "left" || v === "top") return 0;
    if (v === "right" || v === "bottom") return size;
    if (v === "center") return size / 2;
    const n = length(v, ctx(b, size));
    return Number.isFinite(n) ? n : fallback;
  };
  const ox = b.x + pos(o[0], b.w, b.w / 2), oy = b.y + pos(o[1], b.h, b.h / 2);
  return { a, d, tx: ox + tx - a * ox, ty: oy + ty - d * oy };
}

// ---------------------------------------------------------------- backgrounds

interface Stop { color: Rgba; at: number }

function stops(args: string[], lengthPx: number, b: Box): Stop[] {
  const out: { color: Rgba; at: number | null }[] = [];
  for (const a of args) {
    const parts = split(a);
    const c = parseColor(parts[0] ?? "", b.style.color);
    if (c === null) continue;
    const pos = parts[1];
    let at: number | null = null;
    if (pos !== undefined) { const px = length(pos, ctx(b, lengthPx)); at = Number.isFinite(px) && lengthPx > 0 ? px / lengthPx : null; }
    out.push({ color: c, at });
  }
  if (out.length === 0) return [];
  if (out[0]?.at === null) (out[0] as { at: number }).at = 0;
  if (out[out.length - 1]?.at === null) (out[out.length - 1] as { at: number }).at = 1;
  // spread positions evenly between known ones
  for (let i = 1; i < out.length; i++) {
    if (out[i]?.at !== null) continue;
    let j = i;
    while (out[j]?.at === null) j++;
    const a = out[i - 1]?.at ?? 0, z = out[j]?.at ?? 1;
    for (let k = i; k < j; k++) (out[k] as { at: number }).at = a + ((z - a) * (k - i + 1)) / (j - i + 1);
  }
  return out.map((s) => ({ color: s.color, at: s.at ?? 0 }));
}

function sample(st: Stop[], t: number): Rgba {
  if (st.length === 0) return [0, 0, 0, 0];
  if (t <= (st[0]?.at ?? 0)) return (st[0] as Stop).color;
  for (let i = 1; i < st.length; i++) {
    const a = st[i - 1] as Stop, c = st[i] as Stop;
    if (t <= c.at) return mixColor(a.color, c.color, c.at === a.at ? 1 : (t - a.at) / (c.at - a.at));
  }
  return (st[st.length - 1] as Stop).color;
}

/** A gradient over a device rect, as cells. */
function gradient(value: string, b: Box, x: number, y: number, w: number, h: number, alpha: number): void {
  const f = fnArgs(value);
  if (f === null) return;
  const args = split(f.args, true);
  const S = env.S;
  if (f.name === "linear-gradient" || f.name === "repeating-linear-gradient") {
    let angle = 180;
    const first = (args[0] ?? "").trim().toLowerCase();
    if (first.startsWith("to ")) {
      const dir = first.slice(3);
      angle = dir === "top" ? 0 : dir === "right" ? 90 : dir === "left" ? 270 : dir === "bottom" ? 180 : dir.includes("top") ? (dir.includes("right") ? 45 : 315) : dir.includes("right") ? 135 : 225;
      args.shift();
    } else if (/deg|turn|rad$/.test(first)) {
      angle = first.endsWith("turn") ? parseFloat(first) * 360 : first.endsWith("rad") ? (parseFloat(first) * 180) / Math.PI : parseFloat(first);
      args.shift();
    }
    const rad = (angle * Math.PI) / 180;
    const dx = Math.sin(rad), dy = -Math.cos(rad);
    const len = Math.abs(w * dx) + Math.abs(h * dy);
    const st = stops(args, len / S, b);
    // bands along the gradient: rows for vertical ones, columns for horizontal, cells otherwise
    const vertical = Math.abs(dx) < 1e-6, horizontal = Math.abs(dy) < 1e-6;
    const n = vertical ? Math.min(256, Math.ceil(h / 2)) : horizontal ? Math.min(256, Math.ceil(w / 2)) : 48;
    const m = vertical || horizontal ? 1 : 48;
    const cw = vertical ? w : w / (horizontal ? n : m), ch = horizontal ? h : h / (vertical ? n : m);
    for (let i = 0; i < (vertical ? n : horizontal ? 1 : m); i++) {
      for (let j = 0; j < (horizontal ? n : vertical ? 1 : m); j++) {
        const gx = horizontal ? j : vertical ? 0 : j, gy = vertical ? i : horizontal ? 0 : i;
        const px = Math.round(x + gx * cw), py = Math.round(y + gy * ch);
        const qx = Math.round(x + (gx + 1) * cw), qy = Math.round(y + (gy + 1) * ch);
        const cx = (px + qx) / 2 - (x + w / 2), cy = (py + qy) / 2 - (y + h / 2);
        const t = (cx * dx + cy * dy) / len + 0.5;
        rect(px, py, qx - px, qy - py, sample(st, t), alpha);
      }
    }
  } else if (f.name === "radial-gradient" || f.name === "repeating-radial-gradient") {
    let cxr = 0.5, cyr = 0.5, circle = false;
    const first = (args[0] ?? "").trim().toLowerCase();
    if (parseColor(split(first)[0] ?? "") === null) {
      circle = first.includes("circle");
      const at = /at\s+(.+)$/.exec(first);
      if (at !== null) {
        const p = split(at[1] ?? "");
        const pos = (v: string | undefined, fallback: number): number => v === undefined ? fallback : v === "center" ? 0.5 : v === "left" || v === "top" ? 0 : v === "right" || v === "bottom" ? 1 : v.endsWith("%") ? parseFloat(v) / 100 : fallback;
        cxr = pos(p[0], 0.5); cyr = pos(p[1], 0.5);
      }
      args.shift();
    }
    // farthest-corner ellipse: radii so the corner is at distance 1
    const fx = Math.max(cxr, 1 - cxr) * w, fy = Math.max(cyr, 1 - cyr) * h;
    const rx = circle ? Math.hypot(fx, fy) : fx * Math.SQRT2, ry = circle ? rx : fy * Math.SQRT2;
    const st = stops(args, rx / S, b);
    // cells about 24 device px (at most 64 a side)
    const nx = Math.max(8, Math.min(80, Math.ceil(w / 12))), ny = Math.max(8, Math.min(80, Math.ceil(h / 12)));
    const cw = w / nx, ch = h / ny;
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
      // whole device pixels, edge to edge: overlapping cells would double translucent colors
      const px = Math.round(x + j * cw), py = Math.round(y + i * ch), qx = Math.round(x + (j + 1) * cw), qy = Math.round(y + (i + 1) * ch);
      const ddx = ((px + qx) / 2 - (x + cxr * w)) / rx, ddy = ((py + qy) / 2 - (y + cyr * h)) / ry;
      rect(px, py, qx - px, qy - py, sample(st, Math.hypot(ddx, ddy)), alpha);
    }
  }
}

/** A box's background: color, then images (gradients and url()s) over it, inside its rounded border box. */
function background(b: Box, x: number, y: number, w: number, h: number, r: [number, number, number, number], alpha: number): void {
  const bg = color(b, "background-color");
  if (bg[3] > 0) roundRect(x, y, w, h, r, bg, alpha);
  const img = b.style.get("background-image");
  if (img === "none" || img === "") return;
  const saved = clip;
  pushClip({ x0: x, y0: y, x1: x + w, y1: y + h, r });
  for (const layer of split(img, true).reverse()) {
    if (/gradient\(/.test(layer)) gradient(layer, b, x, y, w, h, alpha);
    else {
      const u = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(layer);
      if (u !== null) {
        const file = env.controlText === undefined ? null : backgroundFile(u[1] ?? "");
        if (file !== null) {
          const size = b.style.get("background-size");
          let dw = w, dh = h;
          const nat = imageSizeOf(file);
          if (nat !== null && size !== "100% 100%") {
            const k = size === "contain" ? Math.min(w / nat[0], h / nat[1]) : size === "cover" ? Math.max(w / nat[0], h / nat[1]) : env.S;
            dw = nat[0] * k; dh = nat[1] * k;
          }
          image(file, x + (w - dw) / 2 * (size === "contain" || size === "cover" ? 1 : 0), y + (h - dh) / 2 * (size === "contain" || size === "cover" ? 1 : 0), dw, dh, alpha);
        }
      }
    }
  }
  clip = saved;
}

let backgroundFile: (url: string) => string | null = () => null;
let imageSizeOf: (file: string) => [number, number] | null = () => null;
export function setImageResolvers(file: (url: string) => string | null, size: (file: string) => [number, number] | null): void { backgroundFile = file; imageSizeOf = size; }

function pushClip(c: Clip): void {
  if (clip === null) { clip = c; return; }
  // intersect (keeping the inner radii)
  clip = { x0: Math.max(clip.x0, c.x0), y0: Math.max(clip.y0, c.y0), x1: Math.min(clip.x1, c.x1), y1: Math.min(clip.y1, c.y1), r: c.r[0] + c.r[1] + c.r[2] + c.r[3] > 0 ? c.r : clip.r };
}

function shadows(value: string, b: Box, x: number, y: number, w: number, h: number, r: [number, number, number, number], alpha: number): void {
  if (value === "none" || value === "") return;
  const S = env.S;
  for (const sh of split(value, true).reverse()) {
    const parts = split(sh);
    if (parts.includes("inset")) continue;
    const c = parts.map((p) => parseColor(p, b.style.color)).find((p) => p !== null) ?? b.style.color;
    const nums = parts.filter((p) => parseColor(p) === null && p !== "inset").map((p) => length(p, ctx(b, 0)) * S);
    const ox = nums[0] ?? 0, oy = nums[1] ?? 0, blur = Math.max(0, nums[2] ?? 0), spread = nums[3] ?? 0;
    // blur as layers growing outward, each fainter
    const layers = blur <= 0 ? 1 : Math.max(2, Math.min(8, Math.ceil(blur / (3 * S))));
    for (let k = layers; k >= 1; k--) {
      const e = spread + (blur * (k - 0.5)) / layers;
      const a = blur <= 0 ? 1 : 1.6 / layers * (1 - (k - 1) / layers);
      roundRect(x + ox - e, y + oy - e, w + 2 * e, h + 2 * e, r.map((v) => v + e) as [number, number, number, number], c, alpha * a);
    }
  }
}

// ---------------------------------------------------------------- boxes

function isStackingContext(b: Box): boolean {
  const s = b.style;
  return (b.position !== "static" && s.get("z-index") !== "auto") || Number(s.get("opacity")) < 1 || s.get("transform") !== "none" || b.position === "fixed";
}

interface Ctx { xf: Xf; alpha: number; clip: Clip | null; scrollY: number }

/** Paint a box and its subtree as one stacking context. */
function paintContext(b: Box, c: Ctx): void {
  const deferred: { box: Box; z: number; ctx: Ctx; seq: number }[] = [];
  let seq = 0;
  const visit = (box: Box, cc: Ctx, root: boolean): void => {
    if (!root && box.position !== "static" && box.kind !== "text") {
      const z = parseInt(box.style.get("z-index"), 10);
      deferred.push({ box, z: Number.isFinite(z) ? z : 0, ctx: cc, seq: seq++ });
      return;
    }
    if (!root && isStackingContext(box)) { paintContext(box, cc); return; }
    paintOwn(box, cc);
    // the subtree, inside this box's clip and scroll
    const inner = childContext(box, cc);
    clip = inner.clip;
    for (const child of box.children) if (child.kind !== "text") visit(child, inner, false);
    paintText(box, inner);
    clip = cc.clip;
  };
  // the root's own transform and opacity
  const own = contextOf(b, c);
  visit(b, own, true);
  deferred.sort((p, q) => p.z - q.z || p.seq - q.seq);
  for (const d of deferred) { clip = d.ctx.clip; paintContext(d.box, d.ctx); }
  clip = c.clip;
}

function contextOf(b: Box, c: Ctx): Ctx {
  const t = transformOf(b);
  const opacity = Number(b.style.get("opacity"));
  return { xf: t === null ? c.xf : compose(c.xf, t), alpha: c.alpha * (Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1), clip: c.clip, scrollY: c.scrollY };
}

/** The context for a box's children: its transform and opacity are already in c; clip and scroll if it has overflow. */
function childContext(b: Box, c: Ctx): Ctx {
  const ox = b.style.get("overflow-x"), oy = b.style.get("overflow-y");
  if ((ox === "visible" && oy === "visible") || b.kind === "inline") return c;
  const S = env.S;
  const [x0, y0] = apply(c.xf, b.x + b.border.l, b.y + b.border.t);
  const [x1, y1] = apply(c.xf, b.x + b.w - b.border.r, b.y + b.h - b.border.b);
  const r = radii(b).map((v, i) => Math.max(0, v - (i === 0 || i === 3 ? b.border.l : b.border.r)) * S * c.xf.a) as [number, number, number, number];
  const saved = clip;
  clip = c.clip;
  pushClip({ x0: x0 * S, y0: y0 * S, x1: x1 * S, y1: y1 * S, r });
  const next = clip;
  clip = saved;
  // scrolled content moves up
  const scroll = b.el !== null && (oy === "auto" || oy === "scroll") ? b.el.scrollTop : 0;
  const xf = scroll !== 0 ? compose(c.xf, { a: 1, d: 1, tx: 0, ty: -scroll }) : c.xf;
  return { xf, alpha: c.alpha, clip: next, scrollY: c.scrollY + scroll };
}

/** A box's own drawing: shadow, background, border, outline, replaced content; and where it is. */
function paintOwn(b: Box, c: Ctx): void {
  const el = b.el;
  const S = env.S;
  const s = b.style;
  const visible = s.get("visibility") !== "hidden" && s.get("visibility") !== "collapse";
  const rects = b.kind === "inline" ? b.inlineRects : [{ x: b.x, y: b.y, w: b.w, h: b.h }];
  // where it is, for hit testing and geometry (CSS px on screen)
  if (el !== null) {
    const [x0, y0] = apply(c.xf, b.x, b.y);
    env.place(el, { x: x0, y: y0, w: b.w * c.xf.a, h: b.h * c.xf.d }, visible && s.get("pointer-events") !== "none", order++);
    if (el === env.view) viewAt = cmds.length;
  }
  if (!visible || c.alpha <= 0) return;
  for (const rr of rects) {
    const [X0, Y0] = apply(c.xf, rr.x, rr.y);
    const x = X0 * S, y = Y0 * S, w = rr.w * c.xf.a * S, h = rr.h * c.xf.d * S;
    if (w <= 0 && h <= 0) continue;
    const r = radii(b).map((v) => v * S * c.xf.a) as [number, number, number, number];
    shadows(s.get("box-shadow"), b, x, y, w, h, r, c.alpha);
    const bw = [b.border.t, b.border.r, b.border.b, b.border.l].map((v) => v * S * c.xf.a) as [number, number, number, number];
    // background under the border (border-box); the canvas's (root or body) is painted already
    if (b !== skipBackground) background(b, x, y, w, h, r, c.alpha);
    const cols: [Rgba, Rgba, Rgba, Rgba] = [color(b, "border-top-color"), color(b, "border-right-color"), color(b, "border-bottom-color"), color(b, "border-left-color")];
    const style = s.get("border-top-style");
    borderRing(x, y, w, h, r, bw, cols, c.alpha, style === "dashed" || style === "dotted" ? style : null);
    // outline (focus rings)
    const os = s.get("outline-style");
    if (os !== "none" && os !== "") {
      const ow = (length(s.get("outline-width") === "medium" ? "3px" : s.get("outline-width"), ctx(b, 0)) || 0) * S;
      const off = (length(s.get("outline-offset"), ctx(b, 0)) || 0) * S;
      const oc = parseColor(s.get("outline-color"), s.color) ?? s.color;
      const e = off + ow;
      if (ow > 0) borderRing(x - e, y - e, w + 2 * e, h + 2 * e, r.map((v) => (v > 0 ? v + e : 0)) as [number, number, number, number], [ow, ow, ow, ow], [oc, oc, oc, oc], c.alpha);
    }
  }
  if (b.kind === "replaced" && el !== null) paintReplaced(b, c);
  if (b.marker !== "") paintMarker(b, c);
}

/** A list item's marker, right-aligned before its first line's text. */
function paintMarker(b: Box, c: Ctx): void {
  const first = firstFragment(b);
  if (first === null) return;
  const S = env.S;
  const em = first.size;
  const left = b.x + b.border.l + b.padding.l;
  if (b.marker === "•" || b.marker === "◦" || b.marker === "▪") {
    // a disc like a browser's: about a third of an em, on the x-height middle
    const d = em * 0.36;
    const [X, Y] = apply(c.xf, left - em * 0.9, first.y + em - em * 0.5 - d / 2);
    const r = b.marker === "▪" ? 0 : (d * S) / 2;
    if (b.marker === "◦") borderRing(X * S, Y * S, d * S, d * S, [r, r, r, r], [S, S, S, S], [first.style.color, first.style.color, first.style.color, first.style.color], c.alpha);
    else roundRect(X * S, Y * S, d * S, d * S, [r, r, r, r], first.style.color, c.alpha);
    return;
  }
  const w = measure(b.marker, first.style);
  const [X, Y] = apply(c.xf, left - w - em * 0.5, first.y);
  text(first, b.marker, X * S, Y * S, first.size * S * c.xf.a, first.style.color, c.alpha, false);
}

function firstFragment(b: Box): Fragment | null {
  if (b.fragments.length > 0) return b.fragments[0] as Fragment;
  for (const k of b.children) { const f = firstFragment(k); if (f !== null) return f; }
  return null;
}

function paintReplaced(b: Box, c: Ctx): void {
  const el = b.el as Element;
  const S = env.S;
  const [X, Y] = apply(c.xf, b.x + b.border.l + b.padding.l, b.y + b.border.t + b.padding.t);
  const w = (b.w - b.border.l - b.border.r - b.padding.l - b.padding.r) * c.xf.a, h = (b.h - b.border.t - b.border.b - b.padding.t - b.padding.b) * c.xf.d;
  const file = (el as unknown as { file?: string | null }).file;
  if (el.localName === "img" && typeof file === "string") {
    const fit = b.style.get("object-fit");
    let dw = w, dh = h, dx = X, dy = Y;
    const nat = imageSizeOf(file);
    if (nat !== null && (fit === "contain" || fit === "cover")) {
      const k = fit === "contain" ? Math.min(w / nat[0], h / nat[1]) : Math.max(w / nat[0], h / nat[1]);
      dw = nat[0] * k; dh = nat[1] * k; dx = X + (w - dw) / 2; dy = Y + (h - dh) / 2;
    }
    image(file, dx * S, dy * S, dw * S, dh * S, c.alpha);
    return;
  }
  const t = env.controlText(el);
  if (t !== null && t.text !== "") {
    const s = b.style;
    const size = s.fontSize * S * c.xf.a;
    const col = t.dim ? mixColor(s.color, [s.color[0], s.color[1], s.color[2], 0], 0.5) : s.color;
    const f: Fragment = { text: t.text, x: X, y: Y, w, style: s, face: faceOf(b), size: s.fontSize, spacing: 0 };
    const saved = clip;
    pushClip({ x0: X * S, y0: Y * S, x1: (X + w) * S, y1: (Y + h) * S, r: [0, 0, 0, 0] });
    // centered on the font's content area; Bloom draws the baseline at y + size
    const content = (f.face.ascent + f.face.descent) * s.fontSize;
    const baseline = Y + (h - content * c.xf.d) / 2 + f.face.ascent * s.fontSize * c.xf.d;
    text(f, t.text, X * S, (baseline - s.fontSize * c.xf.d) * S, size, col, c.alpha, Number(s.get("font-weight")) >= 600 && f.face.synthBold);
    clip = saved;
  }
}

let skipBackground: Box | null = null;
let faceOf: (b: Box) => Fragment["face"] = () => { throw new Error("no faces"); };
export function setFaceOf(fn: (b: Box) => Fragment["face"]): void { faceOf = fn; }

/** A block container's text, with text-shadow and text-overflow: ellipsis. */
function paintText(b: Box, c: Ctx): void {
  if (b.fragments.length === 0 || c.alpha <= 0) return;
  const S = env.S;
  const ellipsis = b.style.get("text-overflow") === "ellipsis" && b.style.get("overflow-x") !== "visible";
  const right = b.x + b.w - b.border.r - b.padding.r;
  for (const f of b.fragments) {
    const s = f.style;
    if (s.get("visibility") === "hidden") continue;
    let t = f.text;
    if (ellipsis && f.x + f.w > right + 0.5) {
      // cut to fit with "…"
      const room = right - f.x - measure("…", s);
      while (t.length > 0 && measure(t, s) > room) t = t.slice(0, -1);
      t = t.trimEnd() + "…";
    }
    const [X, Y] = apply(c.xf, f.x, f.y);
    const size = f.size * S * c.xf.a;
    const bold = Number(s.get("font-weight")) >= 600 && f.face.synthBold;
    const ts = s.get("text-shadow");
    if (ts !== "none" && ts !== "") {
      for (const sh of split(ts, true).reverse()) {
        const parts = split(sh);
        const col = parts.map((p) => parseColor(p, s.color)).find((p) => p !== null) ?? s.color;
        const nums = parts.filter((p) => parseColor(p) === null).map((p) => length(p, { em: s.fontSize, rem: env.rem, vw: 0, vh: 0, percent: 0, env: env.env }) * S);
        const ox = nums[0] ?? 0, oy = nums[1] ?? 0, blur = nums[2] ?? 0;
        if (blur > 0) {
          // a blurred shadow as a few faint copies around the offset
          const d = blur / 3;
          for (const [dx, dy] of [[-d, 0], [d, 0], [0, -d], [0, d]]) text(f, t, X * S + ox + (dx ?? 0), Y * S + oy + (dy ?? 0), size, col, c.alpha * 0.35, bold);
        } else text(f, t, X * S + ox, Y * S + oy, size, col, c.alpha, bold);
      }
    }
    text(f, t, X * S, Y * S, size, s.color, c.alpha, bold);
    const deco = s.get("text-decoration-line");
    if (deco.includes("underline")) rect(X * S, (Y + s.fontSize * 0.95) * S, f.w * S * c.xf.a, Math.max(1, s.fontSize * S / 14), s.color, c.alpha);
    if (deco.includes("line-through")) rect(X * S, (Y + s.fontSize * 0.55) * S, f.w * S * c.xf.a, Math.max(1, s.fontSize * S / 14), s.color, c.alpha);
  }
}

// ---------------------------------------------------------------- entry

/** Record the page's drawing; returns the commands to run (those after the view canvas). */
export function paintPage(root: Box, e: PaintEnv): Cmd[] {
  env = e;
  cmds = [];
  viewAt = -1;
  order = 0;
  clip = null;
  // the root's background (or the body's, when the root has none) covers the whole canvas
  skipBackground = null;
  const body = root.children.find((c) => c.el?.localName === "body") ?? null;
  const own = color(root, "background-color");
  const canvasBox = own[3] > 0 || root.style.get("background-image") !== "none" ? root : body;
  if (canvasBox !== null) {
    skipBackground = canvasBox;
    const S = e.S;
    background(canvasBox, 0, 0, e.viewport.w * S, e.viewport.h * S, [0, 0, 0, 0], 1);
  }
  paintContext(root, { xf: IDENTITY, alpha: 1, clip: null, scrollY: 0 });
  const out = viewAt >= 0 ? cmds.slice(viewAt) : cmds;
  cmds = [];
  return out;
}
