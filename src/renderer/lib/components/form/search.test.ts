/**
 * Focused tests for the dialog search filter (pure input → output).
 */
import { describe, it, expect } from "vitest";
import type { DialogSection } from "@shared/dialog-types";
import { sectionText, visibleSections } from "./search";

const heading = (content: string): DialogSection => ({ type: "text", content, style: "heading" });
const subheading = (content: string): DialogSection => ({
  type: "text",
  content,
  style: "subheading",
});
const row = (label: string, description?: string): DialogSection => ({
  type: "setting-row",
  label,
  fields: [{ type: "input", id: label }],
  ...(description !== undefined && { description }),
});
const footer: DialogSection = {
  type: "group",
  pinned: true,
  items: [{ type: "button", id: "cancel", label: "Cancel", role: "cancel" }],
};

/** A settings-shaped dialog: General / sidebar / experimental›youtrack. */
const sections: DialogSection[] = [
  heading("General"),
  row("agent", "Which agent to run"),
  heading("sidebar"),
  row("width", "Width in pixels"),
  row("mode"),
  heading("experimental"),
  subheading("youtrack"),
  row("token", "API token"),
  footer,
];

/** The visible sections' identifying text, for readable assertions. */
function visibleNames(query: string): string[] {
  const visible = visibleSections(sections, query);
  return sections
    .filter((_, index) => visible[index])
    .map((s) => (s.type === "text" ? s.content : s.type === "setting-row" ? s.label : "footer"));
}

describe("visibleSections", () => {
  it("shows everything for a blank query", () => {
    expect(visibleSections(sections, "   ").every(Boolean)).toBe(true);
  });

  it("shows a matching row with its heading, and the pinned footer", () => {
    expect(visibleNames("width")).toEqual(["sidebar", "width", "footer"]);
  });

  it("matches a row's description, case-insensitively", () => {
    expect(visibleNames("PIXELS")).toEqual(["sidebar", "width", "footer"]);
  });

  it("a heading match shows its whole group", () => {
    expect(visibleNames("sidebar")).toEqual(["sidebar", "width", "mode", "footer"]);
  });

  it("a subheading match shows its group under the parent heading", () => {
    expect(visibleNames("youtrack")).toEqual(["experimental", "youtrack", "token", "footer"]);
  });

  it("every word must match, across a row and its headings", () => {
    expect(visibleNames("sidebar mode")).toEqual(["sidebar", "mode", "footer"]);
    expect(visibleNames("sidebar token")).toEqual(["footer"]);
  });

  it("a pinned section alone does not hold up the heading above it", () => {
    expect(visibleNames("nothing-matches")).toEqual(["footer"]);
  });

  it("hides an unpinned footer like any other section", () => {
    const unpinned = sections.map((s) => (s === footer ? { ...footer, pinned: false } : s));
    expect(visibleSections(unpinned, "width").at(-1)).toBe(false);
  });
});

describe("sectionText", () => {
  it("covers a dropdown's labels and option labels", () => {
    const text = sectionText({
      type: "dropdown",
      id: "d",
      label: "Agent",
      suggestions: [{ header: "Installed", items: [{ value: "c", label: "Claude" }] }],
    });
    expect(text).toContain("agent");
    expect(text).toContain("installed");
    expect(text).toContain("claude");
  });

  it("covers a setting row's chrome and its fields' labels", () => {
    const text = sectionText({
      type: "setting-row",
      label: "output",
      description: "Where logs go",
      badge: "env",
      note: "Restart to apply",
      fields: [{ type: "checkbox", id: "o::file", label: "file" }],
    });
    for (const part of ["output", "where logs go", "env", "restart to apply", "file"]) {
      expect(text).toContain(part);
    }
  });
});
