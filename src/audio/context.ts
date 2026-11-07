/**
 * Web Audio on Bloom's mixer.
 *
 * The node graph lives here, in TypeScript; Bloom plays the samples. Each
 * playing source (AudioBufferSourceNode, OscillatorNode, a media element) is
 * one Bloom voice or music track, and once a frame its settings are worked
 * out from its paths through the graph to the destination:
 *   - gain: the product of the GainNodes on a path (with their AudioParam
 *     automation: setValueAtTime, linear and exponential ramps,
 *     setTargetAtTime, setValueCurveAtTime, cancel...), summed over paths
 *   - stereo pan: a StereoPannerNode on the loudest path
 *   - position: a PannerNode on the loudest path makes it a 3D voice (with
 *     the context's AudioListener), refDistance/maxDistance/rolloffFactor
 *   - low-pass: a lowpass BiquadFilterNode's frequency
 *   - rate: playbackRate and detune (an oscillator's frequency and detune)
 * Bloom ramps gain changes inside the mixer, so per-frame updates don't
 * zipper. Nodes without a Bloom counterpart (analyser, compressor, delay,
 * convolver, wave shaper, splitter, merger) pass the sound through
 * unchanged; an AnalyserNode reports silence.
 *
 * Decoded audio stays with Bloom: decodeAudioData hands Bloom the file the
 * bytes came from (fetch.ts remembers it), or writes them to a temporary
 * file; an AudioBuffer a page fills itself is written as a WAV when it first
 * plays. getChannelData on a decoded buffer gives silence (the samples are
 * in the mixer, not here).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  initAudioDevice, loadSound, playSoundEx, playSound3DEx, voiceSetVolume, voiceSetPitch, voiceSetPan, voiceSetLowpass,
  voiceSetPosition, voiceStop, setListenerPosition,
} from "@bloomengine/engine/audio";
import type { Sound } from "@bloomengine/engine/core";
import { Event, EventTarget } from "../dom/index.ts";
import { sourceFile } from "../fetch.ts";
import { onBeforeFrame } from "../frame.ts";
import { encodeWav, extensionFor, probeAudio } from "./probe.ts";

let deviceReady = false;
/** Start Bloom's audio device, once for the whole page (contexts and media elements share it). */
export function device(): void { if (!deviceReady) { deviceReady = true; initAudioDevice(); } }

let warned = new Set<string>();
function warnOnce(what: string): void { if (!warned.has(what)) { warned.add(what); console.error("Web Audio on Bloom: " + what); } }

let tempCount = 0;
/** Bytes as a file Bloom can load. */
export function tempAudioFile(bytes: Uint8Array, ext: string): string {
  const dir = (process.env["TMPDIR"] ?? "/tmp").replace(/\/?$/, "/") + "bloom-web-" + String(process.pid) + "/";
  mkdirSync(dir, { recursive: true });
  const file = dir + "audio-" + String(++tempCount) + "." + ext;
  writeFileSync(file, bytes);
  return file;
}

// ---------------------------------------------------------------- AudioParam

interface ParamEvent { kind: "set" | "linear" | "exp" | "target" | "curve"; time: number; value: number; tc: number; curve: number[]; duration: number }

export class AudioParam {
  readonly defaultValue: number;
  readonly minValue: number;
  readonly maxValue: number;
  automationRate: "a-rate" | "k-rate" = "a-rate";
  /** @internal the value before the first event */ _base: number;
  /** @internal */ _events: ParamEvent[] = [];
  private readonly ctx: BaseAudioContext;

  constructor(ctx: BaseAudioContext, value: number, min = -3.4028234663852886e38, max = 3.4028234663852886e38) {
    this.ctx = ctx;
    this.defaultValue = value;
    this._base = value;
    this.minValue = min;
    this.maxValue = max;
  }

  get value(): number { return this._valueAt(this.ctx.currentTime); }
  set value(v: number) {
    const t = this.ctx.currentTime;
    if (this._events.length === 0) { this._base = this.clamp(v); return; }
    this.setValueAtTime(v, t);
  }

  private clamp(v: number): number { return Math.min(this.maxValue, Math.max(this.minValue, Number(v))); }
  private insert(e: ParamEvent): this {
    if (!Number.isFinite(e.time) || e.time < 0) throw new RangeError("AudioParam: time must be finite and >= 0");
    // events at the same time keep their order; a new one goes after them
    let i = this._events.length;
    while (i > 0 && (this._events[i - 1] as ParamEvent).time > e.time) i--;
    this._events.splice(i, 0, e);
    return this;
  }
  setValueAtTime(value: number, time: number): this { return this.insert({ kind: "set", time: Math.max(0, time), value: this.clamp(value), tc: 0, curve: [], duration: 0 }); }
  linearRampToValueAtTime(value: number, time: number): this { return this.insert({ kind: "linear", time: Math.max(0, time), value: this.clamp(value), tc: 0, curve: [], duration: 0 }); }
  exponentialRampToValueAtTime(value: number, time: number): this {
    if (value === 0) throw new RangeError("exponentialRampToValueAtTime: the value can't be 0");
    return this.insert({ kind: "exp", time: Math.max(0, time), value: this.clamp(value), tc: 0, curve: [], duration: 0 });
  }
  setTargetAtTime(target: number, time: number, timeConstant: number): this {
    if (timeConstant < 0) throw new RangeError("setTargetAtTime: timeConstant must be >= 0");
    return this.insert({ kind: "target", time: Math.max(0, time), value: this.clamp(target), tc: timeConstant, curve: [], duration: 0 });
  }
  setValueCurveAtTime(values: ArrayLike<number>, time: number, duration: number): this {
    return this.insert({ kind: "curve", time: Math.max(0, time), value: Number(values[values.length - 1] ?? 0), tc: 0, curve: Array.from(values), duration });
  }
  cancelScheduledValues(time: number): this {
    const keep = this._events.filter((e) => e.time < time);
    if (keep.length !== this._events.length) this._events = keep;
    return this;
  }
  cancelAndHoldAtTime(time: number): this {
    const held = this._valueAt(time);
    this.cancelScheduledValues(time);
    return this.setValueAtTime(held, time);
  }

