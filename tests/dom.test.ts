/**
 * DOM tests: run with `node --experimental-transform-types tests/dom.test.ts`, and compiled by
 * Perry (`npm run test:perry`), where the same file must pass.
 */
import {
  Document, DOMParser, Event, CustomEvent, MouseEvent, KeyboardEvent, MutationObserver, HTMLInputElement, HTMLSelectElement,
  HTMLOptionElement, HTMLCanvasElement, setCanvasContext, setLayoutBox, parseDocument, Text, AbortController, EventTarget, type Element,
} from "../src/dom/index.ts";
import { eq, ok, report, test, throws } from "./harness.ts";

function page(markup: string): Document {
  const doc = new Document();
  parseDocument(doc, markup);
  return doc;
}

// ---------------------------------------------------------------- parsing

test("a page gets html, head and body", () => {
  const d = page("<!doctype html><title>T &amp; U</title><p>Hi</p>");
  eq(d.documentElement?.localName, "html");
  eq(d.head?.firstElementChild?.localName, "title");
  eq(d.title, "T & U");
  eq(d.body?.innerHTML, "<p>Hi</p>");
  eq(d.doctype?.name, "html");
});

test("explicit structure, attributes in every quoting form", () => {
  const d = page(`<html lang=en><head><meta charset="utf-8"><style>p > a { color: red }</style></head>
    <body class='main'><div id=a data-x-y="1" hidden disabled=''>x</div></body></html>`);
  eq(d.documentElement?.getAttribute("lang"), "en");
  eq(d.querySelector("style")?.textContent, "p > a { color: red }");
  eq(d.body?.className, "main");
  const a = d.getElementById("a") as Element;
  eq(a.dataset["xY"], "1");
  ok(a.hidden, "hidden");
  eq(a.getAttribute("disabled"), "");
});

test("implied end tags: p, li, option, td", () => {
  const d = page("<p>one<p>two<div>three</div><ul><li>a<li>b<ul><li>c</ul></ul><select><option>x<option>y</select><table><tr><td>1<td>2</table>");
  const b = d.body as Element;
  eq(b.querySelectorAll("p").length, 2);
  eq(b.querySelectorAll("body > ul > li").length, 2);
  eq(b.querySelectorAll("li li").length, 1);
  eq(b.querySelectorAll("option").map((o) => o.textContent), ["x", "y"]);
  eq(b.querySelectorAll("td").length, 2);
  eq(b.querySelector("div")?.parentElement?.localName, "body");
});

test("character references, comments, raw text", () => {
  const d = page("<p>&lt;b&gt; &copy; &#169; &#xA9; &nbsp;&unknown; a&b</p><!-- c --><script>if (a < b && c) {}</script><textarea>&lt;x&gt;</textarea>");
  eq(d.querySelector("p")?.textContent, "<b> © © ©  &unknown; a&b");
  eq(d.querySelector("script")?.textContent, "if (a < b && c) {}");
  eq(d.querySelector("textarea")?.textContent, "<x>");
  ok(d.body?.childNodes.some((n) => n.nodeType === 8), "comment kept");
});

test("innerHTML round trip and escaping", () => {
  const d = page("<div></div>");
  const div = d.querySelector("div") as Element;
  div.innerHTML = `<span title="a &quot;q&quot; &amp;">x &lt; y</span><br><img src="a.png">`;
  eq(div.innerHTML, `<span title="a &quot;q&quot; &amp;">x &lt; y</span><br><img src="a.png">`);
  eq(div.children.length, 3);
  eq(div.outerHTML.startsWith("<div>"), true);
  div.insertAdjacentHTML("afterbegin", "<b>1</b>");
  eq(div.firstElementChild?.localName, "b");
});

test("template content and svg namespace", () => {
  const d = page("<template id=t><p>in</p></template><svg viewBox='0 0 1 1'><circle r=1 /></svg>");
  const t = d.getElementById("t") as Element & { content: { childNodes: unknown[] } };
  eq(t.children.length, 0);
  eq(t.content.childNodes.length, 1);
  eq(d.querySelector("circle")?.namespaceURI, "http://www.w3.org/2000/svg");
  eq(d.querySelector("svg")?.getAttribute("viewBox") ?? d.querySelector("svg")?.getAttribute("viewbox"), "0 0 1 1");
});

