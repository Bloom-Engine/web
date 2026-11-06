/**
 * MutationObserver (childList, attributes, characterData, subtree, old
 * values, attributeFilter; records delivered in a microtask),
 * ResizeObserver (element boxes, checked once a frame by `checkObservers`),
 * IntersectionObserver (an element is intersecting while its box overlaps
 * the viewport; also checked once a frame).
 */
import { Element, mutationSinks, type MutationRecordInit, type Node, type Rect } from "./node.ts";

export interface MutationObserverInit {
  childList?: boolean; attributes?: boolean; characterData?: boolean; subtree?: boolean;
  attributeOldValue?: boolean; characterDataOldValue?: boolean; attributeFilter?: string[];
}

export interface MutationRecord {
  readonly type: string; readonly target: Node; readonly addedNodes: Node[]; readonly removedNodes: Node[];
  readonly previousSibling: Node | null; readonly nextSibling: Node | null;
  readonly attributeName: string | null; readonly attributeNamespace: null; readonly oldValue: string | null;
}

const observers = new Set<MutationObserver>();

export class MutationObserver {
  private targets: { node: Node; options: MutationObserverInit }[] = [];
  private queue: MutationRecord[] = [];
  private scheduled = false;
  private readonly callback: (records: MutationRecord[], observer: MutationObserver) => void;
  constructor(callback: (records: MutationRecord[], observer: MutationObserver) => void) { this.callback = callback; }

  observe(node: Node, options: MutationObserverInit = {}): void {
    const o = { ...options };
    if (o.attributeOldValue === true || o.attributeFilter !== undefined) o.attributes ??= true;
    if (o.characterDataOldValue === true) o.characterData ??= true;
    if (o.childList !== true && o.attributes !== true && o.characterData !== true) throw new TypeError("MutationObserver.observe: one of childList, attributes, characterData is required");
    const existing = this.targets.find((t) => t.node === node);
    if (existing !== undefined) existing.options = o; else this.targets.push({ node, options: o });
    observers.add(this);
  }
  disconnect(): void { this.targets = []; this.queue = []; observers.delete(this); }
  takeRecords(): MutationRecord[] { const q = this.queue; this.queue = []; return q; }

  /** @internal */ _offer(r: MutationRecordInit): void {
    for (const { node, options } of this.targets) {
      if (r.target !== node && !(options.subtree === true && node.contains(r.target))) continue;
      if (r.type === "childList" && options.childList !== true) continue;
      if (r.type === "attributes") {
        if (options.attributes !== true) continue;
        if (options.attributeFilter !== undefined && !options.attributeFilter.includes(r.attributeName ?? "")) continue;
      }
      if (r.type === "characterData" && options.characterData !== true) continue;
      const keepOld = r.type === "attributes" ? options.attributeOldValue === true : r.type === "characterData" ? options.characterDataOldValue === true : false;
      this.queue.push({
        type: r.type, target: r.target, addedNodes: r.addedNodes ?? [], removedNodes: r.removedNodes ?? [],
        previousSibling: r.previousSibling ?? null, nextSibling: r.nextSibling ?? null,
        attributeName: r.attributeName ?? null, attributeNamespace: null, oldValue: keepOld ? r.oldValue ?? null : null,
      });
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => {
          this.scheduled = false;
          const records = this.takeRecords();
          if (records.length > 0) this.callback(records, this);
        });
      }
      return;   // once per record, however many of its targets match
    }
  }
}

mutationSinks.push((r) => {
  if (observers.size === 0) return;
  for (const o of observers) o._offer(r);
});

// ---------------------------------------------------------------- ResizeObserver

export interface ResizeObserverEntry {
  readonly target: Element;
  readonly contentRect: { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number };
  readonly borderBoxSize: { inlineSize: number; blockSize: number }[];
  readonly contentBoxSize: { inlineSize: number; blockSize: number }[];
  readonly devicePixelContentBoxSize: { inlineSize: number; blockSize: number }[];
}

