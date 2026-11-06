/**
 * DOM events as the spec has them: Event and its UI subclasses, and
 * EventTarget with capture and bubble phases, `once`, `passive`, `signal`,
 * handler properties (`onclick`), stopPropagation and
 * stopImmediatePropagation, and cancelation.
 *
 * Pure TypeScript, no Bloom: the input layer (input.ts) creates these from
 * Bloom's mouse, keyboard and touch state.
 */

export interface EventInit { bubbles?: boolean; cancelable?: boolean; composed?: boolean }

export class Event {
  static readonly NONE = 0;
  static readonly CAPTURING_PHASE = 1;
  static readonly AT_TARGET = 2;
  static readonly BUBBLING_PHASE = 3;
  readonly NONE = 0;
  readonly CAPTURING_PHASE = 1;
  readonly AT_TARGET = 2;
  readonly BUBBLING_PHASE = 3;

  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly composed: boolean;
  readonly timeStamp: number;
  isTrusted = false;
  defaultPrevented = false;
  eventPhase = 0;
  target: EventTarget | null = null;
  currentTarget: EventTarget | null = null;
  /** @internal */ _stop = false;
  /** @internal */ _stopNow = false;
  /** @internal */ _inPassive = false;
  /** @internal */ _path: EventTarget[] = [];

  constructor(type: string, init: EventInit = {}) {
    if (arguments.length === 0) throw new TypeError("Event: type is required");
    this.type = String(type);
    this.bubbles = init.bubbles === true;
    this.cancelable = init.cancelable === true;
    this.composed = init.composed === true;
    this.timeStamp = typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  get srcElement(): EventTarget | null { return this.target; }
  get returnValue(): boolean { return !this.defaultPrevented; }
  set returnValue(v: boolean) { if (!v) this.preventDefault(); }
  get cancelBubble(): boolean { return this._stop; }
  set cancelBubble(v: boolean) { if (v) this._stop = true; }

  preventDefault(): void { if (this.cancelable && !this._inPassive) this.defaultPrevented = true; }
  stopPropagation(): void { this._stop = true; }
  stopImmediatePropagation(): void { this._stop = true; this._stopNow = true; }
  composedPath(): EventTarget[] { return this.eventPhase === 0 ? [] : this._path.slice(); }
  /** Legacy document.createEvent() initialization. */
  initEvent(type: string, bubbles = false, cancelable = false): void {
    (this as { type: string }).type = type;
    (this as { bubbles: boolean }).bubbles = bubbles;
    (this as { cancelable: boolean }).cancelable = cancelable;
  }
}

export class CustomEvent<T = unknown> extends Event {
  readonly detail: T | null;
  constructor(type: string, init: EventInit & { detail?: T } = {}) { super(type, init); this.detail = init.detail ?? null; }
}

export interface UIEventInit extends EventInit { view?: unknown; detail?: number }
export class UIEvent extends Event {
  readonly view: unknown;
  readonly detail: number;
  constructor(type: string, init: UIEventInit = {}) { super(type, init); this.view = init.view ?? null; this.detail = init.detail ?? 0; }
  get which(): number { return 0; }
}

export interface ModifierInit { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean }

export interface MouseEventInit extends UIEventInit, ModifierInit {
  screenX?: number; screenY?: number; clientX?: number; clientY?: number; movementX?: number; movementY?: number;
  button?: number; buttons?: number; relatedTarget?: EventTarget | null;
  /** Where the target's box starts, for offsetX/offsetY (set by whoever creates the event). */
  offsetOriginX?: number; offsetOriginY?: number;
}
export class MouseEvent extends UIEvent {
  readonly screenX: number; readonly screenY: number;
  readonly clientX: number; readonly clientY: number;
  readonly movementX: number; readonly movementY: number;
  readonly button: number; readonly buttons: number;
  readonly ctrlKey: boolean; readonly shiftKey: boolean; readonly altKey: boolean; readonly metaKey: boolean;
  readonly relatedTarget: EventTarget | null;
  private readonly ox: number; private readonly oy: number;
  constructor(type: string, init: MouseEventInit = {}) {
    super(type, init);
    this.clientX = init.clientX ?? 0; this.clientY = init.clientY ?? 0;
    this.screenX = init.screenX ?? this.clientX; this.screenY = init.screenY ?? this.clientY;
    this.movementX = init.movementX ?? 0; this.movementY = init.movementY ?? 0;
    this.button = init.button ?? 0; this.buttons = init.buttons ?? 0;
    this.ctrlKey = init.ctrlKey === true; this.shiftKey = init.shiftKey === true; this.altKey = init.altKey === true; this.metaKey = init.metaKey === true;
    this.relatedTarget = init.relatedTarget ?? null;
    this.ox = init.offsetOriginX ?? 0; this.oy = init.offsetOriginY ?? 0;
  }
  get pageX(): number { return this.clientX; }
  get pageY(): number { return this.clientY; }
  get x(): number { return this.clientX; }
  get y(): number { return this.clientY; }
  get offsetX(): number { return this.clientX - this.ox; }
  get offsetY(): number { return this.clientY - this.oy; }
  override get which(): number { return this.button + 1; }
  getModifierState(key: string): boolean {
    return key === "Control" ? this.ctrlKey : key === "Shift" ? this.shiftKey : key === "Alt" ? this.altKey : key === "Meta" ? this.metaKey : false;
  }
}

export interface PointerEventInit extends MouseEventInit {
  pointerId?: number; width?: number; height?: number; pressure?: number; tangentialPressure?: number;
  tiltX?: number; tiltY?: number; twist?: number; pointerType?: string; isPrimary?: boolean;
}
export class PointerEvent extends MouseEvent {
  readonly pointerId: number; readonly width: number; readonly height: number;
  readonly pressure: number; readonly tangentialPressure: number;
  readonly tiltX: number; readonly tiltY: number; readonly twist: number;
  readonly pointerType: string; readonly isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0; this.width = init.width ?? 1; this.height = init.height ?? 1;
    this.pressure = init.pressure ?? 0; this.tangentialPressure = init.tangentialPressure ?? 0;
    this.tiltX = init.tiltX ?? 0; this.tiltY = init.tiltY ?? 0; this.twist = init.twist ?? 0;
    this.pointerType = init.pointerType ?? ""; this.isPrimary = init.isPrimary === true;
  }
  getCoalescedEvents(): PointerEvent[] { return [this]; }
  getPredictedEvents(): PointerEvent[] { return []; }
}

