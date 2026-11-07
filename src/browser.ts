/**
 * The browser globals over the DOM (dom/): the page's `document`, parsed
 * from its own index.html, and `window` with location, navigator, screen,
 * innerWidth/innerHeight (live), devicePixelRatio, matchMedia,
 * getComputedStyle, requestAnimationFrame, timers' friends, Worker, and the
 * DOM's classes (Event, KeyboardEvent, HTMLElement, MutationObserver, ...)
 * as globals.
 *
 * Window events (resize, keydown that bubbled up, ...) go to `windowTarget`,
 * whose listeners see `globalThis` as `this` and currentTarget, as in the
 * browser where window is the global object.
 */
import { readFileSync } from "node:fs";
import * as dom from "./dom/index.ts";
import { Document, Element, EventTarget, MessageEvent, Event, styleDeclaration, parseDeclarations, setLayoutBox, type HTMLCanvasElement } from "./dom/index.ts";
import { config, pageUrl, webRoot } from "./config.ts";
import { MOBILE, TV, cancelAnimationFrame, cssSize, pixelRatio, quit, requestAnimationFrame } from "./frame.ts";

const g = globalThis as Record<string, unknown>;

/** The window as an event target: listeners get globalThis as `this` and currentTarget. */
class WindowTarget extends EventTarget {
  override _self(): unknown { return globalThis; }
}
export const windowTarget = new WindowTarget();

// ---------------------------------------------------------------- the document

function readPage(): string {
  try { return readFileSync(webRoot() + "index.html", "utf8"); } catch {
    console.error("@bloomengine/web: no index.html in " + webRoot() + " (set root in configure())");
    return "<!doctype html><html><head></head><body></body></html>";
  }
}

export const document = new Document();
document._url = pageUrl();
document._window = windowTarget;
document.defaultView = globalThis;
document.readyState = "loading";
dom.parseDocument(document, readPage());

// ---------------------------------------------------------------- location

const query = process.env["BLOOM_QUERY"] ?? "";
const pageHref = pageUrl();

/** window.location: a file:// URL into the served folder. Only the hash can change (no navigation). */
class Location {
  private url: URL;
  constructor(href: string) { this.url = new URL(href); }
  get href(): string { return this.url.href; }
  set href(v: string) { this.assign(v); }
  get protocol(): string { return this.url.protocol; }
  get host(): string { return this.url.host; }
  get hostname(): string { return this.url.hostname; }
  get port(): string { return this.url.port; }
  get origin(): string { return "file://"; }
  get pathname(): string { return this.url.pathname; }
  get search(): string { return this.url.search; }
  set search(v: string) { this.url.search = v; }
  get hash(): string { return this.url.hash; }
  set hash(v: string) {
    const old = this.url.href;
    this.url.hash = v;
    if (this.url.href !== old) setTimeout(() => windowTarget.dispatchEvent(new Event("hashchange")), 0);
  }
  get ancestorOrigins(): string[] { return []; }
  assign(v: string): void {
    const next = new URL(v, this.url.href);
    // the same page with another hash is the only navigation there is
    if (next.pathname === this.url.pathname && next.search === this.url.search) this.hash = next.hash;
    else console.error("location: no navigation to " + next.href);
  }
  replace(v: string): void { this.assign(v); }
  reload(): void { console.error("location.reload(): not supported"); }
  toString(): string { return this.url.href; }
}
export const location = new Location(pageHref + (query === "" ? "" : query.startsWith("?") ? query : "?" + query));
document._url = location.href;

// ---------------------------------------------------------------- Worker

/**
 * Workers. Perry's own Worker runs a worker module on a thread of its own and wins over this one.
 * Where it isn't there, the game imports its worker module into the page, as the browser's
 * `self` is the window here: the module's `self.onmessage` hears what Worker objects post, and
 * its `postMessage(reply)` goes back to them, asynchronously, on the main thread.
 */
