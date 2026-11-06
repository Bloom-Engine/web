/**
 * Sound for web games on Bloom: Web Audio (context.ts) and <audio>/<video>
 * elements (media.ts) over Bloom's mixer, installed as the page's globals.
 */
import * as wa from "./context.ts";
import { HTMLAudioElement, HTMLMediaElement, HTMLVideoElement, makeAudioClass } from "./media.ts";
import { document } from "../browser.ts";

const g = globalThis as Record<string, unknown>;
const classes: Record<string, unknown> = {
  AudioContext: wa.AudioContext, webkitAudioContext: wa.AudioContext, OfflineAudioContext: wa.OfflineAudioContext,
  webkitOfflineAudioContext: wa.OfflineAudioContext, BaseAudioContext: wa.BaseAudioContext,
  AudioNode: wa.AudioNode, AudioParam: wa.AudioParam, AudioBuffer: wa.AudioBuffer, AudioListener: wa.AudioListener,
  AudioDestinationNode: wa.AudioDestinationNode, AudioScheduledSourceNode: wa.AudioScheduledSourceNode,
  AudioBufferSourceNode: wa.AudioBufferSourceNode, OscillatorNode: wa.OscillatorNode, ConstantSourceNode: wa.ConstantSourceNode,
  GainNode: wa.GainNode, StereoPannerNode: wa.StereoPannerNode, PannerNode: wa.PannerNode, BiquadFilterNode: wa.BiquadFilterNode,
  DynamicsCompressorNode: wa.DynamicsCompressorNode, DelayNode: wa.DelayNode, ConvolverNode: wa.ConvolverNode,
  WaveShaperNode: wa.WaveShaperNode, AnalyserNode: wa.AnalyserNode, ChannelSplitterNode: wa.ChannelSplitterNode,
  ChannelMergerNode: wa.ChannelMergerNode, IIRFilterNode: wa.IIRFilterNode, PeriodicWave: wa.PeriodicWave,
  ScriptProcessorNode: wa.ScriptProcessorNode, MediaElementAudioSourceNode: wa.MediaElementAudioSourceNode,
  MediaStreamAudioDestinationNode: wa.MediaStreamAudioDestinationNode,
  HTMLMediaElement, HTMLAudioElement, HTMLVideoElement,
  Audio: makeAudioClass(() => document),
};
for (const [k, v] of Object.entries(classes)) g[k] = v;

export * from "./context.ts";
export { HTMLMediaElement, HTMLAudioElement, HTMLVideoElement, mediaElements } from "./media.ts";
export { probeAudio } from "./probe.ts";