const resizeObservers = new Set<ResizeObserver>();

export class ResizeObserver {
  private targets = new Map<Element, { w: number; h: number }>();
  private readonly callback: (entries: ResizeObserverEntry[], observer: ResizeObserver) => void;
  constructor(callback: (entries: ResizeObserverEntry[], observer: ResizeObserver) => void) { this.callback = callback; }
  observe(target: Element, _options?: unknown): void {
    // the first check reports the current size, as in the browser
    this.targets.set(target, { w: -1, h: -1 });
    resizeObservers.add(this);
  }
  unobserve(target: Element): void { this.targets.delete(target); }
  disconnect(): void { this.targets.clear(); resizeObservers.delete(this); }
  /** @internal */ _check(ratio: number): void {
    const entries: ResizeObserverEntry[] = [];
    for (const [target, last] of this.targets) {
      const b: Rect = target._layoutBox();
      if (b.w === last.w && b.h === last.h) continue;
      last.w = b.w; last.h = b.h;
      const size = [{ inlineSize: b.w, blockSize: b.h }];
      entries.push({
        target,
        contentRect: { x: 0, y: 0, width: b.w, height: b.h, top: 0, left: 0, right: b.w, bottom: b.h },
        borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: [{ inlineSize: b.w * ratio, blockSize: b.h * ratio }],
      });
    }
    if (entries.length > 0) this.callback(entries, this);
  }
}

// ---------------------------------------------------------------- IntersectionObserver

const intersectionObservers = new Set<IntersectionObserver>();

export class IntersectionObserver {
  readonly root: Element | null;
  readonly rootMargin: string;
  readonly thresholds: number[];
  private targets = new Map<Element, boolean | null>();
  private readonly callback: (entries: unknown[], observer: IntersectionObserver) => void;
  constructor(callback: (entries: unknown[], observer: IntersectionObserver) => void, options: { root?: Element | null; rootMargin?: string; threshold?: number | number[] } = {}) {
    this.callback = callback;
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? "0px";
    const t = options.threshold ?? 0;
    this.thresholds = Array.isArray(t) ? t : [t];
  }
  observe(target: Element): void { this.targets.set(target, null); intersectionObservers.add(this); }
  unobserve(target: Element): void { this.targets.delete(target); }
  disconnect(): void { this.targets.clear(); intersectionObservers.delete(this); }
  takeRecords(): unknown[] { return []; }
  /** @internal */ _check(viewport: { w: number; h: number }): void {
    const entries: unknown[] = [];
    for (const [target, was] of this.targets) {
      const b = target._layoutBox();
      const ix = Math.max(0, Math.min(b.x + b.w, viewport.w) - Math.max(b.x, 0));
      const iy = Math.max(0, Math.min(b.y + b.h, viewport.h) - Math.max(b.y, 0));
      const area = b.w * b.h;
      const ratio = area > 0 ? (ix * iy) / area : target.isConnected && !target.hidden ? 1 : 0;
      const now = ratio > 0 || (area === 0 && ratio === 1);
      if (now === was) continue;
      this.targets.set(target, now);
      const rect = { x: b.x, y: b.y, width: b.w, height: b.h, top: b.y, left: b.x, right: b.x + b.w, bottom: b.y + b.h };
      entries.push({ target, isIntersecting: now, intersectionRatio: ratio, boundingClientRect: rect, intersectionRect: rect, rootBounds: { x: 0, y: 0, width: viewport.w, height: viewport.h }, time: Date.now() });
    }
    if (entries.length > 0) this.callback(entries, this);
  }
}

/** Run once a frame: deliver ResizeObserver and IntersectionObserver changes. */
export function checkObservers(viewport: { w: number; h: number }, ratio: number): void {
  for (const o of resizeObservers) o._check(ratio);
  for (const o of intersectionObservers) o._check(viewport);
}
