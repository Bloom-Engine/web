/**
 * The HTML elements with behavior of their own: form controls (input,
 * button, select, option, textarea, label, form, fieldset), a, details,
 * dialog, template, canvas and img.
 *
 * What needs a platform is a hook: a canvas's contexts (`setCanvasContext`)
 * and loading an image (`setImageLoader`). Media elements (audio, video)
 * are defined by the audio module.
 */
import { Event, InputEvent, type MouseEvent } from "./events.ts";
import { DocumentFragment, Element, HTMLElement, defineElement, defaultDocument, type Document, type Node } from "./node.ts";

const reflectString = (cls: { prototype: object }, prop: string, attr = prop.toLowerCase(), fallback = ""): void => {
  Object.defineProperty(cls.prototype, prop, {
    get(this: Element): string { return this.getAttribute(attr) ?? fallback; },
    set(this: Element, v: string): void { this.setAttribute(attr, String(v)); },
    configurable: true,
  });
};
const reflectBool = (cls: { prototype: object }, prop: string, attr = prop.toLowerCase()): void => {
  Object.defineProperty(cls.prototype, prop, {
    get(this: Element): boolean { return this.hasAttribute(attr); },
    set(this: Element, v: boolean): void { this.toggleAttribute(attr, Boolean(v)); },
    configurable: true,
  });
};
const reflectNumber = (cls: { prototype: object }, prop: string, attr: string, fallback: number): void => {
  Object.defineProperty(cls.prototype, prop, {
    get(this: Element): number { const v = this.getAttribute(attr); const n = v === null ? NaN : parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : fallback; },
    set(this: Element, v: number): void { this.setAttribute(attr, String(Math.max(0, Math.trunc(v)))); },
    configurable: true,
  });
};

function formOf(e: Element): HTMLFormElement | null {
  const id = e.getAttribute("form");
  if (id !== null) { const f = e.ownerDocument?.getElementById(id); return f instanceof HTMLFormElement ? f : null; }
  return e.closest("form") as HTMLFormElement | null;
}

function fire(target: Element, type: string, bubbles = true): void {
  target.dispatchEvent(type === "input" ? new InputEvent("input", { bubbles, composed: true }) : new Event(type, { bubbles }));
}

// ---------------------------------------------------------------- input

export class HTMLInputElement extends HTMLElement {
  declare name: string; declare placeholder: string; declare min: string; declare max: string; declare step: string; declare pattern: string; declare accept: string; declare autocomplete: string; declare inputMode: string; declare list: string; declare alt: string; declare src: string;
  declare disabled: boolean; declare required: boolean; declare readOnly: boolean; declare multiple: boolean; declare autofocus: boolean; declare maxLength: number; declare size: number;
  private _value: string | null = null;
  private _checked: boolean | null = null;
  indeterminate = false;
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  selectionDirection = "none";
  files: unknown[] | null = null;

