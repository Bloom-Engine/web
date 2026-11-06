# @bloomengine/web

A browser for web games, natively on [Bloom](https://github.com/Bloom-Engine/engine), compiled by
[Perry](https://github.com/PerryTS/perry). A game written for the browser runs as a native app
(macOS, iOS, tvOS, and the other platforms Bloom supports): no WebView, no JavaScript engine, and
no changes to the game.

```ts
// bloom/main.ts: the native entry of a web game
import { configure } from "@bloomengine/web/config";
configure({ app: "mygame", title: "My Game", root: new URL("../", import.meta.url).pathname });
import "@bloomengine/web";        // installs window, document, ... and opens the window
import "../src/main.ts";           // the game, unchanged
```

For three.js games, [@bloomengine/three](https://github.com/Bloom-Engine/three) adds the renderer.

## What it provides

| Area | |
|---|---|
| DOM | `Node`, `Element`, `Text`, `Comment`, `DocumentFragment`, `Document`; the page's own `index.html` parsed into it (HTML parser with implied end tags, entities, raw text, `<template>`, SVG namespace) and `innerHTML`/`outerHTML` serialization; attributes reflected as in the browser (`id`, `className`, `classList`, `dataset`, `style`, `hidden`, ...); `MutationObserver`, `ResizeObserver`, `IntersectionObserver` |
| Selectors | `querySelector(All)`, `matches`, `closest`: type, `#id`, `.class`, attribute operators with `i`/`s`, the `>`, `+`, `~` and descendant combinators, lists, and `:not()`, `:is()`, `:where()`, `:has()`, `:nth-child(An+B of S)`, `:nth-of-type()`, `:first/last/only-child`, `:empty`, `:root`, `:scope`, `:hover`, `:active`, `:focus`, `:focus-visible`, `:focus-within`, `:checked`, `:disabled`, ... |
| Events | `EventTarget` with capture and bubble phases, `once`, `passive`, `signal`, handler properties; `Event`, `CustomEvent`, `MouseEvent`, `PointerEvent`, `WheelEvent`, `KeyboardEvent`, `FocusEvent`, `InputEvent`, `TouchEvent`, ... |
| Input | Bloom's mouse, keyboard, touch and Siri Remote as DOM events at the element under the pointer (or the focused one): pointer events with mouse events after them, click/dblclick/contextmenu on the common ancestor, over/out/enter/leave, pointer capture, wheel, keydown (repeating) and keyup with the browser's `key`, `code` and `keyCode`, text typed into fields, one pointer per finger plus touch events |
| Default actions | Tab focus order (`tabindex`), Enter and Space on buttons, labels, checkboxes and radios, form submit and reset, `<details>`, `<dialog>`, focus on click, Escape closes a dialog; Apple TV spatial focus |
| Forms | `input` (text, number, range, checkbox, radio, ...), `button`, `select`/`option`/`optgroup`, `textarea`, `label`, `form`, `fieldset` with values, defaults, `checked`, `selectedIndex`, validity |
| Window | `location` (a file:// URL into the served folder), `history`, `navigator`, `screen`, live `innerWidth`/`innerHeight`/`devicePixelRatio`, `matchMedia` (sizes, orientation, pointer, hover, color scheme) with change events, `getComputedStyle`, `requestAnimationFrame`, `requestIdleCallback`, `resize`, `DOMContentLoaded` and `load` |
| Files | `fetch` for the page's files (relative, root-relative and file:// URLs; other URLs go to Perry's fetch), `Blob` URLs (`URL.createObjectURL`), `<img>`/`new Image()` (the file goes to Bloom's texture loader; the size comes from its header) |
| Storage | `localStorage` saved to a file, so it survives a restart |
| Canvas | a 2D context that keeps RGBA bytes (paths, curves, arcs, fills, strokes, clips, gradients, transforms, image data, text) for textures a game paints |
| Sound | Web Audio over Bloom's mixer (below), and `<audio>`/`<video>` elements and `new Audio()` as streamed Bloom music |
| Workers | Perry's own `Worker` runs a worker module on its own thread; without it, a worker module imported into the page talks to `Worker` objects on the main thread |

### Sound

The Web Audio node graph lives in TypeScript; Bloom plays the samples. Every frame, each playing
source (an `AudioBufferSourceNode`, an `OscillatorNode`, a media element) gets its settings from
its paths through the graph:

- **gain**: the `GainNode`s on a path, with full `AudioParam` automation (`setValueAtTime`, linear
  and exponential ramps, `setTargetAtTime`, `setValueCurveAtTime`, cancel and hold), summed over paths
- **pan**: a `StereoPannerNode`; **position**: a `PannerNode` (and the context's `AudioListener`)
  makes it a 3D voice, with Bloom's distance attenuation and doppler
- **low-pass**: a lowpass `BiquadFilterNode`'s frequency
- **rate**: `playbackRate` and `detune`; an oscillator's `frequency` and `detune`

Bloom ramps gain changes inside the mixer, so per-frame updates don't zipper. `decodeAudioData`
hands Bloom the file the bytes came from. Analyser, compressor, delay, convolver and wave shaper
nodes pass sound through unchanged (an analyser reports silence). Not supported: `AudioWorklet`,
`ScriptProcessorNode` callbacks, modulating an `AudioParam` from a node, starting a buffer at an
offset (it starts from the beginning), `loopStart`/`loopEnd`, and offline rendering.

## The page

There is no CSS layout engine (yet). Whatever draws the page over the 3D view sets each element's
layout box where it drew it (`setLayoutBox(element, { x, y, w, h })`, CSS pixels); hit testing,
`getBoundingClientRect`, `clientWidth` and the observers use it. The view canvas fills the window
under the page.

## Configuration

`configure()` before importing the runtime (see `src/config.ts`):

| Option | |
|---|---|
| `app` | the folder the saved `localStorage` goes in |
| `title`, `width`, `height` | the window (phones and TVs fill the screen) |
| `root` | the folder with `index.html` in a development build |
| `bundle` | the folder under `assets/` an app bundle carries the files in (default `web`) |
| `served` | the folder of `root` the web server serves as the site root, such as Vite's `public/` |
| `canvas` | the view canvas's selector (default: the first `<canvas>`) |
| `storageName`, `storageFile` | where `localStorage` is saved (`$BLOOM_STORAGE` wins) |
| `tv` | Apple TV hooks: the overlay whose buttons get the focus, whether Menu exits, and what to do with directions nobody used |
| `scriptCommands` | extra `BLOOM_SCRIPT` commands |

## Scripted runs

`BLOOM_SCRIPT="<frame> <command> [arg]; ..."`: `shot <path>`, `click <selector>`,
`clickat <x> <y>`, `key <key>`, `type <text>`, `focus <selector>`, `log`, `fps`, `profile`,
`quit`, and the game's own. `BLOOM_QUERY=theme=dino` sets `location.search`.

## Tests

```bash
npm test             # the DOM suite under Node
npm run test:perry   # the same suite compiled by Perry
```
