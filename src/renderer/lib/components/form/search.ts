/**
 * Dialog search (DialogConfig.search): which sections a query leaves visible.
 *
 * Pure and renderer-side — Form hides the sections this rejects, but keeps
 * them mounted, so their fields' values survive the filter.
 *
 * - Every section is matched on all of its own text (labels, descriptions,
 *   option labels, button labels, …) — see sectionText.
 * - Heading scope: each section belongs to the heading (and subheading) above
 *   it, and is matched together with their text, so a query naming a heading
 *   shows its whole group. A heading stays visible while anything under it
 *   does, so results keep their context.
 * - The query is split on whitespace; every word must be a case-insensitive
 *   substring (the dropdown filter's rule), anywhere across the section's own
 *   text and its headings' — "sidebar width" finds the width row under the
 *   sidebar heading.
 * - A `pinned` section is never hidden.
 */
import type { DialogSection } from "@shared/dialog-types";
import type { ButtonItem } from "./types";

/** The words of a query, lowercased; empty for a blank query. */
function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function buttonText(button: ButtonItem): string[] {
  return [button.label ?? "", button.title ?? ""];
}

/** Everything a section displays (or offers), as one lowercased string. */
export function sectionText(section: DialogSection | ButtonItem): string {
  const parts: string[] = [];
  switch (section.type) {
    case "text":
    case "markdown":
      parts.push(section.content);
      break;
    case "progress":
      for (const item of section.items) parts.push(item.label, item.message ?? "");
      break;
    case "radio":
      parts.push(section.label ?? "", ...section.options.map((o) => o.label));
      break;
    case "dropdown":
      parts.push(section.label ?? "", section.placeholder ?? "");
      for (const group of section.suggestions) {
        parts.push(group.header ?? "");
        for (const item of group.items) parts.push(item.label, item.keywords ?? "");
      }
      break;
    case "table":
      parts.push(section.header ?? "", ...section.columns.map((c) => c.label));
      for (const row of section.rows) parts.push(...Object.values(row));
      break;
    case "input":
      parts.push(section.label ?? "", section.placeholder ?? "");
      break;
    case "checkbox":
      parts.push(section.label ?? "");
      break;
    case "button":
      parts.push(...buttonText(section));
      break;
    case "group":
      parts.push(section.label ?? "", ...section.items.map(sectionText));
      break;
    case "setting-row":
      parts.push(
        section.label,
        section.description ?? "",
        section.badge ?? "",
        section.note ?? "",
        section.action?.label ?? "",
        section.helpLabel ?? "",
        section.helpPanel ?? "",
        ...section.fields.map(sectionText)
      );
      break;
  }
  return parts.filter(Boolean).join("\n").toLowerCase();
}

/** The heading level a section opens: 1 = heading, 2 = subheading, 0 = none. */
function headingLevel(section: DialogSection): 0 | 1 | 2 {
  if (section.type !== "text") return 0;
  if (section.style === "heading") return 1;
  if (section.style === "subheading") return 2;
  return 0;
}

/**
 * Per section of `sections`, whether it is visible under `query`. A blank
 * query shows everything.
 */
export function visibleSections(sections: readonly DialogSection[], query: string): boolean[] {
  const words = queryWords(query);
  if (words.length === 0) return sections.map(() => true);

  const matches = (text: string): boolean => words.every((word) => text.includes(word));

  // Pass 1: each section's own match, judged with its headings' text.
  const matched: boolean[] = [];
  /** Index of the open heading / subheading, or -1. */
  const scope: { heading: number; subheading: number }[] = [];
  let heading = -1;
  let subheading = -1;
  let headingText = "";
  let subheadingText = "";
  sections.forEach((section, index) => {
    const level = headingLevel(section);
    if (level === 1) {
      heading = index;
      subheading = -1;
      headingText = sectionText(section);
      subheadingText = "";
    } else if (level === 2) {
      subheading = index;
      subheadingText = sectionText(section);
    }
    scope.push({ heading, subheading });
    const own = level === 0 ? sectionText(section) : "";
    matched.push(matches([headingText, subheadingText, own].join("\n")));
  });

  // Pass 2: a matched section keeps its headings visible (a merely pinned
  // one does not — the settings footer must not hold up the last group's
  // heading).
  const visible = sections.map((section, index) => section.pinned === true || matched[index]!);
  sections.forEach((_, index) => {
    if (!matched[index]) return;
    const { heading: h, subheading: s } = scope[index]!;
    if (h >= 0 && h !== index) visible[h] = true;
    if (s >= 0 && s !== index) visible[s] = true;
  });

  return visible;
}