export interface WheelEventInit extends MouseEventInit { deltaX?: number; deltaY?: number; deltaZ?: number; deltaMode?: number }
export class WheelEvent extends MouseEvent {
  static readonly DOM_DELTA_PIXEL = 0;
  static readonly DOM_DELTA_LINE = 1;
  static readonly DOM_DELTA_PAGE = 2;
  readonly deltaX: number; readonly deltaY: number; readonly deltaZ: number; readonly deltaMode: number;
  constructor(type: string, init: WheelEventInit = {}) {
    super(type, init);
    this.deltaX = init.deltaX ?? 0; this.deltaY = init.deltaY ?? 0; this.deltaZ = init.deltaZ ?? 0; this.deltaMode = init.deltaMode ?? 0;
  }
  /** Legacy mousewheel value (120 per notch, up positive). */
  get wheelDelta(): number { return -this.deltaY * 1.2; }
  get wheelDeltaY(): number { return -this.deltaY * 1.2; }
}

/** Legacy KeyboardEvent.keyCode for a code. */
function legacyKeyCode(key: string, code: string): number {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return 111 + Number(code.slice(1));
  const table: Record<string, number> = {
    Backspace: 8, Tab: 9, Enter: 13, ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18,
    Pause: 19, CapsLock: 20, Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46, MetaLeft: 91, MetaRight: 93,
    Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192,
    BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222,
  };
  return table[code] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
}

