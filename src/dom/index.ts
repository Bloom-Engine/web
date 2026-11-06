/**
 * The DOM, in pure TypeScript (no Bloom): usable on its own, and what
 * `@bloomengine/web` installs as the page's `document`.
 */
import { Document } from "./node.ts";
import { parseHTML, serialize } from "./html.ts";
import "./elements.ts";

export * from "./events.ts";
export * from "./node.ts";
export * from "./elements.ts";
export * from "./observers.ts";
export { matchesSelector, specificity, SelectorError } from "./selectors.ts";
export { DOMTokenList, parseDeclarations, styleDeclaration, type CSSStyleDeclaration } from "./tokens.ts";
export { parseDocument, parseFragment, parseHTML, decodeEntities, serialize } from "./html.ts";

export class DOMParser {
  parseFromString(markup: string, _type = "text/html"): Document { return parseHTML(markup); }
}

export class XMLSerializer {
  serializeToString(node: import("./node.ts").Node): string { return serialize(node, true); }
}
