/**
 * Bloom's input as DOM events, with the browser's default actions.
 *
 * Pointer: pointerdown/move/up/cancel with the mouse events after them
 * (mousedown, mousemove, mouseup), click/dblclick/contextmenu/auxclick on
 * the nearest common ancestor of the press and release, pointerover/out/
 * enter/leave and mouseover/out as the pointer moves between elements,
 * :hover and :active, pointer capture, wheel. The target is the element
 * under the pointer: the topmost element with a layout box there, else the
 * view canvas, which lies under everything (the usual full-window 3D canvas
 * with a page over it).
 *
 * Touch screens: each finger is a pointer (pointerType "touch", its own
 * pointerId) and a Touch in touchstart/touchmove/touchend events.
 *
 * Keyboard: keydown (repeating while held) and keyup at the focused element,
 * with the browser's key, code, modifiers and legacy keyCode; typed text goes
 * into a focused text field (with input events). Defaults, unless a listener
 * prevents them: Tab and Shift+Tab move the focus, Enter presses a focused
 * button or link or submits a field's form, Space presses a focused button
 * or checkbox (on release), Escape closes an open <dialog>, a click focuses
 * what it hits.
 *
 * Apple TV: the Siri Remote's clickpad and swipes are arrow keys, Select is
 * Enter, Menu is Escape. Unless a keydown listener prevents it, an arrow
 * moves the focus to the nearest focusable element that way (the tvOS focus
 * engine's rule), within config's tv.overlay when it names one, and Select
 * clicks it; tv.navigate gets the arrows nobody used.
 */
import { getMouseX, getMouseY, isMouseButtonPressed, isMouseButtonDown, isMouseButtonReleased, getMouseWheel, MouseButton } from "@bloomengine/engine";
import { isKeyPressed, isKeyReleased, isKeyDown, Key, getGamepadAxis, setMenuButtonExits, getTouchX, getTouchY, isTouchActive, getMaxTouchPoints, getCharPressed } from "@bloomengine/engine/core";
import {
  Element, Event, KeyboardEvent, MouseEvent, PointerEvent, WheelEvent, TouchEvent, Touch, InputEvent, setLayoutBox,
  HTMLInputElement, HTMLTextAreaElement, HTMLDialogElement, checkObservers,
} from "./dom/index.ts";
import { config } from "./config.ts";
import { computedValue, document, fitView, mediaChanged, viewCanvas, windowTarget } from "./browser.ts";
import { ANDROID, MOBILE, TV, cssSize, onBeforeFrame, pixelRatio, quit, screenSize } from "./frame.ts";

// ---------------------------------------------------------------- hit testing

/** The element under a point: the topmost one with a layout box there, else the view canvas. */
export function targetAt(x: number, y: number): Element {
  const view = viewCanvas();
  for (const e of document.elementsFromPoint(x, y)) {
    if (e === view || e === document.body || e === document.documentElement) continue;
    // a page element over the canvas
    if (!view.contains(e)) return e;
  }
  return view;
}

// ---------------------------------------------------------------- keyboard