  get type(): string {
    const t = (this.getAttribute("type") ?? "text").toLowerCase();
    return ["hidden", "text", "search", "tel", "url", "email", "password", "date", "month", "week", "time", "datetime-local", "number", "range", "color", "checkbox", "radio", "file", "submit", "image", "reset", "button"].includes(t) ? t : "text";
  }
  set type(v: string) { this.setAttribute("type", v); }
  get defaultValue(): string { return this.getAttribute("value") ?? ""; }
  set defaultValue(v: string) { this.setAttribute("value", v); }
  get value(): string {
    const t = this.type;
    if (t === "checkbox" || t === "radio") return this.getAttribute("value") ?? "on";
    let v = this._value ?? this.defaultValue;
    if (t === "range") {
      const min = this.numberAttr("min", 0), max = this.numberAttr("max", 100);
      let n = parseFloat(v);
      if (!Number.isFinite(n)) n = max < min ? min : min + (max - min) / 2;
      n = Math.min(Math.max(n, min), Math.max(min, max));
      const step = this.numberAttr("step", 1);
      if (step > 0) n = min + Math.round((n - min) / step) * step;
      v = String(Number(n.toFixed(10)));
    } else if (t === "color") v = /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : "#000000";
    return v;
  }
  set value(v: string) {
    const t = this.type;
    if (t === "checkbox" || t === "radio") { this.setAttribute("value", String(v)); return; }
    this._value = v === null ? "" : String(v);
    this.selectionStart = this.selectionEnd = this._value.length;
  }
  get valueAsNumber(): number { const n = parseFloat(this.value); return Number.isFinite(n) ? n : NaN; }
  set valueAsNumber(n: number) { this.value = String(n); }
  get defaultChecked(): boolean { return this.hasAttribute("checked"); }
  set defaultChecked(v: boolean) { this.toggleAttribute("checked", v); }
  get checked(): boolean { return this._checked ?? this.defaultChecked; }
  set checked(v: boolean) {
    this._checked = Boolean(v);
    if (this._checked && this.type === "radio") this.uncheckGroup();
  }
  private uncheckGroup(): void {
    const name = this.getAttribute("name");
    if (name === null || name === "") return;
    const scope: Node = formOf(this) ?? this.getRootNode();
    for (const other of (scope as Element).querySelectorAll("input")) {
      if (other !== this && other instanceof HTMLInputElement && other.type === "radio" && other.getAttribute("name") === name && formOf(other) === formOf(this)) other._checked = false;
    }
  }
  private numberAttr(name: string, fallback: number): number { const n = parseFloat(this.getAttribute(name) ?? ""); return Number.isFinite(n) ? n : fallback; }
  get form(): HTMLFormElement | null { return formOf(this); }
  get labels(): Element[] { return labelsOf(this); }
  select(): void { this.selectionStart = 0; this.selectionEnd = this.value.length; this.dispatchEvent(new Event("select", { bubbles: true })); }
  setSelectionRange(start: number, end: number, direction = "none"): void { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  setRangeText(text: string): void { const v = this.value; this.value = v.slice(0, this.selectionStart ?? 0) + text + v.slice(this.selectionEnd ?? 0); }
  stepUp(n = 1): void { this.value = String(this.valueAsNumber + n * this.numberAttr("step", 1)); }
  stepDown(n = 1): void { this.stepUp(-n); }
  checkValidity(): boolean { return !(this.hasAttribute("required") && this.value === "" && this.type !== "checkbox") && !(this.type === "checkbox" && this.hasAttribute("required") && !this.checked); }
  reportValidity(): boolean { return this.checkValidity(); }
  setCustomValidity(_message: string): void {}
  get validity(): { valid: boolean; valueMissing: boolean } { const valid = this.checkValidity(); return { valid, valueMissing: !valid }; }
  showPicker(): void {}

  override _preActivate(): () => void {
    const t = this.type;
    if (t === "checkbox") { const was = this.checked; this.checked = !was; return () => { this.checked = was; }; }
    if (t === "radio") {
      const name = this.getAttribute("name");
      const prev = name === null ? null : ((this.getRootNode() as Element).querySelectorAll(`input[type=radio][name="${name}"]`).find((r) => (r as HTMLInputElement).checked) ?? null) as HTMLInputElement | null;
      const was = this.checked;
      this.checked = true;
      return () => { this.checked = was; if (prev !== null && prev !== this) prev.checked = true; };
    }
    return () => {};
  }
  override _activate(_event: Event): void {
    const t = this.type;
    if (t === "checkbox" || t === "radio") { fire(this, "input"); fire(this, "change"); return; }
    const form = formOf(this);
    if (form !== null && (t === "submit" || t === "image")) form.requestSubmit();
    else if (form !== null && t === "reset") form.reset();
  }
  override _cloneInto(copy: Element): void {
    const c = copy as HTMLInputElement;
    c._value = this._value; c._checked = this._checked;
  }
  /** @internal reset to the default value and checkedness */ _reset(): void { this._value = null; this._checked = null; }
}
for (const p of ["name", "placeholder", "min", "max", "step", "pattern", "accept", "autocomplete", "inputMode", "list", "alt", "src"]) reflectString(HTMLInputElement, p);
for (const p of ["disabled", "required", "readOnly", "multiple", "autofocus"]) reflectBool(HTMLInputElement, p);
reflectNumber(HTMLInputElement, "maxLength", "maxlength", -1);
reflectNumber(HTMLInputElement, "size", "size", 20);

// ---------------------------------------------------------------- button

export class HTMLButtonElement extends HTMLElement {
  declare name: string; declare value: string; declare formAction: string; declare disabled: boolean; declare autofocus: boolean;
  get type(): string { const t = (this.getAttribute("type") ?? "submit").toLowerCase(); return t === "button" || t === "reset" ? t : "submit"; }
  set type(v: string) { this.setAttribute("type", v); }
  get form(): HTMLFormElement | null { return formOf(this); }
  get labels(): Element[] { return labelsOf(this); }
  override _activate(_event: Event): void {
    const form = formOf(this);
    if (form === null) return;
    if (this.type === "submit") form.requestSubmit(this);
    else if (this.type === "reset") form.reset();
  }
}
for (const p of ["name", "value", "formAction"]) reflectString(HTMLButtonElement, p);
for (const p of ["disabled", "autofocus"]) reflectBool(HTMLButtonElement, p);

// ---------------------------------------------------------------- select and option

export class HTMLOptionElement extends HTMLElement {
  declare disabled: boolean;
  /** @internal selectedness once set by script or the user; null: the selected attribute decides */ _selected: boolean | null = null;
  get value(): string { return this.getAttribute("value") ?? this.text; }
  set value(v: string) { this.setAttribute("value", v); }
  get text(): string { return (this.textContent ?? "").replace(/\s+/g, " ").trim(); }
  set text(v: string) { this.textContent = v; }
  get label(): string { return this.getAttribute("label") ?? this.text; }
  set label(v: string) { this.setAttribute("label", v); }
  get defaultSelected(): boolean { return this.hasAttribute("selected"); }
  set defaultSelected(v: boolean) { this.toggleAttribute("selected", v); }
  get selected(): boolean {
    const s = this._select();
    if (s !== null) return s.selectedOptions.includes(this);
    return this._selected ?? this.defaultSelected;
  }
  set selected(v: boolean) {
    const s = this._select();
    if (s !== null && v && !s.multiple) for (const o of s.options) if (o !== this) o._selected = false;
    this._selected = Boolean(v);
  }
  get index(): number { const s = this._select(); return s === null ? 0 : s.options.indexOf(this); }
  get form(): HTMLFormElement | null { const s = this._select(); return s === null ? null : formOf(s); }
  /** @internal */ _select(): HTMLSelectElement | null {
    for (let p = this.parentElement; p !== null; p = p.parentElement) {
      if (p instanceof HTMLSelectElement) return p;
      if (p.localName !== "optgroup") return null;
    }
    return null;
  }
  override _cloneInto(copy: Element): void { (copy as HTMLOptionElement)._selected = this._selected; }
}
reflectBool(HTMLOptionElement, "disabled");

export class HTMLSelectElement extends HTMLElement {
  declare name: string; declare disabled: boolean; declare required: boolean; declare multiple: boolean; declare autofocus: boolean; declare size: number;
  get type(): string { return this.multiple ? "select-multiple" : "select-one"; }
  get options(): HTMLOptionElement[] {
    const out: HTMLOptionElement[] = [];
    for (const c of this.children) {
      if (c instanceof HTMLOptionElement) out.push(c);
      else if (c.localName === "optgroup") for (const o of c.children) if (o instanceof HTMLOptionElement) out.push(o);
    }
    return out;
  }
  get length(): number { return this.options.length; }
  /** The selected options: explicit choices, else the selected attributes, else (single choice) the first enabled option. */
  get selectedOptions(): HTMLOptionElement[] {
    const opts = this.options;
    const chosen = opts.filter((o) => o._selected ?? o.defaultSelected);
    if (this.multiple) return chosen;
    if (chosen.length > 0) return [chosen[chosen.length - 1] as HTMLOptionElement];
    if (this.size > 1) return [];
    const first = opts.find((o) => !o._disabled());
    return first === undefined ? [] : [first];
  }
  get selectedIndex(): number { const s = this.selectedOptions[0]; return s === undefined ? -1 : this.options.indexOf(s); }
  set selectedIndex(i: number) { const opts = this.options; for (const [k, o] of opts.entries()) o._selected = k === i; }
  get value(): string { return this.selectedOptions[0]?.value ?? ""; }
  set value(v: string) { let done = false; for (const o of this.options) { const hit = !done && o.value === String(v); o._selected = hit; if (hit) done = true; } }
  get form(): HTMLFormElement | null { return formOf(this); }
  get labels(): Element[] { return labelsOf(this); }
  item(i: number): HTMLOptionElement | null { return this.options[i] ?? null; }
  namedItem(name: string): HTMLOptionElement | null { return this.options.find((o) => o.id === name || o.getAttribute("name") === name) ?? null; }
  add(option: HTMLOptionElement, before?: HTMLOptionElement | number | null): void {
    const ref = typeof before === "number" ? this.options[before] ?? null : before ?? null;
    if (ref !== null && ref.parentNode !== null) ref.parentNode.insertBefore(option, ref); else this.appendChild(option);
  }
  override remove(index?: number): void {
    if (index === undefined) { super.remove(); return; }
    this.options[index]?.remove();
  }
  checkValidity(): boolean { return !(this.required && this.value === ""); }
  showPicker(): void {}
  override _cloneInto(_copy: Element): void {}
}
for (const p of ["name"]) reflectString(HTMLSelectElement, p);
for (const p of ["disabled", "required", "multiple", "autofocus"]) reflectBool(HTMLSelectElement, p);
reflectNumber(HTMLSelectElement, "size", "size", 0);

export class HTMLOptGroupElement extends HTMLElement {
  declare disabled: boolean; declare label: string;
}
reflectBool(HTMLOptGroupElement, "disabled");
reflectString(HTMLOptGroupElement, "label");

// ---------------------------------------------------------------- textarea

export class HTMLTextAreaElement extends HTMLElement {
  declare name: string; declare placeholder: string; declare wrap: string; declare disabled: boolean; declare required: boolean; declare readOnly: boolean; declare autofocus: boolean; declare rows: number; declare cols: number;
  private _value: string | null = null;
  selectionStart = 0;
  selectionEnd = 0;
  get type(): string { return "textarea"; }
  get defaultValue(): string { return this.textContent ?? ""; }
  set defaultValue(v: string) { this.textContent = v; }
  get value(): string { return this._value ?? this.defaultValue; }
  set value(v: string) { this._value = String(v); this.selectionStart = this.selectionEnd = this._value.length; }
  get textLength(): number { return this.value.length; }
  get form(): HTMLFormElement | null { return formOf(this); }
  get labels(): Element[] { return labelsOf(this); }
  select(): void { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end; }
  checkValidity(): boolean { return !(this.hasAttribute("required") && this.value === ""); }
  override _cloneInto(copy: Element): void { (copy as HTMLTextAreaElement)._value = this._value; }
  /** @internal */ _reset(): void { this._value = null; }
}
for (const p of ["name", "placeholder", "wrap"]) reflectString(HTMLTextAreaElement, p);
for (const p of ["disabled", "required", "readOnly", "autofocus"]) reflectBool(HTMLTextAreaElement, p);
reflectNumber(HTMLTextAreaElement, "rows", "rows", 2);
reflectNumber(HTMLTextAreaElement, "cols", "cols", 20);

// ---------------------------------------------------------------- label, form, fieldset

const LABELABLE = new Set(["button", "input", "meter", "output", "progress", "select", "textarea"]);

function labelsOf(control: Element): Element[] {
  const root = control.getRootNode() as Element;
  if (typeof root.querySelectorAll !== "function") return [];
  return root.querySelectorAll("label").filter((l) => (l as HTMLLabelElement).control === control);
}

export class HTMLLabelElement extends HTMLElement {
  get htmlFor(): string { return this.getAttribute("for") ?? ""; }
  set htmlFor(v: string) { this.setAttribute("for", v); }
  get control(): Element | null {
    const id = this.getAttribute("for");
    if (id !== null) {
      const e = this.ownerDocument?.getElementById(id) ?? null;
      return e !== null && LABELABLE.has(e.localName) ? e : null;
    }
    return this.descendants((e) => LABELABLE.has(e.localName) && !(e.localName === "input" && e.getAttribute("type") === "hidden"))[0] ?? null;
  }
  get form(): HTMLFormElement | null { const c = this.control; return c === null ? null : formOf(c); }
  override _activate(event: Event): void {
    const c = this.control;
    // a click on the control itself already did its work
    if (c === null || c.contains((event as MouseEvent).target as unknown as Element)) return;
    c.focus();
    c.click();
  }
}

export class HTMLFormElement extends HTMLElement {
  declare name: string; declare action: string; declare method: string; declare target: string; declare enctype: string; declare noValidate: boolean;
  get elements(): Element[] { return this.descendants((e) => ["button", "fieldset", "input", "object", "output", "select", "textarea"].includes(e.localName)); }
  get length(): number { return this.elements.length; }
  submit(): void {}
  requestSubmit(submitter?: Element | null): void {
    const e = new Event("submit", { bubbles: true, cancelable: true }) as Event & { submitter?: Element | null };
    e.submitter = submitter ?? null;
    this.dispatchEvent(e);
  }
  reset(): void {
    if (!this.dispatchEvent(new Event("reset", { bubbles: true, cancelable: true }))) return;
    for (const e of this.elements) {
      if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) e._reset();
      else if (e instanceof HTMLSelectElement) for (const o of e.options) o._selected = null;
    }
  }
  checkValidity(): boolean { return this.elements.every((e) => (e as unknown as { checkValidity?: () => boolean }).checkValidity?.() ?? true); }
  reportValidity(): boolean { return this.checkValidity(); }
}
for (const p of ["name", "action", "method", "target", "enctype"]) reflectString(HTMLFormElement, p);
reflectBool(HTMLFormElement, "noValidate");

