/**
 * A 2D canvas context that keeps RGBA bytes, for the textures the app paints (boards, floors, the
 * sky gradient). Bloom uploads the bytes as a texture (renderer.ts).
 *
 * The subset of CanvasRenderingContext2D the app uses: paths (moveTo, lineTo, quadratic and
 * bezier curves, arc, arcTo, ellipse, rect, closePath), fill with the nonzero or evenodd rule,
 * stroke (lineWidth, lineCap, round joins), clip, fillRect/strokeRect/clearRect, linear and radial
 * gradients, globalAlpha, affine transforms with save/restore, get/putImageData, and a small
 * bitmap font for fillText.
 *
 * Paths are flattened to polygons in device space and filled by scanline with 4 sub-scanlines a
 * pixel and exact horizontal coverage, so edges are antialiased. Strokes become polygons (a quad
 * per segment, discs at joins and round caps) filled as a union. A clip is a coverage mask.
 * Hot loops follow Perry's rules (hoisted lengths, 2-argument Math.min/max, typed arrays).
 */

export interface CanvasLike { width: number; height: number; data: Uint8ClampedArray | null }

type Rgba = [number, number, number, number];

/**
 * CanvasGradient, in the user space at fill time: linear between two points, or radial between
 * two circles (r0 < 0 marks a linear one).
 */
export class Gradient {
  readonly stops: { offset: number; color: Rgba }[] = [];
  readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number;
  readonly r0: number; readonly r1: number;
  constructor(x0: number, y0: number, x1: number, y1: number, r0 = -1, r1 = -1) {
    this.x0 = x0; this.y0 = y0; this.x1 = x1; this.y1 = y1; this.r0 = r0; this.r1 = r1;
  }
  addColorStop(offset: number, color: string): void {
    this.stops.push({ offset: Math.min(1, Math.max(0, offset)), color: parseColor(color) });
    this.stops.sort((a, b) => a.offset - b.offset);
  }
}

type Paint = string | Gradient;

/** A clip: coverage (0..1) over its bounding box; everything outside it is clipped away. */
interface Clip { x0: number; y0: number; w: number; h: number; mask: Float32Array }

function clipAt(c: Clip, x: number, y: number): number {
  const cx = x - c.x0, cy = y - c.y0;
  return cx < 0 || cy < 0 || cx >= c.w || cy >= c.h ? 0 : (c.mask[cy * c.w + cx] ?? 0);
}

interface State {
  fillStyle: Paint; strokeStyle: Paint; lineWidth: number; lineCap: string; lineJoin: string;
  globalAlpha: number; font: string; textAlign: string; textBaseline: string;
  m: number[]; clip: Clip | null;
}

const SUB = 4;   // sub-scanlines per pixel row

export class Canvas2D {
  fillStyle: Paint = "#000000";
  strokeStyle: Paint = "#000000";
  lineWidth = 1;
  lineCap = "butt";
  lineJoin = "miter";
  globalAlpha = 1;
  font = "10px sans-serif";
  textAlign = "start";
  textBaseline = "alphabetic";
  readonly canvas: CanvasLike;
  // affine transform [a, b, c, d, e, f] (as in setTransform)
  private m = [1, 0, 0, 1, 0, 0];
  private clipMask: Clip | null = null;
  private stack: State[] = [];
  // the current path: closed polygons and the open subpath being built, all in device space
  private polys: number[][] = [];
  private closed: boolean[] = [];
  private cur: number[] = [];
  constructor(canvas: CanvasLike) { this.canvas = canvas; }

  // ------------------------------------------------------------ state

