/**
 * Markdown -> HTML for the user guide's renderers (the site's help page at
 * build time, the in-app help dialog at runtime).
 *
 * Headings get ids from slugifyHeading, so an in-page link like
 * `[Repository hooks](#repository-hooks)` lands and `ch guide` section names
 * match.
 *
 * `safe` is for HTML that goes into a live DOM (the help dialog): raw HTML in
 * the markdown is escaped to text, except bare `<kbd>`/`</kbd>` tags — the one
 * piece of inline HTML the guide uses — and images are dropped, since their
 * sources are relative to the site. Sanitizing at the markdown level rather
 * than on the DOM keeps it independent of the DOM implementation it runs in.
 *
 * NOTE: This file must be browser-compatible (no Node.js imports).
 */

import { Marked, type RendererObject } from "marked";
import { slugifyHeading } from "./user-guide";

export interface RenderOptions {
  readonly safe?: boolean;
}

const KBD_TAG = /(<\/?kbd>)/;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const headingRenderer: RendererObject = {
  heading({ tokens, depth, text }) {
    return `<h${depth} id="${slugifyHeading(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
  },
};

const trusted = new Marked({ gfm: true, renderer: headingRenderer });

const safe = new Marked({
  gfm: true,
  renderer: {
    ...headingRenderer,
    html({ text }) {
      return text
        .split(KBD_TAG)
        .map((part) => (KBD_TAG.test(part) ? part : escapeHtml(part)))
        .join("");
    },
    image() {
      return "";
    },
  },
});

export function renderMarkdown(markdown: string, options: RenderOptions = {}): string {
  return (options.safe ? safe : trusted).parse(markdown, { async: false });
}
