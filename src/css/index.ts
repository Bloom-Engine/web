/**
 * The page, drawn from its HTML and CSS over the 3D view: a small browser
 * engine (cascade.ts, layout.ts, paint.ts, anim.ts) run each frame after
 * the game's frame.
 *
 * Styles are recomputed when the DOM changes (a MutationObserver-style
 * sink), when :hover/:active/:focus change, or when the viewport does;
 * layout and the paint list are rebuilt then and while something animates;
 * otherwise the last paint list is drawn again. Every element gets its
 * layout box (on screen, after transforms), so hit testing, geometry and
 * the observers see the page as drawn. A wheel event nobody prevented
 * scrolls the nearest scrollable box.
 */
import { existsSync } from "node:fs";
import { Element, mutationSinks, setLayoutBox, type Document } from "../dom/node.ts";
import { HTMLImageElement, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLCanvasElement } from "../dom/elements.ts";
import { config } from "../config.ts";
import { fetchFile, localPath } from "../fetch.ts";
import { imageSize } from "../image.ts";
import { readFileSync } from "node:fs";
import { onAfterFrame, pixelRatio, safeArea, cssSize } from "../frame.ts";
import { Animator } from "./anim.ts";
import { Cascade, type Computed } from "./cascade.ts";
import { faceFor, setFontFaces } from "./fonts.ts";
import { Box, buildBoxes, layoutPage } from "./layout.ts";
import { paintPage, setFaceOf, setImageResolvers } from "./paint.ts";
import { parseSheet, type Sheet } from "./sheet.ts";

/** The user agent stylesheet: what a browser gives every page. */
export const UA_CSS = `
html, address, blockquote, body, center, dialog, div, figure, figcaption, footer, form, header, hr, legend, listing, main, p, plaintext, pre, search, xmp,
details, summary, article, aside, h1, h2, h3, h4, h5, h6, hgroup, nav, section, dir, dd, dl, dt, menu, ol, ul, li, fieldset, optgroup { display: block; }
head, link, meta, script, style, title, template, base, noscript, datalist, param, area, map, track, [hidden], option { display: none; }
html { color: canvastext; font-family: serif; font-size: 16px; line-height: normal; }
body { margin: 8px; }
h1 { font-size: 2em; margin: .67em 0; font-weight: bold; }
h2 { font-size: 1.5em; margin: .83em 0; font-weight: bold; }
h3 { font-size: 1.17em; margin: 1em 0; font-weight: bold; }
h4 { margin: 1.33em 0; font-weight: bold; }
h5 { font-size: .83em; margin: 1.67em 0; font-weight: bold; }
h6 { font-size: .67em; margin: 2.33em 0; font-weight: bold; }
p, blockquote, figure, dl, pre { margin: 1em 0; }
ul, ol, menu { margin: 1em 0; padding-left: 40px; }
li { display: list-item; }
b, strong, th { font-weight: bold; }
i, em, cite, var, dfn { font-style: italic; }
small { font-size: smaller; }
big { font-size: larger; }
sub, sup { font-size: smaller; }
code, kbd, samp, tt, pre { font-family: monospace; }
pre { white-space: pre; }
u, ins { text-decoration: underline; }
s, del, strike { text-decoration: line-through; }
a:link, a:any-link { color: #0000ee; text-decoration: underline; cursor: pointer; }
hr { border: 1px inset #808080; margin: .5em auto; }
fieldset { margin: 0 2px; padding: .35em .75em .625em; border: 2px groove #c0c0c0; }
img, canvas, video, svg, iframe, embed, object { display: inline-block; }
button, input, select, textarea, meter, progress { display: inline-block; font: 13.33px sans-serif; color: buttontext; }
button { padding: 1px 6px; border: 2px outset buttonface; background-color: buttonface; text-align: center; cursor: default; }
input, textarea { padding: 1px 2px; border: 2px inset #767676; background-color: field; color: fieldtext; cursor: text; }
input[type=button], input[type=submit], input[type=reset] { padding: 1px 6px; border: 2px outset buttonface; background-color: buttonface; color: buttontext; cursor: default; }
input[type=checkbox], input[type=radio] { margin: 3px 3px 3px 4px; padding: 0; border: 1px solid #767676; background-color: field; }
input[type=radio] { border-radius: 50%; }
input[type=hidden] { display: none; }
select { padding: 1px 2px; border: 1px solid #767676; border-radius: 3px; background-color: field; }
textarea { white-space: pre-wrap; }
dialog { position: absolute; left: 0; right: 0; margin: auto; border: solid; padding: 1em; background-color: canvas; color: canvastext; width: fit-content; }
dialog:not([open]) { display: none; }
dialog:modal { position: fixed; top: 0; bottom: 0; max-width: calc(100% - 6px - 2em); max-height: calc(100% - 6px - 2em); }
summary { display: list-item; cursor: default; }
details:not([open]) > :not(summary) { display: none; }
:focus-visible { outline: auto 1px -webkit-focus-ring-color; }
table { display: table; border-collapse: separate; border-spacing: 2px; }
tr { display: table-row; } td, th { display: table-cell; padding: 1px; }
output { display: inline; }
`.replace(/-webkit-focus-ring-color/g, "#1a73e8").replace(/outline: auto/g, "outline: 2px solid");

