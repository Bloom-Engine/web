/**
 * An audio file's format from its bytes, without decoding it: sample rate,
 * channels and length (WAV, MP3 with or without a Xing/VBRI header, Ogg
 * Vorbis and Opus). Web Audio's AudioBuffer and <audio>'s duration need
 * them; Bloom decodes the samples itself.
 */

export interface AudioInfo { kind: "wav" | "mp3" | "ogg" | "unknown"; sampleRate: number; channels: number; duration: number }

const MP3_RATES = [[11025, 12000, 8000], [0, 0, 0], [22050, 24000, 16000], [44100, 48000, 32000]];
const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_BITRATES_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const MP3_BITRATES_V1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];

function u32le(b: Uint8Array, i: number): number { return ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16)) + (b[i + 3] ?? 0) * 16777216; }
function u16le(b: Uint8Array, i: number): number { return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8); }
function u32be(b: Uint8Array, i: number): number { return (b[i] ?? 0) * 16777216 + (((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)); }
function tag(b: Uint8Array, i: number, s: string): boolean { for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false; return true; }

function wav(b: Uint8Array): AudioInfo | null {
  if (!tag(b, 0, "RIFF") || !tag(b, 8, "WAVE")) return null;
  let i = 12, rate = 0, channels = 0, bytesPerFrame = 0, data = 0;
  while (i + 8 <= b.length) {
    const size = u32le(b, i + 4);
    if (tag(b, i, "fmt ")) { channels = u16le(b, i + 10); rate = u32le(b, i + 12); bytesPerFrame = u16le(b, i + 20); }
    else if (tag(b, i, "data")) { data = Math.min(size, b.length - i - 8); break; }
    i += 8 + size + (size & 1);
  }
  if (rate === 0 || bytesPerFrame === 0) return null;
  return { kind: "wav", sampleRate: rate, channels, duration: data / bytesPerFrame / rate };
}

function mp3(b: Uint8Array): AudioInfo | null {
  let i = 0;
  // ID3v2 tag
  if (tag(b, 0, "ID3") && b.length > 10) i = 10 + (((b[6] ?? 0) & 0x7f) << 21 | ((b[7] ?? 0) & 0x7f) << 14 | ((b[8] ?? 0) & 0x7f) << 7 | ((b[9] ?? 0) & 0x7f));
  let rate = 0, channels = 0, samples = 0, frames = 0;
  const n = b.length;
  while (i + 4 <= n) {
    if (b[i] !== 0xff || ((b[i + 1] ?? 0) & 0xe0) !== 0xe0) { i++; continue; }
    const h1 = b[i + 1] ?? 0, h2 = b[i + 2] ?? 0, h3 = b[i + 3] ?? 0;
    const version = (h1 >> 3) & 3, layer = (h1 >> 1) & 3, bitIdx = h2 >> 4, rateIdx = (h2 >> 2) & 3, padding = (h2 >> 1) & 1;
    if (version === 1 || layer === 0 || bitIdx === 0 || bitIdx === 15 || rateIdx === 3) { i++; continue; }
    const r = (MP3_RATES[version] as number[])[rateIdx] ?? 0;
    const v1 = version === 3;
    const kbps = layer === 1 ? (v1 ? MP3_BITRATES_V1_L3 : MP3_BITRATES_V2_L3)[bitIdx] ?? 0
      : layer === 2 ? (v1 ? MP3_BITRATES_V1_L2 : MP3_BITRATES_V2_L3)[bitIdx] ?? 0
      : (v1 ? MP3_BITRATES_V1_L1 : MP3_BITRATES_V2_L3)[bitIdx] ?? 0;
    const perFrame = layer === 3 ? 384 : layer === 1 && !v1 ? 576 : 1152;
    const length = layer === 3 ? Math.floor((12 * kbps * 1000) / r + padding) * 4 : Math.floor((perFrame / 8 * kbps * 1000) / r) + padding;
    if (length <= 4) { i++; continue; }
    if (frames === 0) {
      rate = r;
      channels = (h3 >> 6) === 3 ? 1 : 2;
      // a Xing/Info or VBRI header in the first frame gives the frame count directly
      const side = v1 ? (channels === 1 ? 17 : 32) : (channels === 1 ? 9 : 17);
      const x = i + 4 + side;
      if (tag(b, x, "Xing") || tag(b, x, "Info")) {
        const flags = u32be(b, x + 4);
        if ((flags & 1) !== 0) return { kind: "mp3", sampleRate: rate, channels, duration: (u32be(b, x + 8) * perFrame) / rate };
      }
      if (tag(b, i + 36, "VBRI")) return { kind: "mp3", sampleRate: rate, channels, duration: (u32be(b, i + 36 + 14) * perFrame) / rate };
    }
    frames++;
    samples += perFrame;
    i += length;
  }
  return frames === 0 ? null : { kind: "mp3", sampleRate: rate, channels, duration: samples / rate };
}

function ogg(b: Uint8Array): AudioInfo | null {
  if (!tag(b, 0, "OggS")) return null;
  let rate = 0, channels = 0, preSkip = 0, opus = false;
  // the identification header is in the first page's packet
  const segs = b[26] ?? 0;
  const p = 27 + segs;
  if (tag(b, p, "\x01vorbis")) { channels = b[p + 11] ?? 0; rate = u32le(b, p + 12); }
  else if (tag(b, p, "OpusHead")) { opus = true; channels = b[p + 9] ?? 0; preSkip = u16le(b, p + 10); rate = 48000; }
  else return null;
  // the last page's granule position is the length in samples
  let granule = 0;
  for (let i = b.length - 27; i >= 0; i--) {
    if (b[i] === 0x4f && tag(b, i, "OggS")) {
      granule = u32le(b, i + 6) + u32le(b, i + 10) * 4294967296;
      break;
    }
  }
  return { kind: "ogg", sampleRate: opus ? 48000 : rate, channels, duration: Math.max(0, granule - preSkip) / rate };
}

export function probeAudio(bytes: Uint8Array): AudioInfo {
  return wav(bytes) ?? ogg(bytes) ?? mp3(bytes) ?? { kind: "unknown", sampleRate: 44100, channels: 2, duration: 0 };
}

/** A file extension Bloom's decoder recognizes for these bytes. */
export function extensionFor(bytes: Uint8Array): string {
  if (tag(bytes, 0, "RIFF")) return "wav";
  if (tag(bytes, 0, "OggS")) return "ogg";
  if (tag(bytes, 0, "fLaC")) return "flac";
  return "mp3";
}

/** 16-bit PCM WAV bytes from float channels (for AudioBuffers a page fills itself). */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const ch = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const data = frames * ch * 2;
  const out = new Uint8Array(44 + data);
  const view = new DataView(out.buffer);
  const str = (i: number, s: string): void => { for (let k = 0; k < s.length; k++) out[i + k] = s.charCodeAt(k); };
  str(0, "RIFF"); view.setUint32(4, 36 + data, true); str(8, "WAVE");
  str(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, ch, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * ch * 2, true); view.setUint16(32, ch * 2, true); view.setUint16(34, 16, true);
  str(36, "data"); view.setUint32(40, data, true);
  let o = 44;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < ch; c++) {
      const v = channels[c]?.[f] ?? 0;
      const s = v < -1 ? -1 : v > 1 ? 1 : v;
      view.setInt16(o, s < 0 ? s * 32768 : s * 32767, true);
      o += 2;
    }
  }
  return out;
}