const workers: Worker[] = [];
class Worker extends EventTarget {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(_url: unknown, _options?: unknown) { super(); workers.push(this); }
  postMessage(data: unknown): void { setTimeout(() => windowTarget.dispatchEvent(new MessageEvent("message", { data })), 0); }
  terminate(): void { const i = workers.indexOf(this); if (i >= 0) workers.splice(i, 1); }
}

/** postMessage(data): a worker module's reply to its Worker objects; else a message to this window. */
function postMessage(data: unknown, _targetOrigin?: unknown): void {
  if (workers.length > 0) { for (const w of workers.slice()) setTimeout(() => w.dispatchEvent(new MessageEvent("message", { data })), 0); return; }
  setTimeout(() => windowTarget.dispatchEvent(new MessageEvent("message", { data, origin: "file://", source: globalThis })), 0);
}

// ---------------------------------------------------------------- media queries

/** Evaluate a media query against this screen: width/height ranges, orientation, pointer, hover, color scheme, motion. */
function mediaMatches(query: string): boolean {
  const { width, height } = cssSize();
  const one = (q: string): boolean => {
    const parts = q.trim().toLowerCase().split(/\s+and\s+/);
    let negate = false;
    if (parts[0]?.startsWith("not ")) { negate = true; parts[0] = parts[0].slice(4); }
    const result = parts.every((p) => {
      p = p.trim();
      if (p === "all" || p === "screen" || p === "only screen" || p === "") return true;
      if (p === "print" || p === "speech") return false;
      const m = /^\(\s*([a-z-]+)\s*(?::\s*([^)]+))?\)$/.exec(p);
      if (m === null) return false;
      const feature = m[1] ?? "", value = (m[2] ?? "").trim();
      const px = (v: string): number => parseFloat(v) * (v.endsWith("em") || v.endsWith("rem") ? 16 : 1);
      switch (feature) {
        case "min-width": return width >= px(value);
        case "max-width": return width <= px(value);
        case "width": return width === px(value);
        case "min-height": return height >= px(value);
        case "max-height": return height <= px(value);
        case "height": return height === px(value);
        case "orientation": return value === (width >= height ? "landscape" : "portrait");
        case "min-aspect-ratio": case "max-aspect-ratio": {
          const [a, b] = value.split("/").map(Number);
          const r = (a ?? 1) / (b ?? 1);
          return feature === "min-aspect-ratio" ? width / height >= r : width / height <= r;
        }
        case "pointer": case "any-pointer": return value === (MOBILE ? "coarse" : TV ? "none" : "fine");
        case "hover": case "any-hover": return value === (MOBILE || TV ? "none" : "hover");
        case "prefers-color-scheme": return value === "dark";
        case "prefers-reduced-motion": return value === "no-preference";
        case "prefers-contrast": return value === "no-preference";
        case "display-mode": return value === "fullscreen" || value === "standalone";
        case "min-resolution": return pixelRatio() * 96 >= parseFloat(value) * (value.endsWith("dppx") || value.endsWith("x") ? 96 : 1);
        case "max-resolution": return pixelRatio() * 96 <= parseFloat(value) * (value.endsWith("dppx") || value.endsWith("x") ? 96 : 1);
        case "-webkit-min-device-pixel-ratio": return pixelRatio() >= parseFloat(value);
        case "color": return true;
        case "grid": return value === "0";
        default: return false;
      }
    });
    return negate ? !result : result;
  };
  return query.split(",").some(one);
}

const mediaLists: { list: MediaQueryList; last: boolean }[] = [];
class MediaQueryList extends EventTarget {
  readonly media: string;
  onchange: ((e: Event) => void) | null = null;
  constructor(media: string) { super(); this.media = media; }
  get matches(): boolean { return mediaMatches(this.media); }
  addListener(fn: (e: Event) => void): void { this.addEventListener("change", fn); }
  removeListener(fn: (e: Event) => void): void { this.removeEventListener("change", fn); }
}

/** Re-evaluate media queries and send "change" to those that flipped (after a resize). */
export function mediaChanged(): void {
  for (const m of mediaLists) {
    const now = m.list.matches;
    if (now === m.last) continue;
    m.last = now;
    const e = new Event("change") as Event & { matches: boolean; media: string };
    e.matches = now;
    e.media = m.list.media;
    m.list.dispatchEvent(e);
  }
}