  /** @internal the value at a time, from the events (the Web Audio spec's rules) */
  _valueAt(t: number): number {
    let v = this._base;
    let start = 0;   // where the current segment starts (time); v is the value there
    const ev = this._events;
    const n = ev.length;
    for (let i = 0; i < n; i++) {
      const e = ev[i] as ParamEvent;
      switch (e.kind) {
        case "set":
          if (t < e.time) return v;
          v = e.value; start = e.time;
          break;
        case "linear": case "exp": {
          if (t < e.time) {
            if (t <= start || e.time <= start) return v;
            const f = (t - start) / (e.time - start);
            if (e.kind === "exp" && v !== 0 && v * e.value > 0) return v * Math.pow(e.value / v, f);
            return v + (e.value - v) * f;
          }
          v = e.value; start = e.time;
          break;
        }
        case "target": {
          if (t < e.time) return v;
          const next = ev[i + 1];
          // a ramp after a target starts where the target began; other events end it at their time
          const end = next === undefined ? Infinity : next.kind === "linear" || next.kind === "exp" ? e.time : next.time;
          const at = (x: number): number => (e.tc === 0 ? e.value : e.value + (v - e.value) * Math.exp(-(x - e.time) / e.tc));
          if (t < end) return at(t);
          v = at(end); start = end;
          break;
        }
        case "curve": {
          if (t < e.time) return v;
          const k = e.curve.length;
          if (t < e.time + e.duration && k > 1) {
            const pos = ((t - e.time) / e.duration) * (k - 1);
            const j = Math.floor(pos);
            const a = e.curve[j] ?? 0, b = e.curve[Math.min(k - 1, j + 1)] ?? a;
            return a + (b - a) * (pos - j);
          }
          v = e.value; start = e.time + e.duration;
          break;
        }
      }
    }
    return v;
  }

  /** @internal drop events that are over (keeping the value), so evaluation stays cheap */
  _settle(now: number): void {
    const ev = this._events;
    if (ev.length === 0) return;
    const last = ev[ev.length - 1] as ParamEvent;
    const over = last.kind === "curve" ? last.time + last.duration : last.time;
    if (now < over) return;
    const v = this._valueAt(now);
    if (last.kind === "target" && Math.abs(v - last.value) > 1e-4 * Math.max(1, Math.abs(last.value))) return;
    this._base = last.kind === "target" ? last.value : v;
    this._events = [];
  }
}

// ---------------------------------------------------------------- nodes

type Output = AudioNode | AudioParam;

export class AudioNode extends EventTarget {
  readonly context: BaseAudioContext;
  readonly numberOfInputs: number;
  readonly numberOfOutputs: number;
  channelCount = 2;
  channelCountMode: "max" | "clamped-max" | "explicit" = "max";
  channelInterpretation: "speakers" | "discrete" = "speakers";
  /** @internal */ _outputs: Output[] = [];

  constructor(context: BaseAudioContext, inputs = 1, outputs = 1) {
    super();
    if (!(context instanceof BaseAudioContext)) throw new TypeError("AudioNode: the first argument must be an AudioContext");
    this.context = context;
    this.numberOfInputs = inputs;
    this.numberOfOutputs = outputs;
  }
  connect<T extends Output>(destination: T, _output = 0, _input = 0): T {
    if (destination instanceof AudioNode && destination.context !== this.context) throw new Error("InvalidAccessError: nodes from different contexts");
    if (!this._outputs.includes(destination)) this._outputs.push(destination);
    if (destination instanceof AudioParam) warnOnce("connecting a node to an AudioParam (modulation) isn't supported; the connection is ignored");
    return destination;
  }
  disconnect(destination?: Output | number, ..._rest: unknown[]): void {
    if (destination === undefined || typeof destination === "number") { this._outputs = []; return; }
    const i = this._outputs.indexOf(destination);
    if (i < 0) throw new Error("InvalidAccessError: not connected to that destination");
    this._outputs.splice(i, 1);
  }
}

export class AudioDestinationNode extends AudioNode {
  readonly maxChannelCount = 2;
  constructor(ctx: BaseAudioContext) { super(ctx, 1, 0); }
}

