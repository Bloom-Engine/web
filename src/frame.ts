/**
 * The Bloom window and its frame loop. Native Bloom's runGame() blocks; a
 * web app is promise-based (loading, workers, timers), so frames are
 * scheduled on Perry's event loop instead: one frame per macrotask.
 *
 * Each frame runs, inside Bloom's drawing pass: the input handlers
 * (onBeforeFrame), the renderer's animation loop (setAnimationLoop), the
 * requestAnimationFrame callbacks, then the page (onAfterFrame).
 */
import { initWindow, windowShouldClose, closeWindow, beginDrawing, endDrawing, clearBackground, setTargetFPS, getScreenWidth, getScreenHeight } from "@bloomengine/engine";
import { QualityPreset, setQualityPreset, setTaaEnabled, setRenderScale, setAutoResolution, isMobile, isTV, getPlatform, Platform, getDisplayScale, getSafeAreaInset, SafeAreaEdge, setProfilerEnabled } from "@bloomengine/engine/core";

/** iPhone, iPad (and Android): touch input, no window to close, the app bundle for files. */
export const MOBILE = isMobile();
/** Apple TV: the Siri Remote (no pointer), seen from across the room. */
export const TV = isTV();
/** Android: a phone or tablet like MOBILE, with a Back button and its files in the app's files folder. */
export const ANDROID = getPlatform() === Platform.ANDROID;

let callback: ((time: number) => void) | null = null;
let rafQueue: { id: number; fn: (time: number) => void }[] = [];
let rafNext = 1;
const before: (() => void)[] = [];
const quitting: (() => void)[] = [];
const after: (() => void)[] = [];
const started = Date.now();
let frames = 0;

export function setFrameCallback(cb: ((time: number) => void) | null): void { callback = cb; }

/** window.requestAnimationFrame: the callback runs in the next frame, inside its drawing pass. */
export function requestAnimationFrame(fn: (time: number) => void): number {
  const id = rafNext++;
  rafQueue.push({ id, fn });
  return id;
}
export function cancelAnimationFrame(id: number): void { rafQueue = rafQueue.filter((r) => r.id !== id); }
/** Run before each frame (input) and after the app's frame (HUD), inside the drawing pass. */
export function onBeforeFrame(fn: () => void): void { before.push(fn); }
export function onAfterFrame(fn: () => void): void { after.push(fn); }
export function frameCount(): number { return frames; }
/** Run when the app quits (window closed or quit()). */
export function onQuit(fn: () => void): void { quitting.push(fn); }
export function quit(): never {
  for (const fn of quitting) fn();
  closeWindow();
  process.exit(0);
}
export function screenSize(): { width: number; height: number } { return { width: getScreenWidth(), height: getScreenHeight() }; }

/**
 * Device pixels per CSS pixel, like window.devicePixelRatio. 1 on a desktop window (Bloom reports
 * its size in points there); on iOS Bloom reports pixels, and the view's display scale (2 or 3).
 * On a tablet (short side 700 points or more) the page is drawn 1.4x larger: its sizes are made
 * for a phone in the hand and read small on an 11-13" screen at arm's length.
 */
export function pixelRatio(): number {
  if (TV) return getDisplayScale() * 1.6;   // read from the couch
  if (!MOBILE) return 1;
  const scale = getDisplayScale();
  const short = Math.min(getScreenWidth(), getScreenHeight()) / scale;
  return short >= 700 ? scale * 1.4 : scale;
}
/** The window in CSS pixels (what the page is laid out in, and pointer events report). */
export function cssSize(): { width: number; height: number } {
  const r = pixelRatio();
  return { width: getScreenWidth() / r, height: getScreenHeight() / r };
}

/**
 * The window's safe area, like CSS env(safe-area-inset-*), in CSS pixels: what the Dynamic
 * Island, a notch, the rounded corners, the home indicator or an iPhone Duo's status-bar column
 * cover. Each edge on its own (they are not symmetric on a foldable), read every frame: they
 * change with rotation and when the device opens or closes.
 */
export function safeArea(): { top: number; right: number; bottom: number; left: number } {
  if (!MOBILE && !TV) return { top: 0, right: 0, bottom: 0, left: 0 };
  const r = pixelRatio();
  return {
    top: getSafeAreaInset(SafeAreaEdge.TOP) / r, right: getSafeAreaInset(SafeAreaEdge.RIGHT) / r,
    bottom: getSafeAreaInset(SafeAreaEdge.BOTTOM) / r, left: getSafeAreaInset(SafeAreaEdge.LEFT) / r,
  };
}

export function openWindow(width: number, height: number, title: string): void {
  // iOS locks the app to landscape when the requested window is wider than tall; the board
  // works both ways, so ask for a portrait size there and keep every orientation.
  if (MOBILE) initWindow(Math.min(width, height), Math.max(width, height), title);
  else initWindow(width, height, title);
  setTargetFPS(60);
  // Medium (shadows, SSAO, bloom) by default: about 6 ms a frame here, while High/Ultra (SSR, SSGI)
  // and Bloom's no-preset default cost ~90 ms with 32 skinned pieces on a Retina display.
  // BLOOM_QUALITY=off|low|medium|high|ultra picks another preset.
  const presets: Record<string, number> = {
    off: QualityPreset.Off, low: QualityPreset.Low, medium: QualityPreset.Medium, high: QualityPreset.High, ultra: QualityPreset.Ultra,
  };
  setQualityPreset(presets[(process.env["BLOOM_QUALITY"] ?? "medium").toLowerCase()] ?? QualityPreset.Medium);
  // overrides of the preset: BLOOM_TAA=0|1, BLOOM_SCALE=0.15..1 (render scale)
  const taa = process.env["BLOOM_TAA"], scale = process.env["BLOOM_SCALE"];
  if (taa !== undefined) setTaaEnabled(taa === "1");
  if (scale !== undefined) setRenderScale(Number(scale));
  // phones and tablets render at 2-3x pixel density: let Bloom pick the render scale that holds 60 Hz
  else if (MOBILE || TV) { setRenderScale(0.6); setAutoResolution(60); }
  // BLOOM_PROFILE=1: Bloom's per-pass CPU/GPU timings (the `profile` script command prints them)
  if (process.env["BLOOM_PROFILE"] === "1") setProfilerEnabled(true);
  setTimeout(tick, 0);
}

/** Milliseconds spent per part of the last frames (sum since the last read). */
export const timing = { input: 0, app: 0, hud: 0, present: 0, idle: 0, frames: 0, worst: 0 };
let lastEnd = Date.now();

function tick(): void {
  if (windowShouldClose()) quit();
  const t0 = Date.now();
  timing.idle += t0 - lastEnd;
  for (const fn of before) fn();
  const t1 = Date.now();
  beginDrawing();
  const now = Date.now() - started;
  const raf = rafQueue;
  rafQueue = [];
  if (callback === null && raf.length === 0) clearBackground({ r: 15, g: 16, b: 18, a: 255 });
  if (callback !== null) callback(now);
  const n = raf.length;
  for (let i = 0; i < n; i++) { const r = raf[i]; if (r !== undefined) r.fn(now); }
  const t2 = Date.now();
  for (const fn of after) fn();
  const t3 = Date.now();
  endDrawing();
  lastEnd = Date.now();
  timing.input += t1 - t0; timing.app += t2 - t1; timing.hud += t3 - t2; timing.present += lastEnd - t3; timing.frames += 1;
  if (lastEnd - t0 > timing.worst) timing.worst = lastEnd - t0;
  frames += 1;
  setTimeout(tick, 0);
}