/** Bloom key -> KeyboardEvent.code and .key (letters lowercase; Shift makes them uppercase). */
const KEYS: [number, string, string][] = [
  [Key.ESCAPE, "Escape", "Escape"], [Key.ENTER, "Enter", "Enter"], [Key.SPACE, "Space", " "], [Key.TAB, "Tab", "Tab"],
  [Key.BACKSPACE, "Backspace", "Backspace"], [Key.DELETE, "Delete", "Delete"], [Key.INSERT, "Insert", "Insert"],
  [Key.HOME, "Home", "Home"], [Key.END, "End", "End"], [Key.PAGE_UP, "PageUp", "PageUp"], [Key.PAGE_DOWN, "PageDown", "PageDown"],
  [Key.UP, "ArrowUp", "ArrowUp"], [Key.DOWN, "ArrowDown", "ArrowDown"], [Key.LEFT, "ArrowLeft", "ArrowLeft"], [Key.RIGHT, "ArrowRight", "ArrowRight"],
  [Key.LEFT_SHIFT, "ShiftLeft", "Shift"], [Key.RIGHT_SHIFT, "ShiftRight", "Shift"], [Key.LEFT_CONTROL, "ControlLeft", "Control"],
  [Key.RIGHT_CONTROL, "ControlRight", "Control"], [Key.LEFT_ALT, "AltLeft", "Alt"], [Key.RIGHT_ALT, "AltRight", "Alt"],
  [Key.LEFT_SUPER, "MetaLeft", "Meta"], [Key.RIGHT_SUPER, "MetaRight", "Meta"],
  [Key.MINUS, "Minus", "-"], [Key.EQUAL, "Equal", "="], [Key.COMMA, "Comma", ","], [Key.PERIOD, "Period", "."], [Key.SLASH, "Slash", "/"],
  [Key.SEMICOLON, "Semicolon", ";"], [Key.APOSTROPHE, "Quote", "'"], [Key.LEFT_BRACKET, "BracketLeft", "["],
  [Key.RIGHT_BRACKET, "BracketRight", "]"], [Key.BACKSLASH, "Backslash", "\\"], [Key.GRAVE, "Backquote", "`"],
];
for (let c = 65; c <= 90; c++) KEYS.push([c, "Key" + String.fromCharCode(c), String.fromCharCode(c + 32)]);
for (let c = 48; c <= 57; c++) KEYS.push([c, "Digit" + String.fromCharCode(c), String.fromCharCode(c)]);
for (let f = 1; f <= 12; f++) KEYS.push([111 + f, "F" + String(f), "F" + String(f)]);
const SHIFTED: Record<string, string> = {
  "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
  "-": "_", "=": "+", ",": "<", ".": ">", "/": "?", ";": ":", "'": "\"", "[": "{", "]": "}", "\\": "|", "`": "~",
};
const CODE_OF = new Map<string, string>(KEYS.map(([, code, key]) => [key, code]));

function modifiers(): { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean } {
  return {
    shiftKey: isKeyDown(Key.LEFT_SHIFT) || isKeyDown(Key.RIGHT_SHIFT),
    ctrlKey: isKeyDown(Key.LEFT_CONTROL) || isKeyDown(Key.RIGHT_CONTROL),
    altKey: isKeyDown(Key.LEFT_ALT) || isKeyDown(Key.RIGHT_ALT),
    metaKey: isKeyDown(Key.LEFT_SUPER) || isKeyDown(Key.RIGHT_SUPER),
  };
}

function keyTarget(): Element { return document.activeElement ?? document.body ?? (document.documentElement as Element); }

const TEXT_TYPES = new Set(["text", "search", "tel", "url", "email", "password", "number"]);
function textField(e: Element | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (e instanceof HTMLTextAreaElement && !e.hasAttribute("readonly") && !e._disabled()) return e;
  if (e instanceof HTMLInputElement && TEXT_TYPES.has(e.type) && !e.hasAttribute("readonly") && !e._disabled()) return e;
  return null;
}

/** Insert typed text into a text field at its caret, with beforeinput and input events. */
function typeInto(field: HTMLInputElement | HTMLTextAreaElement, text: string, inputType: string): void {
  if (!field.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: text, inputType }))) return;
  const v = field.value;
  let start = field.selectionStart ?? v.length, end = field.selectionEnd ?? v.length;
  if (inputType === "deleteContentBackward" && start === end) start = Math.max(0, start - 1);
  if (inputType === "deleteContentForward" && start === end) end = Math.min(v.length, end + 1);
  field.value = v.slice(0, start) + text + v.slice(end);
  field.selectionStart = field.selectionEnd = start + text.length;
  field.dispatchEvent(new InputEvent("input", { bubbles: true, data: text === "" ? null : text, inputType }));
}

/** Keys held, for auto-repeat: Bloom code -> when it repeats next. */
const held = new Map<number, number>();
const REPEAT_DELAY = 500, REPEAT_RATE = 33;

/**
 * A key press as the browser delivers it: keydown at the focused element (bubbling to document
 * and window), then the default action unless a listener prevented it. `key` is a
 * KeyboardEvent.key ("Escape", "a", " ", "ArrowUp").
 */