export class GainNode extends AudioNode {
  readonly gain: AudioParam;
  constructor(ctx: BaseAudioContext, options: { gain?: number } = {}) { super(ctx); this.gain = new AudioParam(ctx, options.gain ?? 1); }
}

export class StereoPannerNode extends AudioNode {
  readonly pan: AudioParam;
  constructor(ctx: BaseAudioContext, options: { pan?: number } = {}) { super(ctx); this.pan = new AudioParam(ctx, options.pan ?? 0, -1, 1); }
}

export interface PannerOptions {
  positionX?: number; positionY?: number; positionZ?: number; orientationX?: number; orientationY?: number; orientationZ?: number;
  refDistance?: number; maxDistance?: number; rolloffFactor?: number; distanceModel?: string; panningModel?: string;
  coneInnerAngle?: number; coneOuterAngle?: number; coneOuterGain?: number;
}
export class PannerNode extends AudioNode {
  readonly positionX: AudioParam; readonly positionY: AudioParam; readonly positionZ: AudioParam;
  readonly orientationX: AudioParam; readonly orientationY: AudioParam; readonly orientationZ: AudioParam;
  refDistance: number; maxDistance: number; rolloffFactor: number;
  distanceModel: string; panningModel: string;
  coneInnerAngle: number; coneOuterAngle: number; coneOuterGain: number;
  constructor(ctx: BaseAudioContext, o: PannerOptions = {}) {
    super(ctx);
    this.positionX = new AudioParam(ctx, o.positionX ?? 0); this.positionY = new AudioParam(ctx, o.positionY ?? 0); this.positionZ = new AudioParam(ctx, o.positionZ ?? 0);
    this.orientationX = new AudioParam(ctx, o.orientationX ?? 1); this.orientationY = new AudioParam(ctx, o.orientationY ?? 0); this.orientationZ = new AudioParam(ctx, o.orientationZ ?? 0);
    this.refDistance = o.refDistance ?? 1; this.maxDistance = o.maxDistance ?? 10000; this.rolloffFactor = o.rolloffFactor ?? 1;
    this.distanceModel = o.distanceModel ?? "inverse"; this.panningModel = o.panningModel ?? "equalpower";
    this.coneInnerAngle = o.coneInnerAngle ?? 360; this.coneOuterAngle = o.coneOuterAngle ?? 360; this.coneOuterGain = o.coneOuterGain ?? 0;
  }
  setPosition(x: number, y: number, z: number): void { this.positionX.value = x; this.positionY.value = y; this.positionZ.value = z; }
  setOrientation(x: number, y: number, z: number): void { this.orientationX.value = x; this.orientationY.value = y; this.orientationZ.value = z; }
}

export class BiquadFilterNode extends AudioNode {
  type: string;
  readonly frequency: AudioParam; readonly detune: AudioParam; readonly Q: AudioParam; readonly gain: AudioParam;
  constructor(ctx: BaseAudioContext, o: { type?: string; frequency?: number; detune?: number; Q?: number; gain?: number } = {}) {
    super(ctx);
    this.type = o.type ?? "lowpass";
    this.frequency = new AudioParam(ctx, o.frequency ?? 350, 0, 24000);
    this.detune = new AudioParam(ctx, o.detune ?? 0);
    this.Q = new AudioParam(ctx, o.Q ?? 1);
    this.gain = new AudioParam(ctx, o.gain ?? 0);
  }
  getFrequencyResponse(freqs: Float32Array, mag: Float32Array, phase: Float32Array): void {
    const f0 = this.frequency.value;
    for (let i = 0; i < freqs.length; i++) { const r = (freqs[i] ?? 0) / Math.max(1, f0); mag[i] = this.type === "lowpass" ? 1 / Math.sqrt(1 + r * r) : 1; phase[i] = 0; }
  }
}

/** Nodes with no counterpart in Bloom's mixer: the sound passes through them unchanged. */
export class PassThroughNode extends AudioNode {}
export class DynamicsCompressorNode extends PassThroughNode {
  readonly threshold: AudioParam; readonly knee: AudioParam; readonly ratio: AudioParam; readonly attack: AudioParam; readonly release: AudioParam;
  readonly reduction = 0;
  constructor(ctx: BaseAudioContext, o: Record<string, number> = {}) {
    super(ctx);
    this.threshold = new AudioParam(ctx, o["threshold"] ?? -24); this.knee = new AudioParam(ctx, o["knee"] ?? 30); this.ratio = new AudioParam(ctx, o["ratio"] ?? 12);
    this.attack = new AudioParam(ctx, o["attack"] ?? 0.003); this.release = new AudioParam(ctx, o["release"] ?? 0.25);
  }
}
export class DelayNode extends PassThroughNode {
  readonly delayTime: AudioParam;
  constructor(ctx: BaseAudioContext, o: { delayTime?: number; maxDelayTime?: number } = {}) { super(ctx); this.delayTime = new AudioParam(ctx, o.delayTime ?? 0, 0, o.maxDelayTime ?? 1); }
}
export class ConvolverNode extends PassThroughNode { buffer: AudioBuffer | null = null; normalize = true; }
export class WaveShaperNode extends PassThroughNode { curve: Float32Array | null = null; oversample = "none"; }
export class ChannelSplitterNode extends PassThroughNode { constructor(ctx: BaseAudioContext, o: { numberOfOutputs?: number } = {}) { super(ctx, 1, o.numberOfOutputs ?? 6); } }
export class ChannelMergerNode extends PassThroughNode { constructor(ctx: BaseAudioContext, o: { numberOfInputs?: number } = {}) { super(ctx, o.numberOfInputs ?? 6, 1); } }
export class IIRFilterNode extends PassThroughNode { getFrequencyResponse(): void {} }
export class AnalyserNode extends PassThroughNode {
  fftSize = 2048; minDecibels = -100; maxDecibels = -30; smoothingTimeConstant = 0.8;
  get frequencyBinCount(): number { return this.fftSize / 2; }
  getFloatFrequencyData(a: Float32Array): void { a.fill(-Infinity); }
  getByteFrequencyData(a: Uint8Array): void { a.fill(0); }
  getFloatTimeDomainData(a: Float32Array): void { a.fill(0); }
  getByteTimeDomainData(a: Uint8Array): void { a.fill(128); }
}
export class MediaStreamAudioDestinationNode extends AudioNode { readonly stream = null; }
export class ScriptProcessorNode extends AudioNode {
  onaudioprocess: unknown = null;
  readonly bufferSize: number;
  constructor(ctx: BaseAudioContext, bufferSize = 4096) { super(ctx); this.bufferSize = bufferSize; warnOnce("ScriptProcessorNode never runs (sample processing in script isn't supported)"); }
}