export class HTMLFieldSetElement extends HTMLElement {
  declare disabled: boolean; declare name: string;
  get elements(): Element[] { return this.descendants((e) => ["button", "fieldset", "input", "object", "output", "select", "textarea"].includes(e.localName)); }
  get form(): HTMLFormElement | null { return formOf(this); }
}
reflectBool(HTMLFieldSetElement, "disabled");
reflectString(HTMLFieldSetElement, "name");

// ---------------------------------------------------------------- a, details, dialog, template

export class HTMLAnchorElement extends HTMLElement {
  declare target: string; declare download: string; declare rel: string; declare hreflang: string; declare type: string;
  get href(): string {
    const h = this.getAttribute("href");
    if (h === null) return "";
    try { return new URL(h, this.ownerDocument?.URL ?? undefined).href; } catch { return h; }
  }
  set href(v: string) { this.setAttribute("href", v); }
  override _activate(_event: Event): void {
    // in-page links move location.hash; others go nowhere (there is no navigation)
    const h = this.getAttribute("href");
    const loc = this.ownerDocument?.location as { hash?: string } | null;
    if (h !== null && h.startsWith("#") && loc !== null && loc !== undefined) {
      loc.hash = h;
      this.ownerDocument?._window?.dispatchEvent(new Event("hashchange"));
    }
  }
}
for (const p of ["target", "download", "rel", "hreflang", "type"]) reflectString(HTMLAnchorElement, p);

