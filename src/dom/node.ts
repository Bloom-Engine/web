/**
 * The DOM tree: Node, Text, Comment, DocumentFragment, Element, Document.
 *
 * Attributes are the truth: id, className, classList, dataset, style,
 * hidden, title and the rest reflect them, as in the browser. Mutations are
 * validated (no cycles, fragments insert their children) and reported to
 * MutationObservers (observers.ts). Elements are created through a registry
 * (`defineElement`), so form controls, canvas, img and media elements get
 * their own classes (elements.ts, and the modules that implement canvas,
 * images and audio).
 *
 * There is no CSS layout engine here. Where an element is on screen is its
 * layout box, set by whatever draws the page (`setLayoutBox`); geometry
 * (getBoundingClientRect, clientWidth, offsetTop, ...) and hit testing
 * (elementFromPoint) read it. Elements nobody placed have an empty box; the
 * root and body fill the viewport.
 *
 * Pure TypeScript, no Bloom.
 */
import { Event, EventTarget, FocusEvent, MouseEvent } from "./events.ts";
import { matchesSelector, type SelectorElement } from "./selectors.ts";
import { DOMTokenList, dataset as makeDataset, styleDeclaration, type CSSStyleDeclaration } from "./tokens.ts";

export const HTML_NS = "http://www.w3.org/1999/xhtml";
export const SVG_NS = "http://www.w3.org/2000/svg";

export class DOMException extends Error {
  constructor(message: string, name = "Error") { super(message); this.name = name; }
}

// ---------------------------------------------------------------- hooks other modules fill in

/** HTML fragment parsing and serialization (html.ts registers them). */
export const html = {
  parseFragment: (_doc: Document, _markup: string, _context: Element | null): Node[] => { throw new Error("html.ts not loaded"); },
  serialize: (_node: Node, _outer: boolean): string => "",
};

export interface MutationRecordInit {
  type: "childList" | "attributes" | "characterData";
  target: Node;
  addedNodes?: Node[];
  removedNodes?: Node[];
  previousSibling?: Node | null;
  nextSibling?: Node | null;
  attributeName?: string | null;
  oldValue?: string | null;
}
/** Called for every mutation (observers.ts subscribes). */
export const mutationSinks: ((record: MutationRecordInit) => void)[] = [];
function mutated(record: MutationRecordInit): void { for (const sink of mutationSinks) sink(record); }

export interface Rect { x: number; y: number; w: number; h: number }

// ---------------------------------------------------------------- Node

let currentDocument: Document | null = null;
/** The document new nodes belong to when none is given (the page's). */
export function defaultDocument(): Document {
  if (currentDocument === null) currentDocument = new Document();
  return currentDocument;
}

export class Node extends EventTarget {
  static readonly ELEMENT_NODE = 1;
  static readonly ATTRIBUTE_NODE = 2;
  static readonly TEXT_NODE = 3;
  static readonly CDATA_SECTION_NODE = 4;
  static readonly PROCESSING_INSTRUCTION_NODE = 7;
  static readonly COMMENT_NODE = 8;
  static readonly DOCUMENT_NODE = 9;
  static readonly DOCUMENT_TYPE_NODE = 10;
  static readonly DOCUMENT_FRAGMENT_NODE = 11;
  static readonly DOCUMENT_POSITION_DISCONNECTED = 1;
  static readonly DOCUMENT_POSITION_PRECEDING = 2;
  static readonly DOCUMENT_POSITION_FOLLOWING = 4;
  static readonly DOCUMENT_POSITION_CONTAINS = 8;
  static readonly DOCUMENT_POSITION_CONTAINED_BY = 16;
  readonly ELEMENT_NODE = 1;
  readonly TEXT_NODE = 3;
  readonly COMMENT_NODE = 8;
  readonly DOCUMENT_NODE = 9;
  readonly DOCUMENT_FRAGMENT_NODE = 11;

  readonly nodeType: number;
  /** @internal */ _parent: Node | null = null;
  /** @internal */ _children: Node[] = [];
  /** @internal */ _doc: Document | null;

  constructor(nodeType: number, doc: Document | null) {
    super();
    this.nodeType = nodeType;
    this._doc = doc;
  }

  get nodeName(): string { return ""; }
  get ownerDocument(): Document | null { return this.nodeType === 9 ? null : this._doc; }
  get parentNode(): Node | null { return this._parent; }
  get parentElement(): Element | null { const p = this._parent; return p !== null && p.nodeType === 1 ? (p as Element) : null; }
  get childNodes(): Node[] { return this._children; }
  get firstChild(): Node | null { return this._children[0] ?? null; }
  get lastChild(): Node | null { return this._children[this._children.length - 1] ?? null; }
  get previousSibling(): Node | null { const p = this._parent; if (p === null) return null; return p._children[p._children.indexOf(this) - 1] ?? null; }
  get nextSibling(): Node | null { const p = this._parent; if (p === null) return null; return p._children[p._children.indexOf(this) + 1] ?? null; }
  get isConnected(): boolean { return this.getRootNode().nodeType === 9; }
  get nodeValue(): string | null { return null; }
  set nodeValue(_v: string | null) {}
  get baseURI(): string { return this._doc?.URL ?? ""; }

  get textContent(): string | null {
    let out = "";
    const walk = (n: Node): void => { for (const c of n._children) { if (c.nodeType === 3) out += (c as Text).data; else if (c.nodeType === 1 || c.nodeType === 11) walk(c); } };
    walk(this);
    return out;
  }
  set textContent(text: string | null) {
    const t = text === null || text === undefined ? "" : String(text);
    const doc = this._doc ?? defaultDocument();
    this._replaceAll(t === "" ? [] : [doc.createTextNode(t)]);
  }

