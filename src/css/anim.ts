/**
 * CSS transitions and @keyframes animations, applied to computed styles
 * each frame before layout.
 *
 * Transitions start when a transitionable property's computed value changes
 * (transition-property, -duration, -timing-function, -delay). Animations
 * start when an element is rendered with an animation-name (and restart when
 * it is rendered again after display: none), with duration, delay,
 * iteration count, direction and fill mode. Values interpolate component by
 * component: numbers with their units, colors, and the functions of a
 * transform ("none" is the matching identity). transitionend and
 * animationend events fire at the end.
 */
import { Event } from "../dom/events.ts";
import type { Element } from "../dom/node.ts";
import { Computed } from "./cascade.ts";
import type { Keyframe } from "./sheet.ts";
import { easing, parseColor, split, time, type Rgba } from "./values.ts";

const NUM = /-?\d*\.?\d+(?:e-?\d+)?/g;

function normalizeColors(v: string): string {
  return v.replace(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b[a-z]+\b/g, (m) => {
    if (/^(none|auto|inherit|translate|scale|rotate|matrix|px|em|rem|deg)/.test(m)) return m;
    const c = parseColor(m);
    return c === null ? m : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3]})`;
  });
}

/** "none" as the identity of the other side's transform functions. */
function identityOf(transform: string): string {
  return split(transform).map((fn) => {
    const m = /^([a-zA-Z0-9]+)\((.*)\)$/.exec(fn);
    if (m === null) return fn;
    const name = (m[1] ?? "").toLowerCase();
    const n = split(m[2] ?? "", true).length;
    const v = name.startsWith("scale") ? "1" : name.startsWith("rotate") || name.startsWith("skew") ? "0deg" : "0px";
    return `${m[1]}(${new Array(n).fill(v).join(", ")})`;
  }).join(" ");
}

/** Interpolate two values of the same shape (numbers replaced in place); otherwise switch halfway. */
export function interpolate(a: string, b: string, t: number): string {
  if (a === b) return a;
  let x = a.trim(), y = b.trim();
  if (x === "none" && y !== "none") x = identityOf(y);
  if (y === "none" && x !== "none") y = identityOf(x);
  x = normalizeColors(x); y = normalizeColors(y);
  const xs = x.replace(NUM, "#"), ys = y.replace(NUM, "#");
  if (xs !== ys) {
    // units differ but shape matches ("0" vs "10px"): treat bare zeros as unitless
    const xz = x.replace(/(^|[\s(,])0(?=[\s),]|$)/g, "$10px").replace(NUM, "#"), yz = y.replace(/(^|[\s(,])0(?=[\s),]|$)/g, "$10px").replace(NUM, "#");
    if (xz !== yz) return t < 0.5 ? a : b;
    x = x.replace(/(^|[\s(,])0(?=[\s),]|$)/g, "$10px"); y = y.replace(/(^|[\s(,])0(?=[\s),]|$)/g, "$10px");
  }
  const xn = (x.match(NUM) ?? []).map(Number), yn = (y.match(NUM) ?? []).map(Number);
  let i = 0;
  return x.replace(NUM, () => { const p = xn[i] ?? 0, q = yn[i] ?? 0; i++; return String(Math.round((p + (q - p) * t) * 10000) / 10000); });
}

const NOT_ANIMATABLE = new Set(["display", "position", "content", "animation-name", "transition-property", "visibility", "pointer-events", "font-family", "white-space", "overflow-x", "overflow-y"]);

interface Running { from: string; to: string; start: number; dur: number; ease: (t: number) => number }
interface AnimState { name: string; start: number; ended?: boolean }

export class Animator {
  private prev = new Map<Element, Record<string, string>>();
  private transitions = new Map<Element, Map<string, Running>>();
  private animations = new Map<Element, AnimState[]>();
  private keyframes: (name: string) => Keyframe[] | undefined = () => undefined;
  setKeyframes(fn: (name: string) => Keyframe[] | undefined): void { this.keyframes = fn; }

  /** Is anything moving (layout and paint must run every frame)? */
  get active(): boolean {
    if (this.transitions.size > 0) return true;
    for (const list of this.animations.values()) for (const a of list) if (a.ended !== true) return true;
    return false;
  }

  /**
   * After a cascade: start transitions for properties whose values changed, and note new
   * animations. `rendered` is whether each element has a box.
   */
  update(styles: Map<Element, Computed>, rendered: (e: Element) => boolean, now: number): void {
    for (const [e, s] of styles) {
      const before = this.prev.get(e);
      const shown = rendered(e);
      // transitions
      const dur = split(s.get("transition-duration"), true).map(time);
      if (before !== undefined && shown && dur.some((d) => d > 0)) {
        const props = split(s.get("transition-property"), true).map((p) => p.toLowerCase());
        const delays = split(s.get("transition-delay"), true).map(time);
        const eases = split(s.get("transition-timing-function"), true);
        const list = this.transitions.get(e) ?? new Map<string, Running>();
        for (const name of Object.keys(s.values)) {
          if (NOT_ANIMATABLE.has(name)) continue;
          const a = before[name], b = s.values[name];
          if (a === undefined || b === undefined || a === b) continue;
          let k = props.indexOf(name);
          if (k < 0) k = props.indexOf("all");
          if (k < 0) {
            // longhands of a listed shorthand (border-color -> border-top-color)
            k = props.findIndex((p) => name.startsWith(p + "-") || (p === "border-color" && /^border-.*-color$/.test(name)) || (p === "background" && name.startsWith("background-")));
          }
          if (k < 0) continue;
          const d = dur[k % dur.length] ?? 0;
          if (d <= 0) continue;
          const running = list.get(name);
          const from = running !== undefined ? this.valueOf(running, now) : a;
          list.set(name, { from, to: b, start: now + (delays[k % delays.length] ?? 0), dur: d, ease: easing(eases[k % eases.length] ?? "ease") });
        }
        if (list.size > 0) this.transitions.set(e, list);
      }
      // animations: a new name (or being shown again) starts it
      const names = split(s.get("animation-name"), true).filter((n) => n !== "none");
      const current = this.animations.get(e) ?? [];
      if (!shown || names.length === 0) { if (current.length > 0) this.animations.delete(e); }
      else {
        const next = names.map((n) => current.find((c) => c.name === n) ?? { name: n, start: now });
        this.animations.set(e, next);
      }
      this.prev.set(e, { ...s.values });
    }
    for (const e of [...this.prev.keys()]) if (!styles.has(e)) { this.prev.delete(e); this.transitions.delete(e); this.animations.delete(e); }
  }

  /** Elements no longer rendered stop animating (shown again, they start over). */
  hidden(e: Element): void { this.animations.delete(e); this.transitions.delete(e); }

  private valueOf(r: Running, now: number): string {
    const t = r.dur <= 0 ? 1 : Math.max(0, Math.min(1, (now - r.start) / r.dur));
    return interpolate(r.from, r.to, r.ease(t));
  }

  /** The styles for this frame: the computed ones with transitioned and animated values over them. */
  apply(styles: Map<Element, Computed>, now: number): Map<Element, Computed> {
    if (!this.active) return styles;
    const out = new Map(styles);
    for (const [e, list] of this.transitions) {
      const s = out.get(e);
      if (s === undefined) continue;
      const values = { ...s.values };
      for (const [name, r] of list) {
        if (now < r.start) { values[name] = r.from; continue; }
        values[name] = this.valueOf(r, now);
        if (now >= r.start + r.dur) {
          list.delete(name);
          const ev = new Event("transitionend", { bubbles: true }) as Event & { propertyName: string; elapsedTime: number };
          ev.propertyName = name; ev.elapsedTime = r.dur;
          setTimeout(() => e.dispatchEvent(ev), 0);
        }
      }
      if (list.size === 0) this.transitions.delete(e);
      out.set(e, new Computed(values, s.custom, s.fontSize, parseColor(values["color"] ?? "", s.color) ?? s.color));
    }
    for (const [e, anims] of this.animations) {
      const base = out.get(e);
      if (base === undefined || anims.length === 0) continue;
      const s = base;
      const values = { ...s.values };
      const list = (k: string): string[] => split(s.get(k), true);
      const durs = list("animation-duration").map(time), delays = list("animation-delay").map(time), eases = list("animation-timing-function");
      const counts = list("animation-iteration-count"), dirs = list("animation-direction"), fills = list("animation-fill-mode"), states = list("animation-play-state");
      anims.forEach((a, k) => {
        const frames = this.keyframes(a.name);
        if (frames === undefined || frames.length === 0) return;
        const dur = durs[k % durs.length] ?? 0, delay = delays[k % delays.length] ?? 0;
        const countS = counts[k % counts.length] ?? "1", count = countS === "infinite" ? Infinity : parseFloat(countS) || 1;
        const dir = dirs[k % dirs.length] ?? "normal", fill = fills[k % fills.length] ?? "none";
        if ((states[k % states.length] ?? "running") === "paused") { a.start += 1 / 60; }
        const elapsed = now - a.start - delay;
        let progress: number;
        if (elapsed < 0) {
          if (fill !== "backwards" && fill !== "both") return;
          progress = dir === "reverse" || dir === "alternate-reverse" ? 1 : 0;
        } else if (dur <= 0 || elapsed >= dur * count) {
          if (Number.isFinite(count) && dur * count <= elapsed && a.ended !== true) {
            a.ended = true;
            const ev = new Event("animationend", { bubbles: true }) as Event & { animationName: string; elapsedTime: number };
            ev.animationName = a.name; ev.elapsedTime = dur * count;
            setTimeout(() => e.dispatchEvent(ev), 0);
          }
          if (fill !== "forwards" && fill !== "both") return;
          const iter = Math.max(0, Math.ceil(count) - 1);
          const odd = iter % 2 === 1;
          const end = count % 1 === 0 ? 1 : count % 1;
          progress = dir === "reverse" ? 1 - end : dir === "alternate" ? (odd ? 1 - end : end) : dir === "alternate-reverse" ? (odd ? end : 1 - end) : end;
        } else {
          const iter = Math.floor(elapsed / dur);
          let p = (elapsed - iter * dur) / dur;
          if (dir === "reverse" || (dir === "alternate" && iter % 2 === 1) || (dir === "alternate-reverse" && iter % 2 === 0)) p = 1 - p;
          progress = p;
        }
        const ease = easing(eases[k % eases.length] ?? "ease");
        // the properties any keyframe sets; missing from/to frames take the computed value
        const props = new Set<string>();
        for (const f of frames) for (const d of f.declarations) props.add(d.name);
        for (const name of props) {
          const known: { offset: number; value: string }[] = [];
          for (const f of frames) { const d = f.declarations.find((x) => x.name === name); if (d !== undefined) known.push({ offset: f.offset, value: d.value }); }
          const computed = s.values[name] ?? s.get(name);
          if (known[0]?.offset !== 0) known.unshift({ offset: 0, value: computed });
          if (known[known.length - 1]?.offset !== 1) known.push({ offset: 1, value: computed });
          let i = 1;
          while (i < known.length - 1 && progress > (known[i] as { offset: number }).offset) i++;
          const lo = known[i - 1] as { offset: number; value: string }, hi = known[i] as { offset: number; value: string };
          const local = hi.offset === lo.offset ? 1 : (progress - lo.offset) / (hi.offset - lo.offset);
          values[name] = interpolate(lo.value, hi.value, ease(Math.max(0, Math.min(1, local))));
        }
      });
      out.set(e, new Computed(values, s.custom, s.fontSize, parseColor(values["color"] ?? "", s.color) ?? s.color as Rgba));
    }
    return out;
  }
}