export class HTMLDetailsElement extends HTMLElement {
  declare open: boolean;
  override _attributeChanged(name: string, old: string | null, value: string | null): void {
    super._attributeChanged(name, old, value);
    if (name === "open" && (old === null) !== (value === null)) setTimeout(() => this.dispatchEvent(new Event("toggle")), 0);
  }
}
reflectBool(HTMLDetailsElement, "open");

/** <summary>: a click opens or closes its details. */
export class HTMLSummaryElement extends HTMLElement {
  override _activate(_event: Event): void {
    const d = this.parentElement;
    if (d !== null && d.localName === "details" && d.firstElementChild === this) d.toggleAttribute("open");
  }
}

export class HTMLDialogElement extends HTMLElement {
  declare open: boolean;
  returnValue = "";
  show(): void { this.setAttribute("open", ""); }
  showModal(): void { this.setAttribute("open", ""); }
  close(returnValue?: string): void {
    if (!this.hasAttribute("open")) return;
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  }
  requestClose(returnValue?: string): void { if (this.dispatchEvent(new Event("cancel", { cancelable: true }))) this.close(returnValue); }
}
reflectBool(HTMLDialogElement, "open");

export class HTMLTemplateElement extends HTMLElement {
  private _content: DocumentFragment | null = null;
  get content(): DocumentFragment { if (this._content === null) this._content = new DocumentFragment(this.ownerDocument ?? defaultDocument()); return this._content; }
  override _cloneInto(copy: Element): void {
    for (const c of this.content.childNodes) (copy as HTMLTemplateElement).content.appendChild(c.cloneNode(true));
  }
}