  getRootNode(_options?: unknown): Node { let n: Node = this; while (n._parent !== null) n = n._parent; return n; }
  hasChildNodes(): boolean { return this._children.length > 0; }
  contains(other: Node | null): boolean { for (let n: Node | null = other; n !== null; n = n._parent) if (n === this) return true; return false; }

  appendChild<T extends Node>(node: T): T { return this.insertBefore(node, null); }
  insertBefore<T extends Node>(node: T, ref: Node | null): T {
    this._validate(node, ref);
    if (ref === node) ref = node.nextSibling;
    const nodes = node.nodeType === 11 ? node._children.slice() : [node];
    if (node.nodeType === 11) { for (const c of nodes) c._parent = null; node._children = []; mutated({ type: "childList", target: node, removedNodes: nodes }); }
    for (const n of nodes) if (n._parent !== null) n._parent.removeChild(n);
    let i = ref === null ? this._children.length : this._children.indexOf(ref);
    const prev = this._children[i - 1] ?? null;
    for (const n of nodes) { n._parent = this; n._adopt(this._doc ?? (this as unknown as Document)); this._children.splice(i++, 0, n); }
    if (nodes.length > 0) {
      mutated({ type: "childList", target: this, addedNodes: nodes, previousSibling: prev, nextSibling: ref });
      for (const n of nodes) n._inserted();
    }
    return node;
  }
  removeChild<T extends Node>(node: T): T {
    if (node._parent !== this) throw new DOMException("The node to be removed is not a child of this node.", "NotFoundError");
    const i = this._children.indexOf(node);
    const prev = this._children[i - 1] ?? null, next = this._children[i + 1] ?? null;
    this._children.splice(i, 1);
    node._parent = null;
    mutated({ type: "childList", target: this, removedNodes: [node], previousSibling: prev, nextSibling: next });
    node._removed(this);
    return node;
  }
  replaceChild<T extends Node>(node: Node, old: T): T {
    if (old._parent !== this) throw new DOMException("The node to be replaced is not a child of this node.", "NotFoundError");
    const next = old.nextSibling === node ? node.nextSibling : old.nextSibling;
    this.removeChild(old);
    this.insertBefore(node, next);
    return old;
  }
  cloneNode(deep = false): Node {
    const copy = this._cloneShallow();
    if (deep) for (const c of this._children) copy.appendChild(c.cloneNode(true));
    return copy;
  }
  isSameNode(other: Node | null): boolean { return this === other; }
  isEqualNode(other: Node | null): boolean {
    if (other === null || other.nodeType !== this.nodeType || other.nodeName !== this.nodeName || other.nodeValue !== this.nodeValue) return false;
    if (this.nodeType === 1) {
      const a = this as unknown as Element, b = other as Element;
      const names = a.getAttributeNames();
      if (names.length !== b.getAttributeNames().length || names.some((n) => a.getAttribute(n) !== b.getAttribute(n))) return false;
    }
    if (other._children.length !== this._children.length) return false;
    return this._children.every((c, i) => c.isEqualNode(other._children[i] ?? null));
  }
  compareDocumentPosition(other: Node): number {
    if (other === this) return 0;
    const chain = (n: Node): Node[] => { const out: Node[] = []; for (let p: Node | null = n; p !== null; p = p._parent) out.unshift(p); return out; };
    const a = chain(this), b = chain(other);
    if (a[0] !== b[0]) return Node.DOCUMENT_POSITION_DISCONNECTED | Node.DOCUMENT_POSITION_PRECEDING | 32;
    if (b.includes(this)) return Node.DOCUMENT_POSITION_CONTAINED_BY | Node.DOCUMENT_POSITION_FOLLOWING;
    if (a.includes(other)) return Node.DOCUMENT_POSITION_CONTAINS | Node.DOCUMENT_POSITION_PRECEDING;
    let i = 0;
    while (a[i] === b[i]) i++;
    const parent = a[i - 1] as Node;
    return parent._children.indexOf(a[i] as Node) < parent._children.indexOf(b[i] as Node) ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING;
  }
  normalize(): void {
    for (let i = 0; i < this._children.length; i++) {
      const c = this._children[i] as Node;
      if (c.nodeType === 3) {
        const t = c as Text;
        while (t.nextSibling !== null && t.nextSibling.nodeType === 3) { t.data += (t.nextSibling as Text).data; this.removeChild(t.nextSibling); }
        if (t.data === "") { this.removeChild(t); i--; }
      } else c.normalize();
    }
  }
  lookupNamespaceURI(_prefix: string | null): string | null { return HTML_NS; }

  override _eventParent(_event: Event): EventTarget | null { return this._parent; }

  /** @internal */ _cloneShallow(): Node { return new Node(this.nodeType, this._doc); }
  /** @internal */ _adopt(doc: Document): void { if (this._doc === doc) return; this._doc = doc; for (const c of this._children) c._adopt(doc); }
  /** @internal called after the node went into a tree */ _inserted(): void { for (const c of this._children) c._inserted(); }
  /** @internal called after the node left a tree */ _removed(_from: Node): void { for (const c of this._children) c._removed(this); }
  /** @internal */ _replaceAll(nodes: Node[]): void {
    const old = this._children.slice();
    for (const c of old) { c._parent = null; c._removed(this); }
    this._children = [];
    for (const n of nodes) { if (n._parent !== null) n._parent.removeChild(n); n._parent = this; n._adopt(this._doc ?? (this as unknown as Document)); this._children.push(n); }
    if (old.length > 0 || nodes.length > 0) mutated({ type: "childList", target: this, addedNodes: nodes, removedNodes: old });
    for (const n of nodes) n._inserted();
  }
  private _validate(node: Node, ref: Node | null): void {
    if (this.nodeType !== 1 && this.nodeType !== 9 && this.nodeType !== 11) throw new DOMException("This node type does not support children.", "HierarchyRequestError");
    if (node.contains(this)) throw new DOMException("The new child element contains the parent.", "HierarchyRequestError");
    if (ref !== null && ref._parent !== this) throw new DOMException("The node before which the new node is to be inserted is not a child of this node.", "NotFoundError");
    if (node.nodeType === 9) throw new DOMException("A document can't be inserted.", "HierarchyRequestError");
  }

