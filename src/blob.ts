/**
 * Blob URLs: URL.createObjectURL(blob) and revokeObjectURL. Loaders that
 * turn bytes into a URL (GLTFLoader's embedded textures, generated sounds)
 * then load it like any other: fetch reads the blob, and <img>/<audio> get
 * it as a temporary file, which is what Bloom's loaders take.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolveObjectURL } from "node:buffer";

interface Entry { blob: Blob; file: Promise<string> | null }
const blobs = new Map<string, Entry>();
let count = 0;

const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp", "image/ktx2": "ktx2",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/ogg": "ogg", "audio/wav": "wav", "audio/wave": "wav", "audio/x-wav": "wav",
  "model/gltf-binary": "glb", "application/json": "json", "text/plain": "txt",
};

export function tempDir(): string {
  const dir = (process.env["TMPDIR"] ?? "/tmp").replace(/\/?$/, "/") + "bloom-web-" + String(process.pid) + "/";
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function createObjectURL(blob: Blob): string {
  const url = "blob:file:///" + String(Date.now().toString(36)) + "-" + String(++count);
  blobs.set(url, { blob, file: null });
  return url;
}
export function revokeObjectURL(url: string): void { blobs.delete(url); }

/**
 * The entry for a blob URL: one of ours, or one the runtime's own URL.createObjectURL made (Perry
 * compiles `URL.createObjectURL(...)` to its built-in, which an assignment can't replace), found
 * through node:buffer's resolveObjectURL.
 */
function entryOf(url: string): Entry | undefined {
  let e = blobs.get(url);
  if (e === undefined) {
    const blob = resolveObjectURL(url) as Blob | undefined;
    if (blob === undefined) return undefined;
    e = { blob, file: null };
    blobs.set(url, e);
  }
  return e;
}

export function blobOf(url: string): Blob | undefined { return entryOf(url)?.blob; }

/** A blob URL's bytes as a temporary file (written once), or null when the URL isn't known. */
export function blobFile(url: string): Promise<string> | null {
  const e = entryOf(url);
  if (e === undefined) return null;
  if (e.file === null) {
    e.file = e.blob.arrayBuffer().then((buf) => {
      const file = tempDir() + "blob-" + String(++count) + "." + (EXT[e.blob.type.split(";")[0] ?? ""] ?? "bin");
      writeFileSync(file, new Uint8Array(buf));
      return file;
    });
  }
  return e.file;
}

const U = URL as unknown as Record<string, unknown>;
if (typeof U["createObjectURL"] !== "function") U["createObjectURL"] = createObjectURL;
if (typeof U["revokeObjectURL"] !== "function") U["revokeObjectURL"] = revokeObjectURL;
