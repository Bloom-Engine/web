/**
 * fetch() for the page's own files. A web app loads its models, sounds and
 * data with relative URLs against `location.href`, which here is a file://
 * URL (config.ts); Perry's fetch doesn't read file:// URLs. This one reads
 * them from disk, and hands every other URL (http, https) to Perry's fetch.
 *
 * A root-relative path ("/models/a.glb") is the site's root on the web: the
 * served folder here. The bytes an ArrayBuffer came from are remembered
 * (sourceFile), so decodeAudioData can hand Bloom the file instead of the
 * bytes.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { config, pageUrl, webRoot } from "./config.ts";
import { blobOf } from "./blob.ts";

const files = new WeakMap<object, string>();

/** The file an ArrayBuffer from this fetch was read from, if it was. */
export function sourceFile(buffer: object): string | undefined { return files.get(buffer); }

/** Where a URL is on disk, or null when it isn't a file:// URL (relative URLs count as file://). */
export function localPath(input: string): string | null {
  const href = String(input);
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("file:")) return null;
  const site = webRoot() + config().served;
  if (href.startsWith("/") && !href.startsWith("//")) return site + href.slice(1);
  let path = decodeURIComponent(new URL(href, pageUrl()).pathname);
  // "/x" resolved against the page's file:// URL lands at the disk's root: it meant the site's
  if (!existsSync(path) && !path.startsWith(site) && existsSync(site + path.slice(1))) path = site + path.slice(1);
  return path;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const TYPES: Record<string, string> = {
  json: "application/json", html: "text/html", js: "text/javascript", css: "text/css", txt: "text/plain",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", ktx2: "image/ktx2",
  glb: "model/gltf-binary", gltf: "model/gltf+json", bin: "application/octet-stream",
  mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4",
};

/** The Response a file read gives: the parts of the Fetch API's Response apps use. */
export class FileResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly type = "basic";
  readonly redirected = false;
  readonly headers: { get(name: string): string | null; has(name: string): boolean };
  bodyUsed = false;
  private readonly path: string;
  private readonly bytes: Uint8Array | null;

  constructor(url: string, path: string, bytes: Uint8Array | null) {
    this.url = url;
    this.path = path;
    this.bytes = bytes;
    this.ok = bytes !== null;
    this.status = bytes !== null ? 200 : 404;
    this.statusText = bytes !== null ? "OK" : "Not Found";
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const head: Record<string, string> = { "content-type": TYPES[ext] ?? "application/octet-stream" };
    if (bytes !== null) head["content-length"] = String(bytes.byteLength);
    this.headers = {
      get: (name: string): string | null => head[name.toLowerCase()] ?? null,
      has: (name: string): boolean => head[name.toLowerCase()] !== undefined,
    };
  }

  private body(): Uint8Array {
    if (this.bytes === null) throw new TypeError("Failed to fetch " + this.url);
    this.bodyUsed = true;
    return this.bytes;
  }
  arrayBuffer(): Promise<ArrayBuffer> {
    try {
      const buffer = toArrayBuffer(this.body());
      files.set(buffer, this.path);
      return Promise.resolve(buffer);
    } catch (err) { return Promise.reject(err); }
  }
  text(): Promise<string> {
    try { return Promise.resolve(new TextDecoder().decode(this.body())); } catch (err) { return Promise.reject(err); }
  }
  json(): Promise<unknown> { return this.text().then((t) => JSON.parse(t) as unknown); }
  bytesView(): Promise<Uint8Array> { try { return Promise.resolve(this.body()); } catch (err) { return Promise.reject(err); } }
  blob(): Promise<{ size: number; type: string; arrayBuffer(): Promise<ArrayBuffer> }> {
    return this.arrayBuffer().then((b) => ({ size: b.byteLength, type: this.headers.get("content-type") ?? "", arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(b) }));
  }
  clone(): FileResponse { return new FileResponse(this.url, this.path, this.bytes); }
}

/** Read a local URL now (null when it isn't one). */
export function fetchFile(href: string): FileResponse | null {
  const path = localPath(href);
  if (path === null) return null;
  let bytes: Uint8Array | null = null;
  try {
    if (existsSync(path) && statSync(path).isFile()) bytes = readFileSync(path);
  } catch {
    bytes = null;
  }
  return new FileResponse(href, path, bytes);
}

type Fetch = (input: unknown, init?: unknown) => Promise<unknown>;
const g = globalThis as Record<string, unknown>;
const perryFetch = g["fetch"] as Fetch | undefined;

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  const o = input as { href?: unknown; url?: unknown } | null;
  if (o !== null && typeof o === "object") {
    if (typeof o.href === "string") return o.href;      // URL
    if (typeof o.url === "string") return o.url;        // Request
  }
  return String(input);
}

g["fetch"] = (input: unknown, init?: unknown): Promise<unknown> => {
  const href = urlOf(input);
  if (href.startsWith("blob:")) {
    const blob = blobOf(href);
    if (blob === undefined) return Promise.reject(new TypeError("Failed to fetch " + href));
    return blob.arrayBuffer().then((b) => new FileResponse(href, "", new Uint8Array(b)));
  }
  const file = fetchFile(href);
  if (file !== null) return Promise.resolve(file);
  if (perryFetch === undefined) return Promise.reject(new TypeError("fetch: no network here: " + href));
  return perryFetch(href, init);
};
