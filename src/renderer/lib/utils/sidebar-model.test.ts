import { describe, it, expect } from "vitest";
import type { UiProjectRow } from "@shared/ui-state";
import { question, sampleProjects } from "../components/sidebar-fixture";
import {
  hiddenQuestions,
  highlightParts,
  markerRows,
  matches,
  moonToggle,
  projectColor,
  projectFolds,
  rowGlyph,
  rowGroup,
  rowHidden,
  rowOn,
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

  it("matches project, title, branch and tags", () => {
    const p = project("acme-api");
    expect(matches(p, rowOf(p, "oauth-pkce"), "pkce")).toBe(true);
    expect(matches(p, rowOf(p, "oauth-pkce"), "security")).toBe(true);
    expect(matches(p, rowOf(p, "oauth-pkce"), "acme")).toBe(true);
    expect(matches(p, rowOf(p, "oauth-pkce"), "website")).toBe(false);
  });

  it("the marker walks visible rows only", () => {
    const keys = markerRows(sampleProjects(), find("ci")).map((row) => row.key);
    expect(keys).toEqual(["infra/ci-cache"]);
  });

  it("finds questions whose rows are out of sight", () => {
    const infra = project("infra");
    const notes = [question("q", "infra/ci-cache", "Run?", ["Yes"])];
    expect(hiddenQuestions(infra, notes, REST).length).toBe(1);
    expect(hiddenQuestions({ ...infra, collapsed: false }, notes, REST).length).toBe(0);
  });

  it("toggles the moon and colors projects stably", () => {
    expect(moonToggle("hidden")).toBe("manual");
    expect(moonToggle("all")).toBe("hidden");
    expect(projectColor("codehydra")).toBe(projectColor("codehydra"));
  });

  it("splits text around the first match", () => {
    expect(highlightParts("Switch login to PKCE", "pkce")).toEqual({
      before: "Switch login to ",
      match: "PKCE",
      after: "",
    });
    expect(highlightParts("abc", "")).toBeNull();
  });
});
