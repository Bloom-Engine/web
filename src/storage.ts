/**
 * localStorage that survives a restart. Perry's own localStorage is kept in
 * memory, and assigning globalThis.localStorage is ignored, so this keeps
 * Perry's store and persists it: it fills the store from a JSON file at
 * startup and writes the file back when the contents change (checked twice
 * a second, and on quit).
 *
 * The file is $BLOOM_STORAGE, else config's storageFile, else
 * `<storageName>` in the app's folder: ~/.config/<app>/ (or
 * $XDG_CONFIG_HOME/<app>/) on a desktop and Apple TV, Library/Application
 * Support/<app>/ in an iOS app's container, <app>/ in an Android app's files
 * folder ($BLOOM_ASSET_PATH).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config.ts";
import { ANDROID, MOBILE, frameCount, onAfterFrame, onQuit } from "./frame.ts";

/** `~/...` -> $HOME/... (on iOS HOME is the app's container). */
export function expandHome(path: string): string {
  return path.startsWith("~/") ? (process.env["HOME"] ?? ".") + path.slice(1) : path;
}

export function storagePath(): string {
  const env = process.env;
  const own = env["BLOOM_STORAGE"];
  if (own !== undefined && own !== "") return expandHome(own);
  const c = config();
  if (c.storageFile !== "") return expandHome(c.storageFile);
  const files = env["BLOOM_ASSET_PATH"];
  if (ANDROID && files !== undefined && files !== "") return files + "/" + c.app + "/" + c.storageName;
  if (MOBILE) return (env["HOME"] ?? ".") + "/Library/Application Support/" + c.app + "/" + c.storageName;
  const xdg = env["XDG_CONFIG_HOME"];
  return (xdg !== undefined && xdg !== "" ? xdg : (env["HOME"] ?? ".") + "/.config") + "/" + c.app + "/" + c.storageName;
}

const STORAGE = storagePath();

function snapshot(): string {
  const data: Record<string, string> = {};
  const n = localStorage.length;
  for (let i = 0; i < n; i++) {
    const k = localStorage.key(i);
    if (k !== null) data[k] = localStorage.getItem(k) ?? "";
  }
  return JSON.stringify(data, null, 1);
}

try {
  if (existsSync(STORAGE)) {
    const data = JSON.parse(readFileSync(STORAGE, "utf8")) as Record<string, string>;
    for (const k of Object.keys(data)) localStorage.setItem(k, String(data[k]));
  }
} catch {
  // unreadable: start empty
}

let saved = snapshot();
let warned = false;

/** Write localStorage to its file now, if it changed. */
export function flushStorage(): void {
  const now = snapshot();
  if (now === saved) return;
  try {
    mkdirSync(STORAGE.slice(0, STORAGE.lastIndexOf("/")), { recursive: true });
    writeFileSync(STORAGE, now);
    saved = now;
  } catch (err) {
    // read-only: keep it in memory
    if (!warned) console.error("localStorage: cannot write " + STORAGE + ": " + String(err));
    warned = true;
  }
}

onAfterFrame(() => { if (frameCount() % 30 === 0) flushStorage(); });
onQuit(flushStorage);
