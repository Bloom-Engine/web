/**
 * <audio> and <video> (sound only), and `new Audio(src)`, as Bloom music
 * tracks: streamed from the file (MP3 and Ogg decode on a background
 * thread), with play/pause/seek, loop, volume, muted, currentTime,
 * duration (read from the file's header), the media events (loadstart,
 * durationchange, loadedmetadata, loadeddata, canplay, canplaythrough,
 * play, playing, pause, timeupdate, seeking, seeked, ended, volumechange,
 * emptied, error), and a place in a Web Audio graph through
 * createMediaElementSource (its gain, pan and the rest then apply).
 *
 * Each element has its own track, so two elements can play one file at
 * once (a crossfade between two copies of a loop).
 */
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { initAudioDevice, loadMusic, playMusicFrom, stopMusic, setMusicVolume, setMusicLooping, getMusicTimePlayed, getMusicTimeLength, isMusicPlaying } from "@bloomengine/engine/audio";
import type { Music } from "@bloomengine/engine/core";
import { Event, HTMLElement, defineElement, type Document } from "../dom/index.ts";
import { fileFor } from "../image.ts";
import { onAudioFrame, route, type AudioNode, type MediaElementAudioSourceNode } from "./context.ts";
import { probeAudio } from "./probe.ts";

let deviceReady = false;

/** The first bytes of a file: enough for its header (an MP3's length needs its frames, so all of it when small). */
function head(path: string, max: number): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const buf = new Uint8Array(Math.min(max, statSync(path).size));
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n);
  } finally { closeSync(fd); }
}

class TimeRanges {
  private readonly ranges: [number, number][];
  constructor(ranges: [number, number][]) { this.ranges = ranges; }
  get length(): number { return this.ranges.length; }
  start(i: number): number { const r = this.ranges[i]; if (r === undefined) throw new RangeError("IndexSizeError"); return r[0]; }
  end(i: number): number { const r = this.ranges[i]; if (r === undefined) throw new RangeError("IndexSizeError"); return r[1]; }
}

const all: HTMLMediaElement[] = [];
/** Every media element made, for diagnostics. */
export function mediaElements(): HTMLMediaElement[] { return all.slice(); }

export class HTMLMediaElement extends HTMLElement {
  static readonly HAVE_NOTHING = 0;
  static readonly HAVE_METADATA = 1;
  static readonly HAVE_CURRENT_DATA = 2;
  static readonly HAVE_FUTURE_DATA = 3;
  static readonly HAVE_ENOUGH_DATA = 4;
  static readonly NETWORK_EMPTY = 0;
  static readonly NETWORK_IDLE = 1;
  static readonly NETWORK_LOADING = 2;
  static readonly NETWORK_NO_SOURCE = 3;

