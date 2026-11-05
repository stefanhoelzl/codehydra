import { describe, it, expect } from "vitest";
import { PROJECT_COLOR_COUNT, type UiProjectRow } from "@shared/ui-state";
import { sampleProjects } from "../components/sidebar-fixture";
import {
  describeRowCounts,
  highlightParts,
  markerRows,
  matches,
  moonToggle,
  PROJECT_COLORS,
  projectColor,
  projectFolds,
  rowCounts,
  rowGlyph,
  rowGroup,
  rowHidden,
  rowOn,
  rowStatusText,
  type SidebarView,
} from "./sidebar-model";

const REST: SidebarView = { find: null, query: "" };
const find = (query = "", hibernatedView: "hidden" | "manual" | "all" = "manual"): SidebarView => ({
  find: { hibernatedView },
  query,
});

function project(id: string, change: Partial<UiProjectRow> = {}): UiProjectRow {
  const found = sampleProjects().find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(id);
  return { ...found, ...change };
}
const rowOf = (p: UiProjectRow, name: string) => {
  const found = p.workspaces.find((row) => row.name === name);
  if (found === undefined) throw new Error(name);
  return found;
};

describe("sidebar-model", () => {
  it("counts a row at most once, by the glyph it shows, and names the non-zero counts", () => {
    const counts = rowCounts(project("codehydra").workspaces);
    // e2e-flake-hunt failed to open: it counts nowhere.
    expect(counts).toEqual({
      busy: 1,
      loading: 1,
      idle: 1,
      noAgent: 0,
      hibernated: 2,
      automated: 2,
    });
    expect(describeRowCounts(counts)).toBe(
      "1 working · 1 loading · 1 waiting for you · 2 hibernated · 2 automated"
    );
    expect(describeRowCounts(rowCounts([]))).toBe("");
  });

  it("groups rows into hibernated, automated and awake", () => {
    const p = project("codehydra");
    expect(rowGroup(rowOf(p, "atomic-state-writes"))).toBe("hibernated");
    expect(rowGroup(rowOf(p, "ci-watch"))).toBe("automated");
    expect(rowGroup(rowOf(p, "redesign-sidebar"))).toBe("awake");
  });

  it("picks the status glyph", () => {
    const p = project("codehydra");
    expect(rowGlyph(rowOf(p, "redesign-sidebar"))).toBe("busy");
    expect(rowGlyph(rowOf(p, "hibernation-age"))).toBe("idle");
    expect(rowGlyph(rowOf(p, "opencode-mcp-timeout"))).toBe("pending");
    expect(rowGlyph(rowOf(p, "e2e-flake-hunt"))).toBe("failed");
    expect(rowGlyph(rowOf(p, "ci-watch"))).toBe("hibernated");
  });

  it("at rest: automated rows only once shown, hibernated list only when opened", () => {
    const p = project("codehydra");
    expect(rowOn(p, rowOf(p, "ci-watch"), REST)).toBe(false);
    expect(rowOn(p, rowOf(p, "atomic-state-writes"), REST)).toBe(true);
    expect(rowHidden(p, rowOf(p, "atomic-state-writes"), REST)).toBe(true);
    const open = { ...p, hibernatedView: "manual" as const };
    expect(rowHidden(open, rowOf(open, "atomic-state-writes"), REST)).toBe(false);
    const all = { ...p, hibernatedView: "all" as const };
    expect(rowOn(all, rowOf(all, "ci-watch"), REST)).toBe(true);
  });

  it("Find expands everything and its view decides the hibernated rows", () => {
    const p = project("infra");
    expect(projectFolds(p, REST).expanded).toBe(false);
    expect(projectFolds(p, find()).expanded).toBe(true);
    const c = project("codehydra");
    expect(rowOn(c, rowOf(c, "ci-watch"), find())).toBe(false);
    expect(rowOn(c, rowOf(c, "ci-watch"), find("", "all"))).toBe(true);
    expect(rowOn(c, rowOf(c, "atomic-state-writes"), find("", "hidden"))).toBe(false);
  });

  it("a collapsed project shows no rows", () => {
    const infra = project("infra");
    expect(projectFolds(infra, REST)).toMatchObject({ expanded: false, bodyOpen: false });
    for (const row of infra.workspaces) {
      expect(rowHidden(infra, row, REST)).toBe(true);
    }
  });

  it("matches project, title, branch and tags", () => {
    const p = project("acme-api");
    expect(matches(p, rowOf(p, "oauth-pkce"), "pkce")).toBe(true);
    expect(matches(p, rowOf(p, "oauth-pkce"), "security")).toBe(true);
    expect(matches(p, rowOf(p, "oauth-pkce"), "acme")).toBe(true);
    expect(matches(p, rowOf(p, "oauth-pkce"), "website")).toBe(false);
  });

  it("needs every word to match, in any field and any order", () => {
    const p = project("acme-api");
    expect(matches(p, rowOf(p, "oauth-pkce"), "acm pkce")).toBe(true);
    expect(matches(p, rowOf(p, "oauth-pkce"), "pkce acm")).toBe(true);
    expect(matches(p, rowOf(p, "oauth-pkce"), "acm   oauth")).toBe(true);
    expect(matches(p, rowOf(p, "oauth-pkce"), "acm website")).toBe(false);
    expect(matches(p, rowOf(p, "oauth-pkce"), "")).toBe(true);
  });

  it("the marker walks visible rows only", () => {
    const keys = markerRows(sampleProjects(), find("ci")).map((row) => row.key);
    expect(keys).toEqual(["infra/ci-cache"]);
  });

  it("words a row's status for its accessible name", () => {
    const p = project("codehydra");
    const text = (name: string) => rowStatusText(rowOf(p, name), "Hibernated");
    expect(text("redesign-sidebar")).toMatch(/^\d+ agents? busy$|^\d+ idle, \d+ busy$/);
    expect(text("hibernation-age")).toMatch(/^\d+ agents? idle$/);
    expect(text("opencode-mcp-timeout")).toBe("Creating");
    expect(text("e2e-flake-hunt")).toBe("Failed to open");
    expect(text("atomic-state-writes")).toBe("Hibernated");
    const none = { ...rowOf(p, "hibernation-age"), agent: { type: "none" as const } };
    expect(rowStatusText(none, "Hibernated")).toBe("No agents running");
  });

  it("toggles the moon", () => {
    expect(moonToggle("hidden")).toBe("manual");
    expect(moonToggle("all")).toBe("hidden");
  });

  it("has a distinct color for every index main assigns", () => {
    expect(PROJECT_COLORS).toHaveLength(PROJECT_COLOR_COUNT);
    expect(new Set(PROJECT_COLORS).size).toBe(PROJECT_COLOR_COUNT);
    expect(projectColor(0)).toBe(PROJECT_COLORS[0]);
    expect(projectColor(PROJECT_COLOR_COUNT - 1)).toBe(PROJECT_COLORS[PROJECT_COLOR_COUNT - 1]);
  });

  it("marks the first match of each word", () => {
    expect(highlightParts("Switch login to PKCE", "pkce login")).toEqual([
      { text: "Switch ", marked: false },
      { text: "login", marked: true },
      { text: " to ", marked: false },
      { text: "PKCE", marked: true },
    ]);
    expect(highlightParts("abab", "ab")).toEqual([
      { text: "ab", marked: true },
      { text: "ab", marked: false },
    ]);
  });

  it("merges marks that overlap or touch", () => {
    expect(highlightParts("abcdef", "abc bcd")).toEqual([
      { text: "abcd", marked: true },
      { text: "ef", marked: false },
    ]);
    expect(highlightParts("abcdef", "cd ab")).toEqual([
      { text: "abcd", marked: true },
      { text: "ef", marked: false },
    ]);
    expect(highlightParts("abcdef", "abc b")).toEqual([
      { text: "abc", marked: true },
      { text: "def", marked: false },
    ]);
  });

  it("marks nothing without a match", () => {
    expect(highlightParts("abc", "")).toEqual([{ text: "abc", marked: false }]);
    expect(highlightParts("abc", "x")).toEqual([{ text: "abc", marked: false }]);
  });
});
