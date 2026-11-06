/**
 * Live views of attributes: DOMTokenList (classList, relList) over a
 * space-separated attribute, CSSStyleDeclaration (style) over the style
 * attribute, and the dataset map over data-* attributes.
 */

export interface AttributeHost {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttributeNames(): string[];
}

export class DOMTokenList {
  private readonly host: AttributeHost;
  private readonly attr: string;
  constructor(host: AttributeHost, attr: string) { this.host = host; this.attr = attr; }
  private tokens(): string[] {
    const v = this.host.getAttribute(this.attr);
    if (v === null) return [];
    const out: string[] = [];
    for (const t of v.split(/[\t\n\f\r ]+/)) if (t !== "" && !out.includes(t)) out.push(t);
    return out;
  }
  private write(tokens: string[]): void { this.host.setAttribute(this.attr, tokens.join(" ")); }
  private static check(token: string): void {
    if (token === "") throw new Error("SyntaxError: an empty token");
    if (/[\t\n\f\r ]/.test(token)) throw new Error("InvalidCharacterError: a token with whitespace");
  }
  get length(): number { return this.tokens().length; }
  get value(): string { return this.host.getAttribute(this.attr) ?? ""; }
  set value(v: string) { this.host.setAttribute(this.attr, v); }
  item(i: number): string | null { return this.tokens()[i] ?? null; }
  contains(token: string): boolean { return this.tokens().includes(token); }
  add(...tokens: string[]): void {
    for (const t of tokens) DOMTokenList.check(t);
    const list = this.tokens();
    for (const t of tokens) if (!list.includes(t)) list.push(t);
    this.write(list);
  }
  remove(...tokens: string[]): void {
    for (const t of tokens) DOMTokenList.check(t);
    if (this.host.getAttribute(this.attr) === null) return;
    this.write(this.tokens().filter((t) => !tokens.includes(t)));
  }
  toggle(token: string, force?: boolean): boolean {
    DOMTokenList.check(token);
    const has = this.contains(token);
    const on = force ?? !has;
    if (on && !has) this.add(token);
    else if (!on && has) this.remove(token);
    return on;
  }
  replace(token: string, by: string): boolean {
    DOMTokenList.check(token); DOMTokenList.check(by);
    const list = this.tokens();
    const i = list.indexOf(token);
    if (i < 0) return false;
    const j = list.indexOf(by);
    if (j >= 0 && j !== i) list.splice(j, 1);
    list[list.indexOf(token)] = by;
    this.write(list);
    return true;
  }
  supports(_token: string): boolean { return true; }
  forEach(fn: (value: string, index: number, list: DOMTokenList) => void): void { this.tokens().forEach((t, i) => fn(t, i, this)); }
  entries(): IterableIterator<[number, string]> { return this.tokens().entries(); }
  keys(): IterableIterator<number> { return this.tokens().keys(); }
  values(): IterableIterator<string> { return this.tokens().values(); }
  [Symbol.iterator](): IterableIterator<string> { return this.tokens().values(); }
  toString(): string { return this.value; }
}

// ---------------------------------------------------------------- style

export const kebab = (name: string): string =>
  name.startsWith("--") ? name : name.replace(/^(webkit|moz|ms)(?=[A-Z])/, "-$1").replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
export const camel = (name: string): string =>
  name.startsWith("--") ? name : name.replace(/^-(webkit|moz|ms)-/, "$1-").replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

