/**
 * HTML parsing and serialization.
 *
 * The parser follows the HTML tree builder where pages depend on it: void
 * elements, raw text (script, style, textarea, title, ...), comments and
 * doctypes, attributes in all quoting forms, named and numeric character
 * references, implied end tags (a new <p>, <li>, <option>, <tr>, <td> ...
 * closes the open one; block elements close an open <p>), end tags that
 * close back to their element and stray end tags ignored, <template>
 * content, and for a whole document the html/head/body structure with
 * head-only elements placed in head. It is not the full HTML5 algorithm
 * (no adoption agency for misnested formatting tags, no foster parenting
 * of table text).
 *
 * The serializer writes innerHTML/outerHTML as the browser does: escaped
 * text and attribute values, raw text unescaped, void elements without an
 * end tag.
 */
import { Comment, Document, DocumentFragment, DocumentType, Element, HTML_NS, SVG_NS, Text, html, type Node } from "./node.ts";

export const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen", "frame"]);
const RAW = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "plaintext"]);
const RCDATA = new Set(["textarea", "title"]);
const HEAD_ONLY = new Set(["base", "link", "meta", "title", "style", "script", "noscript", "template"]);
/** Elements whose start tag closes an open <p>. */
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "details", "dialog", "div", "dl", "fieldset", "figcaption", "figure", "footer",
  "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section",
  "summary", "table", "ul",
]);
/** A start tag of the key closes open elements of these names (up to the scope boundary). */
const IMPLIED: Record<string, string[]> = {
  li: ["li"], dt: ["dt", "dd"], dd: ["dt", "dd"], option: ["option"], optgroup: ["option", "optgroup"],
  tr: ["tr", "td", "th"], td: ["td", "th"], th: ["td", "th"], thead: ["tbody", "tfoot", "thead", "tr", "td", "th"],
  tbody: ["thead", "tbody", "tfoot", "tr", "td", "th"], tfoot: ["thead", "tbody", "tr", "td", "th"],
  rt: ["rt", "rp"], rp: ["rt", "rp"],
};
/** Implied closing stops at these (a <li> inside a nested <ul> doesn't close the outer <li>). */
const SCOPE = new Set(["ul", "ol", "table", "select", "dl", "html", "body", "td", "th", "template", "button", "object"]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", bull: "•", middot: "·", deg: "°",
  times: "×", divide: "÷", plusmn: "±", minus: "−", larr: "←", rarr: "→", uarr: "↑",
  darr: "↓", harr: "↔", crarr: "↵", euro: "€", pound: "£", yen: "¥", cent: "¢",
  sect: "§", para: "¶", ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍",
  shy: "­", iexcl: "¡", iquest: "¿", frac12: "½", frac14: "¼", frac34: "¾", sup2: "²",
  sup3: "³", micro: "µ", hearts: "♥", spades: "♠", clubs: "♣", diams: "♦", check: "✓",
  star: "☆", starf: "★", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö",
  Uuml: "Ü", szlig: "ß", eacute: "é", egrave: "è", aacute: "á", agrave: "à", ccedil: "ç",
  ntilde: "ñ", oacute: "ó", uacute: "ú", iacute: "í", ecirc: "ê", acirc: "â",
};