/** Natural size of replaced elements and form controls, in CSS px. */
function natural(e: Element, s: Computed | undefined): { w: number; h: number } | null {
  const fs = s?.fontSize ?? 13.33;
  if (e instanceof HTMLImageElement) return e.naturalWidth > 0 ? { w: e.naturalWidth, h: e.naturalHeight } : { w: 0, h: 0 };
  if (e instanceof HTMLCanvasElement) return { w: e.width, h: e.height };
  if (e instanceof HTMLInputElement) {
    const t = e.type;
    if (t === "checkbox" || t === "radio") return { w: 13, h: 13 };
    if (t === "range") return { w: 129, h: 16 };
    if (t === "color") return { w: 50, h: 27 };
    if (t === "submit" || t === "button" || t === "reset") return { w: Math.max(fs * 0.6 * (e.value.length || 6), 20), h: fs * 1.2 };
    return { w: fs * 0.55 * (e.size || 20), h: fs * 1.2 };
  }
  if (e instanceof HTMLSelectElement) return { w: Math.max(40, ...e.options.map((o) => o.text.length * fs * 0.6)) + 24, h: fs * 1.2 };
  if (e instanceof HTMLTextAreaElement) return { w: fs * 0.55 * e.cols, h: fs * 1.2 * e.rows };
  if (e.localName === "video" || e.localName === "iframe" || e.localName === "embed" || e.localName === "object") return { w: 300, h: 150 };
  if (e.localName === "svg") return { w: Number(e.getAttribute("width")) || 300, h: Number(e.getAttribute("height")) || 150 };
  return null;
}

function controlText(e: Element): { text: string; dim: boolean } | null {
  if (e instanceof HTMLInputElement) {
    const t = e.type;
    if (t === "checkbox") return { text: e.checked ? "✓" : "", dim: false };
    if (t === "radio") return { text: e.checked ? "●" : "", dim: false };
    if (t === "range" || t === "color" || t === "hidden" || t === "file") return null;
    const v = e.value;
    if (v === "") return { text: e.placeholder, dim: true };
    return { text: t === "password" ? "•".repeat(v.length) : v, dim: false };
  }
  if (e instanceof HTMLTextAreaElement) return e.value === "" ? { text: e.placeholder, dim: true } : { text: e.value, dim: false };
  if (e instanceof HTMLSelectElement) return { text: (e.selectedOptions[0]?.text ?? "") + "  ▾", dim: false };
  return null;
}

const UA = parseSheet(UA_CSS, 0);
const PROFILE = process.env["BLOOM_CSS_PROFILE"] === "1";

export class Page {
  private readonly doc: Document;
  private readonly view: () => Element | null;
  private cascade = new Cascade();
  private animator = new Animator();
  private dirty = true;
  private signature = "";
  private styles = new Map<Element, Computed>();
  private root: Box | null = null;
  private boxes = new Map<Element, Box>();
  private list: (() => void)[] = [];
  private placed = new Set<Element>();

  constructor(doc: Document, view: () => Element | null) {
    this.doc = doc;
    this.view = view;
    mutationSinks.push(() => { this.dirty = true; });
    this.animator.setKeyframes((n) => this.cascade.keyframes(n) as never);
    setFaceOf((b) => faceFor(b.style.get("font-family"), Number(b.style.get("font-weight")) || 400, b.style.get("font-style")));
    setImageResolvers((url) => { const p = localPath(url); return p !== null && existsSync(p) ? p : null; }, (file) => {
      try { return imageSize(readFileSync(file)); } catch { return null; }
    });
  }

  /** The stylesheets: the UA's, then the page's <style> and <link rel=stylesheet> in order. */
  private sheets(): Sheet[] {
    const parts: string[] = [];
    for (const e of this.doc.querySelectorAll("style, link")) {
      if (e.localName === "style") parts.push(e.textContent ?? "");
      else if ((e.getAttribute("rel") ?? "").split(/\s+/).includes("stylesheet")) {
        const href = e.getAttribute("href");
        if (href !== null) { const r = fetchFile(new URL(href, this.doc.URL).href); if (r !== null && r.ok) parts.push(readFileSync(localPath(new URL(href, this.doc.URL).href) ?? "", "utf8")); }
      }
    }
    return [UA, parseSheet(parts.join("\n"))];
  }
  private parsed: Sheet[] | null = null;
  private parsedFor = "\u0000";