/** Split a declaration block into [property, value, important] (semicolons in strings and parentheses don't end one). */
export function parseDeclarations(text: string): [string, string, boolean][] {
  const out: [string, string, boolean][] = [];
  let depth = 0, quote = "", start = 0;
  const parts: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (quote !== "") { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === "\"" || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ";" && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  for (const p of parts) {
    const colon = p.indexOf(":");
    if (colon < 0) continue;
    const name = p.slice(0, colon).trim();
    let value = p.slice(colon + 1).trim();
    if (name === "" || value === "") continue;
    let important = false;
    const imp = /!\s*important\s*$/i.exec(value);
    if (imp !== null) { important = true; value = value.slice(0, imp.index).trim(); }
    out.push([name.startsWith("--") ? name : name.toLowerCase(), value, important]);
  }
  return out;
}

/**
 * The style attribute as an object: `style.backgroundColor = "red"`,
 * `style.setProperty("--x", "1")`, `style.cssText`. A Proxy, so any
 * camelCase or kebab-case property name works.
 */
export interface CSSStyleDeclaration {
  cssText: string;
  readonly length: number;
  item(i: number): string;
  getPropertyValue(name: string): string;
  getPropertyPriority(name: string): string;
  setProperty(name: string, value: string | null, priority?: string): void;
  removeProperty(name: string): string;
  [property: string]: unknown;
}

export function styleDeclaration(host: AttributeHost | null, initial: [string, string, boolean][] = [], readOnly = false): CSSStyleDeclaration {
  let decls: [string, string, boolean][] = initial;
  let seen: string | null = null;
  const read = (): [string, string, boolean][] => {
    if (host === null) return decls;
    const attr = host.getAttribute("style") ?? "";
    if (attr !== seen) { seen = attr; decls = parseDeclarations(attr); }
    return decls;
  };
  const write = (): void => {
    if (readOnly) throw new Error("NoModificationAllowedError: computed style is read-only");
    const text = decls.map(([n, v, imp]) => `${n}: ${v}${imp ? " !important" : ""};`).join(" ");
    seen = text;
    if (host !== null) { if (text === "") host.removeAttribute("style"); else host.setAttribute("style", text); }
  };
  const get = (name: string): string => { const d = read().find((x) => x[0] === name); return d === undefined ? "" : d[1]; };
  const set = (name: string, value: string | null, important = false): void => {
    read();
    decls = decls.filter((x) => x[0] !== name);
    if (value !== null && String(value) !== "") decls.push([name, String(value), important]);
    write();
  };
  const api = {
    get cssText(): string { return read().map(([n, v, imp]) => `${n}: ${v}${imp ? " !important" : ""};`).join(" "); },
    set cssText(text: string) { decls = parseDeclarations(String(text)); write(); },
    get length(): number { return read().length; },
    item: (i: number): string => read()[i]?.[0] ?? "",
    getPropertyValue: (name: string): string => get(name.startsWith("--") ? name : name.toLowerCase()),
    getPropertyPriority: (name: string): string => (read().find((x) => x[0] === name)?.[2] === true ? "important" : ""),
    setProperty: (name: string, value: string | null, priority?: string): void => set(name.startsWith("--") ? name : name.toLowerCase(), value, priority === "important"),
    removeProperty: (name: string): string => { const old = get(name); set(name, null); return old; },
  };
  return new Proxy(api as unknown as CSSStyleDeclaration, {
    get(target, key) {
      if (typeof key !== "string") return (target as unknown as Record<symbol, unknown>)[key as unknown as symbol];
      if (key in api) return (api as unknown as Record<string, unknown>)[key];
      if (/^\d+$/.test(key)) return api.item(Number(key));
      return get(kebab(key));
    },
    set(_target, key, value) {
      if (typeof key !== "string") return false;
      if (key === "cssText") { api.cssText = String(value); return true; }
      set(kebab(key), value === null || value === undefined ? null : String(value));
      return true;
    },
    has(_target, key) { return typeof key === "string" && (key in api || read().some((d) => d[0] === kebab(key))); },
  });
}

// ---------------------------------------------------------------- dataset

const dataName = (key: string): string => "data-" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
const dataKey = (attr: string): string => attr.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

/** element.dataset: data-* attributes by their camelCase names, live. */
export function dataset(host: AttributeHost): Record<string, string | undefined> {
  return new Proxy({} as Record<string, string | undefined>, {
    get(_t, key) { return typeof key === "string" ? host.getAttribute(dataName(key)) ?? undefined : undefined; },
    set(_t, key, value) { if (typeof key !== "string") return false; host.setAttribute(dataName(key), String(value)); return true; },
    deleteProperty(_t, key) { if (typeof key === "string") host.removeAttribute(dataName(key)); return true; },
    has(_t, key) { return typeof key === "string" && host.getAttribute(dataName(key)) !== null; },
    ownKeys() { return host.getAttributeNames().filter((n) => n.startsWith("data-")).map(dataKey); },
    getOwnPropertyDescriptor(_t, key) {
      if (typeof key !== "string") return undefined;
      const v = host.getAttribute(dataName(key));
      return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
    },
  });
}