export interface KeyboardEventInit extends UIEventInit, ModifierInit {
  key?: string; code?: string; location?: number; repeat?: boolean; isComposing?: boolean; keyCode?: number; charCode?: number;
}
export class KeyboardEvent extends UIEvent {
  static readonly DOM_KEY_LOCATION_STANDARD = 0;
  static readonly DOM_KEY_LOCATION_LEFT = 1;
  static readonly DOM_KEY_LOCATION_RIGHT = 2;
  static readonly DOM_KEY_LOCATION_NUMPAD = 3;
  readonly key: string; readonly code: string; readonly location: number;
  readonly repeat: boolean; readonly isComposing: boolean;
  readonly ctrlKey: boolean; readonly shiftKey: boolean; readonly altKey: boolean; readonly metaKey: boolean;
  readonly keyCode: number; readonly charCode: number;
  constructor(type: string, init: KeyboardEventInit = {}) {
    super(type, init);
    this.key = init.key ?? ""; this.code = init.code ?? ""; this.repeat = init.repeat === true; this.isComposing = init.isComposing === true;
    this.location = init.location ?? (this.code.endsWith("Left") ? 1 : this.code.endsWith("Right") && !this.code.startsWith("Arrow") && !this.code.startsWith("Bracket") ? 2 : this.code.startsWith("Numpad") ? 3 : 0);
    this.ctrlKey = init.ctrlKey === true; this.shiftKey = init.shiftKey === true; this.altKey = init.altKey === true; this.metaKey = init.metaKey === true;
    this.keyCode = init.keyCode ?? legacyKeyCode(this.key, this.code);
    this.charCode = init.charCode ?? (type === "keypress" && this.key.length === 1 ? this.key.charCodeAt(0) : 0);
  }
  override get which(): number { return this.keyCode; }
  getModifierState(key: string): boolean {
    return key === "Control" ? this.ctrlKey : key === "Shift" ? this.shiftKey : key === "Alt" ? this.altKey : key === "Meta" ? this.metaKey : false;
  }
}

export class FocusEvent extends UIEvent {
  readonly relatedTarget: EventTarget | null;
  constructor(type: string, init: UIEventInit & { relatedTarget?: EventTarget | null } = {}) { super(type, init); this.relatedTarget = init.relatedTarget ?? null; }
}

export class InputEvent extends UIEvent {
  readonly data: string | null; readonly inputType: string; readonly isComposing: boolean;
  constructor(type: string, init: UIEventInit & { data?: string | null; inputType?: string; isComposing?: boolean } = {}) {
    super(type, init); this.data = init.data ?? null; this.inputType = init.inputType ?? ""; this.isComposing = init.isComposing === true;
  }
}

export interface TouchInit { identifier: number; target: EventTarget; clientX: number; clientY: number; force?: number; radiusX?: number; radiusY?: number }
export class Touch {
  readonly identifier: number; readonly target: EventTarget; readonly clientX: number; readonly clientY: number;
  readonly force: number; readonly radiusX: number; readonly radiusY: number;
  constructor(init: TouchInit) {
    this.identifier = init.identifier; this.target = init.target; this.clientX = init.clientX; this.clientY = init.clientY;
    this.force = init.force ?? 0.5; this.radiusX = init.radiusX ?? 1; this.radiusY = init.radiusY ?? 1;
  }
  get pageX(): number { return this.clientX; }
  get pageY(): number { return this.clientY; }
  get screenX(): number { return this.clientX; }
  get screenY(): number { return this.clientY; }
}
export class TouchEvent extends UIEvent {
  readonly touches: Touch[]; readonly targetTouches: Touch[]; readonly changedTouches: Touch[];
  readonly ctrlKey: boolean; readonly shiftKey: boolean; readonly altKey: boolean; readonly metaKey: boolean;
  constructor(type: string, init: UIEventInit & ModifierInit & { touches?: Touch[]; targetTouches?: Touch[]; changedTouches?: Touch[] } = {}) {
    super(type, init);
    this.touches = init.touches ?? []; this.targetTouches = init.targetTouches ?? []; this.changedTouches = init.changedTouches ?? [];
    this.ctrlKey = init.ctrlKey === true; this.shiftKey = init.shiftKey === true; this.altKey = init.altKey === true; this.metaKey = init.metaKey === true;
  }
}

