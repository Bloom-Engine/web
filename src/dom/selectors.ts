/**
 * CSS selectors (Selectors Level 4, the parts a page uses): type, universal,
 * #id, .class, attribute selectors with = ~= |= ^= $= *= and the i/s flags,
 * the descendant, child (>), next-sibling (+) and subsequent-sibling (~)
 * combinators, selector lists, and the pseudo-classes
 *   :not() :is() :where() :has()
 *   :first-child :last-child :only-child :nth-child(An+B [of S]) :nth-last-child()
 *   :first-of-type :last-of-type :only-of-type :nth-of-type() :nth-last-of-type()
 *   :root :empty :scope :defined
 *   :hover :active :focus :focus-visible :focus-within (from the element state hooks)
 *   :checked :disabled :enabled :required :optional :read-only :read-write
 *   :placeholder-shown :link :any-link :target
 * Pseudo-elements never match an element, so a selector with one matches nothing.
 * Parsed selectors are cached.
 */

/** What matching needs from an element (the DOM's Element implements it). */
export interface SelectorElement {
  readonly localName: string;
  readonly id: string;
  readonly parentElement: SelectorElement | null;
  readonly children: ArrayLike<SelectorElement>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  /** @internal pseudo-class state: hover, active, focus, focus-visible, checked, disabled, ... */
  _state(name: string): boolean;
  /** @internal whether it has element or non-empty text children */
  _isEmpty(): boolean;
  /** @internal the document's root element */
  _root(): SelectorElement | null;
}

type Test = (e: SelectorElement, scope: SelectorElement | null) => boolean;

interface Compound { tests: Test[]; never: boolean }
/** A complex selector: compounds right to left, each with the combinator to the next one left. */
interface Complex { parts: { compound: Compound; combinator: string }[]; specificity: [number, number, number] }

export class SelectorError extends Error {
  constructor(selector: string, why: string) { super(`SyntaxError: '${selector}' is not a valid selector (${why})`); this.name = "SyntaxError"; }
}

// ---------------------------------------------------------------- tokenizer

class Reader {
  i = 0;
  readonly s: string;
  readonly whole: string;
  constructor(s: string, whole: string) { this.s = s; this.whole = whole; }
  peek(n = 0): string { return this.s.charAt(this.i + n); }
  eof(): boolean { return this.i >= this.s.length; }
  skipSpace(): boolean { const at = this.i; while (/\s/.test(this.peek())) this.i++; return this.i > at; }
  fail(why: string): never { throw new SelectorError(this.whole, why); }
  ident(): string {
    let out = "";
    while (!this.eof()) {
      const c = this.peek();
      if (c === "\\") {
        this.i++;
        const hex = /^[0-9a-fA-F]{1,6}\s?/.exec(this.s.slice(this.i));
        if (hex !== null) { out += String.fromCodePoint(parseInt(hex[0].trim(), 16)); this.i += hex[0].length; }
        else { out += this.peek(); this.i++; }
      } else if (/[-\w -￿]/.test(c)) { out += c; this.i++; }
      else break;
    }
    if (out === "") this.fail("expected a name");
    return out;
  }
  string(): string {
    const q = this.peek();
    this.i++;
    let out = "";
    while (!this.eof() && this.peek() !== q) {
      if (this.peek() === "\\") { this.i++; out += this.peek(); this.i++; } else { out += this.peek(); this.i++; }
    }
    if (this.eof()) this.fail("unterminated string");
    this.i++;
    return out;
  }
  /** The text up to the matching ")" (the reader is just past "("). */
  balanced(): string {
    let depth = 1;
    const start = this.i;
    while (!this.eof()) {
      const c = this.peek();
      if (c === "\"" || c === "'") { this.string(); continue; }
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) { const inner = this.s.slice(start, this.i); this.i++; return inner; }
      this.i++;
    }
    return this.fail("missing )");
  }
}

// ---------------------------------------------------------------- An+B

function parseNth(text: string, whole: string): [number, number] {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  if (t === "odd") return [2, 1];
  if (t === "even") return [2, 0];
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(t);
  if (m !== null) {
    const a = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]);
    return [a, m[2] === undefined ? 0 : Number(m[2])];
  }
  if (/^[+-]?\d+$/.test(t)) return [0, Number(t)];
  throw new SelectorError(whole, "bad An+B: " + text);
}

function nthMatches(a: number, b: number, index: number): boolean {
  if (a === 0) return index === b;
  const n = (index - b) / a;
  return Number.isInteger(n) && n >= 0;
}

