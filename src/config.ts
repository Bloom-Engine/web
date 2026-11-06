/**
 * Settings for the browser runtime. A game sets them in its Bloom entry
 * before it imports `@bloomengine/web`, which reads them while it installs
 * `document`, `window` and the rest:
 *
 *   import { configure } from "@bloomengine/web/config";
 *   configure({ app: "mygame", title: "My Game", root: new URL("../", import.meta.url).pathname });
 *   import "@bloomengine/web";
 *   import "../src/main.ts";
 *
 * This module has no side effects, so a game's own hooks can import it (and
 * `webRoot()`) without starting the runtime early.
 */
import { existsSync } from "node:fs";

export interface Rect { x: number; y: number; w: number; h: number }

/** An element as the hooks below see it (the runtime's Element, kept structural here). */
export interface HookElement {
  readonly tagName: string;
  id: string;
  hidden: boolean;
  rect: Rect | null;
  parent: HookElement | null;
  contains(other: HookElement | null): boolean;
  click(): void;
}

/**
 * Apple TV (Siri Remote, no pointer). By default the clickpad moves the focus to the nearest
 * button in the direction pressed and Select presses it. A game can narrow that to the overlay
 * that is open, and take over directions the buttons don't use (a board cursor, say).
 */
export interface TvHooks {
  /** The element whose buttons get the focus (a menu or a dialog), or null for none. */
  overlay?(): HookElement | null;
  /** Whether Menu leaves the app now (Apple wants it to on the root screen). Default: false. */
  menuExits?(): boolean;
  /**
   * Called when no overlay is open: a direction (dx, dy each -1, 0, 1), and whether Select was
   * pressed. Return true if the game handled it.
   */
  navigate?(dx: number, dy: number, select: boolean): boolean;
}

export interface WebConfig {
  /** The app's name: the folder its saved localStorage goes in. */
  app: string;
  /** Window title and size in points (desktop; phones and TVs fill the screen). */
  title: string;
  width: number;
  height: number;
  /**
   * Where index.html and the web app's files are in a development build: an absolute folder,
   * ending in "/". A bundled app reads them from `assets/<bundle>/` next to its executable (or
   * in Contents/Resources on macOS) instead.
   */
  root: string;
  /** The folder under assets/ a bundle carries the files in. Default: "web". */
  bundle: string;
  /**
   * The folder of `root` the web server serves as the site's root (Vite's `public/`), ending in
   * "/". `location.href` points into it, so relative URLs resolve as on the web. Default: "".
   */
  served: string;
  /** The page's canvas, when the page has more than one. Default: the first <canvas>. */
  canvas: string;
  /** The localStorage file's name in the app's folder. Default: "storage.json". */
  storageName: string;
  /** A path for the localStorage file that wins over the default (BLOOM_STORAGE wins over both). */
  storageFile: string;
  /** Desktop builds define `globalThis.nativeApp = { quit() }` so a page can show a Quit button. Default: true. */
  nativeApp: boolean;
  tv: TvHooks;
  /**
   * Who draws the page over the 3D view: "css" (the built-in engine: the page's HTML and CSS,
   * laid out and drawn with Bloom 2D) or "none" (the game draws it, setting layout boxes itself).
   */
  page: "css" | "none";
  /** Font files for font-family names (paths relative to root, or absolute). */
  fonts: Record<string, string>;
  /** Extra commands for BLOOM_SCRIPT (see README), by name. */
  scriptCommands: Record<string, (arg: string) => void>;
}

const settings: WebConfig = {
  app: "bloom-web",
  title: "Bloom",
  width: 1280,
  height: 800,
  root: "",
  bundle: "web",
  served: "",
  canvas: "",
  storageName: "storage.json",
  storageFile: "",
  nativeApp: true,
  tv: {},
  page: "css",
  fonts: {},
  scriptCommands: {},
};

export function configure(options: Partial<WebConfig>): void {
  const scripts = options.scriptCommands;
  Object.assign(settings, options);
  if (scripts !== undefined) settings.scriptCommands = { ...scripts };
  if (options.fonts !== undefined) settings.fonts = { ...options.fonts };
  root = null;
}

export function config(): WebConfig { return settings; }

let root: string | null = null;

/**
 * The folder index.html is in, ending in "/": `assets/<bundle>/` in an app bundle (next to
 * the executable on iOS and tvOS, Contents/Resources on macOS), else the configured root.
 */
export function webRoot(): string {
  if (root !== null) return root;
  const exe = process.execPath ?? process.argv[0] ?? "";
  const dir = exe.slice(0, exe.lastIndexOf("/") + 1);
  const bundle = settings.bundle;
  for (const bundled of [dir + "assets/" + bundle + "/", dir + "../Resources/assets/" + bundle + "/"]) {
    if (existsSync(bundled + "index.html")) { root = bundled; return root; }
  }
  let r = settings.root;
  if (r === "") r = (process.cwd?.() ?? ".") + "/";
  if (!r.endsWith("/")) r += "/";
  root = r;
  return root;
}

/** The URL the page is at: index.html in the served folder, as a file:// URL. */
export function pageUrl(): string {
  return "file://" + webRoot() + settings.served + "index.html";
}