test("DOMParser", () => {
  const d = new DOMParser().parseFromString("<p class=x>hi</p>", "text/html");
  eq(d.querySelector(".x")?.textContent, "hi");
});

// ---------------------------------------------------------------- tree

test("append, insertBefore, fragments, remove, siblings", () => {
  const d = page("<ul id=l><li id=a>a</li><li id=c>c</li></ul>");
  const l = d.getElementById("l") as Element;
  const b = d.createElement("li"); b.id = "b"; b.textContent = "b";
  l.insertBefore(b, d.getElementById("c"));
  eq(l.children.map((c) => c.id), ["a", "b", "c"]);
  const f = d.createDocumentFragment();
  f.append("t", d.createElement("li"));
  l.appendChild(f);
  eq(f.childNodes.length, 0);
  eq(l.childNodes.length, 5);
  eq(d.getElementById("b")?.nextElementSibling?.id, "c");
  eq(d.getElementById("b")?.previousElementSibling?.id, "a");
  b.remove();
  eq(d.getElementById("b"), null);
  l.prepend(b);
  eq(l.firstElementChild?.id, "b");
  b.after("x");
  eq((b.nextSibling as Text).data, "x");
});

test("cycles and bad moves throw", () => {
  const d = page("<div id=a><div id=b></div></div>");
  const a = d.getElementById("a") as Element, b = d.getElementById("b") as Element;
  throws(() => b.appendChild(a), "ancestor into descendant");
  throws(() => a.removeChild(d.createElement("p")), "remove a non-child");
  throws(() => d.createElement("1bad"), "bad tag name");
});

test("textContent, cloneNode, isEqualNode, contains, compareDocumentPosition", () => {
  const d = page("<div id=a>x<b>y</b><!--z--></div><p id=p></p>");
  const a = d.getElementById("a") as Element;
  eq(a.textContent, "xy");
  const copy = a.cloneNode(true) as Element;
  ok(copy.isEqualNode(a), "equal clone");
  ok(copy !== a && copy.parentNode === null, "detached clone");
  ok(d.body?.contains(a), "contains");
  eq(a.compareDocumentPosition(d.getElementById("p") as Element) & 4, 4);
  a.textContent = "new";
  eq(a.childNodes.length, 1);
});

// ---------------------------------------------------------------- attributes and reflection

test("attributes reflect: id, class, classList, dataset, style, hidden", () => {
  const d = page("<div></div>");
  const e = d.querySelector("div") as Element;
  e.id = "x";
  eq(e.getAttribute("id"), "x");
  e.classList.add("a", "b");
  e.classList.toggle("a");
  e.classList.replace("b", "c");
  eq(e.className, "c");
  e.dataset["fooBar"] = "1";
  eq(e.getAttribute("data-foo-bar"), "1");
  eq(Object.keys(e.dataset), ["fooBar"]);
  delete e.dataset["fooBar"];
  eq(e.hasAttribute("data-foo-bar"), false);
  e.style.backgroundColor = "red";
  e.style.setProperty("--gap", "4px");
  eq(e.getAttribute("style"), "background-color: red; --gap: 4px;");
  e.setAttribute("style", "width: 10px !important; color: blue");
  eq(e.style.width, "10px");
  eq(e.style.getPropertyPriority("width"), "important");
  eq(e.style["color"], "blue");
  e.hidden = true;
  ok(e.hasAttribute("hidden"), "hidden attribute");
  eq(e.attributes.length, 4);
  eq(e.attributes.getNamedItem("id")?.value, "x");
});

// ---------------------------------------------------------------- selectors