  paused = true;
  ended = false;
  seeking = false;
  readyState = 0;
  networkState = 0;
  error: { code: number; message: string } | null = null;
  duration = NaN;
  defaultPlaybackRate = 1;
  private _playbackRate = 1;
  private _volume = 1;
  private _muted: boolean | null = null;
  private file: string | null = null;
  private music: Music | null = null;
  /** Seconds into the track where the current playback started (Bloom reports time since then). */
  private from = 0;
  private pausedAt = 0;
  private source: AudioNode | null = null;
  private lastGain = -1;
  private lastUpdate = 0;
  private started = 0;
  private loadTicket = 0;
  private playWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];

  constructor(doc: Document, localName: string) {
    super(doc, localName);
    onAudioFrame(this);
    all.push(this);
  }

  /** @internal for diagnostics: the Bloom track and its gain */
  _report(): string {
    const name = this.src.slice(this.src.lastIndexOf("/") + 1);
    return `${this.localName} ${name === "" ? "(no src)" : name} ${this.paused ? "paused" : "playing"} ${this.currentTime.toFixed(1)}/${Number.isFinite(this.duration) ? this.duration.toFixed(1) : "?"}s gain ${this.lastGain.toFixed(2)}` +
      (this.music !== null && !this.paused ? (isMusicPlaying(this.music) ? " (Bloom: playing)" : " (Bloom: stopped)") : "");
  }

  get src(): string {
    const s = this.getAttribute("src");
    if (s === null || s === "") return "";
    if (s.startsWith("data:")) return s;
    try { return new URL(s, this.ownerDocument?.URL ?? undefined).href; } catch { return s; }
  }
  set src(v: string) { this.setAttribute("src", v); }
  get currentSrc(): string { return this.file === null ? "" : this.src; }
  get loop(): boolean { return this.hasAttribute("loop"); }
  set loop(v: boolean) { this.toggleAttribute("loop", v); if (this.music !== null) setMusicLooping(this.music, v); }
  get autoplay(): boolean { return this.hasAttribute("autoplay"); }
  set autoplay(v: boolean) { this.toggleAttribute("autoplay", v); }
  get controls(): boolean { return this.hasAttribute("controls"); }
  set controls(v: boolean) { this.toggleAttribute("controls", v); }
  get preload(): string { return this.getAttribute("preload") ?? "auto"; }
  set preload(v: string) { this.setAttribute("preload", v); }
  get crossOrigin(): string | null { return this.getAttribute("crossorigin"); }
  set crossOrigin(v: string | null) { if (v === null) this.removeAttribute("crossorigin"); else this.setAttribute("crossorigin", v); }
  get defaultMuted(): boolean { return this.hasAttribute("muted"); }
  set defaultMuted(v: boolean) { this.toggleAttribute("muted", v); }
  get muted(): boolean { return this._muted ?? this.defaultMuted; }
  set muted(v: boolean) { if (this.muted === Boolean(v)) return; this._muted = Boolean(v); this.fire("volumechange"); }
  get volume(): number { return this._volume; }
  set volume(v: number) {
    if (!(v >= 0 && v <= 1)) throw new RangeError("IndexSizeError: volume must be between 0 and 1");
    if (v === this._volume) return;
    this._volume = v;
    this.fire("volumechange");
  }
  get playbackRate(): number { return this._playbackRate; }
  set playbackRate(v: number) { if (v !== 1) console.error("<audio>.playbackRate: music plays at its own rate on Bloom"); this._playbackRate = v; this.fire("ratechange"); }
  get preservesPitch(): boolean { return true; }
  get buffered(): TimeRanges { return new TimeRanges(this.readyState > 0 && Number.isFinite(this.duration) ? [[0, this.duration]] : []); }
  get seekable(): TimeRanges { return this.buffered; }
  get played(): TimeRanges { return new TimeRanges([]); }
  get textTracks(): unknown[] { return []; }

  get currentTime(): number {
    if (this.paused || this.music === null) return this.pausedAt;
    let t = this.from + getMusicTimePlayed(this.music);
    const d = this.duration;
    if (Number.isFinite(d) && d > 0) t = this.loop ? t % d : Math.min(t, d);
    return t;
  }
  set currentTime(v: number) {
    const t = Math.max(0, Number(v) || 0);
    this.seeking = true;
    this.fire("seeking");
    this.ended = false;
    if (!this.paused && this.music !== null) { this.from = t; playMusicFrom(this.music, t); this.started = Date.now(); }
    else this.pausedAt = t;
    this.seeking = false;
    this.fire("timeupdate");
    this.fire("seeked");
  }
  fastSeek(t: number): void { this.currentTime = t; }

  canPlayType(type: string): "" | "maybe" | "probably" {
    const t = type.toLowerCase();
    if (/^audio\/(mpeg|mp3|wav|wave|x-wav|ogg|vorbis)/.test(t) || t.startsWith("application/ogg")) return t.includes("codecs") && !/vorbis|opus|mp3|1/.test(t) ? "" : "probably";
    if (t.startsWith("audio/flac")) return "maybe";
    return "";
  }

  private fire(type: string): void { this.dispatchEvent(new Event(type)); }

  override _attributeChanged(name: string, old: string | null, value: string | null): void {
    super._attributeChanged(name, old, value);
    if (name === "src" && value !== old) this.load();
    if (name === "loop" && this.music !== null) setMusicLooping(this.music, value !== null);
  }

  /** @internal its sound goes through this graph node (createMediaElementSource) */
  _attachSource(node: AudioNode): void {
    if (this.source !== null) throw new Error("InvalidStateError: this element already has a MediaElementAudioSourceNode");
    this.source = node;
  }

  /** Start over with the current src: find its file, read its length, send the loading events. */
  load(): void {
    const ticket = ++this.loadTicket;
    if (this.music !== null) { stopMusic(this.music); this.music = null; }
    const wasPlaying = !this.paused;
    this.paused = true; this.ended = false; this.pausedAt = 0; this.from = 0; this.duration = NaN;
    this.readyState = 0; this.networkState = 0; this.error = null; this.file = null;
    for (const w of this.playWaiters.splice(0)) w.reject(new Error("AbortError: the media was reloaded"));
    if (wasPlaying) this.fire("pause");
    this.fire("emptied");
    const url = this.src;
    if (url === "") { this.networkState = 3; return; }
    this.networkState = 2;
    setTimeout(() => {
      if (ticket !== this.loadTicket) return;
      this.fire("loadstart");
      fileFor(url).then((path) => { if (ticket === this.loadTicket) this.loaded(url, path); }, () => this.fail(2, "MEDIA_ERR_NETWORK: " + url));
    }, 0);
  }

  private loaded(url: string, path: string | null): void {
    {
      if (path === null || !existsSync(path)) { this.fail(4, "MEDIA_ERR_SRC_NOT_SUPPORTED: " + url); return; }
      let info;
      try { info = probeAudio(head(path, 64 * 1024 * 1024)); } catch { info = null; }
      if (info === null || info.kind === "unknown") { this.fail(4, "MEDIA_ERR_SRC_NOT_SUPPORTED: not WAV, MP3 or Ogg: " + url); return; }
      this.file = path;
      this.duration = info.duration > 0 ? info.duration : NaN;
      this.networkState = 1;
      this.readyState = 1;
      this.fire("durationchange");
      this.fire("loadedmetadata");
      this.readyState = 4;
      this.fire("loadeddata");
      this.fire("canplay");
      this.fire("canplaythrough");
      if (this.autoplay && this.paused) void this.play();
      // a play() before the file was found starts now
      if (this.playWaiters.length > 0) this.startPlayback();
    }
  }

  private fail(code: number, message: string): void {
    this.error = { code, message };
    this.networkState = 3;
    this.fire("error");
    for (const w of this.playWaiters.splice(0)) w.reject(new Error("NotSupportedError: " + message));
  }

  play(): Promise<void> {
    if (this.error !== null) return Promise.reject(new Error("NotSupportedError: " + this.error.message));
    if (this.src === "") return Promise.reject(new Error("NotSupportedError: no source"));
    const promise = new Promise<void>((resolve, reject) => this.playWaiters.push({ resolve, reject }));
    if (this.paused) { this.paused = false; this.fire("play"); }
    if (this.file !== null) this.startPlayback();
    return promise;
  }

  private startPlayback(): void {
    if (this.paused || this.file === null) return;
    if (!deviceReady) { deviceReady = true; initAudioDevice(); }
    if (this.music === null) {
      const m = loadMusic(this.file);
      if (m.handle === 0) { this.fail(3, "MEDIA_ERR_DECODE: " + this.file); return; }
      this.music = m;
      if (!Number.isFinite(this.duration)) { const d = getMusicTimeLength(m); if (d > 0) { this.duration = d; this.fire("durationchange"); } }
    }
    if (this.ended || (Number.isFinite(this.duration) && this.pausedAt >= this.duration)) this.pausedAt = 0;
    this.ended = false;
    setMusicLooping(this.music, this.loop);
    this.lastGain = -1;
    setMusicVolume(this.music, this.gain());
    this.lastGain = this.gain();
    this.from = this.pausedAt;
    playMusicFrom(this.music, this.from);
    this.started = Date.now();
    this.fire("playing");
    for (const w of this.playWaiters.splice(0)) w.resolve();
  }

  pause(): void {
    if (this.paused) return;
    this.pausedAt = this.currentTime;
    this.paused = true;
    if (this.music !== null) stopMusic(this.music);
    for (const w of this.playWaiters.splice(0)) w.reject(new Error("AbortError: play() was interrupted by pause()"));
    this.fire("timeupdate");
    this.fire("pause");
  }

  private gain(): number {
    if (this.muted) return 0;
    let g = this._volume;
    const src = this.source as MediaElementAudioSourceNode | null;
    if (src !== null) {
      const ctx = src.context;
      if (ctx.state !== "running") return 0;
      g *= route(src, ctx.currentTime).gain;
    }
    return g;
  }

  /** @internal once a frame: volume through the graph, time updates, the end */
  _tick(_now: number, _dt: number): void {
    if (this.paused || this.music === null) return;
    const g = this.gain();
    if (Math.abs(g - this.lastGain) > 1e-4) { setMusicVolume(this.music, g); this.lastGain = g; }
    const now = Date.now();
    if (now - this.lastUpdate >= 250) { this.lastUpdate = now; this.fire("timeupdate"); }
    // a track that plays once has ended when Bloom stops it (give it a moment to start)
    if (!this.loop && now - this.started > 200 && !isMusicPlaying(this.music)) {
      this.pausedAt = Number.isFinite(this.duration) ? this.duration : this.currentTime;
      this.paused = true;
      this.ended = true;
      this.fire("timeupdate");
      this.fire("pause");
      this.fire("ended");
    }
  }
}

export class HTMLAudioElement extends HTMLMediaElement {}
export class HTMLVideoElement extends HTMLMediaElement {
  videoWidth = 0;
  videoHeight = 0;
  poster = "";
  playsInline = true;
  getVideoPlaybackQuality(): { totalVideoFrames: number; droppedVideoFrames: number } { return { totalVideoFrames: 0, droppedVideoFrames: 0 }; }
  requestVideoFrameCallback(): number { return 0; }
}

defineElement("audio", HTMLAudioElement as never);
defineElement("video", HTMLVideoElement as never);

/** `new Audio(src)` */
export function makeAudioClass(doc: () => Document): unknown {
  return class Audio extends HTMLAudioElement {
    constructor(src?: string) {
      super(doc(), "audio");
      this.preload = "auto";
      if (src !== undefined) this.src = src;
    }
  };
}