  // ParentNode and ChildNode mixins (on Element, Document, DocumentFragment, CharacterData)

  get children(): Element[] { return this._children.filter((c): c is Element => c.nodeType === 1); }
  get childElementCount(): number { let n = 0; for (const c of this._children) if (c.nodeType === 1) n++; return n; }
  get firstElementChild(): Element | null { for (const c of this._children) if (c.nodeType === 1) return c as Element; return null; }
  get lastElementChild(): Element | null { for (let i = this._children.length - 1; i >= 0; i--) { const c = this._children[i] as Node; if (c.nodeType === 1) return c as Element; } return null; }
  get previousElementSibling(): Element | null { for (let n = this.previousSibling; n !== null; n = n.previousSibling) if (n.nodeType === 1) return n as Element; return null; }
  get nextElementSibling(): Element | null { for (let n = this.nextSibling; n !== null; n = n.nextSibling) if (n.nodeType === 1) return n as Element; return null; }

  private nodesOf(items: (Node | string)[]): Node {
    const doc = this._doc ?? (this as unknown as Document);
    if (items.length === 1 && typeof items[0] !== "string") return items[0] as Node;
    const f = doc.createDocumentFragment();
    for (const i of items) f.appendChild(typeof i === "string" ? doc.createTextNode(i) : i);
    return f;
  }
  append(...items: (Node | string)[]): void { this.appendChild(this.nodesOf(items)); }
  prepend(...items: (Node | string)[]): void { this.insertBefore(this.nodesOf(items), this.firstChild); }
  replaceChildren(...items: (Node | string)[]): void {
    const doc = this._doc ?? (this as unknown as Document);
    this._replaceAll(items.map((i) => (typeof i === "string" ? doc.createTextNode(i) : i)).flatMap((n) => (n.nodeType === 11 ? n._children.slice() : [n])));
  }
  before(...items: (Node | string)[]): void { const p = this._parent; if (p !== null) p.insertBefore(this.nodesOf(items), this); }
  after(...items: (Node | string)[]): void { const p = this._parent; if (p !== null) p.insertBefore(this.nodesOf(items), this.nextSibling); }
  replaceWith(...items: (Node | string)[]): void { const p = this._parent; if (p === null) return; const next = this.nextSibling; p.removeChild(this); p.insertBefore(this.nodesOf(items), next); }
  remove(): void { if (this._parent !== null) this._parent.removeChild(this); }

