import { describe, it, expect } from "vitest";
import { parseSources, validateSourcesConfig } from "./source-config";

const GH = `name: github
type: cron
cmd: gh api graphql --jq '.'
template:
  name: "{{ title }}"
  key: "{{ html_url }}"
  prompt: "Review {{ number }}"`;

const YT = `name: youtrack
cmd: curl -s https://yt/api/issues
template:
  name: "{{ summary }}"`;

describe("parseSources", () => {
  it("returns nothing for null / empty input", () => {
    expect(parseSources(null)).toEqual({ sources: [], errors: [] });
    expect(parseSources("   ")).toEqual({ sources: [], errors: [] });
  });

  it("parses multiple documents into sources", () => {
    const { sources, errors } = parseSources(`${GH}\n---\n${YT}`);
    expect(errors).toEqual([]);
    expect(sources.map((s) => s.name)).toEqual(["github", "youtrack"]);
    expect(sources[0]!.type).toBe("cron");
    expect(sources[0]!.template.name).toBe("{{ title }}");
  });

  it("defaults type to cron when omitted", () => {
    const { sources } = parseSources(YT);
    expect(sources[0]!.type).toBe("cron");
  });

  it("ignores an empty trailing document", () => {
    const { sources, errors } = parseSources(`${GH}\n---\n`);
    expect(errors).toEqual([]);
    expect(sources).toHaveLength(1);
  });

  it("errors on a missing name (by index)", () => {
    const { sources, errors } = parseSources(`cmd: x\ntemplate:\n  name: y`);
    expect(sources).toHaveLength(0);
    expect(errors[0]).toMatchObject({ index: 1, message: expect.stringContaining("name") });
  });

  it("errors on a missing cmd", () => {
    const { errors } = parseSources(`name: a\ntemplate:\n  name: y`);
    expect(errors[0]).toMatchObject({ name: "a", message: expect.stringContaining("cmd") });
  });

  it("errors on a missing template.name", () => {
    const { errors } = parseSources(`name: a\ncmd: x\ntemplate:\n  prompt: hi`);
    expect(errors[0]).toMatchObject({
      name: "a",
      message: expect.stringContaining("template.name"),
    });
  });

  it("rejects type: event as unsupported", () => {
    const { errors } = parseSources(`name: a\ntype: event\ncmd: x\ntemplate:\n  name: y`);
    expect(errors[0]!.message).toContain("only 'cron'");
  });

  it("errors on duplicate names", () => {
    const { sources, errors } = parseSources(`${GH}\n---\n${GH}`);
    expect(sources).toHaveLength(1);
    expect(errors[0]!.message).toContain("Duplicate");
  });

  it("errors on invalid Liquid in a template leaf, naming the source", () => {
    const bad = `name: a\ncmd: x\ntemplate:\n  name: "{{ unclosed"`;
    const { sources, errors } = parseSources(bad);
    expect(sources).toHaveLength(0);
    expect(errors[0]).toMatchObject({ name: "a", message: expect.stringContaining("Liquid") });
  });

  it("keeps valid documents when another is malformed", () => {
    const { sources, errors } = parseSources(
      `${GH}\n---\nname: b\ntype: event\ncmd: x\ntemplate:\n  name: y`
    );
    expect(sources.map((s) => s.name)).toEqual(["github"]);
    expect(errors).toHaveLength(1);
  });
});

describe("validateSourcesConfig", () => {
  it("passes through null and valid strings, rejects invalid", () => {
    expect(validateSourcesConfig(null)).toBeNull();
    expect(validateSourcesConfig("")).toBe("");
    expect(validateSourcesConfig(GH)).toBe(GH);
    expect(validateSourcesConfig(`name: a\ncmd: x\ntemplate: {}`)).toBeUndefined();
    expect(validateSourcesConfig(42)).toBeUndefined();
  });
});