// ---------------------------------------------------------------- AudioBuffer

export class AudioBuffer {
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
  /** @internal the file Bloom loads it from */ _file: string | null;
  /** @internal */ _channels: (Float32Array | null)[];
  private sound: Sound | null = null;
  private written = false;

  constructor(options: { length: number; sampleRate: number; numberOfChannels?: number }, file: string | null = null) {
    if (options.length < 0 || options.sampleRate <= 0) throw new RangeError("AudioBuffer: bad length or sampleRate");
    this.sampleRate = options.sampleRate;
    this.length = Math.max(0, Math.round(options.length));
    this.numberOfChannels = options.numberOfChannels ?? 1;
    this._file = file;
    this._channels = new Array(this.numberOfChannels).fill(null);
  }
  get duration(): number { return this.length / this.sampleRate; }
  getChannelData(channel: number): Float32Array {
    if (channel < 0 || channel >= this.numberOfChannels) throw new RangeError("IndexSizeError: no channel " + String(channel));
    let data = this._channels[channel] ?? null;
    if (data === null) {
      if (this._file !== null) warnOnce("getChannelData on decoded audio gives silence (the samples are in Bloom's mixer)");
      data = new Float32Array(this.length);
      this._channels[channel] = data;
    }
    return data;
  }
  copyFromChannel(dest: Float32Array, channel: number, start = 0): void { dest.set(this.getChannelData(channel).subarray(start, start + dest.length)); }
  copyToChannel(src: Float32Array, channel: number, start = 0): void { this.getChannelData(channel).set(src.subarray(0, this.length - start), start); }

  /** @internal Bloom's sound for this buffer: its file, or its samples written as a WAV */
  _sound(): Sound | null {
    if (this.sound !== null) return this.sound;
    let file = this._file;
    if (file === null) {
      if (this.written) return null;
      this.written = true;
      file = tempAudioFile(encodeWav(this._channels.map((c) => c ?? new Float32Array(this.length)), this.sampleRate), "wav");
    }
    device();
    const sound = loadSound(file);
    if (sound.handle === 0) { warnOnce("Bloom couldn't decode " + file); return null; }
    this.sound = sound;
    return sound;
  }
}

// ---------------------------------------------------------------- the graph

/** What a source's paths to the destination add up to. */
export interface Route { gain: number; pan: number; lowpass: number; panner: PannerNode | null }

/** Walk a node's outputs to the destination, multiplying gains; sum the paths, keep the loudest's pan and position. */
export function route(node: AudioNode, t: number): Route {
  const out: Route = { gain: 0, pan: 0, lowpass: 0, panner: null };
  let loudest = -1;
  const walk = (n: AudioNode, gain: number, pan: number, lowpass: number, panner: PannerNode | null, depth: number): void => {
    if (depth > 64 || gain <= 0) return;
    for (const o of n._outputs) {
      if (o instanceof AudioParam) continue;
      if (o instanceof AudioDestinationNode) {
        out.gain += gain;
        if (gain > loudest) { loudest = gain; out.pan = pan; out.lowpass = lowpass; out.panner = panner; }
        continue;
      }
      let g = gain, p = pan, lp = lowpass, pn = panner;
      if (o instanceof GainNode) g *= o.gain._valueAt(t);
      else if (o instanceof StereoPannerNode) p = Math.max(-1, Math.min(1, o.pan._valueAt(t)));
      else if (o instanceof PannerNode) pn = o;
      else if (o instanceof BiquadFilterNode && o.type === "lowpass") { const f = o.frequency._valueAt(t) * Math.pow(2, o.detune._valueAt(t) / 1200); lp = lp === 0 ? f : Math.min(lp, f); }
      walk(o, g, p, lp, pn, depth + 1);
    }
  };
  walk(node, 1, 0, 0, null, 0);
  return out;
}

