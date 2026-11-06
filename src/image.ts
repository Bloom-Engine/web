/**
 * <img> and `new Image()` on Bloom: the image stays a file, which the GPU
 * side (a renderer) hands to Bloom's texture loader. Loading finds the file
 * for the URL (the page's files, or a data: URL written to a temporary file)
 * and reads its size from the file's header (PNG, JPEG, GIF, WebP, BMP), so
 * `load` fires with naturalWidth/naturalHeight set, as in the browser.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setImageLoader } from "./dom/index.ts";
import { localPath } from "./fetch.ts";
import { blobFile, tempDir } from "./blob.ts";

/** Width and height from an image file's header, or null when the format isn't known. */
export function imageSize(b: Uint8Array): [number, number] | null {
  const n = b.length;
  const u16be = (i: number): number => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
  const u16le = (i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
  const u32be = (i: number): number => ((b[i] ?? 0) * 16777216) + (((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0));
  const u24le = (i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
  // PNG
  if (n >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return [u32be(16), u32be(20)];
  // GIF
  if (n >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return [u16le(6), u16le(8)];
  // BMP
  if (n >= 26 && b[0] === 0x42 && b[1] === 0x4d) return [Math.abs(u16le(18) | (u16le(20) << 16)), Math.abs((u16le(22) | (u16le(24) << 16)) << 0)];
  // WebP
  if (n >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const chunk = String.fromCharCode(b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0);
    if (chunk === "VP8 ") return [u16le(26) & 0x3fff, u16le(28) & 0x3fff];
    if (chunk === "VP8L") { const v = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24); return [(v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1]; }
    if (chunk === "VP8X") return [u24le(24) + 1, u24le(27) + 1];
  }
  // JPEG: the first start-of-frame marker
  if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < n) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1] ?? 0;
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = u16be(i + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return [u16be(i + 7), u16be(i + 5)];
      }
      i += 2 + len;
    }
  }
  return null;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg" };
let tempCount = 0;

/** A data: URL as a file in the temporary folder. */
export function dataUrlFile(url: string): string | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
  if (m === null) return null;
  const bytes = m[2] !== undefined ? Buffer.from(m[3] ?? "", "base64") : Buffer.from(decodeURIComponent(m[3] ?? ""), "utf8");
  const file = tempDir() + "data-" + String(++tempCount) + "." + (EXT[m[1] ?? ""] ?? "bin");
  writeFileSync(file, bytes);
  return file;
}

/** The file behind an image or media URL: the page's files, data: URLs and blob: URLs. */
export function fileFor(url: string): Promise<string | null> {
  if (url.startsWith("blob:")) return blobFile(url) ?? Promise.resolve(null);
  return Promise.resolve(url.startsWith("data:") ? dataUrlFile(url) : localPath(url));
}

setImageLoader((img, url, done) => {
  fileFor(url).then((path) => loaded(img, url, path, done), () => done(false));
});

function loaded(img: Parameters<Parameters<typeof setImageLoader>[0]>[0], url: string, path: string | null, done: (ok: boolean) => void): void {
  if (path === null || !existsSync(path)) {
    if (path === null) console.error("<img>: only the page's own files, data: and blob: URLs load here: " + url);
    done(false);
    return;
  }
  let size: [number, number] | null = null;
  try { size = imageSize(readFileSync(path)); } catch { size = null; }
  if (size === null) { done(false); return; }
  img.naturalWidth = size[0];
  img.naturalHeight = size[1];
  img.file = path;
  done(true);
}
