/**
 * The user guide (docs/USER_GUIDE.md), split into its `##` sections.
 *
 * One markdown file feeds three readers: the site's help page, `ch guide` and
 * the in-app help dialog. They must agree on what a section is called, so the
 * slug rule lives here, and the renderers (site, dialog) derive heading ids
 * from it too — `ch guide repository-hooks` names the same thing as
 * `#repository-hooks` on the site.
 *
 * NOTE: This file must be browser-compatible (no Node.js imports).
 */

/** One `##` section of the guide, heading line included. */
export interface GuideSection {
  readonly slug: string;
  readonly title: string;
  readonly markdown: string;
}

/**
 * Slug of a heading's raw markdown text: lowercase, inline markup and
 * punctuation dropped, runs of spaces/hyphens collapsed to one hyphen.
 * "Background processes: `ch bg`" -> "background-processes-ch-bg".
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-");
}

const FENCE = /^(```|~~~)/;
const SECTION_HEADING = /^## (.+?)\s*#*\s*$/;

/**
 * Split the guide at its `##` headings. Anything before the first one (the
 * title and intro) belongs to no section. Headings inside fenced code blocks
 * are not headings.
 */
export function guideSections(markdown: string): GuideSection[] {
  const sections: { title: string; lines: string[] }[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : SECTION_HEADING.exec(line);
    if (heading) {
      sections.push({ title: heading[1]!, lines: [line] });
    } else {
      sections[sections.length - 1]?.lines.push(line);
    }
  }
  return sections.map(({ title, lines }) => ({
    slug: slugifyHeading(title),
    title,
    markdown: `${lines.join("\n").trimEnd()}\n`,
  }));
}