// ---------------------------------------------------------------- computed style

/**
 * getComputedStyle: the element's own style attribute, and `display: none` for hidden elements.
 * There is no stylesheet cascade without a CSS engine; values a page reads for layout come from
 * the element's layout box (width/height) when it has one.
 */
let computedProvider: ((e: Element) => Record<string, string> | null) | null = null;
/** The page painter's computed styles, for getComputedStyle. */
export function setComputedStyleProvider(fn: (e: Element) => Record<string, string> | null): void { computedProvider = fn; }
/** One computed property of an element, straight from the provider ("" without one). */
export function computedValue(e: Element, name: string): string { return computedProvider?.(e)?.[name] ?? ""; }

function getComputedStyle(e: Element, _pseudo?: string | null): unknown {
  const values = computedProvider?.(e) ?? null;
  if (values !== null) {
    const decls: [string, string, boolean][] = Object.keys(values).map((k) => [k, values[k] ?? "", false]);
    const box = e._box;
    if (box !== null) { decls.push(["width", box.w + "px", false]); decls.push(["height", box.h + "px", false]); }
    return styleDeclaration(null, decls, true);
  }
  const decls = parseDeclarations(e.getAttribute("style") ?? "");
  const has = (name: string): boolean => decls.some((d) => d[0] === name);
  if (e.hidden && !has("display")) decls.push(["display", "none", false]);
  const box = e._box;
  if (box !== null) {
    if (!has("width")) decls.push(["width", box.w + "px", false]);
    if (!has("height")) decls.push(["height", box.h + "px", false]);
  }
  return styleDeclaration(null, decls, true);
}

// ---------------------------------------------------------------- globals

const view = (): Element | null => {
  const selector = config().canvas;
  return (selector !== "" ? document.querySelector(selector) : null) ?? document.querySelector("canvas");
};
let createdCanvas: Element | null = null;

/** The canvas the 3D view draws into: the page's (config.canvas or its first <canvas>), or the one a renderer made. */
export function viewCanvas(): Element {
  const v = view();
  if (v !== null) return v;
  if (createdCanvas === null) createdCanvas = document.createElement("canvas");
  return createdCanvas;
}
/** A renderer that made its own canvas makes it the view (unless the page has one). */
export function setViewCanvas(canvas: HTMLCanvasElement): void { if (view() === null) { createdCanvas = canvas; fitView(); } }

/** The viewport, and the view canvas filling it under the page: set now, and every frame (input.ts). */
export function fitView(): void {
  const { width, height } = cssSize();
  document._viewport = { w: width, h: height };
  setLayoutBox(viewCanvas(), { x: 0, y: 0, w: width, h: height });
}

function define(name: string, get: () => unknown): void {
  Object.defineProperty(g, name, { get, configurable: true });
}

