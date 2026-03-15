// @vitest-environment node

import { describe, it, expect } from "vitest";
import { parseTemplateOutput } from "./template";

describe("parseTemplateOutput", () => {
  it("treats entire string as prompt when no front matter", () => {
    const result = parseTemplateOutput("Review PR #42");
    expect(result.config).toEqual({ prompt: "Review PR #42" });
    expect(result.warnings).toEqual([]);
  });

  it("parses all supported front-matter fields", () => {
    const input = [
      "---",
      "name: review/42",
      "agent: plan",
      "base: origin/main",
      "focus: true",
      "model.provider: anthropic",
      "model.id: claude-sonnet-4-6",
      "project: /home/user/repo",
      "git: https://github.com/org/repo.git",
      "---",
      "Review this PR",
    ].join("\n");

    const result = parseTemplateOutput(input);
    expect(result.config).toEqual({
      prompt: "Review this PR",
      name: "review/42",
      agent: "plan",
      base: "origin/main",
      focus: true,
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      project: "/home/user/repo",
      git: "https://github.com/org/repo.git",
    });
    expect(result.warnings).toEqual([]);
  });

  it("returns only specified fields (rest remain undefined)", () => {
    const input = "---\nagent: build\n---\nDo the thing";
    const result = parseTemplateOutput(input);
    expect(result.config.agent).toBe("build");
    expect(result.config.name).toBeUndefined();
    expect(result.config.base).toBeUndefined();
    expect(result.config.focus).toBeUndefined();
    expect(result.config.model).toBeUndefined();
    expect(result.config.project).toBeUndefined();
    expect(result.config.git).toBeUndefined();
    expect(result.config.prompt).toBe("Do the thing");
  });

  it("handles empty front matter (prompt only)", () => {
    const input = "---\n---\nJust the prompt";
    const result = parseTemplateOutput(input);
    expect(result.config).toEqual({ prompt: "Just the prompt" });
    expect(result.warnings).toEqual([]);
  });

  it("warns on unknown front-matter keys", () => {
    const input = "---\nunknown: value\nname: ws\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.name).toBe("ws");
    expect(result.warnings).toEqual(['Unknown front-matter key: "unknown"']);
  });

  it("warns on invalid boolean value for focus", () => {
    const input = "---\nfocus: banana\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.focus).toBeUndefined();
    expect(result.warnings).toEqual(['Invalid focus value "banana", expected "true" or "false"']);
  });

  it("treats opening --- without closing as no front matter", () => {
    const input = "---\nname: ws\nno closing delimiter";
    const result = parseTemplateOutput(input);
    expect(result.config).toEqual({ prompt: input });
    expect(result.warnings).toEqual([]);
  });

  it("warns when only model.provider is specified", () => {
    const input = "---\nmodel.provider: anthropic\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.model).toBeUndefined();
    expect(result.warnings).toEqual([
      "Both model.provider and model.id must be specified together",
    ]);
  });

  it("warns when only model.id is specified", () => {
    const input = "---\nmodel.id: claude-sonnet-4-6\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.model).toBeUndefined();
    expect(result.warnings).toEqual([
      "Both model.provider and model.id must be specified together",
    ]);
  });

  it("ignores comments and blank lines in front matter", () => {
    const input = "---\n# this is a comment\n\nname: ws\n\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.name).toBe("ws");
    expect(result.warnings).toEqual([]);
  });

  it("splits on first colon only (values can contain colons)", () => {
    const input = "---\nbase: origin/main:feature\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.base).toBe("origin/main:feature");
  });

  it("parses focus: false correctly", () => {
    const input = "---\nfocus: false\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.focus).toBe(false);
  });

  it("strips single leading newline after closing delimiter", () => {
    const input = "---\nname: ws\n---\n\nTwo newlines before this";
    const result = parseTemplateOutput(input);
    expect(result.config.prompt).toBe("\nTwo newlines before this");
  });

  it("parses metadata.* keys into metadata record", () => {
    const input =
      "---\nmetadata.pr-url: https://github.com/org/repo/pull/42\nmetadata.pr-number: 42\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.metadata).toEqual({
      "pr-url": "https://github.com/org/repo/pull/42",
      "pr-number": "42",
    });
    expect(result.warnings).toEqual([]);
  });

  it("warns on invalid metadata key", () => {
    const input =
      "---\nmetadata.note-: trailing hyphen\nmetadata.123: leading digit\nmetadata.: empty\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.metadata).toBeUndefined();
    expect(result.warnings).toEqual([
      'Invalid metadata key: "note-"',
      'Invalid metadata key: "123"',
      'Invalid metadata key: ""',
    ]);
  });

  it("includes valid keys and warns on invalid ones in same template", () => {
    const input = "---\nmetadata.good-key: value\nmetadata.bad-: invalid\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.metadata).toEqual({ "good-key": "value" });
    expect(result.warnings).toEqual(['Invalid metadata key: "bad-"']);
  });

  it("metadata works alongside other front-matter fields", () => {
    const input =
      "---\nname: review/42\nmetadata.pr-url: https://example.com\nagent: plan\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.name).toBe("review/42");
    expect(result.config.agent).toBe("plan");
    expect(result.config.metadata).toEqual({ "pr-url": "https://example.com" });
    expect(result.warnings).toEqual([]);
  });

  it("empty metadata values are valid", () => {
    const input = "---\nmetadata.note:\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.metadata).toEqual({ note: "" });
    expect(result.warnings).toEqual([]);
  });

  it("parses project key", () => {
    const input = "---\nproject: /home/user/repo\n---\nFix it";
    const result = parseTemplateOutput(input);
    expect(result.config.project).toBe("/home/user/repo");
  });

  it("parses git key", () => {
    const input = "---\ngit: https://github.com/org/repo.git\n---\nFix it";
    const result = parseTemplateOutput(input);
    expect(result.config.git).toBe("https://github.com/org/repo.git");
  });
});