function siblings(e: SelectorElement): ArrayLike<SelectorElement> {
  const p = e.parentElement;
  return p === null ? [e] : p.children;
}

/** 1-based position among (or from the end of) the siblings that pass `filter`. */
function position(e: SelectorElement, fromEnd: boolean, filter: (s: SelectorElement) => boolean): number {
  const sibs = siblings(e);
  const n = sibs.length;
  let k = 0;
  if (!fromEnd) {
    for (let i = 0; i < n; i++) { const s = sibs[i]; if (s === undefined || !filter(s)) continue; k++; if (s === e) return k; }
  } else {
    for (let i = n - 1; i >= 0; i--) { const s = sibs[i]; if (s === undefined || !filter(s)) continue; k++; if (s === e) return k; }
  }
  return 0;
}

// ---------------------------------------------------------------- parser

const STATES = new Set([
  "hover", "active", "focus", "focus-visible", "focus-within", "checked", "disabled", "enabled", "required", "optional",
  "read-only", "read-write", "placeholder-shown", "link", "any-link", "visited", "target", "indeterminate", "default",
  "valid", "invalid", "in-range", "out-of-range", "autofill", "fullscreen", "modal", "open", "popover-open",
]);

function parseCompound(r: Reader, spec: [number, number, number]): Compound {
  const tests: Test[] = [];
  let never = false;
  let any = false;
  const c0 = r.peek();
  if (c0 === "*") { r.i++; any = true; if (r.peek() === "|") { r.i++; if (r.peek() === "*") r.i++; else r.ident(); } }
  else if (/[-\w\\ -￿]/.test(c0) && c0 !== "-" || (c0 === "-" && /[-a-zA-Z_]/.test(r.peek(1)))) {
    const name = r.ident().toLowerCase();
    any = true;
    spec[2]++;
    tests.push((e) => e.localName === name);
  }
  for (;;) {
    const c = r.peek();
    if (c === "#") {
      r.i++;
      const id = r.ident();
      spec[0]++;
      tests.push((e) => e.id === id);
    } else if (c === ".") {
      r.i++;
      const cls = r.ident();
      spec[1]++;
      tests.push((e) => {
        const v = e.getAttribute("class");
        return v !== null && v.split(/[\t\n\f\r ]+/).includes(cls);
      });
    } else if (c === "[") {
      r.i++;
      r.skipSpace();
      let name = r.ident();
      if (r.peek() === "|" && r.peek(1) !== "=") { r.i++; name = r.ident(); }
      const attr = name.toLowerCase();
      r.skipSpace();
      spec[1]++;
      if (r.peek() === "]") { r.i++; tests.push((e) => e.hasAttribute(attr)); continue; }
      let op = r.peek();
      if (op === "=") { r.i++; op = ""; } else if ("~|^$*".includes(op) && r.peek(1) === "=") r.i += 2;
      else r.fail("bad attribute operator");
      r.skipSpace();
      const q = r.peek();
      let value = q === "\"" || q === "'" ? r.string() : r.ident();
      r.skipSpace();
      let insensitive = false;
      if (/[iIsS]/.test(r.peek()) && (r.peek(1) === "]" || /\s/.test(r.peek(1)))) { insensitive = r.peek().toLowerCase() === "i"; r.i++; r.skipSpace(); }
      if (r.peek() !== "]") r.fail("expected ]");
      r.i++;
      if (insensitive) value = value.toLowerCase();
      const want = value;
      tests.push((e) => {
        let v = e.getAttribute(attr);
        if (v === null) return false;
        if (insensitive) v = v.toLowerCase();
        switch (op) {
          case "": return v === want;
          case "~": return want !== "" && !/\s/.test(want) && v.split(/[\t\n\f\r ]+/).includes(want);
          case "|": return v === want || v.startsWith(want + "-");
          case "^": return want !== "" && v.startsWith(want);
          case "$": return want !== "" && v.endsWith(want);
          default: return want !== "" && v.includes(want);
        }
      });
    } else if (c === ":") {
      r.i++;
      if (r.peek() === ":") {
        // a pseudo-element: never an element
        r.i++;
        r.ident();
        if (r.peek() === "(") { r.i++; r.balanced(); }
        spec[2]++;
        never = true;
        continue;
      }
      const name = r.ident().toLowerCase();
      if (name === "before" || name === "after" || name === "first-line" || name === "first-letter") { never = true; spec[2]++; continue; }
      if (r.peek() === "(") {
        r.i++;
        const arg = r.balanced();
        tests.push(functional(name, arg, r.whole, spec));
        continue;
      }
      spec[1]++;
      tests.push(simplePseudo(name, r));
    } else break;
    any = true;
  }
  if (!any && tests.length === 0 && !never) r.fail("expected a selector");
  return { tests, never };
}