  querySelector(selector: string): Element | null {
    let found: Element | null = null;
    const scope = this.nodeType === 1 ? (this as unknown as Element) : null;
    const walk = (n: Node): boolean => {
      for (const c of n._children) {
        if (c.nodeType !== 1) continue;
        if (matchesSelector(c as Element, selector, scope)) { found = c as Element; return true; }
        if (walk(c)) return true;
      }
      return false;
    };
    walk(this);
    return found;
  }
  querySelectorAll(selector: string): Element[] {
    const out: Element[] = [];
    const scope = this.nodeType === 1 ? (this as unknown as Element) : null;
    const walk = (n: Node): void => {
      for (const c of n._children) {
        if (c.nodeType !== 1) continue;
        if (matchesSelector(c as Element, selector, scope)) out.push(c as Element);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  getElementsByTagName(tag: string): Element[] { return tag === "*" ? this.querySelectorAll("*") : this.descendants((e) => e.localName === tag.toLowerCase()); }
  getElementsByClassName(names: string): Element[] {
    const want = names.split(/\s+/).filter((n) => n !== "");
    return this.descendants((e) => want.every((n) => e.classList.contains(n)));
  }
  /** @internal */ descendants(test: (e: Element) => boolean): Element[] {
    const out: Element[] = [];
    const walk = (n: Node): void => { for (const c of n._children) if (c.nodeType === 1) { if (test(c as Element)) out.push(c as Element); walk(c); } };
    walk(this);
    return out;
  }
}

// ---------------------------------------------------------------- CharacterData

export class CharacterData extends Node {
  private _data: string;
  constructor(type: number, doc: Document | null, data: string) { super(type, doc); this._data = data; }
  get data(): string { return this._data; }
  set data(v: string) {
    const old = this._data;
    this._data = String(v);
    mutated({ type: "characterData", target: this, oldValue: old });
  }
  get length(): number { return this._data.length; }
  override get nodeValue(): string { return this._data; }
  override set nodeValue(v: string | null) { this.data = v ?? ""; }
  override get textContent(): string { return this._data; }
  override set textContent(v: string | null) { this.data = v ?? ""; }
  appendData(s: string): void { this.data = this._data + s; }
  insertData(offset: number, s: string): void { this.data = this._data.slice(0, offset) + s + this._data.slice(offset); }
  deleteData(offset: number, count: number): void { this.data = this._data.slice(0, offset) + this._data.slice(offset + count); }
  replaceData(offset: number, count: number, s: string): void { this.data = this._data.slice(0, offset) + s + this._data.slice(offset + count); }
  substringData(offset: number, count: number): string { return this._data.slice(offset, offset + count); }
}

export class Text extends CharacterData {
  constructor(data = "", doc: Document | null = null) { super(3, doc ?? defaultDocument(), String(data)); }
  override get nodeName(): string { return "#text"; }
  get wholeText(): string {
    let start: Node = this;
    while (start.previousSibling !== null && start.previousSibling.nodeType === 3) start = start.previousSibling;
    let out = "";
    for (let n: Node | null = start; n !== null && n.nodeType === 3; n = n.nextSibling) out += (n as Text).data;
    return out;
  }
  splitText(offset: number): Text {
    const rest = new Text(this.data.slice(offset), this._doc);
    this.data = this.data.slice(0, offset);
    if (this._parent !== null) this._parent.insertBefore(rest, this.nextSibling);
    return rest;
  }
  override _cloneShallow(): Node { return new Text(this.data, this._doc); }
}

export class Comment extends CharacterData {
  constructor(data = "", doc: Document | null = null) { super(8, doc ?? defaultDocument(), String(data)); }
  override get nodeName(): string { return "#comment"; }
  override _cloneShallow(): Node { return new Comment(this.data, this._doc); }
}

export class DocumentType extends Node {
  readonly name: string;
  readonly publicId: string;
  readonly systemId: string;
  constructor(name: string, publicId = "", systemId = "", doc: Document | null = null) { super(10, doc); this.name = name; this.publicId = publicId; this.systemId = systemId; }
  override get nodeName(): string { return this.name; }
  override _cloneShallow(): Node { return new DocumentType(this.name, this.publicId, this.systemId, this._doc); }
}

export class DocumentFragment extends Node {
  constructor(doc: Document | null = null) { super(11, doc ?? defaultDocument()); }
  override get nodeName(): string { return "#document-fragment"; }
  getElementById(id: string): Element | null { return this.descendants((e) => e.id === id)[0] ?? null; }
  override _cloneShallow(): Node { return new DocumentFragment(this._doc); }
}

// ---------------------------------------------------------------- Element

export interface Attr { readonly name: string; value: string; readonly localName: string; readonly namespaceURI: string | null; readonly prefix: string | null; readonly ownerElement: Element | null; readonly specified: boolean }

/** element.attributes: the attributes in order, by index and by name. */
export interface NamedNodeMap extends ArrayLike<Attr>, Iterable<Attr> {
  getNamedItem(name: string): Attr | null;
  item(i: number): Attr | null;
  setNamedItem(attr: { name: string; value: string }): Attr | null;
  removeNamedItem(name: string): Attr;
}

const FOCUSABLE = new Set(["button", "input", "select", "textarea", "iframe", "summary"]);
const FORM_CONTROL = new Set(["button", "input", "select", "textarea", "fieldset", "optgroup", "option"]);

export class Element extends Node implements SelectorElement {
  readonly localName: string;
  readonly namespaceURI: string | null;
  readonly prefix: string | null = null;
  /** @internal name, value pairs in order */ _attrs: { name: string; value: string }[] = [];
  /** @internal */ _box: Rect | null = null;
  /** @internal pointer-events: none (or not visible): hit testing passes through it */ _noHit = false;
  /** @internal paint order from the page painter (-1: unknown, document order decides) */ _order = -1;
  private _classList: DOMTokenList | null = null;
  private _style: CSSStyleDeclaration | null = null;
  private _dataset: Record<string, string | undefined> | null = null;
  scrollTop = 0;
  scrollLeft = 0;

  constructor(doc: Document | null, localName: string, namespaceURI: string | null = HTML_NS) {
    super(1, doc ?? defaultDocument());
    this.localName = namespaceURI === HTML_NS ? localName.toLowerCase() : localName;
    this.namespaceURI = namespaceURI;
  }

  get tagName(): string { return this.namespaceURI === HTML_NS ? this.localName.toUpperCase() : this.localName; }
  override get nodeName(): string { return this.tagName; }

  // attributes
  private norm(name: string): string { return this.namespaceURI === HTML_NS ? String(name).toLowerCase() : String(name); }
  getAttribute(name: string): string | null { const n = this.norm(name); for (const a of this._attrs) if (a.name === n) return a.value; return null; }
  getAttributeNS(_ns: string | null, name: string): string | null { return this.getAttribute(name); }
  hasAttribute(name: string): boolean { return this.getAttribute(name) !== null; }
  hasAttributes(): boolean { return this._attrs.length > 0; }
  getAttributeNames(): string[] { return this._attrs.map((a) => a.name); }
  setAttribute(name: string, value: unknown): void {
    const n = this.norm(name);
    if (!/^[^\s"'>/=\u0000-\u001f]+$/.test(n)) throw new DOMException(`'${name}' is not a valid attribute name.`, "InvalidCharacterError");
    const v = String(value);
    const a = this._attrs.find((x) => x.name === n);
    const old = a === undefined ? null : a.value;
    if (a === undefined) this._attrs.push({ name: n, value: v }); else a.value = v;
    this._attributeChanged(n, old, v);
  }
  setAttributeNS(_ns: string | null, name: string, value: unknown): void { this.setAttribute(name.includes(":") ? name.slice(name.indexOf(":") + 1) : name, value); }
  removeAttribute(name: string): void {
    const n = this.norm(name);
    const i = this._attrs.findIndex((x) => x.name === n);
    if (i < 0) return;
    const old = (this._attrs[i] as { value: string }).value;
    this._attrs.splice(i, 1);
    this._attributeChanged(n, old, null);
  }
  removeAttributeNS(_ns: string | null, name: string): void { this.removeAttribute(name); }
  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.hasAttribute(name);
    if (on && !this.hasAttribute(name)) this.setAttribute(name, "");
    else if (!on) this.removeAttribute(name);
    return on;
  }
  get attributes(): NamedNodeMap {
    const el = this;
    const attr = (a: { name: string; value: string }): Attr => ({
      name: a.name, localName: a.name, namespaceURI: null, prefix: null, ownerElement: el, specified: true,
      get value(): string { return el.getAttribute(a.name) ?? ""; },
      set value(v: string) { el.setAttribute(a.name, v); },
    });
    const list = this._attrs.map(attr);
    const map = Object.assign(list, {
      getNamedItem: (name: string): Attr | null => { const a = el._attrs.find((x) => x.name === el.norm(name)); return a === undefined ? null : attr(a); },
      item: (i: number): Attr | null => list[i] ?? null,
      setNamedItem: (a: { name: string; value: string }): Attr | null => { const old = map.getNamedItem(a.name); el.setAttribute(a.name, a.value); return old; },
      removeNamedItem: (name: string): Attr => {
        const old = map.getNamedItem(name);
        if (old === null) throw new DOMException("No such attribute: " + name, "NotFoundError");
        el.removeAttribute(name);
        return old;
      },
    });
    return map as unknown as NamedNodeMap;
  }
  /** @internal */ _attributeChanged(name: string, old: string | null, value: string | null): void {
    mutated({ type: "attributes", target: this, attributeName: name, oldValue: old });
    void value;
  }

  // reflected attributes
  get id(): string { return this.getAttribute("id") ?? ""; }
  set id(v: string) { this.setAttribute("id", v); }
  get className(): string { return this.getAttribute("class") ?? ""; }
  set className(v: string) { this.setAttribute("class", v); }
  get classList(): DOMTokenList { if (this._classList === null) this._classList = new DOMTokenList(this, "class"); return this._classList; }
  set classList(v: unknown) { this.setAttribute("class", String(v)); }
  get style(): CSSStyleDeclaration { if (this._style === null) this._style = styleDeclaration(this); return this._style; }
  set style(v: unknown) { this.setAttribute("style", String(v)); }
  get dataset(): Record<string, string | undefined> { if (this._dataset === null) this._dataset = makeDataset(this); return this._dataset; }
  get hidden(): boolean { return this.hasAttribute("hidden"); }
  set hidden(v: boolean) { this.toggleAttribute("hidden", Boolean(v)); }
  get title(): string { return this.getAttribute("title") ?? ""; }
  set title(v: string) { this.setAttribute("title", v); }
  get lang(): string { return this.getAttribute("lang") ?? ""; }
  set lang(v: string) { this.setAttribute("lang", v); }
  get dir(): string { return this.getAttribute("dir") ?? ""; }
  set dir(v: string) { this.setAttribute("dir", v); }
  get slot(): string { return this.getAttribute("slot") ?? ""; }
  get inert(): boolean { return this.hasAttribute("inert"); }
  set inert(v: boolean) { this.toggleAttribute("inert", v); }
  get draggable(): boolean { return this.getAttribute("draggable") === "true"; }
  set draggable(v: boolean) { this.setAttribute("draggable", String(v)); }
  get accessKey(): string { return this.getAttribute("accesskey") ?? ""; }
  get contentEditable(): string { return this.getAttribute("contenteditable") ?? "inherit"; }
  set contentEditable(v: string) { this.setAttribute("contenteditable", v); }
  get isContentEditable(): boolean { for (let e: Element | null = this; e !== null; e = e.parentElement) { const c = e.getAttribute("contenteditable"); if (c !== null) return c !== "false"; } return false; }
  get tabIndex(): number {
    const v = this.getAttribute("tabindex");
    if (v !== null && /^-?\d+$/.test(v.trim())) return Number(v);
    return this._naturallyFocusable() ? 0 : -1;
  }
  set tabIndex(v: number) { this.setAttribute("tabindex", String(Math.trunc(v))); }
  get role(): string | null { return this.getAttribute("role"); }
  set role(v: string | null) { if (v === null) this.removeAttribute("role"); else this.setAttribute("role", v); }

  // markup
  get innerHTML(): string { return html.serialize(this, false); }
  set innerHTML(markup: string) { this._replaceAll(html.parseFragment(this._doc ?? defaultDocument(), String(markup), this)); }
  get outerHTML(): string { return html.serialize(this, true); }
  set outerHTML(markup: string) {
    const p = this._parent;
    if (p === null) return;
    const nodes = html.parseFragment(this._doc ?? defaultDocument(), String(markup), p.nodeType === 1 ? (p as Element) : null);
    const f = (this._doc ?? defaultDocument()).createDocumentFragment();
    for (const n of nodes) f.appendChild(n);
    p.replaceChild(f, this);
  }
  get innerText(): string { return this.textContent ?? ""; }
  set innerText(v: string) {
    const doc = this._doc ?? defaultDocument();
    const parts = String(v).split("\n");
    const nodes: Node[] = [];
    parts.forEach((p, i) => { if (i > 0) nodes.push(doc.createElement("br")); if (p !== "") nodes.push(doc.createTextNode(p)); });
    this._replaceAll(nodes);
  }
  get outerText(): string { return this.innerText; }
  insertAdjacentHTML(where: string, markup: string): void {
    const ctx = where === "beforebegin" || where === "afterend" ? this.parentElement : this;
    const nodes = html.parseFragment(this._doc ?? defaultDocument(), markup, ctx);
    const f = (this._doc ?? defaultDocument()).createDocumentFragment();
    for (const n of nodes) f.appendChild(n);
    this.insertAdjacent(where, f);
  }
  insertAdjacentElement(where: string, el: Element): Element | null { return this.insertAdjacent(where, el) as Element | null; }
  insertAdjacentText(where: string, text: string): void { this.insertAdjacent(where, (this._doc ?? defaultDocument()).createTextNode(text)); }
  private insertAdjacent(where: string, node: Node): Node | null {
    switch (where.toLowerCase()) {
      case "beforebegin": if (this._parent === null) return null; this._parent.insertBefore(node, this); return node;
      case "afterbegin": this.insertBefore(node, this.firstChild); return node;
      case "beforeend": this.appendChild(node); return node;
      case "afterend": if (this._parent === null) return null; this._parent.insertBefore(node, this.nextSibling); return node;
      default: throw new DOMException("Bad position: " + where, "SyntaxError");
    }
  }

  // selectors
  matches(selector: string): boolean { return matchesSelector(this, selector, this); }
  webkitMatchesSelector(selector: string): boolean { return this.matches(selector); }
  closest(selector: string): Element | null {
    for (let e: Element | null = this; e !== null; e = e.parentElement) if (matchesSelector(e, selector, this)) return e;
    return null;
  }
  /** @internal */ _root(): Element | null { return this._doc?.documentElement ?? null; }
  /** @internal */ _isEmpty(): boolean { return this._children.every((c) => c.nodeType === 8 || (c.nodeType === 3 && (c as Text).data === "")); }
  /** @internal pseudo-class state */
  _state(name: string): boolean {
    const doc = this._doc;
    switch (name) {
      case "hover": return doc !== null && doc._hover !== null && this.contains(doc._hover);
      case "active": return doc !== null && doc._active !== null && this.contains(doc._active);
      case "focus": return doc !== null && doc._focused === this;
      case "focus-visible": return doc !== null && doc._focused === this && doc._focusVisible;
      case "focus-within": return doc !== null && doc._focused !== null && this.contains(doc._focused);
      case "disabled": return this._disabled();
      case "enabled": return FORM_CONTROL.has(this.localName) && !this._disabled();
      case "link": case "any-link": return (this.localName === "a" || this.localName === "area") && this.hasAttribute("href");
      case "target": return doc !== null && this.id !== "" && doc._hash() === "#" + this.id;
      case "open": case "modal": return this.hasAttribute("open");
      case "required": return this.hasAttribute("required");
      case "optional": return FORM_CONTROL.has(this.localName) && !this.hasAttribute("required");
      case "read-only": return !this._state("read-write");
      case "read-write": return this.isContentEditable || ((this.localName === "input" || this.localName === "textarea") && !this.hasAttribute("readonly") && !this._disabled());
      case "fullscreen": return doc !== null && doc.fullscreenElement === this;
      default: return false;
    }
  }
  /** @internal disabled form control (its own attribute or a disabled fieldset around it) */
  _disabled(): boolean {
    if (!FORM_CONTROL.has(this.localName)) return false;
    if (this.hasAttribute("disabled")) return true;
    if (this.localName === "option") { const g = this.parentElement; return g !== null && g.localName === "optgroup" && g.hasAttribute("disabled"); }
    for (let p = this.parentElement; p !== null; p = p.parentElement) {
      if (p.localName === "fieldset" && p.hasAttribute("disabled")) {
        // the fieldset's first legend stays enabled
        const legend = p.children.find((c) => c.localName === "legend");
        return legend === undefined || !legend.contains(this);
      }
    }
    return false;
  }

  // focus
  /** @internal */ _naturallyFocusable(): boolean {
    const n = this.localName;
    if (FOCUSABLE.has(n)) return !(n === "input" && this.getAttribute("type") === "hidden");
    if ((n === "a" || n === "area") && this.hasAttribute("href")) return true;
    if ((n === "audio" || n === "video") && this.hasAttribute("controls")) return true;
    return this.isContentEditable;
  }
  /** @internal could take the focus now */
  _focusable(): boolean {
    if (!this.isConnected || this._disabled() || this.inert) return false;
    for (let e: Element | null = this; e !== null; e = e.parentElement) if (e.hidden || e.inert) return false;
    return this._naturallyFocusable() || this.hasAttribute("tabindex");
  }
  focus(options?: { preventScroll?: boolean; focusVisible?: boolean }): void {
    const doc = this._doc;
    if (doc === null || !this._focusable()) return;
    doc._moveFocus(this, options?.focusVisible);
  }
  blur(): void { const doc = this._doc; if (doc !== null && doc._focused === this) doc._moveFocus(null); }

  click(): void {
    if (this._disabled()) return;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, detail: 1, view: this._doc?.defaultView });
    const undo = this._preActivate();
    const ok = this.dispatchEvent(event);
    if (!ok) { undo(); return; }
    this._activate(event);
  }
  /** @internal checkbox and radio change before click listeners run (undone if one cancels) */ _preActivate(): () => void { return () => {}; }
  /** @internal the default action after a click nobody canceled */ _activate(_event: Event): void {}

  // geometry
  /** @internal the box, or the viewport for the root and body */
  _layoutBox(): Rect {
    if (this._box !== null) return this._box;
    const doc = this._doc;
    if (doc !== null && (this === doc.documentElement || this === doc.body)) return { x: 0, y: 0, w: doc._viewport.w, h: doc._viewport.h };
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  getBoundingClientRect(): DOMRect { return new DOMRect(this._layoutBox()); }
  getClientRects(): DOMRect[] { return this._box === null ? [] : [new DOMRect(this._box)]; }
  get clientWidth(): number { return this._layoutBox().w; }
  get clientHeight(): number { return this._layoutBox().h; }
  get clientLeft(): number { return 0; }
  get clientTop(): number { return 0; }
  get offsetWidth(): number { return this._layoutBox().w; }
  get offsetHeight(): number { return this._layoutBox().h; }
  get offsetLeft(): number { return this._layoutBox().x; }
  get offsetTop(): number { return this._layoutBox().y; }
  get offsetParent(): Element | null { return this._doc?.body ?? null; }
  get scrollWidth(): number { return this._layoutBox().w; }
  get scrollHeight(): number { return this._layoutBox().h; }
  scrollIntoView(_arg?: unknown): void {}
  scrollTo(..._args: unknown[]): void {}
  scrollBy(..._args: unknown[]): void {}
  checkVisibility(): boolean { for (let e: Element | null = this; e !== null; e = e.parentElement) if (e.hidden) return false; return this.isConnected; }

  // pointer and fullscreen
  setPointerCapture(_id: number): void { if (this._doc !== null) this._doc._capture = this; }
  releasePointerCapture(_id: number): void { if (this._doc !== null && this._doc._capture === this) this._doc._capture = null; }
  hasPointerCapture(_id: number): boolean { return this._doc !== null && this._doc._capture === this; }
  requestPointerLock(_options?: unknown): Promise<void> {
    const doc = this._doc;
    if (doc !== null) { doc.pointerLockElement = this; doc.dispatchEvent(new Event("pointerlockchange", { bubbles: true })); }
    return Promise.resolve();
  }
  requestFullscreen(_options?: unknown): Promise<void> {
    const doc = this._doc;
    if (doc !== null) { doc.fullscreenElement = this; this.dispatchEvent(new Event("fullscreenchange", { bubbles: true })); }
    return Promise.resolve();
  }
  animate(): { finished: Promise<void>; cancel(): void; onfinish: null } { return { finished: Promise.resolve(), cancel(): void {}, onfinish: null }; }
  getAnimations(): unknown[] { return []; }
  attachShadow(_init: unknown): DocumentFragment { return new DocumentFragment(this._doc); }

  override _cloneShallow(): Node {
    const copy = (this._doc ?? defaultDocument()).createElementNS(this.namespaceURI, this.localName);
    for (const a of this._attrs) copy.setAttribute(a.name, a.value);
    this._cloneInto(copy);
    return copy;
  }
  /** @internal subclasses copy their state (an input's value) */ _cloneInto(_copy: Element): void {}
  override _removed(from: Node): void {
    const doc = this._doc;
    if (doc !== null && doc._focused !== null && this.contains(doc._focused)) doc._focused = null;
    super._removed(from);
  }
}

export class DOMRect {
  x: number; y: number; width: number; height: number;
  constructor(r: Rect | number = 0, y = 0, width = 0, height = 0) {
    if (typeof r === "number") { this.x = r; this.y = y; this.width = width; this.height = height; }
    else { this.x = r.x; this.y = r.y; this.width = r.w; this.height = r.h; }
  }
  get left(): number { return Math.min(this.x, this.x + this.width); }
  get top(): number { return Math.min(this.y, this.y + this.height); }
  get right(): number { return Math.max(this.x, this.x + this.width); }
  get bottom(): number { return Math.max(this.y, this.y + this.height); }
  toJSON(): Record<string, number> { return { x: this.x, y: this.y, width: this.width, height: this.height, left: this.left, top: this.top, right: this.right, bottom: this.bottom }; }
}

/** Place an element on screen (CSS pixels): what geometry and hit testing report. null: not drawn. */
export function setLayoutBox(e: Element, box: Rect | null): void { e._box = box; }
export function layoutBox(e: Element): Rect | null { return e._box; }

// ---------------------------------------------------------------- element registry

type ElementClass = new (doc: Document, localName: string) => Element;
const registry = new Map<string, ElementClass>();

/** The class for an HTML element name (createElement and the parser use it). */
export function defineElement(localName: string, ctor: ElementClass): void { registry.set(localName.toLowerCase(), ctor); }
export function elementClass(localName: string): ElementClass | undefined { return registry.get(localName.toLowerCase()); }

export class HTMLElement extends Element {
  constructor(doc: Document | null, localName: string) { super(doc, localName, HTML_NS); }
}
export class HTMLUnknownElement extends HTMLElement {}

// ---------------------------------------------------------------- Document

export class Document extends Node {
  /** The window events bubble to from the document (set by the browser layer). */
  defaultView: unknown = null;
  /** @internal */ _window: EventTarget | null = null;
  /** @internal */ _focused: Element | null = null;
  /** @internal */ _focusVisible = false;
  /** @internal */ _hover: Element | null = null;
  /** @internal */ _active: Element | null = null;
  /** @internal */ _capture: Element | null = null;
  /** @internal */ _viewport = { w: 0, h: 0 };
  /** @internal */ _url = "about:blank";
  readyState: "loading" | "interactive" | "complete" = "complete";
  visibilityState: "visible" | "hidden" = "visible";
  pointerLockElement: Element | null = null;
  fullscreenElement: Element | null = null;
  readonly fullscreenEnabled = true;
  readonly pointerLockEnabled = true;
  cookie = "";
  referrer = "";
  designMode = "off";
  readonly characterSet = "UTF-8";
  readonly charset = "UTF-8";
  readonly contentType = "text/html";
  readonly compatMode = "CSS1Compat";
  readonly implementation = { createHTMLDocument: (title?: string): Document => { const d = new Document(); d.initialize(title); return d; }, hasFeature: (): boolean => true };
  onvisibilitychange: ((e: Event) => void) | null = null;

  constructor() {
    super(9, null);
    this._doc = this;
    if (currentDocument === null) currentDocument = this;
  }
  /** Give an empty document its html, head and body. */
  initialize(title?: string): void {
    const root = this.createElement("html");
    root.append(this.createElement("head"), this.createElement("body"));
    this.appendChild(root);
    if (title !== undefined) this.title = title;
  }

  override get nodeName(): string { return "#document"; }
  override get textContent(): null { return null; }
  override set textContent(_v: string | null) {}
  get documentElement(): Element | null { return this.firstElementChild; }
  get head(): Element | null { return this.documentElement?.children.find((c) => c.localName === "head") ?? null; }
  get body(): Element | null { return this.documentElement?.children.find((c) => c.localName === "body" || c.localName === "frameset") ?? null; }
  get doctype(): DocumentType | null { return (this._children.find((c) => c.nodeType === 10) as DocumentType | undefined) ?? null; }
  get title(): string { return (this.querySelector("title")?.textContent ?? "").replace(/\s+/g, " ").trim(); }
  set title(v: string) {
    let t = this.querySelector("title");
    if (t === null) { t = this.createElement("title"); this.head?.appendChild(t); }
    t.textContent = v;
  }
  get URL(): string { return this._url; }
  get documentURI(): string { return this._url; }
  get location(): unknown { return (this.defaultView as { location?: unknown } | null)?.location ?? null; }
  get hidden(): boolean { return this.visibilityState === "hidden"; }
  get activeElement(): Element | null { return this._focused !== null && this._focused.isConnected ? this._focused : this.body; }
  get scrollingElement(): Element | null { return this.documentElement; }
  get forms(): Element[] { return this.getElementsByTagName("form"); }
  get images(): Element[] { return this.getElementsByTagName("img"); }
  get links(): Element[] { return this.querySelectorAll("a[href], area[href]"); }
  get scripts(): Element[] { return this.getElementsByTagName("script"); }
  get styleSheets(): unknown[] { return []; }
  hasFocus(): boolean { return true; }

  createElement(tag: string, _options?: unknown): Element {
    const name = String(tag);
    if (!/^[a-zA-Z][^\s\/>]*$/.test(name)) throw new DOMException(`'${tag}' is not a valid name.`, "InvalidCharacterError");
    const ctor = elementClass(name);
    return ctor !== undefined ? new ctor(this, name.toLowerCase()) : new HTMLElement(this, name);
  }
  createElementNS(ns: string | null, qualified: string): Element {
    if (ns === HTML_NS || ns === null || ns === "") return this.createElement(qualified);
    const local = qualified.includes(":") ? qualified.slice(qualified.indexOf(":") + 1) : qualified;
    return new Element(this, local, ns);
  }
  createTextNode(data: string): Text { return new Text(String(data), this); }
  createComment(data: string): Comment { return new Comment(String(data), this); }
  createDocumentFragment(): DocumentFragment { return new DocumentFragment(this); }
  createEvent(kind: string): Event {
    const e = new Event("");
    void kind;
    return e;
  }
  createAttribute(name: string): { name: string; value: string } { return { name: name.toLowerCase(), value: "" }; }
  importNode<T extends Node>(node: T, deep = false): T { const copy = node.cloneNode(deep) as T; copy._adopt(this); return copy; }
  adoptNode<T extends Node>(node: T): T { node.remove(); node._adopt(this); return node; }
  getElementById(id: string): Element | null {
    let found: Element | null = null;
    const walk = (n: Node): boolean => {
      for (const c of n._children) {
        if (c.nodeType !== 1) continue;
        if ((c as Element).id === id) { found = c as Element; return true; }
        if (walk(c)) return true;
      }
      return false;
    };
    walk(this);
    return found;
  }
  getElementsByName(name: string): Element[] { return this.descendants((e) => e.getAttribute("name") === name); }

  /** The topmost element whose layout box holds (x, y): later in document order is on top. */
  elementFromPoint(x: number, y: number): Element | null { return this.elementsFromPoint(x, y)[0] ?? null; }
  elementsFromPoint(x: number, y: number): Element[] {
    const hits: Element[] = [];
    const walk = (e: Element): void => {
      if (e.hidden) return;
      const b = e._box;
      if (b !== null && !e._noHit && x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) hits.push(e);
      for (const c of e.children) walk(c);
    };
    const root = this.documentElement;
    if (root !== null) walk(root);
    // topmost first: by paint order where the page painter gave one, else later in the document
    const seq = new Map<Element, number>(hits.map((e, i) => [e, i]));
    hits.sort((a, b) => (a._order >= 0 && b._order >= 0 ? b._order - a._order : (seq.get(b) ?? 0) - (seq.get(a) ?? 0)));
    const body = this.body;
    if (body !== null && !hits.includes(body)) hits.push(body);
    if (root !== null && !hits.includes(root)) hits.push(root);
    return hits;
  }
  exitPointerLock(): void { if (this.pointerLockElement !== null) { this.pointerLockElement = null; this.dispatchEvent(new Event("pointerlockchange", { bubbles: true })); } }
  exitFullscreen(): Promise<void> {
    const el = this.fullscreenElement;
    this.fullscreenElement = null;
    if (el !== null) el.dispatchEvent(new Event("fullscreenchange", { bubbles: true }));
    return Promise.resolve();
  }
  open(): Document { return this; }
  close(): void {}
  write(...markup: string[]): void { const b = this.body; if (b !== null) b.insertAdjacentHTML("beforeend", markup.join("")); }
  writeln(...markup: string[]): void { this.write(...markup, "\n"); }
  execCommand(): boolean { return false; }
  queryCommandSupported(): boolean { return false; }

  override _eventParent(event: Event): EventTarget | null { return event.type === "load" ? null : this._window; }
  override _cloneShallow(): Node { return new Document(); }
  /** @internal */ _hash(): string { const loc = this.location as { hash?: string } | null; return loc?.hash ?? ""; }

  /** @internal move the focus, with blur/focusout on the old element and focus/focusin on the new */
  _moveFocus(to: Element | null, visible?: boolean): void {
    const from = this._focused;
    if (visible !== undefined) this._focusVisible = visible;
    if (from === to) return;
    this._focused = to;
    if (from !== null) {
      from.dispatchEvent(new FocusEvent("blur", { relatedTarget: to }));
      from.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: to }));
    }
    if (to !== null && this._focused === to) {
      to.dispatchEvent(new FocusEvent("focus", { relatedTarget: from }));
      to.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: from }));
    }
  }
  /** The elements Tab moves through, in order: positive tabindex first (ascending), then document order. */
  sequentialFocusOrder(): Element[] {
    const all = this.descendants((e) => e._focusable() && e.tabIndex >= 0);
    const positive = all.filter((e) => e.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex);
    return [...positive, ...all.filter((e) => e.tabIndex === 0)];
  }
}