/** Something that plays: updated once a frame from its route. */
export interface Playing { _tick(now: number, dt: number): void }

// ---------------------------------------------------------------- sources

export class AudioScheduledSourceNode extends AudioNode {
  onended: ((e: Event) => void) | null = null;
  /** @internal */ _startAt = -1;
  /** @internal */ _stopAt = Infinity;
  /** @internal */ _state: "idle" | "scheduled" | "playing" | "done" = "idle";
  constructor(ctx: BaseAudioContext) { super(ctx, 0, 1); }
  start(when = 0): void {
    if (this._state !== "idle") throw new Error("InvalidStateError: start() can only be called once");
    this._startAt = Math.max(when, 0);
    this._state = "scheduled";
    (this.context as BaseAudioContext)._playing.add(this as unknown as Playing);
  }
  stop(when = 0): void {
    if (this._state === "idle") throw new Error("InvalidStateError: stop() before start()");
    this._stopAt = Math.max(when, 0);
  }
  /** @internal */ _ended(): void {
    if (this._state === "done") return;
    this._state = "done";
    (this.context as BaseAudioContext)._playing.delete(this as unknown as Playing);
    setTimeout(() => this.dispatchEvent(new Event("ended")), 0);
  }
}

/** A Bloom voice driven by a route: started, steered every frame, stopped. */
class Voice {
  id = 0;
  private gain = -1; private rate = -1; private pan = 2; private lowpass = -1;
  private px = NaN; private py = NaN; private pz = NaN;
  private spatial = false;

  start(sound: Sound, loop: boolean, r: Route, rate: number, t: number): void {
    const p = r.panner;
    if (p !== null) {
      const x = p.positionX._valueAt(t), y = p.positionY._valueAt(t), z = p.positionZ._valueAt(t);
      this.id = playSound3DEx(sound, x, y, z, loop, p.refDistance, p.distanceModel === "linear" ? p.maxDistance : 0, p.rolloffFactor);
      this.spatial = true;
      this.px = x; this.py = y; this.pz = z;
      voiceSetVolume(this.id, r.gain);
      if (rate !== 1) voiceSetPitch(this.id, rate);
    } else {
      this.id = playSoundEx(sound, loop, r.gain, rate, r.pan);
    }
    this.gain = r.gain; this.rate = rate; this.pan = r.pan; this.lowpass = 0;
    if (r.lowpass > 0) { voiceSetLowpass(this.id, r.lowpass); this.lowpass = r.lowpass; }
  }
  update(r: Route, rate: number, t: number, muted: boolean): void {
    if (this.id === 0) return;
    const gain = muted ? 0 : r.gain;
    if (Math.abs(gain - this.gain) > 1e-4) { voiceSetVolume(this.id, gain); this.gain = gain; }
    if (Math.abs(rate - this.rate) > 1e-4) { voiceSetPitch(this.id, rate); this.rate = rate; }
    if (!this.spatial && Math.abs(r.pan - this.pan) > 1e-4) { voiceSetPan(this.id, r.pan); this.pan = r.pan; }
    if (Math.abs(r.lowpass - this.lowpass) > 0.5) { voiceSetLowpass(this.id, r.lowpass); this.lowpass = r.lowpass; }
    const p = r.panner;
    if (this.spatial && p !== null) {
      const x = p.positionX._valueAt(t), y = p.positionY._valueAt(t), z = p.positionZ._valueAt(t);
      if (x !== this.px || y !== this.py || z !== this.pz) { voiceSetPosition(this.id, x, y, z); this.px = x; this.py = y; this.pz = z; }
    }
  }
  stop(): void { if (this.id !== 0) voiceStop(this.id); this.id = 0; }
}

export class AudioBufferSourceNode extends AudioScheduledSourceNode {
  buffer: AudioBuffer | null;
  readonly playbackRate: AudioParam;
  readonly detune: AudioParam;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  private voice = new Voice();
  private played = 0;
  private offset = 0;
  private duration = Infinity;

  constructor(ctx: BaseAudioContext, o: { buffer?: AudioBuffer | null; playbackRate?: number; detune?: number; loop?: boolean; loopStart?: number; loopEnd?: number } = {}) {
    super(ctx);
    this.buffer = o.buffer ?? null;
    this.playbackRate = new AudioParam(ctx, o.playbackRate ?? 1);
    this.detune = new AudioParam(ctx, o.detune ?? 0);
    this.loop = o.loop ?? false;
    this.loopStart = o.loopStart ?? 0;
    this.loopEnd = o.loopEnd ?? 0;
  }
  override start(when = 0, offset = 0, duration?: number): void {
    super.start(when);
    this.offset = Math.max(0, offset);
    if (duration !== undefined) this.duration = Math.max(0, duration);
    if (this.offset > 0) warnOnce("start() with an offset plays from the beginning (Bloom voices can't start mid-sound)");
    if (this.loopStart !== 0 || this.loopEnd !== 0) warnOnce("loopStart/loopEnd are ignored: the whole buffer loops");
  }
  private rate(t: number): number {
    const r = this.playbackRate._valueAt(t) * Math.pow(2, this.detune._valueAt(t) / 1200);
    return Math.max(0.25, Math.min(4, r));
  }
  /** @internal */ _tick(now: number, dt: number): void {
    const ctx = this.context as BaseAudioContext;
    if (this._state === "scheduled") {
      if (now < this._startAt) return;
      const sound = this.buffer?._sound() ?? null;
      if (sound === null || this.buffer === null) { ctx._failed++; this._ended(); return; }
      this.voice.start(sound, this.loop, route(this, now), this.rate(now), now);
      if (this.voice.id === 0) { ctx._failed++; this._ended(); return; }
      ctx._started++;
      this._state = "playing";
      return;
    }
    if (this._state !== "playing") return;
    const rate = this.rate(now);
    this.voice.update(route(this, now), rate, now, ctx.state !== "running");
    if (ctx.state === "running") this.played += dt * rate;
    const length = this.buffer?.duration ?? 0;
    if (now >= this._stopAt || this.played >= this.duration || (!this.loop && this.played >= length)) {
      this.voice.stop();
      this._ended();
    }
  }
}

