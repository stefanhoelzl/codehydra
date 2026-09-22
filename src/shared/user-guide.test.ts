/**
 * Focused tests for the guide's slug rule and section splitting, and that the
 * renderer's heading ids use the same rule.
 */

import { describe, it, expect } from "vitest";
import { guideSections, slugifyHeading } from "./user-guide";
import { renderMarkdown } from "./markdown";

describe("slugifyHeading", () => {
  it.each([
    ["Repository hooks", "repository-hooks"],
    ["Background processes: `ch bg`", "background-processes-ch-bg"],
    ["Configuration & Automation", "configuration-automation"],
    ["The `ch` CLI and MCP", "the-ch-cli-and-mcp"],
  ])("%s -> %s", (heading, slug) => {
    expect(slugifyHeading(heading)).toBe(slug);
  });
});

describe("guideSections", () => {
  it("ignores text before the first ## heading", () => {
    expect(guideSections("# Title\n\nIntro\n").map((s) => s.slug)).toEqual([]);
  });

  it("does not split at a ## line inside a fence", () => {
    const sections = guideSections("## A\n\n~~~\n## B\n~~~\n\n## C\n");
    expect(sections.map((s) => s.slug)).toEqual(["a", "c"]);
  });
});

describe("renderMarkdown", () => {
  it("gives headings the ids the sections are named by", () => {
    const html = renderMarkdown("## Background processes: `ch bg`\n");
    expect(html).toContain('<h2 id="background-processes-ch-bg">');
    expect(html).toContain("<code>ch bg</code>");
  });
});