  save(): void {
    this.stack.push({
      fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, lineCap: this.lineCap,
      lineJoin: this.lineJoin, globalAlpha: this.globalAlpha, font: this.font, textAlign: this.textAlign,
      textBaseline: this.textBaseline, m: this.m.slice(), clip: this.clipMask,
    });
  }
  restore(): void {
    const s = this.stack.pop();
    if (s === undefined) return;
    this.fillStyle = s.fillStyle; this.strokeStyle = s.strokeStyle; this.lineWidth = s.lineWidth; this.lineCap = s.lineCap;
    this.lineJoin = s.lineJoin; this.globalAlpha = s.globalAlpha; this.font = s.font; this.textAlign = s.textAlign;
    this.textBaseline = s.textBaseline; this.m = s.m; this.clipMask = s.clip;
  }
  translate(x: number, y: number): void { this.transform(1, 0, 0, 1, x, y); }
  scale(x: number, y: number): void { this.transform(x, 0, 0, y, 0, 0); }
  rotate(angle: number): void {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    this.transform(cos, sin, -sin, cos, 0, 0);
  }
  transform(a2: number, b2: number, c2: number, d2: number, e2: number, f2: number): void {
    const m = this.m;
    const a = m[0] ?? 1, b = m[1] ?? 0, c = m[2] ?? 0, d = m[3] ?? 1, e = m[4] ?? 0, f = m[5] ?? 0;
    this.m = [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f];
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void { this.m = [a, b, c, d, e, f]; }
  resetTransform(): void { this.m = [1, 0, 0, 1, 0, 0]; }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): Gradient { return new Gradient(x0, y0, x1, y1); }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): Gradient {
    return new Gradient(x0, y0, x1, y1, Math.max(0, r0), Math.max(0, r1));
  }

  private px(x: number, y: number): number { const m = this.m; return (m[0] ?? 1) * x + (m[2] ?? 0) * y + (m[4] ?? 0); }
  private py(x: number, y: number): number { const m = this.m; return (m[1] ?? 0) * x + (m[3] ?? 1) * y + (m[5] ?? 0); }
  /** How much the transform scales lengths (for line widths and curve flattening). */
  private unit(): number { const m = this.m; return Math.sqrt(Math.abs((m[0] ?? 1) * (m[3] ?? 1) - (m[1] ?? 0) * (m[2] ?? 0))); }

  // ------------------------------------------------------------ path

  beginPath(): void { this.polys = []; this.closed = []; this.cur = []; }
  private flush(close: boolean): void {
    if (this.cur.length >= 4) { this.polys.push(this.cur); this.closed.push(close); }
    this.cur = [];
  }
  moveTo(x: number, y: number): void { this.flush(false); this.cur.push(this.px(x, y), this.py(x, y)); }
  lineTo(x: number, y: number): void {
    if (this.cur.length === 0) { this.moveTo(x, y); return; }
    this.cur.push(this.px(x, y), this.py(x, y));
  }
  closePath(): void {
    const n = this.cur.length;
    if (n < 2) return;
    const x = this.cur[0] ?? 0, y = this.cur[1] ?? 0;
    this.flush(true);
    this.cur.push(x, y);   // a new subpath starts where the closed one began
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath();
  }
  /** The last point, back in user space (curves start from it). */
  private last(): [number, number] {
    const n = this.cur.length;
    const X = this.cur[n - 2] ?? 0, Y = this.cur[n - 1] ?? 0;
    const m = this.m;
    const a = m[0] ?? 1, b = m[1] ?? 0, c = m[2] ?? 0, d = m[3] ?? 1, e = m[4] ?? 0, f = m[5] ?? 0;
    const det = a * d - b * c;
    if (det === 0) return [0, 0];
    return [(d * (X - e) - c * (Y - f)) / det, (a * (Y - f) - b * (X - e)) / det];
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    if (this.cur.length === 0) this.moveTo(cx, cy);
    const [x0, y0] = this.last();
    const n = Math.max(4, Math.min(64, Math.ceil(Math.hypot(x - x0, y - y0) * this.unit() / 3)));
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      this.lineTo(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y);
    }
  }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    if (this.cur.length === 0) this.moveTo(c1x, c1y);
    const [x0, y0] = this.last();
    const n = Math.max(6, Math.min(96, Math.ceil(Math.hypot(x - x0, y - y0) * this.unit() / 3)));
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      this.lineTo(u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
        u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y);
    }
  }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void { this.ellipse(x, y, r, r, 0, a0, a1, ccw); }
  /** A line toward (x1, y1), then an arc of radius r that turns toward (x2, y2). */
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    if (this.cur.length === 0) { this.moveTo(x1, y1); return; }
    const [x0, y0] = this.last();
    const ax = x0 - x1, ay = y0 - y1, bx = x2 - x1, by = y2 - y1;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    const cross = ax * by - ay * bx;
    if (r <= 0 || la === 0 || lb === 0 || Math.abs(cross) < 1e-9) { this.lineTo(x1, y1); return; }
    // the arc touches both lines at distance d from the corner
    const angle = Math.acos(Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb))));
    const d = r / Math.tan(angle / 2);
    const tax = x1 + ax / la * d, tay = y1 + ay / la * d, tbx = x1 + bx / lb * d, tby = y1 + by / lb * d;
    // the center: r along the normal of the first line, on the side of the second
    const side = cross > 0 ? 1 : -1;
    const nx = -ay / la * side, ny = ax / la * side;
    const cx = tax - nx * r, cy = tay - ny * r;
    this.lineTo(tax, tay);
    const a0 = Math.atan2(tay - cy, tax - cx), a1 = Math.atan2(tby - cy, tbx - cx);
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
    this.ellipse(cx, cy, r, r, 0, a0, a0 + sweep, sweep < 0);
  }
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, a0: number, a1: number, ccw = false): void {
    let sweep = a1 - a0;
    const full = Math.PI * 2;
    if (!ccw && sweep < 0) sweep = sweep % full + full;
    if (ccw && sweep > 0) sweep = sweep % full - full;
    if (Math.abs(a1 - a0) >= full) sweep = ccw ? -full : full;
    const r = Math.max(rx, ry) * this.unit();
    const n = Math.max(8, Math.min(128, Math.ceil(Math.abs(sweep) * Math.max(2, Math.sqrt(r) * 2.5))));
    const cos = Math.cos(rotation), sin = Math.sin(rotation);
    for (let i = 0; i <= n; i++) {
      const t = a0 + sweep * i / n;
      const ex = Math.cos(t) * rx, ey = Math.sin(t) * ry;
      this.lineTo(x + ex * cos - ey * sin, y + ex * sin + ey * cos);
    }
  }

  /** The path's polygons (every subpath, closed for filling). */
  private fillPolys(): number[][] {
    const out: number[][] = [];
    const polys = this.polys, n = polys.length;
    for (let i = 0; i < n; i++) { const p = polys[i]; if (p !== undefined && p.length >= 6) out.push(p); }
    if (this.cur.length >= 6) out.push(this.cur);
    return out;
  }

  fill(rule: string = "nonzero"): void {
    this.paint(this.fillPolys(), rule === "evenodd", this.fillStyle);
  }
  stroke(): void {
    const all: number[][] = [];
    const polys = this.polys, n = polys.length;
    for (let i = 0; i < n; i++) { const p = polys[i]; if (p !== undefined) all.push(...strokePolys(p, this.closed[i] === true, this.lineWidth * this.unit(), this.lineCap)); }
    if (this.cur.length >= 4) all.push(...strokePolys(this.cur, false, this.lineWidth * this.unit(), this.lineCap));
    this.paint(all, false, this.strokeStyle);
  }
  clip(rule: string = "nonzero"): void {
    const W = this.canvas.width, H = this.canvas.height;
    const polys = this.fillPolys();
    // the clip's box: the path's bounds, inside the previous clip's
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    const np = polys.length;
    for (let i = 0; i < np; i++) {
      const p = polys[i];
      if (p === undefined) continue;
      const len = p.length;
      for (let j = 0; j < len; j += 2) {
        x0 = Math.min(x0, Math.floor(p[j] ?? 0)); x1 = Math.max(x1, Math.ceil(p[j] ?? 0) + 1);
        y0 = Math.min(y0, Math.floor(p[j + 1] ?? 0)); y1 = Math.max(y1, Math.ceil(p[j + 1] ?? 0) + 1);
      }
    }
    const old = this.clipMask;
    if (old !== null) { x0 = Math.max(x0, old.x0); y0 = Math.max(y0, old.y0); x1 = Math.min(x1, old.x0 + old.w); y1 = Math.min(y1, old.y0 + old.h); }
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
    const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
    const clip: Clip = { x0, y0, w, h, mask: new Float32Array(Math.max(1, w * h)) };
    if (w > 0 && h > 0) {
      rasterize(polys, rule === "evenodd", W, H, (rx, y, cov, n) => {
        if (y < y0 || y >= y0 + h) return;
        for (let i = 0; i < n; i++) {
          const x = rx + i - x0;
          if (x < 0 || x >= w) continue;
          let v = cov[i] ?? 0;
          if (old !== null) v *= clipAt(old, rx + i, y);
          clip.mask[(y - y0) * w + x] = v;
        }
      }, clip);
    }
    this.clipMask = clip;
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const m = this.m;
    const plain = (m[0] ?? 1) === 1 && (m[1] ?? 0) === 0 && (m[2] ?? 0) === 0 && (m[3] ?? 1) === 1 && this.clipMask === null && typeof this.fillStyle === "string";
    const X = x + (m[4] ?? 0), Y = y + (m[5] ?? 0);
    if (plain && X === Math.round(X) && Y === Math.round(Y) && w === Math.round(w) && h === Math.round(h)) {
      this.solidRect(X, Y, w, h, parseColor(this.fillStyle as string));
      return;
    }
    const keep = [this.polys, this.closed, this.cur] as const;
    this.beginPath(); this.rect(x, y, w, h);
    this.paint(this.fillPolys(), false, this.fillStyle);
    [this.polys, this.closed, this.cur] = [keep[0], keep[1], keep[2]];
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    const keep = [this.polys, this.closed, this.cur] as const;
    this.beginPath(); this.rect(x, y, w, h); this.stroke();
    [this.polys, this.closed, this.cur] = [keep[0], keep[1], keep[2]];
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    const data = this.pixels(), W = this.canvas.width, H = this.canvas.height;
    const m = this.m;
    const x0 = Math.max(0, Math.floor(x + (m[4] ?? 0))), y0 = Math.max(0, Math.floor(y + (m[5] ?? 0)));
    const x1 = Math.min(W, Math.ceil(x + w + (m[4] ?? 0))), y1 = Math.min(H, Math.ceil(y + h + (m[5] ?? 0)));
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
      const k = (py * W + px) * 4;
      data[k] = 0; data[k + 1] = 0; data[k + 2] = 0; data[k + 3] = 0;
    }
  }

  // ------------------------------------------------------------ text (a 5x7 bitmap font)

  measureText(text: string): { width: number } { return { width: text.length * 6 * this.textScale() }; }
  private textScale(): number { const m = /(\d+)px/.exec(this.font); return Math.max(1, Math.round(Number(m?.[1] ?? 10) / 8)); }
  fillText(text: string, x: number, y: number): void {
    const s = this.textScale();
    const width = text.length * 6 * s - s;
    let left = x;
    if (this.textAlign === "center") left = x - width / 2;
    else if (this.textAlign === "right" || this.textAlign === "end") left = x - width;
    let top = y - 7 * s;
    if (this.textBaseline === "middle") top = y - 3.5 * s;
    else if (this.textBaseline === "top") top = y;
    const n = text.length;
    for (let i = 0; i < n; i++) {
      const glyph = GLYPHS[text.charAt(i).toLowerCase()];
      if (glyph === undefined) continue;
      for (let cell = 0; cell < 35; cell++) {
        if (glyph.charAt(cell) === "#") this.fillRect(left + (i * 6 + cell % 5) * s, top + Math.floor(cell / 5) * s, s, s);
      }
    }
  }

  // ------------------------------------------------------------ pixels

  /** A copy of the pixels in a rectangle (device space, transform ignored, as in the browser). */
  getImageData(x: number, y: number, w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } {
    const src = this.pixels(), W = this.canvas.width, H = this.canvas.height;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      const sy = y + row;
      if (sy < 0 || sy >= H) continue;
      for (let col = 0; col < w; col++) {
        const sx = x + col;
        if (sx < 0 || sx >= W) continue;
        const s = (sy * W + sx) * 4, d = (row * w + col) * 4;
        data[d] = src[s] ?? 0; data[d + 1] = src[s + 1] ?? 0; data[d + 2] = src[s + 2] ?? 0; data[d + 3] = src[s + 3] ?? 0;
      }
    }
    return { width: w, height: h, data };
  }
  /** Write pixels back unblended (no clip, alpha or transform, as in the browser). */
  putImageData(img: { width: number; height: number; data: Uint8ClampedArray }, x: number, y: number): void {
    const dst = this.pixels(), W = this.canvas.width, H = this.canvas.height;
    const w = img.width, h = img.height, src = img.data;
    for (let row = 0; row < h; row++) {
      const dy = y + row;
      if (dy < 0 || dy >= H) continue;
      for (let col = 0; col < w; col++) {
        const dx = x + col;
        if (dx < 0 || dx >= W) continue;
        const s = (row * w + col) * 4, d = (dy * W + dx) * 4;
        dst[d] = src[s] ?? 0; dst[d + 1] = src[s + 1] ?? 0; dst[d + 2] = src[s + 2] ?? 0; dst[d + 3] = src[s + 3] ?? 0;
      }
    }
  }
  createImageData(w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }

  private pixels(): Uint8ClampedArray {
    const c = this.canvas;
    if (c.data === null || c.data.length !== c.width * c.height * 4) c.data = new Uint8ClampedArray(c.width * c.height * 4);
    return c.data;
  }

  /** An axis-aligned, pixel-aligned rectangle in one solid color: no coverage to compute. */
  private solidRect(x: number, y: number, w: number, h: number, color: Rgba): void {
    const data = this.pixels(), W = this.canvas.width, H = this.canvas.height;
    const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(W, x + w), y1 = Math.min(H, y + h);
    const a = color[3] * this.globalAlpha;
    if (x1 <= x0 || y1 <= y0 || a <= 0) return;
    if (a >= 1) {
      // opaque: write one row, copy it down (boards and backgrounds are mostly this)
      const r = color[0], g = color[1], b = color[2];
      const first = (y0 * W + x0) * 4, end = first + (x1 - x0) * 4;
      for (let k = first; k < end; k += 4) { data[k] = r; data[k + 1] = g; data[k + 2] = b; data[k + 3] = 255; }
      for (let py = y0 + 1; py < y1; py++) data.copyWithin((py * W + x0) * 4, first, end);
      return;
    }
    for (let py = y0; py < y1; py++) {
      let k = (py * W + x0) * 4;
      for (let px = x0; px < x1; px++) { blend(data, k, color[0], color[1], color[2], a); k += 4; }
    }
  }

  /** Fill polygons (device space) with a paint, through the clip, at globalAlpha. */
  private paint(polys: number[][], evenodd: boolean, paint: Paint): void {
    if (polys.length === 0) return;
    const data = this.pixels(), W = this.canvas.width, H = this.canvas.height;
    const clip = this.clipMask, alpha = this.globalAlpha;
    if (typeof paint === "string") {
      const c = parseColor(paint);
      const a = c[3] * alpha;
      if (a <= 0) return;
      const r = c[0], g = c[1], b = c[2];
      rasterize(polys, evenodd, W, H, (x0, y, cov, n) => {
        const row = y * W;
        let k = (row + x0) * 4;
        for (let i = 0; i < n; i++) {
          let v = cov[i] ?? 0;
          if (clip !== null) v *= clipAt(clip, x0 + i, y);
          // fully covered and opaque (most of a shape): the color, without blending
          if (v >= 1 && a >= 1) { data[k] = r; data[k + 1] = g; data[k + 2] = b; data[k + 3] = 255; }
          else if (v > 0) blend(data, k, r, g, b, a * v);
          k += 4;
        }
      }, clip);
      return;
    }
    // linear gradient: its line in device space, t = projection onto it
    const g = paint;
    const gx0 = this.px(g.x0, g.y0), gy0 = this.py(g.x0, g.y0), gx1 = this.px(g.x1, g.y1), gy1 = this.py(g.x1, g.y1);
    const dx = gx1 - gx0, dy = gy1 - gy0, len2 = dx * dx + dy * dy;
    const stops = g.stops, ns = stops.length;
    if (ns === 0) return;
    const radial = g.r0 >= 0;
    // radial: pixels go back to user space, where the circles are (inverse transform)
    const m = this.m;
    const ma = m[0] ?? 1, mb = m[1] ?? 0, mc = m[2] ?? 0, md = m[3] ?? 1, me = m[4] ?? 0, mf = m[5] ?? 0;
    const det = ma * md - mb * mc;
    const cdx = g.x1 - g.x0, cdy = g.y1 - g.y0, dr = g.r1 - g.r0;
    const qa = cdx * cdx + cdy * cdy - dr * dr;
    rasterize(polys, evenodd, W, H, (x0, y, cov, n) => {
      const row = y * W;
      let k = (row + x0) * 4;
      for (let i = 0; i < n; i++) {
        let v = cov[i] ?? 0;
        if (clip !== null) v *= clipAt(clip, x0 + i, y);
        let t = 0;
        if (v > 0 && radial) {
          // the largest t whose circle (center c0 + t(c1 - c0), radius r0 + t dr >= 0) passes through the pixel
          const X = x0 + i + 0.5 - me, Y = y + 0.5 - mf;
          const ux = det === 0 ? 0 : (md * X - mc * Y) / det - g.x0, uy = det === 0 ? 0 : (ma * Y - mb * X) / det - g.y0;
          const qb = ux * cdx + uy * cdy + g.r0 * dr, qc = ux * ux + uy * uy - g.r0 * g.r0;
          if (Math.abs(qa) < 1e-9) t = qb === 0 ? 0 : qc / (2 * qb);
          else {
            const disc = qb * qb - qa * qc;
            if (disc < 0) v = 0;
            else {
              const root = Math.sqrt(disc);
              const ta = (qb + root) / qa, tb = (qb - root) / qa;
              const hi = Math.max(ta, tb), lo = Math.min(ta, tb);
              if (g.r0 + hi * dr >= 0) t = hi;
              else if (g.r0 + lo * dr >= 0) t = lo;
              else v = 0;
            }
          }
          t = Math.min(1, Math.max(0, t));
        } else if (v > 0) {
          t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x0 + i + 0.5 - gx0) * dx + (y + 0.5 - gy0) * dy) / len2));
        }
        if (v > 0) {
          let j = 0;
          while (j < ns - 1 && (stops[j + 1]?.offset ?? 1) < t) j++;
          const s0 = stops[j], s1 = stops[Math.min(j + 1, ns - 1)];
          if (s0 !== undefined && s1 !== undefined) {
            const span = s1.offset - s0.offset, f = span <= 0 ? 0 : Math.min(1, Math.max(0, (t - s0.offset) / span));
            const c0 = s0.color, c1 = s1.color;
            blend(data, k, c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f,
              (c0[3] + (c1[3] - c0[3]) * f) * alpha * v);
          }
        }
        k += 4;
      }
    }, clip);
  }
}