export function pressKey(key: string, code = CODE_OF.get(key) ?? key, repeat = false): boolean {
  const mods = modifiers();
  const shown = mods.shiftKey && key.length === 1 ? SHIFTED[key] ?? key.toUpperCase() : key;
  const target = keyTarget();
  const ok = target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: shown, code, repeat, ...mods }));
  if (!ok) return false;
  if (key.length === 1 && !mods.ctrlKey && !mods.metaKey) target.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, cancelable: true, key: shown, code, repeat, ...mods }));
  const field = textField(document._focused);
  if (field !== null) {
    if (key === "Backspace") { typeInto(field, "", "deleteContentBackward"); return true; }
    if (key === "Delete") { typeInto(field, "", "deleteContentForward"); return true; }
    if (key === "Enter" && field instanceof HTMLTextAreaElement) { typeInto(field, "\n", "insertLineBreak"); return true; }
  }
  const f = document._focused;
  if (key === "Tab") { moveFocus(mods.shiftKey ? -1 : 1); return true; }
  if (key === "Enter" && f !== null) {
    if (f.localName === "button" || f.localName === "a" || f.localName === "summary" || (f instanceof HTMLInputElement && ["submit", "button", "reset", "image", "checkbox", "radio"].includes(f.type) && f.type !== "checkbox" && f.type !== "radio")) f.click();
    else if (f instanceof HTMLInputElement && f.form !== null) f.form.requestSubmit();
  }
  if (key === "Escape") {
    const open = document.querySelectorAll("dialog[open]").pop();
    if (open instanceof HTMLDialogElement) open.requestClose();
  }
  return true;
}

function releaseKey(key: string, code: string): void {
  const mods = modifiers();
  const shown = mods.shiftKey && key.length === 1 ? SHIFTED[key] ?? key.toUpperCase() : key;
  const ok = keyTarget().dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, composed: true, key: shown, code, ...mods }));
  // Space presses buttons and checkboxes on release, as in the browser
  const f = document._focused;
  if (ok && key === " " && f !== null && textField(f) === null && (f.localName === "button" || f.localName === "summary" || (f instanceof HTMLInputElement && ["checkbox", "radio", "submit", "button", "reset"].includes(f.type)))) f.click();
}

/** Tab: the next (or previous) element in the sequential focus order, wrapping around. */
export function moveFocus(direction: 1 | -1): void {
  const order = document.sequentialFocusOrder().filter((e) => e._box !== null || e === document._focused);
  if (order.length === 0) return;
  const i = document._focused === null ? -1 : order.indexOf(document._focused);
  const next = order[(i + direction + order.length + (i < 0 && direction < 0 ? 1 : 0)) % order.length];
  next?.focus({ focusVisible: true });
}

// ---------------------------------------------------------------- pointer

interface PointerState {
  id: number; x: number; y: number; down: number; target: Element; pressed: Element | null; over: Element | null;
  /** touch panning: where the finger went down, and whether the gesture became a scroll */
  sx?: number; sy?: number; panning?: boolean; vy?: number;
}

const mouse: PointerState = { id: 1, x: -1, y: -1, down: 0, target: document.body as Element, pressed: null, over: null };
let lastClick = { at: 0, x: 0, y: 0, target: null as Element | null, count: 0 };

const BUTTONS: [number, number][] = [[MouseButton.LEFT, 0], [MouseButton.MIDDLE, 1], [MouseButton.RIGHT, 2]];

function mouseInit(p: PointerState, button: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const box = p.target._box ?? { x: 0, y: 0 };
  return {
    bubbles: true, cancelable: true, composed: true, view: globalThis, clientX: p.x, clientY: p.y,
    button, buttons: p.down, offsetOriginX: box.x, offsetOriginY: box.y, ...modifiers(), ...extra,
  };
}

function pointerInit(p: PointerState, button: number, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...mouseInit(p, button, extra), pointerId: p.id, pointerType: type, isPrimary: p.id === 1 || p.id === firstTouch,
    width: 1, height: 1, pressure: p.down !== 0 ? 0.5 : 0,
  };
}