test("selectors: combinators, attributes, lists", () => {
  const d = page(`<main><section class="s a"><p lang="en-US" data-k="Ab">1</p><p>2</p><span>3</span><p>4</p></section><aside><p>5</p></aside></main>`);
  const text = (sel: string): string => d.querySelectorAll(sel).map((e) => e.textContent).join(",");
  eq(text("section > p"), "1,2,4");
  eq(text("main p"), "1,2,4,5");
  eq(text("p + p"), "2");
  eq(text("span ~ p"), "4");
  eq(text("[data-k=ab i]"), "1");
  eq(text("[lang|=en]"), "1");
  eq(d.querySelectorAll("[class~=a]").length, 1);
  eq(text(".s.a > span, aside p"), "3,5");
  eq(text("[data-k^=A][data-k$=b][data-k*=b]"), "1");
  eq(text("main *:not(p):not(section):not(aside)"), "3");
});

test("structural pseudo-classes", () => {
  const d = page("<ul><li>1</li><li>2</li><li>3</li><li>4</li><li>5</li></ul><div><b></b><i>t</i><b></b></div>");
  const text = (sel: string): string => d.querySelectorAll(sel).map((e) => e.textContent).join(",");
  eq(text("li:first-child"), "1");
  eq(text("li:last-child"), "5");
  eq(text("li:nth-child(2n+1)"), "1,3,5");
  eq(text("li:nth-child(odd of :not(:first-child))"), "2,4");
  eq(text("li:nth-last-child(-n+2)"), "4,5");
  eq(text("li:nth-child(3)"), "3");
  eq(d.querySelectorAll("b:empty").length, 2);
  eq(d.querySelectorAll("b:first-of-type").length, 1);
  eq(d.querySelectorAll("i:only-of-type").length, 1);
  eq(d.querySelectorAll(":root").length, 1);
  eq(text("ul:has(> li:nth-child(5)) li:is(:first-child, :last-child)"), "1,5");
  eq(d.querySelectorAll("div:has(i)").length, 1);
});

test("matches, closest, :scope, specificity errors", () => {
  const d = page("<div class=o><div class=i><a href=#x>l</a></div></div>");
  const a = d.querySelector("a") as Element;
  ok(a.matches(".o a:any-link"), "matches");
  eq(a.closest(".o")?.className, "o");
  const inner = d.querySelector(".i") as Element;
  eq(inner.querySelectorAll(":scope > a").length, 1);
  eq(inner.querySelectorAll("div a").length, 1);   // the outer div counts, as in the browser
  throws(() => d.querySelector("a[") , "bad selector");
  throws(() => d.querySelector(":nope"), "unknown pseudo");
  eq(d.querySelectorAll("a::before").length, 0);
});

// ---------------------------------------------------------------- events

test("capture, target, bubble order; stopPropagation; once; handler props", () => {
  const d = page("<div id=o><button id=b>x</button></div>");
  const o = d.getElementById("o") as Element, b = d.getElementById("b") as Element;
  const log: string[] = [];
  o.addEventListener("click", () => log.push("o-capture"), true);
  o.addEventListener("click", () => log.push("o-bubble"));
  b.addEventListener("click", (e) => log.push("b:" + (e as Event).eventPhase));
  (b as unknown as { onclick: unknown }).onclick = (): void => { log.push("b-onclick"); };
  d.body?.addEventListener("click", () => log.push("body"), { once: true });
  b.click();
  eq(log, ["o-capture", "b-onclick", "b:2", "o-bubble", "body"]);
  log.length = 0;
  o.addEventListener("click", (e) => (e as Event).stopPropagation(), true);
  b.click();
  eq(log, ["o-capture"]);
});

test("preventDefault, passive, cancelable, dispatchEvent result, CustomEvent", () => {
  const d = page("<p></p>");
  const p = d.querySelector("p") as Element;
  p.addEventListener("x", (e) => (e as Event).preventDefault());
  eq(p.dispatchEvent(new Event("x", { cancelable: true })), false);
  eq(p.dispatchEvent(new Event("x")), true);
  p.addEventListener("y", (e) => (e as Event).preventDefault(), { passive: true });
  eq(p.dispatchEvent(new Event("y", { cancelable: true })), true);
  let detail: unknown = null;
  p.addEventListener("c", (e) => { detail = (e as CustomEvent).detail; });
  p.dispatchEvent(new CustomEvent("c", { detail: { n: 1 } }));
  eq(detail, { n: 1 });
});