/** Oscillators play a looping one-second wave at a base pitch; frequency and detune ride the voice's rate. */
const waveCache = new Map<string, AudioBuffer>();
export class OscillatorNode extends AudioScheduledSourceNode {
  type: "sine" | "square" | "sawtooth" | "triangle" | "custom";
  readonly frequency: AudioParam;
  readonly detune: AudioParam;
  private voice = new Voice();
  private base = 440;
  private custom: number[] | null = null;
  constructor(ctx: BaseAudioContext, o: { type?: "sine" | "square" | "sawtooth" | "triangle"; frequency?: number; detune?: number; periodicWave?: PeriodicWave } = {}) {
    super(ctx);
    this.type = o.type ?? "sine";
    this.frequency = new AudioParam(ctx, o.frequency ?? 440, -24000, 24000);
    this.detune = new AudioParam(ctx, o.detune ?? 0);
    if (o.periodicWave !== undefined) this.setPeriodicWave(o.periodicWave);
  }
  setPeriodicWave(wave: PeriodicWave): void { this.type = "custom"; this.custom = wave._harmonics; }
  private freq(t: number): number { return Math.abs(this.frequency._valueAt(t) * Math.pow(2, this.detune._valueAt(t) / 1200)); }
  /** One second of the wave at a base frequency within two octaves of f (a whole number of cycles: a seamless loop). */
  private wave(f: number): AudioBuffer {
    let base = 440;
    while (f / base > 2 && base < 12000) base *= 2;
    while (f / base < 0.5 && base > 20) base /= 2;
    this.base = base;
    const key = this.type + ":" + String(base) + ":" + (this.custom ?? []).join(",");
    let b = waveCache.get(key);
    if (b === undefined) {
      const rate = 44100;
      b = new AudioBuffer({ length: rate, sampleRate: rate, numberOfChannels: 1 });
      const d = b.getChannelData(0);
      for (let i = 0; i < rate; i++) {
        const ph = (i * base / rate) % 1;
        let v: number;
        switch (this.type) {
          case "square": v = ph < 0.5 ? 1 : -1; break;
          case "sawtooth": v = 2 * ph - 1; break;
          case "triangle": v = ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph; break;
          case "custom": { v = 0; const h = this.custom ?? [1]; for (let k = 0; k < h.length; k++) v += (h[k] ?? 0) * Math.sin(2 * Math.PI * (k + 1) * ph); break; }
          default: v = Math.sin(2 * Math.PI * ph);
        }
        d[i] = v * 0.5;
      }
      waveCache.set(key, b);
    }
    return b;
  }
  /** @internal */ _tick(now: number, _dt: number): void {
    const ctx = this.context as BaseAudioContext;
    if (this._state === "scheduled") {
      if (now < this._startAt) return;
      const sound = this.wave(this.freq(now))._sound();
      if (sound === null) { this._ended(); return; }
      this.voice.start(sound, true, route(this, now), Math.max(0.25, Math.min(4, this.freq(now) / this.base)), now);
      this._state = "playing";
      return;
    }
    if (this._state !== "playing") return;
    this.voice.update(route(this, now), Math.max(0.25, Math.min(4, this.freq(now) / this.base)), now, ctx.state !== "running");
    if (now >= this._stopAt) { this.voice.stop(); this._ended(); }
  }
}

export class ConstantSourceNode extends AudioScheduledSourceNode {
  readonly offset: AudioParam;
  constructor(ctx: BaseAudioContext, o: { offset?: number } = {}) { super(ctx); this.offset = new AudioParam(ctx, o.offset ?? 1); }
  /** @internal */ _tick(now: number): void { if (now >= this._stopAt) this._ended(); }
}

export class PeriodicWave {
  /** @internal sine amplitudes of the harmonics */ readonly _harmonics: number[];
  constructor(_ctx: BaseAudioContext, o: { real?: ArrayLike<number>; imag?: ArrayLike<number>; disableNormalization?: boolean } = {}) {
    const imag = Array.from(o.imag ?? [0, 1]), real = Array.from(o.real ?? []);
    const h: number[] = [];
    for (let k = 1; k < Math.max(imag.length, real.length); k++) h.push(Math.hypot(imag[k] ?? 0, real[k] ?? 0));
    const max = h.reduce((a, b) => a + Math.abs(b), 0);
    this._harmonics = o.disableNormalization === true || max === 0 ? h : h.map((v) => v / max);
  }
}

