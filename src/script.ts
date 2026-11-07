/**
 * Scripted runs for tests and screenshots: BLOOM_SCRIPT="<frame> <command> [arg]; ..." runs each
 * command when that frame is drawn. Commands:
 *   shot <path>          a screenshot (Bloom's), ~ for $HOME
 *   click <selector>     a click on the first shown element matching it, at its center (as the mouse would)
 *   clickat <x> <y>      a click at a point in CSS pixels
 *   touch <x> <y>        a finger down at (or moved to) a point; untouch lifts it
 *   key <key>            a key press and release (a KeyboardEvent.key: Escape, Enter, a, Space)
 *   type <text>          text typed into the focused field
 *   focus <selector>     move the focus to an element
 *   log                  the focused element, open dialogs, and the page's title
 *   fps                  frame timings per phase since the last fps, and the worst frame
 *   audio                what plays: Web Audio contexts and <audio> elements
 *   profile              Bloom's profiler table (with BLOOM_PROFILE=1)
 *   quit                 close the app
 * and the game's own (config scriptCommands).
 */
import { mkdirSync } from "node:fs";
import { takeScreenshot } from "@bloomengine/engine";
import { printProfilerSummary } from "@bloomengine/engine/core";
import { config } from "./config.ts";
import { document } from "./browser.ts";
import { clickAt, pressKey, scriptTouch } from "./input.ts";
import { KeyboardEvent, InputEvent, HTMLInputElement, HTMLTextAreaElement, type Element } from "./dom/index.ts";
import { frameCount, onAfterFrame, quit, timing } from "./frame.ts";
import { contextReport, mediaElements } from "./audio/index.ts";
import { expandHome } from "./storage.ts";

/** Milliseconds per frame of named parts a renderer measures (printed by `fps`), summed since the last read. */
export const extraTimings: Record<string, number> = {};

const bootTime = Date.now();

function shown(e: Element): boolean { for (let p: Element | null = e; p !== null; p = p.parentElement) if (p.hidden) return false; return e._box !== null; }

const steps = (process.env["BLOOM_SCRIPT"] ?? "").split(";").map((s) => s.trim()).filter((s) => s !== "").map((s) => {
  const [frame, command, ...rest] = s.split(/\s+/);
  return { frame: Number(frame), command: command ?? "", arg: rest.join(" ") };
});

function run(command: string, arg: string): void {
  switch (command) {
    case "shot": {
      const path = expandHome(arg);
      mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      takeScreenshot(path);
      return;
    }
    case "click": {
      const target = document.querySelectorAll(arg).find(shown);
      console.log("click", arg, target === undefined ? "NOT FOUND" : "ok");
      if (target !== undefined && target._box !== null) clickAt(target._box.x + target._box.w / 2, target._box.y + target._box.h / 2);
      return;
    }
    case "clickat": { const [x, y] = arg.split(/\s+/).map(Number); clickAt(x ?? 0, y ?? 0); return; }
    case "touch": { const [x, y] = arg.split(/\s+/).map(Number); scriptTouch({ x: x ?? 0, y: y ?? 0 }); return; }
    case "untouch": scriptTouch(null); return;
    case "key": {
      const key = arg === "Space" ? " " : arg;
      pressKey(key);
      (document.activeElement ?? document.body)?.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key }));
      return;
    }
    case "type": {
      const f = document._focused;
      if (f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement) {
        f.value = f.value + arg;
        f.dispatchEvent(new InputEvent("input", { bubbles: true, data: arg, inputType: "insertText" }));
      }
      return;
    }
    case "focus": document.querySelector(arg)?.focus({ focusVisible: true }); return;
    case "log": {
      const f = document._focused;
      console.log("page", JSON.stringify({
        title: document.title, focus: f === null ? null : f.localName + (f.id !== "" ? "#" + f.id : "") + " " + (f.textContent ?? "").trim().slice(0, 40),
        dialogs: document.querySelectorAll("dialog[open]").map((d) => d.id),
      }));
      return;
    }
    case "fps": {
      const n = Math.max(1, timing.frames), per = (v: number): string => (v / n).toFixed(1);
      const extra = Object.keys(extraTimings).map((k) => k + " " + per(extraTimings[k] ?? 0)).join(", ");
      console.log("frames", frameCount(), "at", Date.now() - bootTime, "ms; per frame: input", per(timing.input), "app", per(timing.app),
        extra === "" ? "" : "(" + extra + ")", "page", per(timing.hud), "present", per(timing.present), "idle", per(timing.idle), "worst", timing.worst);
      for (const k of Object.keys(timing) as (keyof typeof timing)[]) timing[k] = 0;
      for (const k of Object.keys(extraTimings)) extraTimings[k] = 0;
      return;
    }
    case "audio": for (const line of [...contextReport(), ...mediaElements().map((m) => m._report())]) console.log("audio", line); return;
    case "profile": printProfilerSummary(); return;
    case "quit": quit();
  }
  const own = config().scriptCommands[command];
  if (own !== undefined) own(arg);
  else console.error("BLOOM_SCRIPT: unknown command " + command);
}

if (steps.length > 0) onAfterFrame(() => {
  const n = frameCount();
  for (const step of steps) if (step.frame === n) run(step.command, step.arg);
});