/** Source-over of one non-premultiplied color at alpha a onto data[k..k+3]. */
function blend(data: Uint8ClampedArray, k: number, r: number, g: number, b: number, a: number): void {
  if (a >= 1) { data[k] = r; data[k + 1] = g; data[k + 2] = b; data[k + 3] = 255; return; }
  const da = (data[k + 3] ?? 0) / 255;
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  const w = da * (1 - a);
  data[k] = (r * a + (data[k] ?? 0) * w) / oa;
  data[k + 1] = (g * a + (data[k + 1] ?? 0) * w) / oa;
  data[k + 2] = (b * a + (data[k + 2] ?? 0) * w) / oa;
  data[k + 3] = oa * 255;
}

/**
 * Scanline-fill polygons (flat [x0, y0, x1, y1, ...], each implicitly closed) and hand each
 * covered row's coverage (0..1 per pixel, from x0 for n pixels) to `row`.
 */
function rasterize(polys: number[][], evenodd: boolean, W: number, H: number,
  row: (x0: number, y: number, cov: Float32Array, n: number) => void, within: Clip | null = null): void {
  // edges, and the bounding box
  let count = 0;
  const np = polys.length;
  for (let i = 0; i < np; i++) count += (polys[i]?.length ?? 0) / 2;
  const ex0 = new Float64Array(count), ey0 = new Float64Array(count), ex1 = new Float64Array(count), ey1 = new Float64Array(count);
  const dir = new Int8Array(count);
  let e = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < np; i++) {
    const p = polys[i];
    if (p === undefined) continue;
    const len = p.length;
    for (let j = 0; j < len; j += 2) {
      const ax = p[j] ?? 0, ay = p[j + 1] ?? 0;
      const bx = p[(j + 2) % len] ?? 0, by = p[(j + 3) % len] ?? 0;
      minX = Math.min(minX, ax); maxX = Math.max(maxX, ax); minY = Math.min(minY, ay); maxY = Math.max(maxY, ay);
      if (ay === by) continue;
      if (ay < by) { ex0[e] = ax; ey0[e] = ay; ex1[e] = bx; ey1[e] = by; dir[e] = 1; }
      else { ex0[e] = bx; ey0[e] = by; ex1[e] = ax; ey1[e] = ay; dir[e] = -1; }
      e++;
    }
  }
  const edges = e;
  if (edges === 0) return;
  // the path's box, inside the canvas and the clip's box
  let lx = 0, ly = 0, hx = W, hy = H;
  if (within !== null) { lx = within.x0; ly = within.y0; hx = within.x0 + within.w; hy = within.y0 + within.h; }
  const bx0 = Math.max(lx, Math.floor(minX)), bx1 = Math.min(hx, Math.ceil(maxX) + 1);
  const by0 = Math.max(ly, Math.floor(minY)), by1 = Math.min(hy, Math.ceil(maxY));
  const n = bx1 - bx0;
  if (n <= 0 || by1 <= by0) return;
  const cov = new Float32Array(n);
  const xs = new Float64Array(edges), ws = new Int8Array(edges);
  const weight = 1 / SUB;
  for (let y = by0; y < by1; y++) {
    cov.fill(0);
    let any = false;
    for (let s = 0; s < SUB; s++) {
      const sy = y + (s + 0.5) / SUB;
      // crossings of this sub-scanline, sorted by x (insertion sort: few per line)
      let c = 0;
      for (let i = 0; i < edges; i++) {
        const y0 = ey0[i] ?? 0, y1 = ey1[i] ?? 0;
        if (sy < y0 || sy >= y1) continue;
        const x = (ex0[i] ?? 0) + ((ex1[i] ?? 0) - (ex0[i] ?? 0)) * (sy - y0) / (y1 - y0);
        let k = c;
        while (k > 0 && (xs[k - 1] ?? 0) > x) { xs[k] = xs[k - 1] ?? 0; ws[k] = ws[k - 1] ?? 0; k--; }
        xs[k] = x; ws[k] = dir[i] ?? 0;
        c++;
      }
      // spans inside the path, added with exact horizontal coverage
      let wind = 0;
      for (let k = 0; k < c - 1; k++) {
        wind += ws[k] ?? 0;
        const inside = evenodd ? (wind & 1) !== 0 : wind !== 0;
        if (!inside) continue;
        const xa = Math.max(bx0, xs[k] ?? 0) - bx0, xb = Math.min(bx1, xs[k + 1] ?? 0) - bx0;
        if (xb <= xa) continue;
        any = true;
        const ia = Math.floor(xa), ib = Math.floor(xb);
        if (ia === ib) { cov[ia] = (cov[ia] ?? 0) + (xb - xa) * weight; continue; }
        cov[ia] = (cov[ia] ?? 0) + (ia + 1 - xa) * weight;
        for (let i = ia + 1; i < ib; i++) cov[i] = (cov[i] ?? 0) + weight;
        if (ib < n) cov[ib] = (cov[ib] ?? 0) + (xb - ib) * weight;
      }
    }
    if (any) {
      for (let i = 0; i < n; i++) if ((cov[i] ?? 0) > 1) cov[i] = 1;
      row(bx0, y, cov, n);
    }
  }
}