/** The pointer moved onto another element: out/leave on the old one, over/enter on the new one. */
function crossTo(p: PointerState, to: Element, type: string): void {
  const from = p.over;
  if (from === to) return;
  p.over = to;
  const base = (rel: Element | null): Record<string, unknown> => ({ ...pointerInit(p, -1, type), relatedTarget: rel });
  if (from !== null) {
    from.dispatchEvent(new PointerEvent("pointerout", base(to)));
    from.dispatchEvent(new MouseEvent("mouseout", { ...mouseInit(p, 0), relatedTarget: to }));
    for (let e: Element | null = from; e !== null && !e.contains(to); e = e.parentElement) {
      e.dispatchEvent(new PointerEvent("pointerleave", { ...base(to), bubbles: false, cancelable: false }));
      e.dispatchEvent(new MouseEvent("mouseleave", { ...mouseInit(p, 0), bubbles: false, cancelable: false, relatedTarget: to }));
    }
  }
  to.dispatchEvent(new PointerEvent("pointerover", base(from)));
  to.dispatchEvent(new MouseEvent("mouseover", { ...mouseInit(p, 0), relatedTarget: from }));
  const entered: Element[] = [];
  for (let e: Element | null = to; e !== null && (from === null || !e.contains(from)); e = e.parentElement) entered.unshift(e);
  for (const e of entered) {
    e.dispatchEvent(new PointerEvent("pointerenter", { ...base(from), bubbles: false, cancelable: false }));
    e.dispatchEvent(new MouseEvent("mouseenter", { ...mouseInit(p, 0), bubbles: false, cancelable: false, relatedTarget: from }));
  }
}

function commonAncestor(a: Element, b: Element): Element {
  for (let e: Element | null = a; e !== null; e = e.parentElement) if (e.contains(b)) return e;
  return document.documentElement as Element;
}

function press(p: PointerState, button: number, type: string): void {
  p.down |= 1 << (button === 1 ? 2 : button === 2 ? 1 : 0);
  p.target = document._capture ?? targetAt(p.x, p.y);
  if (p.id === 1 || p.id === firstTouch) document._active = p.target;
  const ok = p.target.dispatchEvent(new PointerEvent("pointerdown", pointerInit(p, button, type)));
  if (ok) p.target.dispatchEvent(new MouseEvent("mousedown", mouseInit(p, button, { detail: 1 })));
  if (button === 0) {
    p.pressed = p.target;
    // a click focuses the focusable element it lands on (or blurs the focus)
    let f: Element | null = p.target;
    while (f !== null && !f._focusable()) f = f.parentElement;
    if (f !== null) f.focus({ focusVisible: false });
    else if (document._focused !== null) document._focused.blur();
  }
}

function release(p: PointerState, button: number, type: string): void {
  p.down &= ~(1 << (button === 1 ? 2 : button === 2 ? 1 : 0));
  const target = document._capture ?? targetAt(p.x, p.y);
  p.target = target;
  target.dispatchEvent(new PointerEvent("pointerup", pointerInit(p, button, type)));
  target.dispatchEvent(new MouseEvent("mouseup", mouseInit(p, button)));
  if (document._capture !== null) { document._capture.dispatchEvent(new PointerEvent("lostpointercapture", pointerInit(p, button, type))); document._capture = null; }
  if (p.id === 1 || p.id === firstTouch) document._active = null;
  const pressed = p.pressed;
  if (button !== 0) {
    target.dispatchEvent(new (button === 2 ? MouseEvent : PointerEvent)(button === 2 ? "contextmenu" : "auxclick", pointerInit(p, button, type)));
    return;
  }
  p.pressed = null;
  if (pressed === null) return;
  const on = commonAncestor(pressed, target);
  const now = Date.now();
  const again = now - lastClick.at < 500 && Math.abs(p.x - lastClick.x) < 5 && Math.abs(p.y - lastClick.y) < 5 && lastClick.target === on;
  lastClick = { at: now, x: p.x, y: p.y, target: on, count: again ? lastClick.count + 1 : 1 };
  if (on._disabled()) return;
  const event = new PointerEvent("click", pointerInit(p, 0, type, { detail: lastClick.count }));
  const undo = on._preActivate();
  if (!on.dispatchEvent(event)) { undo(); return; }
  on._activate(event);
  if (lastClick.count === 2) on.dispatchEvent(new MouseEvent("dblclick", mouseInit(p, 0, { detail: 2 })));
}

function move(p: PointerState, x: number, y: number, type: string): void {
  const movementX = p.x < 0 ? 0 : x - p.x, movementY = p.y < 0 ? 0 : y - p.y;
  p.x = x; p.y = y;
  const target = document._capture ?? targetAt(x, y);
  p.target = target;
  crossTo(p, target, type);
  if (p.id === 1 || p.id === firstTouch) document._hover = MOBILE && p.down === 0 ? null : target;
  target.dispatchEvent(new PointerEvent("pointermove", pointerInit(p, -1, type, { movementX, movementY })));
  target.dispatchEvent(new MouseEvent("mousemove", mouseInit(p, 0, { movementX, movementY })));
}