  computed(e: Element): Computed | undefined { return this.styles.get(e); }

  /** Draw the page (call once a frame, inside the drawing pass). */
  frame(): void {
    const doc = this.doc;
    const root = doc.documentElement;
    if (root === null) return;
    const S = pixelRatio();
    const { width, height } = cssSize();
    const sig = [width, height, S, doc._hover?.localName, doc._active?.localName, doc._focused?.localName, doc._focusVisible].join("|") + objId(doc._hover) + objId(doc._active) + objId(doc._focused);
    const now = Date.now() / 1000;
    const safe = safeArea();
    const env = (name: string): number => {
      const n = name.trim();
      return n === "safe-area-inset-top" ? safe.top : n === "safe-area-inset-right" ? safe.right : n === "safe-area-inset-bottom" ? safe.bottom : n === "safe-area-inset-left" ? safe.left : NaN;
    };
    let relayout = false;
    const t0 = Date.now();
    let t1 = t0, t2 = t0;
    if (this.dirty || sig !== this.signature) {
      this.signature = sig;
      this.dirty = false;
      const current = this.doc.querySelectorAll("style, link").map((e) => e.textContent ?? e.getAttribute("href") ?? "").join("\u0001");
      if (this.parsed === null || current !== this.parsedFor) {
        this.parsedFor = current;
        this.parsed = this.sheets();
        this.cascade.setSheets(this.parsed);
        setFontFaces(this.parsed.flatMap((s) => s.fonts));
      }
      const mq = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
      this.cascade.run(root, { vw: width, vh: height, env, mediaMatches: (q) => mq?.(q).matches ?? false });
      this.styles = this.cascade.styles;
      const rendered = (e: Element): boolean => {
        for (let p: Element | null = e; p !== null; p = p.parentElement) if (this.styles.get(p)?.get("display").trim() === "none") return false;
        return true;
      };
      this.animator.update(this.styles, rendered, now);
      relayout = true;
      t1 = Date.now();
    }
    if (relayout || this.animator.active) {
      const styles = this.animator.apply(this.styles, now);
      this.root = buildBoxes(root, styles);
      this.boxes.clear();
      if (this.root !== null) {
        const index = (b: Box): void => { if (b.el !== null) this.boxes.set(b.el, b); for (const c of b.children) index(c); };
        index(this.root);
        const rootSize = this.styles.get(root)?.fontSize ?? 16;
        layoutPage(this.root, { vw: width, vh: height, rem: rootSize, env, natural: (e) => natural(e, styles.get(e)) });
        t2 = Date.now();
        const was = this.placed;
        this.placed = new Set();
        this.list = paintPage(this.root, {
          S, viewport: { w: width, h: height }, rem: rootSize, env, view: this.view(),
          place: (e, rect, hit, order) => { setLayoutBox(e, rect); e._noHit = !hit; e._order = order; this.placed.add(e); },
          controlText,
        });
        for (const e of was) if (!this.placed.has(e) && e !== this.view()) { setLayoutBox(e, null); e._order = -1; }
      } else this.list = [];
      if (PROFILE) console.error(`css: style ${t1 - t0} ms, layout ${t2 - t1} ms, paint ${Date.now() - t2} ms, ${this.list.length} draws, ${this.styles.size} elements`);
    }
    for (const cmd of this.list) cmd();
  }

  /** Scroll the nearest scrollable box around an element (a wheel nobody prevented). Returns whether it moved. */
  scroll(target: Element, dy: number): boolean {
    for (let e: Element | null = target; e !== null; e = e.parentElement) {
      const b = this.boxes.get(e);
      if (b === undefined) continue;
      const oy = b.style.get("overflow-y");
      if (oy !== "auto" && oy !== "scroll") continue;
      const visible = b.h - b.border.t - b.border.b - b.padding.t - b.padding.b;
      const max = Math.max(0, b.contentH - visible);
      if (max <= 0) continue;
      const next = Math.max(0, Math.min(max, e.scrollTop + dy));
      if (next === e.scrollTop) continue;
      e.scrollTop = next;
      this.dirty = true;
      return true;
    }
    return false;
  }
}

const ids = new WeakMap<object, number>();
let nextId = 1;
function objId(o: object | null): string {
  if (o === null) return "-";
  let id = ids.get(o);
  if (id === undefined) { id = nextId++; ids.set(o, id); }
  return String(id);
}

/** Install the CSS page painter (unless config.page is "none"). */
export function installPage(doc: Document, view: () => Element | null): Page | null {
  if (config().page === "none") return null;
  const page = new Page(doc, view);
  onAfterFrame(() => page.frame());
  return page;
}