export class MessageEvent<T = unknown> extends Event {
  readonly data: T; readonly origin: string; readonly lastEventId: string; readonly source: unknown; readonly ports: unknown[];
  constructor(type: string, init: EventInit & { data?: T; origin?: string; lastEventId?: string; source?: unknown; ports?: unknown[] } = {}) {
    super(type, init);
    this.data = init.data as T; this.origin = init.origin ?? ""; this.lastEventId = init.lastEventId ?? ""; this.source = init.source ?? null; this.ports = init.ports ?? [];
  }
}

export class ErrorEvent extends Event {
  readonly message: string; readonly filename: string; readonly lineno: number; readonly colno: number; readonly error: unknown;
  constructor(type: string, init: EventInit & { message?: string; filename?: string; lineno?: number; colno?: number; error?: unknown } = {}) {
    super(type, init);
    this.message = init.message ?? ""; this.filename = init.filename ?? ""; this.lineno = init.lineno ?? 0; this.colno = init.colno ?? 0; this.error = init.error;
  }
}

export class ProgressEvent extends Event {
  readonly lengthComputable: boolean; readonly loaded: number; readonly total: number;
  constructor(type: string, init: EventInit & { lengthComputable?: boolean; loaded?: number; total?: number } = {}) {
    super(type, init); this.lengthComputable = init.lengthComputable === true; this.loaded = init.loaded ?? 0; this.total = init.total ?? 0;
  }
}

// ---------------------------------------------------------------- AbortController

export class AbortSignal extends EventTargetBase() {
  aborted = false;
  reason: unknown = undefined;
  onabort: ((e: Event) => void) | null = null;
  throwIfAborted(): void { if (this.aborted) throw this.reason; }
  static abort(reason?: unknown): AbortSignal { const s = new AbortSignal(); s.aborted = true; s.reason = reason ?? new Error("AbortError"); return s; }
  static timeout(ms: number): AbortSignal { const c = new AbortController(); setTimeout(() => c.abort(new Error("TimeoutError")), ms); return c.signal; }
}
export class AbortController {
  readonly signal = new AbortSignal();
  abort(reason?: unknown): void {
    const s = this.signal;
    if (s.aborted) return;
    s.aborted = true;
    s.reason = reason ?? new Error("AbortError");
    s.dispatchEvent(new Event("abort"));
  }
}

// ---------------------------------------------------------------- EventTarget

export type EventListener = ((event: Event) => unknown) | { handleEvent(event: Event): unknown };
export interface AddEventListenerOptions { capture?: boolean; once?: boolean; passive?: boolean; signal?: AbortSignal }

interface Registration { callback: EventListener; capture: boolean; once: boolean; passive: boolean; removed: boolean }

function captureOf(options: boolean | { capture?: boolean } | undefined): boolean {
  return typeof options === "boolean" ? options : options?.capture === true;
}

/**
 * The parent in an event's path is asked for with `_eventParent(event)`: nodes return their
 * parent node, a document its window. Handler properties (`on<type>`) run as listeners in
 * the order they were first set, as in the browser.
 */