// ---------------------------------------------------------------- canvas

/** A canvas context: `factory(canvas, options)` makes one; it is kept per canvas and kind. */
type ContextFactory = (canvas: HTMLCanvasElement, options: unknown) => unknown;
const contexts = new Map<string, ContextFactory>();
/** Provide a canvas context kind ("2d", "webgl2", "bitmaprenderer", ...). */
export function setCanvasContext(kind: string, factory: ContextFactory): void { contexts.set(kind, factory); }

export class HTMLCanvasElement extends HTMLElement {
  /** The 2D context's RGBA pixels (canvas2d.ts writes them here; the renderer uploads them). */
  data: Uint8ClampedArray | null = null;
  private made: { kind: string; context: unknown } | null = null;
  get width(): number { const n = parseInt(this.getAttribute("width") ?? "", 10); return Number.isFinite(n) && n >= 0 ? n : 300; }
  set width(v: number) { this.setAttribute("width", String(Math.max(0, Math.trunc(v)))); }
  get height(): number { const n = parseInt(this.getAttribute("height") ?? "", 10); return Number.isFinite(n) && n >= 0 ? n : 150; }
  set height(v: number) { this.setAttribute("height", String(Math.max(0, Math.trunc(v)))); }
  getContext(kind: string, options?: unknown): unknown {
    if (this.made !== null) return this.made.kind === kind ? this.made.context : null;
    const factory = contexts.get(kind);
    if (factory === undefined) return null;
    const context = factory(this, options ?? {});
    if (context !== null && context !== undefined) this.made = { kind, context };
    return context ?? null;
  }
  toDataURL(_type?: string): string { return "data:,"; }
  toBlob(callback: (blob: unknown) => void): void { setTimeout(() => callback(null), 0); }
  transferControlToOffscreen(): this { return this; }
  captureStream(): unknown { return null; }
}