// ---------------------------------------------------------------- listener

export class AudioListener {
  readonly positionX: AudioParam; readonly positionY: AudioParam; readonly positionZ: AudioParam;
  readonly forwardX: AudioParam; readonly forwardY: AudioParam; readonly forwardZ: AudioParam;
  readonly upX: AudioParam; readonly upY: AudioParam; readonly upZ: AudioParam;
  private last = "";
  constructor(ctx: BaseAudioContext) {
    this.positionX = new AudioParam(ctx, 0); this.positionY = new AudioParam(ctx, 0); this.positionZ = new AudioParam(ctx, 0);
    this.forwardX = new AudioParam(ctx, 0); this.forwardY = new AudioParam(ctx, 0); this.forwardZ = new AudioParam(ctx, -1);
    this.upX = new AudioParam(ctx, 0); this.upY = new AudioParam(ctx, 1); this.upZ = new AudioParam(ctx, 0);
  }
  setPosition(x: number, y: number, z: number): void { this.positionX.value = x; this.positionY.value = y; this.positionZ.value = z; }
  setOrientation(x: number, y: number, z: number, ux: number, uy: number, uz: number): void {
    this.forwardX.value = x; this.forwardY.value = y; this.forwardZ.value = z; this.upX.value = ux; this.upY.value = uy; this.upZ.value = uz;
  }
  /** @internal */ _sync(t: number): void {
    const v = [this.positionX, this.positionY, this.positionZ, this.forwardX, this.forwardY, this.forwardZ].map((p) => p._valueAt(t));
    const key = v.join(",");
    if (key === this.last) return;
    this.last = key;
    setListenerPosition(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0, v[4] ?? 0, v[5] ?? -1);
  }
}

// ---------------------------------------------------------------- contexts

const contexts = new Set<BaseAudioContext>();

export class BaseAudioContext extends EventTarget {
  readonly sampleRate: number;
  readonly destination: AudioDestinationNode;
  readonly listener: AudioListener;
  readonly audioWorklet = { addModule: (): Promise<void> => Promise.reject(new Error("NotSupportedError: AudioWorklet isn't supported on Bloom")) };
  state: "suspended" | "running" | "closed" = "running";
  onstatechange: ((e: Event) => void) | null = null;
  /** @internal */ _playing = new Set<Playing>();
  /** @internal seconds of running time */ _clock = 0;
  /** @internal sources started and those that couldn't play, for diagnostics */ _started = 0;
  /** @internal */ _failed = 0;

  constructor(sampleRate = 48000) {
    super();
    this.sampleRate = sampleRate;
    this.destination = new AudioDestinationNode(this);
    this.listener = new AudioListener(this);
    contexts.add(this);
  }
  get currentTime(): number { return this._clock; }

  createGain(): GainNode { return new GainNode(this); }
  createStereoPanner(): StereoPannerNode { return new StereoPannerNode(this); }
  createPanner(): PannerNode { return new PannerNode(this); }
  createBiquadFilter(): BiquadFilterNode { return new BiquadFilterNode(this); }
  createDynamicsCompressor(): DynamicsCompressorNode { return new DynamicsCompressorNode(this); }
  createDelay(maxDelayTime = 1): DelayNode { return new DelayNode(this, { maxDelayTime }); }
  createConvolver(): ConvolverNode { return new ConvolverNode(this); }
  createWaveShaper(): WaveShaperNode { return new WaveShaperNode(this); }
  createAnalyser(): AnalyserNode { return new AnalyserNode(this); }
  createChannelSplitter(n = 6): ChannelSplitterNode { return new ChannelSplitterNode(this, { numberOfOutputs: n }); }
  createChannelMerger(n = 6): ChannelMergerNode { return new ChannelMergerNode(this, { numberOfInputs: n }); }
  createIIRFilter(): IIRFilterNode { return new IIRFilterNode(this); }
  createScriptProcessor(bufferSize = 4096): ScriptProcessorNode { return new ScriptProcessorNode(this, bufferSize); }
  createBufferSource(): AudioBufferSourceNode { return new AudioBufferSourceNode(this); }
  createOscillator(): OscillatorNode { return new OscillatorNode(this); }
  createConstantSource(): ConstantSourceNode { return new ConstantSourceNode(this); }
  createPeriodicWave(real: ArrayLike<number>, imag: ArrayLike<number>, o: { disableNormalization?: boolean } = {}): PeriodicWave { return new PeriodicWave(this, { real, imag, ...o }); }
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer { return new AudioBuffer({ numberOfChannels, length, sampleRate }); }