test("events bubble to the window; AbortSignal removes listeners", () => {
  const d = page("<p></p>");
  const win = new EventTarget();
  d._window = win;
  const seen: string[] = [];
  win.addEventListener("ping", () => seen.push("window"));
  const c = new AbortController();
  d.querySelector("p")?.addEventListener("ping", () => seen.push("p"), { signal: c.signal });
  d.querySelector("p")?.dispatchEvent(new Event("ping", { bubbles: true }));
  c.abort();
  d.querySelector("p")?.dispatchEvent(new Event("ping", { bubbles: true }));
  eq(seen, ["p", "window", "window"]);
});

test("UI events carry their fields", () => {
  const m = new MouseEvent("click", { clientX: 5, clientY: 6, button: 2, shiftKey: true, offsetOriginX: 1 });
  eq([m.clientX, m.pageY, m.offsetX, m.button, m.shiftKey, m.getModifierState("Shift")], [5, 6, 4, 2, true, true]);
  const k = new KeyboardEvent("keydown", { key: "a", code: "KeyA" });
  eq([k.keyCode, k.which, k.location], [65, 65, 0]);
  eq(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftRight" }).location, 2);
});

// ---------------------------------------------------------------- forms

test("checkbox and radio clicks, canceled click reverts", () => {
  const d = page("<input type=checkbox id=c><input type=radio name=r id=r1 checked><input type=radio name=r id=r2>");
  const c = d.getElementById("c") as HTMLInputElement;
  const changes: string[] = [];
  c.addEventListener("change", () => changes.push("c"));
  c.click();
  ok(c.checked, "checked after click");
  eq(changes, ["c"]);
  c.addEventListener("click", (e) => (e as Event).preventDefault());
  c.click();
  ok(c.checked, "a canceled click reverts the toggle");
  const r2 = d.getElementById("r2") as HTMLInputElement;
  r2.click();
  ok(r2.checked && !(d.getElementById("r1") as HTMLInputElement).checked, "radio group");
});

test("input values: text, range, number, defaults", () => {
  const d = page("<input id=t value=a><input id=r type=range min=0 max=10 step=2 value=5><form><input id=n type=number value=3></form>");
  const t = d.getElementById("t") as HTMLInputElement;
  t.value = "b";
  eq([t.value, t.defaultValue, t.getAttribute("value")], ["b", "a", "a"]);
  eq((d.getElementById("r") as HTMLInputElement).value, "6");
  const n = d.getElementById("n") as HTMLInputElement;
  n.stepUp(2);
  eq(n.valueAsNumber, 5);
  ok(n.form !== null, "form owner");
});

test("select: selectedIndex, value, selected attribute, optgroups, new options", () => {
  const d = page("<select id=s><option value=a>A</option><optgroup label=g><option selected>B</option></optgroup><option value=c disabled>C</option></select>");
  const s = d.getElementById("s") as HTMLSelectElement;
  eq([s.selectedIndex, s.value, s.length], [1, "B", 3]);
  s.value = "c";
  eq(s.selectedIndex, 2);
  (s.options[0] as HTMLOptionElement).selected = true;
  eq([s.value, s.selectedOptions.length, (s.options[2] as HTMLOptionElement).selected], ["a", 1, false]);
  const o = d.createElement("option") as HTMLOptionElement;
  o.text = "D"; o.value = "d";
  s.add(o);
  s.selectedIndex = 3;
  eq(s.value, "d");
  const empty = d.createElement("select") as HTMLSelectElement;
  eq([empty.value, empty.selectedIndex], ["", -1]);
});

test("labels click their control; disabled controls don't click", () => {
  const d = page("<label id=l for=c>x</label><input type=checkbox id=c><label id=w><input type=checkbox id=c2> y</label><button disabled id=b>b</button>");
  (d.getElementById("l") as Element).click();
  ok((d.getElementById("c") as HTMLInputElement).checked, "for=");
  (d.getElementById("w") as Element).click();
  ok((d.getElementById("c2") as HTMLInputElement).checked, "wrapped");
  let clicked = false;
  d.getElementById("b")?.addEventListener("click", () => { clicked = true; });
  (d.getElementById("b") as Element).click();
  ok(!clicked, "disabled button");
  ok((d.getElementById("b") as Element).matches(":disabled"), ":disabled");
});

test("form submit and reset", () => {
  const d = page("<form id=f><input id=i value=x><button id=go>go</button></form>");
  let submitted = 0;
  d.getElementById("f")?.addEventListener("submit", (e) => { submitted++; (e as Event).preventDefault(); });
  (d.getElementById("go") as Element).click();
  eq(submitted, 1);
  const i = d.getElementById("i") as HTMLInputElement;
  i.value = "changed";
  (d.getElementById("f") as unknown as { reset(): void }).reset();
  eq(i.value, "x");
});

// ---------------------------------------------------------------- focus, geometry, canvas

test("focus, blur and the focus events; :focus, :focus-within; tab order", () => {
  const d = page("<div id=w><button id=a>a</button><input id=b><span id=s>s</span><span id=t tabindex=0>t</span><button id=h hidden>h</button><a id=p tabindex=2 href=#>p</a></div>");
  const log: string[] = [];
  d.getElementById("w")?.addEventListener("focusin", (e) => log.push("in:" + ((e as Event).target as Element).id));
  d.getElementById("a")?.addEventListener("blur", () => log.push("blur:a"));
  (d.getElementById("a") as Element).focus();
  (d.getElementById("b") as Element).focus();
  (d.getElementById("s") as Element).focus();   // not focusable
  eq(log, ["in:a", "blur:a", "in:b"]);
  eq(d.activeElement?.id, "b");
  ok((d.getElementById("w") as Element).matches(":focus-within"), "focus-within");
  eq(d.sequentialFocusOrder().map((e) => e.id), ["p", "a", "b", "t"]);
  (d.getElementById("b") as Element).remove();
  eq(d.activeElement?.localName, "body");
});

test("layout boxes: geometry and elementFromPoint", () => {
  const d = page("<div id=a><button id=b>b</button></div>");
  d._viewport = { w: 800, h: 600 };
  setLayoutBox(d.getElementById("a") as Element, { x: 10, y: 10, w: 100, h: 50 });
  setLayoutBox(d.getElementById("b") as Element, { x: 20, y: 20, w: 30, h: 20 });
  const r = (d.getElementById("b") as Element).getBoundingClientRect();
  eq([r.left, r.top, r.right, r.bottom, r.width], [20, 20, 50, 40, 30]);
  eq(d.elementFromPoint(25, 25)?.id, "b");
  eq(d.elementFromPoint(15, 15)?.id, "a");
  eq(d.elementFromPoint(500, 500)?.localName, "body");
  eq(d.body?.clientWidth, 800);
});

test("canvas size reflection and pluggable contexts", () => {
  const d = page("<canvas id=c width=64></canvas>");
  const c = d.getElementById("c") as HTMLCanvasElement;
  eq([c.width, c.height], [64, 150]);
  setCanvasContext("2d", (canvas) => ({ canvas, kind: "2d" }));
  const ctx = c.getContext("2d") as { canvas: unknown };
  ok(ctx.canvas === c && c.getContext("2d") === ctx, "one context per canvas");
  eq(c.getContext("webgl"), null);
});

// ---------------------------------------------------------------- observers

test("MutationObserver: childList, attributes with old values, subtree", () => {
  const d = page("<div id=a><p id=p></p></div>");
  const records: string[] = [];
  const mo = new MutationObserver((rs) => { for (const r of rs) records.push(r.type + ":" + (r.attributeName ?? r.addedNodes.length) + ":" + (r.oldValue ?? "")); });
  mo.observe(d.getElementById("a") as Element, { subtree: true, childList: true, attributeOldValue: true });
  (d.getElementById("p") as Element).setAttribute("class", "x");
  (d.getElementById("p") as Element).setAttribute("class", "y");
  d.getElementById("a")?.appendChild(d.createElement("i"));
  eq(mo.takeRecords().length, 3);
  void records;
});

report("dom");