// ---------------------------------------------------------------- img

/**
 * Loading an image: the loader finds its file (or fails), sets naturalWidth/naturalHeight and
 * `file`, then calls done(ok). The image module provides it.
 */
type ImageLoader = (img: HTMLImageElement, url: string, done: (ok: boolean) => void) => void;
let imageLoader: ImageLoader | null = null;
export function setImageLoader(loader: ImageLoader): void { imageLoader = loader; }

export class HTMLImageElement extends HTMLElement {
  declare alt: string; declare srcset: string; declare sizes: string; declare loading: string; declare decoding: string; declare referrerPolicy: string; declare useMap: string; declare isMap: boolean;
  naturalWidth = 0;
  naturalHeight = 0;
  complete = true;
  /** The image's file on disk, once loaded (a renderer hands it to the GPU). */
  file: string | null = null;
  /** Decoded RGBA pixels, if a loader decoded them. */
  pixels: Uint8Array | null = null;
  private loadTicket = 0;
  get width(): number { const a = this.getAttribute("width"); return a !== null ? Number(a) : this.naturalWidth; }
  set width(v: number) { this.setAttribute("width", String(v)); }
  get height(): number { const a = this.getAttribute("height"); return a !== null ? Number(a) : this.naturalHeight; }
  set height(v: number) { this.setAttribute("height", String(v)); }
  get src(): string {
    const s = this.getAttribute("src");
    if (s === null || s === "") return "";
    if (s.startsWith("data:") || s.startsWith("blob:")) return s;
    try { return new URL(s, this.ownerDocument?.URL ?? undefined).href; } catch { return s; }
  }
  set src(v: string) { this.setAttribute("src", v); }
  get currentSrc(): string { return this.src; }
  get crossOrigin(): string | null { return this.getAttribute("crossorigin"); }
  set crossOrigin(v: string | null) { if (v === null) this.removeAttribute("crossorigin"); else this.setAttribute("crossorigin", v); }
  decode(): Promise<void> {
    if (this.complete) return this.naturalWidth > 0 || this.getAttribute("src") === null ? Promise.resolve() : Promise.reject(new Error("EncodingError: the image can't be decoded"));
    return new Promise((resolve, reject) => {
      this.addEventListener("load", () => resolve(), { once: true });
      this.addEventListener("error", () => reject(new Error("EncodingError: the image can't be decoded")), { once: true });
    });
  }
  override _attributeChanged(name: string, old: string | null, value: string | null): void {
    super._attributeChanged(name, old, value);
    if (name !== "src" || value === null) return;
    const url = this.src;
    const ticket = ++this.loadTicket;
    this.complete = false;
    this.naturalWidth = this.naturalHeight = 0;
    this.file = null;
    this.pixels = null;
    // the load happens after the current script, as in the browser (listeners set after src still hear it)
    setTimeout(() => {
      if (ticket !== this.loadTicket) return;
      const done = (ok: boolean): void => {
        if (ticket !== this.loadTicket) return;
        this.complete = true;
        this.dispatchEvent(new Event(ok ? "load" : "error"));
      };
      if (imageLoader === null || url === "") done(false);
      else imageLoader(this, url, done);
    }, 0);
  }
}
for (const p of ["alt", "srcset", "sizes", "loading", "decoding", "referrerPolicy", "useMap"]) reflectString(HTMLImageElement, p);
reflectBool(HTMLImageElement, "isMap");