  decodeAudioData(data: ArrayBuffer, success?: (b: AudioBuffer) => void, failure?: (e: Error) => void): Promise<AudioBuffer> {
    const result = new Promise<AudioBuffer>((resolve, reject) => {
      setTimeout(() => {
        try {
          const bytes = new Uint8Array(data);
          let file = sourceFile(data) ?? null;
          if (file === null || !existsSync(file)) file = tempAudioFile(bytes, extensionFor(bytes));
          const info = probeAudio(bytes.length > 0 ? bytes : readFileSync(file));
          const buffer = new AudioBuffer({ length: Math.round(info.duration * info.sampleRate), sampleRate: info.sampleRate, numberOfChannels: info.channels }, file);
          // decode now (as the browser does), so the first play doesn't wait
          if (buffer._sound() === null) throw new Error("EncodingError: unable to decode audio data");
          resolve(buffer);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }, 0);
    });
    result.then((b) => success?.(b), (e: Error) => failure?.(e));
    return result;
  }

  /** @internal */ _setState(s: "suspended" | "running" | "closed"): void {
    if (this.state === s) return;
    this.state = s;
    this.dispatchEvent(new Event("statechange"));
  }
  /** @internal advance the clock and update what plays */
  _tick(dt: number): void {
    if (this.state === "running") this._clock += dt;
    const now = this._clock;
    this.listener._sync(now);
    for (const p of [...this._playing]) p._tick(now, this.state === "running" ? dt : 0);
  }
}

export class AudioContext extends BaseAudioContext {
  readonly baseLatency = 0.01;
  readonly outputLatency = 0.02;
  readonly latencyHint: string;
  sinkId = "";
  constructor(options: { latencyHint?: string | number; sampleRate?: number; sinkId?: string } = {}) {
    super(options.sampleRate ?? 48000);
    this.latencyHint = String(options.latencyHint ?? "interactive");
    device();
  }
  resume(): Promise<void> { if (this.state === "closed") return Promise.reject(new Error("InvalidStateError: closed")); this._setState("running"); return Promise.resolve(); }
  suspend(): Promise<void> { if (this.state === "closed") return Promise.reject(new Error("InvalidStateError: closed")); this._setState("suspended"); return Promise.resolve(); }
  close(): Promise<void> {
    for (const p of [...this._playing]) if (p instanceof AudioScheduledSourceNode) { try { p.stop(); } catch { /* not started */ } p._tick(this._clock, 0); }
    this._setState("closed");
    contexts.delete(this);
    return Promise.resolve();
  }
  getOutputTimestamp(): { contextTime: number; performanceTime: number } { return { contextTime: this.currentTime, performanceTime: Date.now() }; }
  setSinkId(id: string): Promise<void> { this.sinkId = id; return Promise.resolve(); }
  createMediaElementSource(element: { _attachSource(node: AudioNode): void }): MediaElementAudioSourceNode { return new MediaElementAudioSourceNode(this, { mediaElement: element }); }
  createMediaStreamSource(): never { throw new Error("NotSupportedError: media streams aren't supported on Bloom"); }
  createMediaStreamDestination(): MediaStreamAudioDestinationNode { return new MediaStreamAudioDestinationNode(this); }
}

/** An <audio> or <video> element's sound in the graph: the element asks it for its route. */
export class MediaElementAudioSourceNode extends AudioNode {
  readonly mediaElement: unknown;
  constructor(ctx: BaseAudioContext, o: { mediaElement: { _attachSource(node: AudioNode): void } }) {
    super(ctx, 0, 1);
    this.mediaElement = o.mediaElement;
    o.mediaElement._attachSource(this);
  }
}

/** Renders nothing: there is no offline mixing; startRendering gives silence of the right length. */
export class OfflineAudioContext extends BaseAudioContext {
  readonly length: number;
  oncomplete: ((e: Event) => void) | null = null;
  constructor(channels: number | { numberOfChannels?: number; length: number; sampleRate: number }, length?: number, sampleRate?: number) {
    const o = typeof channels === "number" ? { numberOfChannels: channels, length: length ?? 0, sampleRate: sampleRate ?? 44100 } : channels;
    super(o.sampleRate);
    this.length = o.length;
    this.state = "suspended";
    this.channels = o.numberOfChannels ?? 1;
    contexts.delete(this);
  }
  private readonly channels: number;
  startRendering(): Promise<AudioBuffer> {
    warnOnce("OfflineAudioContext renders silence");
    const b = new AudioBuffer({ length: this.length, sampleRate: this.sampleRate, numberOfChannels: this.channels });
    setTimeout(() => this.dispatchEvent(Object.assign(new Event("complete"), { renderedBuffer: b })), 0);
    return Promise.resolve(b);
  }
  resume(): Promise<void> { return Promise.resolve(); }
  suspend(): Promise<void> { return Promise.resolve(); }
}

// ---------------------------------------------------------------- the frame

const others: Playing[] = [];
/** Something outside a context that updates once a frame (media elements). */
export function onAudioFrame(p: Playing): void { others.push(p); }

let lastTick = Date.now();
onBeforeFrame(() => {
  const now = Date.now();
  const dt = Math.min(0.25, (now - lastTick) / 1000);
  lastTick = now;
  for (const c of contexts) c._tick(dt);
  for (const p of others) p._tick(now / 1000, dt);
});

export function resetWarnings(): void { warned = new Set(); }

/** For diagnostics: each live context's state, clock and sources playing now. */
export function contextReport(): string[] {
  return [...contexts].map((c) => `AudioContext ${c.state} t=${c.currentTime.toFixed(2)}s, ${c._playing.size} sources playing, ${c._started} started, ${c._failed} failed`);
}