// ---------------------------------------------------------------- touch

const touches = new Map<number, PointerState>();
let firstTouch = -1;

function touchList(): Touch[] {
  const out: Touch[] = [];
  for (const t of touches.values()) out.push(new Touch({ identifier: t.id, target: t.target, clientX: t.x, clientY: t.y }));
  return out;
}

function touchEvent(type: string, changed: PointerState[], target: Element): void {
  const all = touchList();
  const changedTouches = changed.map((t) => new Touch({ identifier: t.id, target: t.target, clientX: t.x, clientY: t.y }));
  target.dispatchEvent(new TouchEvent(type, {
    bubbles: true, cancelable: type !== "touchcancel", composed: true, view: globalThis,
    touches: type === "touchend" ? all.filter((t) => !changed.some((c) => c.id === t.identifier)) : all,
    targetTouches: all.filter((t) => t.target === target), changedTouches, ...modifiers(),
  }));
}

/** How far (CSS px) a finger moves before the browser decides it is scrolling, not tapping. */
const PAN_SLOP = 10;
const flings: { target: Element; v: number }[] = [];

/** Does an element or one of its ancestors forbid panning (touch-action: none)? */
function panForbidden(e: Element | null): boolean {
  for (; e !== null; e = e.parentElement) {
    const v = computedValue(e, "touch-action");
    if (v === "none" || v === "pinch-zoom" || v === "pan-x") return true;
  }
  return false;
}

/**
 * A vertical drag past the slop over something that scrolls becomes a pan, as in a mobile browser:
 * the page gets pointercancel and touchcancel, no click follows, and the box follows the finger.
 */
function startPan(p: PointerState, x: number, y: number): boolean {
  if (scrollDefault === null || p.sx === undefined || p.sy === undefined || touches.size > 1) return false;
  const dx = x - p.sx, dy = y - p.sy;
  if (Math.abs(dy) < PAN_SLOP || Math.abs(dy) < Math.abs(dx)) return false;
  if (panForbidden(p.pressed ?? p.target)) return false;
  if (!scrollDefault(p.pressed ?? p.target, p.y - y)) return false;
  p.panning = true;
  p.vy = p.y - y;
  p.x = x; p.y = y;
  p.target = p.pressed ?? p.target;
  const init = pointerInit(p, -1, "touch");
  p.target.dispatchEvent(new PointerEvent("pointercancel", { ...init, cancelable: false }));
  touchEvent("touchcancel", [p], p.target);
  p.pressed = null;
  p.down = 0;
  if (p.id === firstTouch) { document._active = null; document._hover = null; }
  return true;
}

/** Momentum after a pan: the box keeps scrolling and slows down. */
function flingFrame(): void {
  for (let i = flings.length - 1; i >= 0; i--) {
    const f = flings[i] as { target: Element; v: number };
    f.v *= 0.95;
    if (Math.abs(f.v) < 0.5 || scrollDefault === null || !scrollDefault(f.target, f.v)) flings.splice(i, 1);
  }
}

/** Each finger is a pointer with its own id (Bloom's touch slot + 2) and a Touch. */
/** A scripted finger (BLOOM_SCRIPT touch/untouch), in CSS pixels; it is touch slot 0. */
let scripted: { x: number; y: number } | null = null;
let scriptedUsed = false;
export function scriptTouch(at: { x: number; y: number } | null): void { scripted = at; scriptedUsed = true; }