// ---------------------------------------------------------------- registration

defineElement("input", HTMLInputElement as never);
defineElement("button", HTMLButtonElement as never);
defineElement("select", HTMLSelectElement as never);
defineElement("option", HTMLOptionElement as never);
defineElement("optgroup", HTMLOptGroupElement as never);
defineElement("textarea", HTMLTextAreaElement as never);
defineElement("label", HTMLLabelElement as never);
defineElement("form", HTMLFormElement as never);
defineElement("fieldset", HTMLFieldSetElement as never);
defineElement("a", HTMLAnchorElement as never);
defineElement("details", HTMLDetailsElement as never);
defineElement("summary", HTMLSummaryElement as never);
defineElement("dialog", HTMLDialogElement as never);
defineElement("template", HTMLTemplateElement as never);
defineElement("canvas", HTMLCanvasElement as never);
defineElement("img", HTMLImageElement as never);

/** `new Image(w, h)` */
export function makeImageClass(doc: () => Document): unknown {
  return class Image extends HTMLImageElement {
    constructor(width?: number, height?: number) {
      super(doc(), "img");
      if (width !== undefined) this.width = width;
      if (height !== undefined) this.height = height;
    }
  };
}
/** `new Option(text, value, defaultSelected, selected)` */
export function makeOptionClass(doc: () => Document): unknown {
  return class Option extends HTMLOptionElement {
    constructor(text = "", value?: string, defaultSelected = false, selected = false) {
      super(doc(), "option");
      if (text !== "") this.text = text;
      if (value !== undefined) this.value = value;
      if (defaultSelected) this.defaultSelected = true;
      if (selected) this.selected = true;
    }
  };
}
