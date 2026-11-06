/**
 * @bloomengine/web: a web game's browser, natively on Bloom.
 *
 * Importing it installs `window`, `document` (parsed from the game's own
 * index.html), the DOM, events from Bloom's input, fetch for the game's
 * files, localStorage that persists, <img>, a 2D canvas, Web Audio and
 * <audio>, then opens the Bloom window. Configure it first (config.ts):
 *
 *   import { configure } from "@bloomengine/web/config";
 *   configure({ app: "mygame", title: "My Game", root: new URL("../", import.meta.url).pathname });
 *   import "@bloomengine/web";
 *   import "../src/main.ts";            // the game, unchanged
 *
 * The page itself (HTML and CSS over the canvas) is drawn by whoever draws
 * it: a game's page painter sets each element's layout box
 * (`setLayoutBox`), which hit testing and geometry use.
 */
import "./window.ts";
import "./blob.ts";
import "./fetch.ts";
import { document, pageLoaded } from "./browser.ts";
import { setCanvasContext, type HTMLCanvasElement } from "./dom/index.ts";
import { Canvas2D } from "./canvas2d.ts";
import "./image.ts";
import "./storage.ts";
import "./input.ts";
import "./audio/index.ts";
import "./script.ts";

setCanvasContext("2d", (canvas: HTMLCanvasElement) => new Canvas2D(canvas));

// after the game's modules ran: DOMContentLoaded, then load
setTimeout(pageLoaded, 0);

export { configure, config, webRoot, pageUrl, type WebConfig, type TvHooks } from "./config.ts";
export { document, location, windowTarget, viewCanvas, setViewCanvas } from "./browser.ts";
export { targetAt, pressKey, moveFocus, clickAt, nearestFocusable } from "./input.ts";
export { MOBILE, TV, cssSize, pixelRatio, safeArea, screenSize, onBeforeFrame, onAfterFrame, onQuit, quit, frameCount, setFrameCallback, timing } from "./frame.ts";
export { flushStorage, storagePath } from "./storage.ts";
export { extraTimings } from "./script.ts";
export { fetchFile, localPath, sourceFile } from "./fetch.ts";
export { imageSize, fileFor } from "./image.ts";
export { createObjectURL, revokeObjectURL, blobFile } from "./blob.ts";
export { Canvas2D } from "./canvas2d.ts";
export * as dom from "./dom/index.ts";
export { setLayoutBox, layoutBox, type Element, type Rect } from "./dom/index.ts";
