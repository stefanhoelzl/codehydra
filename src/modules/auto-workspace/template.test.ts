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
      "agent.type: claude",
      "agent.name: plan",
      "agent.permission-mode: plan",
      "base: origin/main",
      "tracking: origin/feature-login",
      "focus: true",
      "agent.model.provider: anthropic",
      "agent.model.id: claude-sonnet-4-6",
      "project: /home/user/repo",
      "git: https://github.com/org/repo.git",
      "---",
      "Review this PR",
    ].join("\n");

    const result = parseTemplateOutput(input);
    expect(result.config).toEqual({
      prompt: "Review this PR",
      name: "review/42",
      base: "origin/main",
      tracking: "origin/feature-login",
      focus: true,
      project: "/home/user/repo",
      git: "https://github.com/org/repo.git",
      agent: {
        type: "claude",
        prompt: "Review this PR",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        permissionMode: "plan",
        agentName: "plan",
      },
    });
    expect(result.warnings).toEqual([]);
  });

  it("returns only specified fields (rest remain undefined)", () => {
    const input = "---\nagent.type: opencode\nagent.name: build\n---\nDo the thing";
    const result = parseTemplateOutput(input);
    expect(result.config.agent).toEqual({
      type: "opencode",
      prompt: "Do the thing",
      agentName: "build",
    });
    expect(result.config.name).toBeUndefined();
    expect(result.config.base).toBeUndefined();
    expect(result.config.tracking).toBeUndefined();
    expect(result.config.focus).toBeUndefined();
    expect(result.config.project).toBeUndefined();
    expect(result.config.git).toBeUndefined();
    expect(result.config.prompt).toBe("Do the thing");
    expect(result.warnings).toEqual([]);
  });

  it("shims legacy agent/model keys onto a claude arm with a deprecation warning", () => {
    const input =
      "---\nagent: build\nmodel.provider: anthropic\nmodel.id: claude-sonnet-4-6\n---\nDo it";
    const result = parseTemplateOutput(input);
    expect(result.config.agent).toEqual({
      type: "claude",
      prompt: "Do it",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      agentName: "build",
    });
    expect(result.warnings).toContain(
      "Front-matter keys 'agent', 'model.provider', 'model.id' are deprecated; " +
        "use 'agent.name' and 'agent.model.*' (with 'agent.type'). Legacy keys assume agent.type: claude."
    );
  });

  it("assumes claude and warns when agent options lack an agent.type", () => {
    const input = "---\nagent.name: plan\n---\nDo it";
    const result = parseTemplateOutput(input);
    expect(result.config.agent).toEqual({ type: "claude", prompt: "Do it", agentName: "plan" });
    expect(result.warnings).toContain(
      "agent.type is required to set a model, permission mode or named agent; assuming claude"
    );
  });

  it("warns and ignores permission-mode for opencode", () => {
    const input = "---\nagent.type: opencode\nagent.permission-mode: plan\n---\nDo it";
    const result = parseTemplateOutput(input);
    expect(result.config.agent).toEqual({ type: "opencode", prompt: "Do it" });
    expect(result.warnings).toContain("agent.permission-mode is ignored for opencode");
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

  it("warns when only the model provider is specified", () => {
    const input = "---\nagent.type: claude\nagent.model.provider: anthropic\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.agent).toEqual({ type: "claude", prompt: "prompt" });
    expect(result.warnings).toEqual(["Both the model provider and id must be specified together"]);
  });

  it("warns when only the model id is specified", () => {
    const input = "---\nagent.type: claude\nagent.model.id: claude-sonnet-4-6\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.agent).toEqual({ type: "claude", prompt: "prompt" });
    expect(result.warnings).toEqual(["Both the model provider and id must be specified together"]);
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
      "---\nname: review/42\nmetadata.pr-url: https://example.com\nagent.type: claude\nagent.name: plan\n---\nprompt";
    const result = parseTemplateOutput(input);
    expect(result.config.name).toBe("review/42");
    expect(result.config.agent).toEqual({ type: "claude", prompt: "prompt", agentName: "plan" });
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