/** Replace character references (&amp; &#169; &#xA9;) in text or an attribute value. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (whole, ref: string) => {
    if (ref.charAt(0) === "#") {
      const code = ref.charAt(1) === "x" || ref.charAt(1) === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
      return String.fromCodePoint(code);
    }
    const v = ENTITIES[ref];
    return v === undefined ? whole : v;
  });
}

interface Token { kind: "start" | "end" | "text" | "comment" | "doctype"; name: string; attrs: [string, string][]; selfClosing: boolean; data: string }

/** Tokens of an HTML string. Raw text elements' content comes as one text token. */
function* tokenize(src: string): Generator<Token> {
  let i = 0;
  const n = src.length;
  let raw: string | null = null;
  while (i < n) {
    if (raw !== null) {
      // everything up to the matching end tag is text
      const close = new RegExp("</" + raw + "[\\s/>]", "i");
      const m = close.exec(src.slice(i));
      const end = m === null ? n : i + m.index;
      if (end > i) yield { kind: "text", name: "", attrs: [], selfClosing: false, data: RCDATA.has(raw) ? decodeEntities(src.slice(i, end)) : src.slice(i, end) };
      i = end;
      raw = null;
      continue;
    }
    const lt = src.indexOf("<", i);
    if (lt < 0) { yield { kind: "text", name: "", attrs: [], selfClosing: false, data: decodeEntities(src.slice(i)) }; break; }
    if (lt > i) { yield { kind: "text", name: "", attrs: [], selfClosing: false, data: decodeEntities(src.slice(i, lt)) }; i = lt; continue; }
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      yield { kind: "comment", name: "", attrs: [], selfClosing: false, data: src.slice(i + 4, end < 0 ? n : end) };
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<!", i) || src.startsWith("<?", i)) {
      const end = src.indexOf(">", i);
      const body = src.slice(i + 2, end < 0 ? n : end);
      if (/^doctype/i.test(body)) yield { kind: "doctype", name: body.slice(7).trim().split(/\s+/)[0]?.toLowerCase() ?? "html", attrs: [], selfClosing: false, data: "" };
      else yield { kind: "comment", name: "", attrs: [], selfClosing: false, data: body };
      i = end < 0 ? n : end + 1;
      continue;
    }
    const tag = /^<(\/?)([a-zA-Z][^\s\/>]*)/.exec(src.slice(i, i + 256));
    if (tag === null) { yield { kind: "text", name: "", attrs: [], selfClosing: false, data: "<" }; i++; continue; }
    const closing = tag[1] === "/";
    const name = (tag[2] ?? "").toLowerCase();
    i += tag[0].length;
    // attributes
    const attrs: [string, string][] = [];
    let selfClosing = false;
    for (;;) {
      while (i < n && /[\s]/.test(src.charAt(i))) i++;
      if (i >= n) break;
      const c = src.charAt(i);
      if (c === ">") { i++; break; }
      if (c === "/") { i++; if (src.charAt(i) === ">") { selfClosing = true; i++; break; } continue; }
      let an = "";
      while (i < n && !/[\s\/>=]/.test(src.charAt(i))) { an += src.charAt(i); i++; }
      if (an === "") { an = src.charAt(i); i++; }
      while (i < n && /\s/.test(src.charAt(i))) i++;
      let value = "";
      if (src.charAt(i) === "=") {
        i++;
        while (i < n && /\s/.test(src.charAt(i))) i++;
        const q = src.charAt(i);
        if (q === "\"" || q === "'") {
          const end = src.indexOf(q, i + 1);
          value = src.slice(i + 1, end < 0 ? n : end);
          i = end < 0 ? n : end + 1;
        } else {
          const start = i;
          while (i < n && !/[\s>]/.test(src.charAt(i))) i++;
          value = src.slice(start, i);
        }
        value = decodeEntities(value);
      }
      const key = an.toLowerCase();
      if (!attrs.some((a) => a[0] === key)) attrs.push([key, value]);
    }
    if (closing) { yield { kind: "end", name, attrs: [], selfClosing: false, data: "" }; continue; }
    yield { kind: "start", name, attrs, selfClosing, data: "" };
    if ((RAW.has(name) || RCDATA.has(name)) && !selfClosing) raw = name;
  }
}

/** The node a template's children go into. */
function container(e: Node): Node {
  const el = e as Element;
  if (el.nodeType === 1 && el.localName === "template") return (el as unknown as { content: DocumentFragment }).content;
  return e;
}

/**
 * Build a tree into `root` from markup. `documentMode` puts the html/head/body structure
 * around the content (a whole page); otherwise the nodes go straight into root (a fragment).
 */