/** A polyline (device space) as polygons of one orientation: a quad per segment, discs at joins and round caps. */
function strokePolys(p: number[], closed: boolean, width: number, cap: string): number[][] {
  const out: number[][] = [];
  const hw = Math.max(0.35, width / 2);
  const len = p.length;
  const pts = closed && len >= 6 ? p.concat([p[0] ?? 0, p[1] ?? 0]) : p;
  const n = pts.length;
  for (let j = 0; j + 3 < n; j += 2) {
    let ax = pts[j] ?? 0, ay = pts[j + 1] ?? 0, bx = pts[j + 2] ?? 0, by = pts[j + 3] ?? 0;
    const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy);
    if (l === 0) continue;
    const ux = dx / l, uy = dy / l, nx = -uy * hw, ny = ux * hw;
    if (cap === "square" && !closed) {
      if (j === 0) { ax -= ux * hw; ay -= uy * hw; }
      if (j + 4 >= n) { bx += ux * hw; by += uy * hw; }
    }
    out.push(orient([ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny]));
  }
  // discs: at every interior vertex (round joins) and, for round caps, at the ends
  const first = 0, lastV = n - 2;
  for (let j = 0; j < n; j += 2) {
    const end = j === first || j === lastV;
    if (end && !closed && cap !== "round") continue;
    out.push(disc(pts[j] ?? 0, pts[j + 1] ?? 0, hw));
  }
  return out;
}