function touchFrame(): void {
  const ratio = pixelRatio();
  const max = scriptedUsed ? Math.max(1, getMaxTouchPoints()) : getMaxTouchPoints();
  for (let i = 0; i < max; i++) {
    const id = i + 2;
    const fake = scriptedUsed && i === 0;
    const active = fake ? scripted !== null : isTouchActive(i);
    const known = touches.get(id);
    if (active) {
      const x = fake ? (scripted as { x: number; y: number }).x : getTouchX(i) / ratio;
      const y = fake ? (scripted as { x: number; y: number }).y : getTouchY(i) / ratio;
      if (known === undefined) {
        const p: PointerState = { id, x, y, down: 0, target: targetAt(x, y), pressed: null, over: null, sx: x, sy: y };
        touches.set(id, p);
        flings.length = 0;
        if (firstTouch < 0) firstTouch = id;
        crossTo(p, p.target, "touch");
        touchEvent("touchstart", [p], p.target);
        press(p, 0, "touch");
      } else if (known.panning === true) {
        const dy = known.y - y;
        known.vy = (known.vy ?? 0) * 0.5 + dy * 0.5;
        known.x = x; known.y = y;
        scrollDefault?.(known.target, dy);
      } else if (known.x !== x || known.y !== y) {
        if (startPan(known, x, y)) continue;
        move(known, x, y, "touch");
        touchEvent("touchmove", [known], known.pressed ?? known.target);
      }
    } else if (known !== undefined && known.panning === true) {
      // a scroll gesture ends without pointer or touch events (they were cancelled); it glides on
      if (Math.abs(known.vy ?? 0) > 1) flings.push({ target: known.target, v: known.vy ?? 0 });
      touches.delete(id);
      if (firstTouch === id) { firstTouch = -1; document._hover = null; }
    } else if (known !== undefined) {
      release(known, 0, "touch");
      touchEvent("touchend", [known], known.target);
      known.target.dispatchEvent(new PointerEvent("pointerout", pointerInit(known, -1, "touch")));
      known.target.dispatchEvent(new PointerEvent("pointerleave", { ...pointerInit(known, -1, "touch"), bubbles: false }));
      touches.delete(id);
      if (firstTouch === id) { firstTouch = -1; document._hover = null; }
    }
  }
}

// ---------------------------------------------------------------- Apple TV

let swipeX = 0, swipeY = 0;

function center(e: Element): [number, number] { const b = e._box; return b === null ? [0, 0] : [b.x + b.w / 2, b.y + b.h / 2]; }

/** The focusable element nearest (x, y) in direction (dx, dy): distance along it counts once, across it twice. */
export function nearestFocusable(candidates: Element[], from: Element | null, dx: number, dy: number): Element | null {
  const [x, y] = from === null ? [0, 0] : center(from);
  let best: Element | null = null, score = Infinity;
  for (const c of candidates) {
    if (c === from) continue;
    const [cx, cy] = center(c);
    const ox = cx - x, oy = cy - y;
    const along = ox * dx + oy * dy;
    if (along <= 1) continue;
    const s = along + 2 * Math.abs(ox * dy - oy * dx);
    if (s < score) { score = s; best = c; }
  }
  return best;
}

function remote(): void {
  const tv = config().tv;
  const exits = tv.menuExits?.() ?? false;
  setMenuButtonExits(exits);
  // swipes on the touch surface are arrow presses (re-armed once the axis comes back near 0)
  const ax = getGamepadAxis(0), ay = getGamepadAxis(1);
  if (Math.abs(ax) < 0.25) swipeX = 0;
  if (Math.abs(ay) < 0.25) swipeY = 0;
  const arrows: [number, number, string][] = [];
  if (isKeyPressed(Key.UP)) arrows.push([0, -1, "ArrowUp"]);
  if (isKeyPressed(Key.DOWN)) arrows.push([0, 1, "ArrowDown"]);
  if (isKeyPressed(Key.LEFT)) arrows.push([-1, 0, "ArrowLeft"]);
  if (isKeyPressed(Key.RIGHT)) arrows.push([1, 0, "ArrowRight"]);
  if (arrows.length === 0) {
    if (swipeX === 0 && Math.abs(ax) > 0.7 && Math.abs(ax) > Math.abs(ay)) { swipeX = ax > 0 ? 1 : -1; arrows.push([swipeX, 0, swipeX > 0 ? "ArrowRight" : "ArrowLeft"]); }
    else if (swipeY === 0 && Math.abs(ay) > 0.7) { swipeY = ay > 0 ? 1 : -1; arrows.push([0, swipeY, swipeY > 0 ? "ArrowDown" : "ArrowUp"]); }
  }
  const overlay = tv.overlay !== undefined ? (tv.overlay() as Element | null) : (document.body as Element);
  const candidates = overlay === null ? [] : overlay.descendants((e) => e._focusable() && e._box !== null);
  for (const [dx, dy, key] of arrows) {
    if (!pressKey(key)) continue;
    const f = document._focused;
    if (candidates.length > 0) {
      if (f === null || !candidates.includes(f)) { candidates[0]?.focus({ focusVisible: true }); continue; }
      const next = nearestFocusable(candidates, f, dx, dy);
      if (next !== null) { next.focus({ focusVisible: true }); continue; }
    }
    tv.navigate?.(dx, dy, false);
  }
  if (isKeyPressed(Key.ENTER) && pressKey("Enter")) {
    // Select presses what has the focus (Enter already pressed buttons and links), else it's the game's
    const f = document._focused;
    if (f !== null && candidates.includes(f)) { if (f.localName !== "button" && f.localName !== "a" && f.localName !== "summary") f.click(); }
    else tv.navigate?.(0, 0, true);
  }
  if (isKeyPressed(Key.ESCAPE) && !exits) pressKey("Escape");
}

