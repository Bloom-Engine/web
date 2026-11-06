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

The page's HTML and CSS are drawn over the 3D view by a small browser engine (`src/css/`), with
Bloom 2D, every frame after the game's:

| Stage | |
|---|---|
| Cascade | the user agent stylesheet, `<style>` and `<link rel=stylesheet>`, `style` attributes; `@media` (re-evaluated on resize), `!important` and origins, specificity and order, custom properties and `var()`, shorthands, inheritance, `inherit`/`initial`/`unset`; rules indexed by their rightmost id, class or tag |
| Values | lengths (`px`, `em`, `rem`, `%`, `vw`/`vh`/`vmin`/`vmax`, ...), `calc()`, `min()`, `max()`, `clamp()`, `env(safe-area-inset-*)`, named, hex, `rgb()` and `hsl()` colors |
| Layout | block flow (auto margins, collapsing sibling margins, `box-sizing`, min/max sizes, percentage heights), inline text broken into lines (`white-space`, `overflow-wrap`, `text-align`, `line-height`, `letter-spacing`, `text-transform`, `text-indent`), inline-blocks and replaced elements on the line, flexbox (direction, wrap, gap, grow/shrink/basis, auto margins, justify and align), grid (`px`, `%`, `fr`, `auto`, `minmax()`, `repeat()` with `auto-fill`/`auto-fit`, spans, gaps, alignment), `position` relative, absolute and fixed, `z-index`, list markers |
| Paint | backgrounds (colors, linear and radial gradients, images; the root's and body's cover the canvas), borders (per side, rounded, dashed, dotted), `border-radius`, `box-shadow`, `outline`, text with `text-shadow`, `text-decoration`, `text-overflow: ellipsis`, `opacity`, `transform` (translate and scale), `overflow` clipping (rounded) and scrolling with the wheel, `<img>`, form controls' values |
| Motion | transitions and `@keyframes` animations (timing functions, delays, iterations, direction, fill mode), `transitionend` and `animationend` |
| Fonts | `font-family` resolved to font files (`@font-face` with local `url()`s, `configure({ fonts })`, the system's fonts for the generic families), the face nearest the weight and style, faux bold, the font's own metrics for the baseline and `line-height: normal`, per-character fallback fonts for symbols |

Every element gets its layout box where it was drawn (after transforms), so hit testing, `:hover`,
`getBoundingClientRect` and the observers see the page as drawn; `pointer-events: none` passes
clicks through; `getComputedStyle` returns the computed styles. A full-window `<canvas>` (the 3D
view) lies under the page: what paints before it in paint order is hidden by it, as in the browser.

Not drawn: `backdrop-filter` and `filter`, blur (shadows are layered approximations), rotation and
skew, `::before`/`::after`, floats, tables (laid out as blocks), color emoji, `<video>` frames.

`tests/compare.sh` renders the pages in `tests/pages/` with Bloom and with headless Chrome and
compares them (`.build/compare/`).

A game that draws its own page sets `configure({ page: "none" })` and calls `setLayoutBox(element,
{ x, y, w, h })` for what it draws.

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
| `page` | `"css"` (default: the built-in engine draws the page) or `"none"` (the game draws it) |
| `fonts` | font files for `font-family` names |
| `scriptCommands` | extra `BLOOM_SCRIPT` commands |

## Scripted runs

`BLOOM_SCRIPT="<frame> <command> [arg]; ..."`: `shot <path>`, `click <selector>`,
`clickat <x> <y>`, `key <key>`, `type <text>`, `focus <selector>`, `log`, `audio`, `fps`, `profile`,
`quit`, and the game's own. `BLOOM_QUERY=theme=dino` sets `location.search`; `BLOOM_CSS_PROFILE=1` prints what each page
rebuild costs.

## Tests

```bash
npm test             # the DOM suite under Node
npm run test:perry   # the same suite compiled by Perry
sh tests/compare.sh  # test pages: Bloom against headless Chrome
```