g["window"] = globalThis;
g["document"] = document;
g["self"] = globalThis;
g["globalThis"] = globalThis;
g["location"] = location;
g["history"] = { length: 1, state: null, scrollRestoration: "auto", pushState(): void {}, replaceState(): void {}, back(): void {}, forward(): void {}, go(): void {} };
g["navigator"] = {
  userAgent: "Mozilla/5.0 (Bloom; Perry) AppleWebKit/537.36 (KHTML, like Gecko)", appName: "Netscape", appVersion: "5.0",
  vendor: "Bloom", platform: process.platform === "darwin" ? (MOBILE ? "iPhone" : "MacIntel") : process.platform,
  language: process.env["LANG"]?.split(".")[0]?.replace("_", "-") ?? "en-US",
  get languages(): string[] { return [(g["navigator"] as { language: string }).language]; },
  maxTouchPoints: MOBILE ? 5 : 0, hardwareConcurrency: 8, deviceMemory: 8, onLine: true, cookieEnabled: false, webdriver: false,
  pdfViewerEnabled: false, doNotTrack: null,
  getGamepads: (): unknown[] => [],
  vibrate: (): boolean => false,
  sendBeacon: (): boolean => false,
  clipboard: { writeText: (): Promise<void> => Promise.resolve(), readText: (): Promise<string> => Promise.resolve("") },
  storage: { persist: (): Promise<boolean> => Promise.resolve(true), estimate: (): Promise<{ usage: number; quota: number }> => Promise.resolve({ usage: 0, quota: 1e9 }) },
  mediaDevices: undefined, serviceWorker: undefined, xr: undefined, gpu: undefined,
};
define("devicePixelRatio", () => pixelRatio());
define("innerWidth", () => cssSize().width);
define("innerHeight", () => cssSize().height);
define("outerWidth", () => cssSize().width);
define("outerHeight", () => cssSize().height);
define("screen", () => {
  const { width, height } = cssSize();
  return { width, height, availWidth: width, availHeight: height, colorDepth: 24, pixelDepth: 24,
    orientation: { type: width >= height ? "landscape-primary" : "portrait-primary", angle: 0, lock: (): Promise<void> => Promise.resolve(), unlock(): void {}, addEventListener(): void {}, removeEventListener(): void {} } };
});
g["screenX"] = 0; g["screenY"] = 0; g["screenLeft"] = 0; g["screenTop"] = 0;
g["scrollX"] = 0; g["scrollY"] = 0; g["pageXOffset"] = 0; g["pageYOffset"] = 0;
g["isSecureContext"] = true;
g["origin"] = "file://";
g["name"] = "";
g["closed"] = false;
g["frames"] = globalThis;
g["parent"] = globalThis;
g["top"] = globalThis;
g["opener"] = null;
g["frameElement"] = null;
g["visualViewport"] = { get width(): number { return cssSize().width; }, get height(): number { return cssSize().height; }, scale: 1, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, addEventListener(): void {}, removeEventListener(): void {} };
g["addEventListener"] = (type: string, fn: dom.EventListener, options?: boolean | dom.AddEventListenerOptions): void => windowTarget.addEventListener(type, fn, options);
g["removeEventListener"] = (type: string, fn: dom.EventListener, options?: boolean | { capture?: boolean }): void => windowTarget.removeEventListener(type, fn, options);
g["dispatchEvent"] = (event: Event): boolean => windowTarget.dispatchEvent(event);
g["requestAnimationFrame"] = requestAnimationFrame;
g["cancelAnimationFrame"] = cancelAnimationFrame;
g["requestIdleCallback"] = (fn: (d: { didTimeout: boolean; timeRemaining(): number }) => void): unknown => setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 10 }), 1);
g["cancelIdleCallback"] = (id: unknown): void => clearTimeout(id as never);
g["matchMedia"] = (q: string): MediaQueryList => { const list = new MediaQueryList(q); mediaLists.push({ list, last: list.matches }); return list; };
g["getComputedStyle"] = getComputedStyle;
g["getSelection"] = (): unknown => ({ rangeCount: 0, removeAllRanges(): void {}, addRange(): void {}, toString: (): string => "" });
g["focus"] = (): void => {};
g["blur"] = (): void => {};
g["scrollTo"] = (): void => {};
g["scrollBy"] = (): void => {};
g["scroll"] = (): void => {};
g["print"] = (): void => {};
g["open"] = (url?: string): null => { if (url !== undefined) console.error("window.open: not supported: " + url); return null; };
g["close"] = (): void => quit();
g["alert"] = (msg: unknown): void => { console.log(String(msg)); };
g["confirm"] = (msg: unknown): boolean => { console.log(String(msg)); return true; };
g["prompt"] = (msg: unknown, value?: string): string | null => { console.log(String(msg)); return value ?? null; };
g["postMessage"] = postMessage;
g["Worker"] = Worker;
g["Image"] = dom.makeImageClass(() => document);
g["Option"] = dom.makeOptionClass(() => document);
if (typeof g["performance"] === "undefined") g["performance"] = { now: (): number => Date.now(), timeOrigin: Date.now(), mark(): void {}, measure(): void {}, getEntriesByName: (): unknown[] => [] };
if (typeof g["AbortController"] === "undefined") { g["AbortController"] = dom.AbortController; g["AbortSignal"] = dom.AbortSignal; }
/** A desktop window can close itself: a page can show a Quit button when this exists (iOS and tvOS apps have none). */
if (!MOBILE && !TV && config().nativeApp) g["nativeApp"] = { quit: (): void => quit() };