// ---------------------------------------------------------------- the frame

let lastW = 0, lastH = 0;

onBeforeFrame(() => {
  const { width, height } = screenSize();
  // the view canvas fills the window, under the page
  fitView();
  if (width !== lastW || height !== lastH) {
    const first = lastW === 0;
    lastW = width; lastH = height;
    if (!first) { windowTarget.dispatchEvent(new Event("resize")); mediaChanged(); }
  }
  checkObservers(document._viewport, pixelRatio());
  if (TV) { remote(); return; }
  // Android's Back button is Escape, except where Menu would leave an Apple TV app (the native
  // layer then hands Back to the system)
  if (ANDROID) setMenuButtonExits(config().tv.menuExits?.() ?? false);
  // macOS: Bloom's window has no menu bar, so the standard Cmd-Q / Cmd-W close it here
  if (!MOBILE && (isKeyDown(Key.LEFT_SUPER) || isKeyDown(Key.RIGHT_SUPER)) && (isKeyPressed(Key.Q) || isKeyPressed(Key.W))) quit();

  const now = Date.now();
  for (const [k, code, key] of KEYS) {
    if (isKeyPressed(k)) { pressKey(key, code); held.set(k, now + REPEAT_DELAY); }
    else if (isKeyReleased(k)) { held.delete(k); releaseKey(key, code); }
    else {
      const next = held.get(k);
      if (next !== undefined && now >= next) {
        held.set(k, now + REPEAT_RATE);
        pressKey(key, code, true);
      }
    }
  }
  // typed text (with the keyboard layout and IME) goes into a focused text field
  const field = textField(document._focused);
  for (let c = getCharPressed(); c !== 0; c = getCharPressed()) {
    if (field !== null && c >= 32 && c !== 127) typeInto(field, String.fromCodePoint(c), "insertText");
  }

  if (MOBILE || scriptedUsed) { touchFrame(); flingFrame(); }
  else {
    const ratio = pixelRatio();
    const x = getMouseX() / ratio, y = getMouseY() / ratio;
    if (x !== mouse.x || y !== mouse.y) move(mouse, x, y, "mouse");
    for (const [b, button] of BUTTONS) if (isMouseButtonPressed(b)) press(mouse, button, "mouse");
    for (const [b, button] of BUTTONS) if (isMouseButtonReleased(b)) release(mouse, button, "mouse");
    if (mouse.down !== 0 && !BUTTONS.some(([b]) => isMouseButtonDown(b))) mouse.down = 0;
  }
  const wheel = getMouseWheel();
  if (wheel !== 0) {
    const p = MOBILE ? [...touches.values()][0] ?? mouse : mouse;
    const target = targetAt(p.x, p.y);
    if (target.dispatchEvent(new WheelEvent("wheel", { ...mouseInit(p, 0), deltaY: -wheel * 100, deltaMode: 0 }))) scrollDefault?.(target, -wheel * 100);
  }
});

/**
 * Scrolling the nearest scrollable box around an element by dy CSS pixels (the page painter does
 * it): the default action of a wheel event nobody prevented, and of a finger dragging. Returns
 * whether anything moved.
 */
let scrollDefault: ((target: Element, dy: number) => boolean) | null = null;
export function setScrollDefault(fn: (target: Element, dy: number) => boolean): void { scrollDefault = fn; }
/** @deprecated use setScrollDefault */
export function setWheelDefault(fn: (target: Element, dy: number) => void): void { scrollDefault = (t, dy) => { fn(t, dy); return true; }; }

/** A click at a point, through the same path as the mouse (scripted tests use it). */
export function clickAt(x: number, y: number): void {
  const p: PointerState = { id: 1, x, y, down: 0, target: targetAt(x, y), pressed: null, over: mouse.over };
  press(p, 0, "mouse");
  release(p, 0, "mouse");
  mouse.over = p.over;
}