function build(doc: Document, markup: string, root: Node, documentMode: boolean): void {
  const stack: Node[] = [root];
  let htmlEl = null as Element | null, headEl = null as Element | null, bodyEl = null as Element | null;
  const top = (): Node => stack[stack.length - 1] as Node;
  const ensureBody = (): void => {
    if (!documentMode || bodyEl !== null) return;
    ensureHead();
    bodyEl = doc.createElement("body");
    (htmlEl as Element).appendChild(bodyEl);
    stack.length = 2;
    stack.push(bodyEl);
  };
  const ensureHtml = (): void => {
    if (!documentMode || htmlEl !== null) return;
    htmlEl = doc.createElement("html");
    root.appendChild(htmlEl);
    stack.push(htmlEl);
  };
  const ensureHead = (): void => {
    ensureHtml();
    if (!documentMode || headEl !== null) return;
    headEl = doc.createElement("head");
    (htmlEl as Element).appendChild(headEl);
  };
  /** Before the body, inside an element of the head (a template, noscript): its content stays there. */
  const insideHeadElement = (): boolean => { const t = top(); return t !== root && t !== htmlEl && t !== headEl; };
  const inSvg = (): boolean => { for (let i = stack.length - 1; i >= 0; i--) { const s = stack[i] as Element; if (s.nodeType === 1 && s.namespaceURI === SVG_NS) return true; } return false; };
  const append = (node: Node): void => { container(top()).appendChild(node); };
  const closeTo = (names: string[], boundary: Set<string>): void => {
    for (let i = stack.length - 1; i > 0; i--) {
      const s = stack[i] as Element;
      if (s.nodeType !== 1) return;
      if (names.includes(s.localName)) { stack.length = i; return; }
      if (boundary.has(s.localName)) return;
    }
  };

  for (const t of tokenize(markup)) {
    if (t.kind === "doctype") { if (documentMode && htmlEl === null) root.appendChild(new DocumentType(t.name, "", "", doc)); continue; }
    if (t.kind === "comment") { (documentMode && htmlEl === null ? root : container(top())).appendChild(doc.createComment(t.data)); continue; }
    if (t.kind === "text") {
      if (documentMode && bodyEl === null) {
        // whitespace before the body is dropped; other text starts the body
        if (/^\s*$/.test(t.data)) { if (stack.length > 2 && top() !== headEl) append(doc.createTextNode(t.data)); continue; }
        if (!insideHeadElement()) ensureBody();
      }
      const parent = container(top());
      const last = parent.lastChild;
      if (last !== null && last.nodeType === 3) (last as Text).data += t.data;
      else parent.appendChild(doc.createTextNode(t.data));
      continue;
    }
    const name = t.name;
    if (t.kind === "start") {
      if (documentMode) {
        if (name === "html") { ensureHtml(); for (const [k, v] of t.attrs) if (!(htmlEl as Element).hasAttribute(k)) (htmlEl as Element).setAttribute(k, v); continue; }
        if (name === "head") { ensureHead(); for (const [k, v] of t.attrs) (headEl as Element).setAttribute(k, v); stack.length = 2; stack.push(headEl as Element); continue; }
        if (name === "body") {
          if (bodyEl === null) { ensureHead(); bodyEl = doc.createElement("body"); (htmlEl as Element).appendChild(bodyEl); }
          for (const [k, v] of t.attrs) if (!bodyEl.hasAttribute(k)) bodyEl.setAttribute(k, v);
          stack.length = 2;
          stack.push(bodyEl);
          continue;
        }
        if (bodyEl === null && !insideHeadElement()) {
          if (HEAD_ONLY.has(name)) { ensureHead(); if (top() !== headEl) { stack.length = 2; stack.push(headEl as Element); } }
          else ensureBody();
        }
      }
      if (CLOSES_P.has(name)) closeTo(["p"], new Set([...SCOPE]));
      const implied = IMPLIED[name];
      if (implied !== undefined) closeTo(implied, SCOPE);
      if (/^h[1-6]$/.test(name)) closeTo(["h1", "h2", "h3", "h4", "h5", "h6"], new Set(["div", "section", "article", ...SCOPE]));
      let el: Element;
      if (name === "svg" || inSvg()) {
        el = doc.createElementNS(SVG_NS, name === "svg" ? "svg" : t.name);
      } else if (name === "math") el = doc.createElementNS("http://www.w3.org/1998/Math/MathML", "math");
      else el = doc.createElement(name);
      for (const [k, v] of t.attrs) {
        try { el.setAttribute(k, v); } catch { /* an invalid attribute name is dropped */ }
      }
      append(el);
      const isVoid = el.namespaceURI === HTML_NS && VOID.has(name);
      if (!isVoid && !(t.selfClosing && el.namespaceURI !== HTML_NS)) stack.push(el);
      continue;
    }
    // end tag
    if (documentMode && (name === "html" || name === "body" || name === "head")) {
      if (name === "head" && top() === headEl) stack.pop();
      continue;
    }
    if (name === "p" && !stack.some((s) => s.nodeType === 1 && (s as Element).localName === "p")) { append(doc.createElement("p")); continue; }
    if (name === "br") { append(doc.createElement("br")); continue; }
    for (let i = stack.length - 1; i > 0; i--) {
      const s = stack[i] as Element;
      if (s.nodeType === 1 && (s.localName === name || s.localName === t.name)) { stack.length = i; break; }
      // an end tag doesn't reach past a scope boundary (an unclosed </div> inside a table cell)
      if (s.nodeType === 1 && SCOPE.has(s.localName) && s.localName !== name) break;
    }
  }
  if (documentMode) { ensureHead(); ensureBody(); }
}