// the DOM's classes, for `instanceof` and `new KeyboardEvent(...)` in page code
const classes: Record<string, unknown> = {
  Event: dom.Event, CustomEvent: dom.CustomEvent, UIEvent: dom.UIEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
  WheelEvent: dom.WheelEvent, KeyboardEvent: dom.KeyboardEvent, FocusEvent: dom.FocusEvent, InputEvent: dom.InputEvent,
  TouchEvent: dom.TouchEvent, Touch: dom.Touch, MessageEvent: dom.MessageEvent, ErrorEvent: dom.ErrorEvent, ProgressEvent: dom.ProgressEvent,
  EventTarget: dom.EventTarget, Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement, Text: dom.Text, Comment: dom.Comment,
  CharacterData: dom.CharacterData, Document: dom.Document, HTMLDocument: dom.Document, DocumentFragment: dom.DocumentFragment, DocumentType: dom.DocumentType,
  HTMLInputElement: dom.HTMLInputElement, HTMLButtonElement: dom.HTMLButtonElement, HTMLSelectElement: dom.HTMLSelectElement,
  HTMLOptionElement: dom.HTMLOptionElement, HTMLTextAreaElement: dom.HTMLTextAreaElement, HTMLLabelElement: dom.HTMLLabelElement,
  HTMLFormElement: dom.HTMLFormElement, HTMLFieldSetElement: dom.HTMLFieldSetElement, HTMLAnchorElement: dom.HTMLAnchorElement,
  HTMLDetailsElement: dom.HTMLDetailsElement, HTMLDialogElement: dom.HTMLDialogElement, HTMLTemplateElement: dom.HTMLTemplateElement,
  HTMLCanvasElement: dom.HTMLCanvasElement, HTMLImageElement: dom.HTMLImageElement, HTMLUnknownElement: dom.HTMLUnknownElement,
  SVGElement: dom.Element, DOMRect: dom.DOMRect, DOMException: dom.DOMException, DOMParser: dom.DOMParser, XMLSerializer: dom.XMLSerializer,
  MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, IntersectionObserver: dom.IntersectionObserver,
  MediaQueryList, Window: WindowTarget,
};
for (const [k, v] of Object.entries(classes)) if (k === "Event" || k === "EventTarget" || typeof g[k] === "undefined" || k.startsWith("HTML") || k === "Node" || k === "Element" || k === "Document" || k === "Text") g[k] = v;

fitView();

/** Once the app's modules ran: DOMContentLoaded and load, as a browser sends them after the scripts. */
export function pageLoaded(): void {
  document.readyState = "interactive";
  document.dispatchEvent(new Event("readystatechange"));
  document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: true }));
  document.readyState = "complete";
  document.dispatchEvent(new Event("readystatechange"));
  windowTarget.dispatchEvent(new Event("load"));
  windowTarget.dispatchEvent(new Event("pageshow"));
  if (config().autoplay && process.env["BLOOM_NO_AUTOPLAY"] === undefined) {
    // the user activation a web game waits for before it starts sound (window listeners only)
    windowTarget.dispatchEvent(new dom.PointerEvent("pointerdown", { pointerType: "mouse", isPrimary: true, button: 0, buttons: 1 }));
    windowTarget.dispatchEvent(new dom.PointerEvent("pointerup", { pointerType: "mouse", isPrimary: true, button: 0 }));
    windowTarget.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Unidentified" }));
    windowTarget.dispatchEvent(new dom.KeyboardEvent("keyup", { key: "Unidentified" }));
  }
}