function simplePseudo(name: string, r: Reader): Test {
  switch (name) {
    case "root": return (e) => e._root() === e;
    case "scope": return (e, scope) => (scope === null ? e._root() === e : e === scope);
    case "empty": return (e) => e._isEmpty();
    case "first-child": return (e) => position(e, false, () => true) === 1;
    case "last-child": return (e) => position(e, true, () => true) === 1;
    case "only-child": return (e) => siblings(e).length === 1;
    case "first-of-type": return (e) => position(e, false, (s) => s.localName === e.localName) === 1;
    case "last-of-type": return (e) => position(e, true, (s) => s.localName === e.localName) === 1;
    case "only-of-type": return (e) => position(e, false, (s) => s.localName === e.localName) === 1 && position(e, true, (s) => s.localName === e.localName) === 1;
    case "defined": return () => true;
    default:
      if (STATES.has(name)) return (e) => e._state(name);
      return r.fail("unknown pseudo-class :" + name);
  }
}

function functional(name: string, arg: string, whole: string, spec: [number, number, number]): Test {
  switch (name) {
    case "not": case "is": case "matches": case "where": case "-webkit-any": {
      const list = parseList(arg, whole);
      if (name !== "where") {
        // the most specific selector in the list counts
        let best: [number, number, number] = [0, 0, 0];
        for (const c of list) if (compareSpec(c.specificity, best) > 0) best = c.specificity;
        spec[0] += best[0]; spec[1] += best[1]; spec[2] += best[2];
      }
      if (name === "not") return (e, scope) => !list.some((c) => matchComplex(e, c, scope));
      return (e, scope) => list.some((c) => matchComplex(e, c, scope));
    }
    case "has": {
      spec[1]++;
      // relative selectors: "> a", "+ a", "~ a", or "a" (a descendant)
      const rel = arg.split(",").map((s) => s.trim()).map((s) => {
        const m = /^([>+~])\s*/.exec(s);
        return { combinator: m === null ? " " : m[1] ?? " ", list: parseList(m === null ? s : s.slice(m[0].length), whole) };
      });
      return (e) => rel.some(({ combinator, list }) => {
        const candidates: SelectorElement[] = [];
        if (combinator === " ") descendants(e, candidates);
        else if (combinator === ">") { const ch = e.children; for (let i = 0; i < ch.length; i++) { const c = ch[i]; if (c !== undefined) candidates.push(c); } }
        else {
          const sibs = siblings(e);
          let after = false;
          for (let i = 0; i < sibs.length; i++) {
            const s = sibs[i];
            if (s === e) { after = true; continue; }
            if (!after || s === undefined) continue;
            candidates.push(s);
            if (combinator === "+") break;
          }
        }
        return candidates.some((c) => list.some((x) => matchComplex(c, x, e)));
      });
    }
    case "nth-child": case "nth-last-child": {
      spec[1]++;
      const of = /\s+of\s+/i.exec(arg);
      const [a, b] = parseNth(of === null ? arg : arg.slice(0, of.index), whole);
      const filter = of === null ? null : parseList(arg.slice(of.index + of[0].length), whole);
      const last = name === "nth-last-child";
      return (e, scope) => {
        if (filter !== null && !filter.some((c) => matchComplex(e, c, scope))) return false;
        return nthMatches(a, b, position(e, last, (s) => filter === null || filter.some((c) => matchComplex(s, c, scope))));
      };
    }
    case "nth-of-type": case "nth-last-of-type": {
      spec[1]++;
      const [a, b] = parseNth(arg, whole);
      const last = name === "nth-last-of-type";
      return (e) => nthMatches(a, b, position(e, last, (s) => s.localName === e.localName));
    }
    case "lang": {
      spec[1]++;
      const want = arg.trim().replace(/^["']|["']$/g, "").toLowerCase();
      return (e) => {
        for (let p: SelectorElement | null = e; p !== null; p = p.parentElement) {
          const l = p.getAttribute("lang");
          if (l !== null) { const v = l.toLowerCase(); return v === want || v.startsWith(want + "-"); }
        }
        return false;
      };
    }
    case "dir": {
      spec[1]++;
      const want = arg.trim().toLowerCase();
      return (e) => {
        for (let p: SelectorElement | null = e; p !== null; p = p.parentElement) { const d = p.getAttribute("dir"); if (d !== null) return d.toLowerCase() === want; }
        return want === "ltr";
      };
    }
    default:
      throw new SelectorError(whole, "unknown pseudo-class :" + name + "()");
  }
}

function descendants(e: SelectorElement, out: SelectorElement[]): void {
  const ch = e.children;
  for (let i = 0; i < ch.length; i++) { const c = ch[i]; if (c !== undefined) { out.push(c); descendants(c, out); } }
}

function compareSpec(a: [number, number, number], b: [number, number, number]): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] !== b[1] ? a[1] - b[1] : a[2] - b[2];
}