function disc(x: number, y: number, r: number): number[] {
  const n = Math.max(8, Math.min(48, Math.ceil(r * 3)));
  const out: number[] = [];
  for (let i = 0; i < n; i++) { const t = i / n * Math.PI * 2; out.push(x + Math.cos(t) * r, y + Math.sin(t) * r); }
  return out;
}

/** The polygon with positive signed area (so a union of them fills under the nonzero rule). */
function orient(p: number[]): number[] {
  let area = 0;
  const n = p.length;
  for (let j = 0; j < n; j += 2) area += (p[j] ?? 0) * (p[(j + 3) % n] ?? 0) - (p[(j + 2) % n] ?? 0) * (p[j + 1] ?? 0);
  if (area >= 0) return p;
  const out: number[] = [];
  for (let j = n - 2; j >= 0; j -= 2) out.push(p[j] ?? 0, p[j + 1] ?? 0);
  return out;
}

const GLYPHS: Record<string, string> = {
  a: "...........###.....#.#####...#.####", b: "#....#....####.#...##...##...#####.", c: "...........#####....#....#.....####",
  d: "....#....#.#####...##...##...#.####", e: "...........###.#...#######....#####", f: "..##..#...####..#....#....#....#...",
  g: ".......####...##...#.####....#.###.", h: "#....#....####.#...##...##...##...#", "1": "..#...##....#....#....#....#...###.",
  "2": ".###.#...#....#...#...#...#...#####", "3": "####.....#....#.###.....#....#####.", "4": "...#...##..#.#.#..#.#####...#....#.",
  "5": "######....####.....#....##...#.###.", "6": ".###.#....#....####.#...##...#.###.", "7": "#####....#...#...#...#....#....#...",
  "8": ".###.#...##...#.###.#...##...#.###.",
};

const colorCache = new Map<string, Rgba>();

/** #rgb, #rrggbb, rgb(...), rgba(...) and a few names -> [r, g, b, alpha 0..1]. */
export function parseColor(css: string): Rgba {
  const hit = colorCache.get(css);
  if (hit !== undefined) return hit;
  const s = css.trim().toLowerCase();
  let out: Rgba = [0, 0, 0, 1];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex !== null) {
    let h = hex[1] ?? "000";
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    const v = parseInt(h, 16);
    out = [(v >> 16) & 255, (v >> 8) & 255, v & 255, 1];
  } else {
    const fn = /^rgba?\(([^)]*)\)$/.exec(s);
    if (fn !== null) {
      const parts = (fn[1] ?? "").split(/[\s,/]+/).filter((x) => x !== "").map(Number);
      out = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts.length > 3 ? (parts[3] ?? 1) : 1];
    } else if (s === "white") out = [255, 255, 255, 1];
    else if (s === "transparent") out = [0, 0, 0, 0];
  }
  colorCache.set(css, out);
  return out;
}