function EventTargetBase() {
  return class EventTargetImpl {
    /** @internal */ _listeners: Map<string, Registration[]> | null = null;

    addEventListener(type: string, callback: EventListener | null | undefined, options?: boolean | AddEventListenerOptions): void {
      if (callback === null || callback === undefined) return;
      const capture = captureOf(options);
      const o = typeof options === "object" && options !== null ? options : {};
      if (o.signal?.aborted === true) return;
      if (this._listeners === null) this._listeners = new Map();
      const list = this._listeners.get(type) ?? [];
      for (const r of list) if (r.callback === callback && r.capture === capture) return;
      const reg: Registration = { callback, capture, once: o.once === true, passive: o.passive === true, removed: false };
      list.push(reg);
      this._listeners.set(type, list);
      o.signal?.addEventListener("abort", () => this.removeEventListener(type, callback, { capture }));
    }

    removeEventListener(type: string, callback: EventListener | null | undefined, options?: boolean | { capture?: boolean }): void {
      const list = this._listeners?.get(type);
      if (list === undefined || callback === null || callback === undefined) return;
      const capture = captureOf(options);
      const i = list.findIndex((r) => r.callback === callback && r.capture === capture);
      if (i < 0) return;
      const r = list[i];
      if (r !== undefined) r.removed = true;
      list.splice(i, 1);
    }

    dispatchEvent(event: Event): boolean {
      return dispatch(this as unknown as EventTarget, event);
    }

    /** @internal The next target up in an event's path. */
    _eventParent(_event: Event): EventTarget | null { return null; }
    /** @internal What listeners see as `this` and currentTarget (window events: globalThis). */
    _self(): unknown { return this; }
  };
}

export class EventTarget extends EventTargetBase() {}

/** Call one target's listeners: the capture ones, or the others (with the handler property). */
function invoke(target: EventTarget, event: Event, phase: number, capture: boolean): void {
  if (event._stopNow) return;
  event.currentTarget = target._self() as EventTarget;
  event.eventPhase = phase;
  if (!capture) {
    const handler = (target._self() as Record<string, unknown>)["on" + event.type];
    if (typeof handler === "function") {
      try {
        const result = (handler as (e: Event) => unknown).call(target._self(), event);
        if (result === false) event.preventDefault();
      } catch (err) { reportError(err); }
      if (event._stopNow) return;
    }
  }
  const list = target._listeners?.get(event.type);
  if (list === undefined || list.length === 0) return;
  for (const r of list.slice()) {
    if (r.removed || r.capture !== capture) continue;
    if (r.once) target.removeEventListener(event.type, r.callback, { capture: r.capture });
    event._inPassive = r.passive;
    try {
      const cb = r.callback;
      if (typeof cb === "function") cb.call(target._self(), event);
      else cb.handleEvent(event);
    } catch (err) {
      // a listener's error doesn't stop the others, as in the browser
      reportError(err);
    }
    event._inPassive = false;
    if (event._stopNow) return;
  }
}

function reportError(err: unknown): void {
  const g = globalThis as Record<string, unknown>;
  const onerror = g["onerror"];
  if (typeof onerror === "function") (onerror as (m: string, s: string, l: number, c: number, e: unknown) => void)(String(err), "", 0, 0, err);
  else console.error(err instanceof Error ? err.stack ?? err.message : err);
}

/** Dispatch an event through its path: capture down to the target, the target, bubble back up. */
export function dispatch(target: EventTarget, event: Event): boolean {
  if (event.eventPhase !== 0) throw new Error("InvalidStateError: the event is already being dispatched");
  event.target = target._self() as EventTarget;
  event._stop = false;
  event._stopNow = false;
  const path: EventTarget[] = [target];
  for (let p = target._eventParent(event); p !== null; p = p._eventParent(event)) path.push(p);
  event._path = path.map((t) => t._self() as EventTarget);
  for (let i = path.length - 1; i > 0 && !event._stop; i--) { const t = path[i]; if (t !== undefined) invoke(t, event, Event.CAPTURING_PHASE, true); }
  if (!event._stop) {
    invoke(target, event, Event.AT_TARGET, true);
    if (!event._stopNow) invoke(target, event, Event.AT_TARGET, false);
  }
  if (event.bubbles) for (let i = 1; i < path.length && !event._stop; i++) { const t = path[i]; if (t !== undefined) invoke(t, event, Event.BUBBLING_PHASE, false); }
  event.eventPhase = 0;
  event.currentTarget = null;
  return !event.defaultPrevented;
}