function parseComplex(r: Reader): Complex {
  const spec: [number, number, number] = [0, 0, 0];
  const left: { compound: Compound; combinator: string }[] = [];
  r.skipSpace();
  let combinator = "";
  for (;;) {
    const compound = parseCompound(r, spec);
    left.push({ compound, combinator });
    const spaced = r.skipSpace();
    const c = r.peek();
    if (r.eof() || c === ",") break;
    if (c === ">" || c === "+" || c === "~") { combinator = c; r.i++; r.skipSpace(); }
    else if (spaced) combinator = " ";
    else r.fail("unexpected " + c);
  }
  // right to left: each part keeps the combinator that joins it to the part on its left
  const parts: { compound: Compound; combinator: string }[] = [];
  for (let i = left.length - 1; i >= 0; i--) {
    const cur = left[i];
    if (cur === undefined) continue;
    parts.push({ compound: cur.compound, combinator: cur.combinator });
  }
  return { parts, specificity: spec };
}

const cache = new Map<string, Complex[]>();

/** Parse a selector list (cached). Throws SelectorError (a SyntaxError) when it isn't valid. */
export function parseList(selector: string, whole = selector): Complex[] {
  const hit = cache.get(selector);
  if (hit !== undefined) return hit;
  const r = new Reader(selector, whole);
  const list: Complex[] = [];
  r.skipSpace();
  if (r.eof()) r.fail("empty selector");
  for (;;) {
    list.push(parseComplex(r));
    r.skipSpace();
    if (r.eof()) break;
    if (r.peek() !== ",") r.fail("expected ,");
    r.i++;
  }
  if (cache.size > 2000) cache.clear();
  cache.set(selector, list);
  return list;
}

// ---------------------------------------------------------------- matching

function matchCompound(e: SelectorElement, c: Compound, scope: SelectorElement | null): boolean {
  if (c.never) return false;
  const t = c.tests;
  const n = t.length;
  for (let i = 0; i < n; i++) { const f = t[i]; if (f !== undefined && !f(e, scope)) return false; }
  return true;
}

function matchFrom(e: SelectorElement, parts: Complex["parts"], k: number, scope: SelectorElement | null): boolean {
  const part = parts[k];
  if (part === undefined) return true;
  if (!matchCompound(e, part.compound, scope)) return false;
  if (k === parts.length - 1) return true;
  const comb = part.combinator;
  if (comb === ">") { const p = e.parentElement; return p !== null && matchFrom(p, parts, k + 1, scope); }
  if (comb === " ") {
    for (let p = e.parentElement; p !== null; p = p.parentElement) if (matchFrom(p, parts, k + 1, scope)) return true;
    return false;
  }
  // + and ~ look at the siblings before e
  const sibs = siblings(e);
  let i = 0;
  while (i < sibs.length && sibs[i] !== e) i++;
  for (let j = i - 1; j >= 0; j--) {
    const s = sibs[j];
    if (s === undefined) continue;
    if (matchFrom(s, parts, k + 1, scope)) return true;
    if (comb === "+") return false;
  }
  return false;
}

function matchComplex(e: SelectorElement, c: Complex, scope: SelectorElement | null): boolean {
  return matchFrom(e, c.parts, 0, scope);
}

/** Whether an element matches a selector list. `scope` is :scope (the element querySelector was called on). */
export function matchesSelector(e: SelectorElement, selector: string, scope: SelectorElement | null = null): boolean {
  const list = parseList(selector);
  const n = list.length;
  for (let i = 0; i < n; i++) { const c = list[i]; if (c !== undefined && matchComplex(e, c, scope)) return true; }
  return false;
}

/** The highest specificity among the selectors of a list that match (for a style cascade). */
export function specificity(selector: string): [number, number, number] {
  let best: [number, number, number] = [0, 0, 0];
  for (const c of parseList(selector)) if (compareSpec(c.specificity, best) > 0) best = c.specificity;
  return best;
}