/** Parse a whole page into a document (replacing what it had). */
export function parseDocument(doc: Document, markup: string): void {
  doc._replaceAll([]);
  build(doc, markup, doc, true);
}

/** Parse markup as the children of `context` would be (innerHTML). */
export function parseFragment(doc: Document, markup: string, _context: Element | null): Node[] {
  const f = new DocumentFragment(doc);
  build(doc, markup, f, false);
  return f.childNodes.slice();
}

/** Parse a page into a new document (DOMParser). */
export function parseHTML(markup: string): Document {
  const doc = new Document();
  parseDocument(doc, markup);
  return doc;
}

// ---------------------------------------------------------------- serialization

const escapeText = (s: string): string => s.replace(/&/g, "&amp;").replace(/ /g, "&nbsp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/ /g, "&nbsp;").replace(/"/g, "&quot;");

function serializeNode(node: Node, out: string[], parentRaw: boolean): void {
  switch (node.nodeType) {
    case 3: out.push(parentRaw ? (node as Text).data : escapeText((node as Text).data)); return;
    case 8: out.push("<!--" + (node as Comment).data + "-->"); return;
    case 10: out.push("<!DOCTYPE " + (node as DocumentType).name + ">"); return;
    case 1: {
      const e = node as Element;
      const tag = e.namespaceURI === HTML_NS ? e.localName : e.tagName;
      out.push("<" + tag);
      for (const name of e.getAttributeNames()) out.push(" " + name + "=\"" + escapeAttr(e.getAttribute(name) ?? "") + "\"");
      out.push(">");
      if (e.namespaceURI === HTML_NS && VOID.has(e.localName)) return;
      const raw = e.namespaceURI === HTML_NS && (RAW.has(e.localName) || e.localName === "noscript");
      for (const c of container(e).childNodes) serializeNode(c, out, raw);
      out.push("</" + tag + ">");
      return;
    }
    default:
      for (const c of node.childNodes) serializeNode(c, out, false);
  }
}

export function serialize(node: Node, outer: boolean): string {
  const out: string[] = [];
  if (outer) serializeNode(node, out, false);
  else {
    const e = node as Element;
    const raw = e.nodeType === 1 && e.namespaceURI === HTML_NS && RAW.has(e.localName);
    for (const c of container(node).childNodes) serializeNode(c, out, raw);
  }
  return out.join("");
}

html.parseFragment = parseFragment;
html.serialize = serialize;
