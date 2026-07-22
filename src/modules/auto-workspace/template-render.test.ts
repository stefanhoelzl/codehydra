import { describe, it, expect } from "vitest";
import { renderDefinition } from "./template-render";
import type { TemplateObject } from "./source-config";

const data = {
  number: 42,
  title: "Fix the bug",
  html_url: "https://github.com/o/r/pull/42",
  base: { ref: "main" },
  clone_url: "https://github.com/o/r.git",
  summary: "Do the thing",
};

describe("renderDefinition", () => {
  it("renders core fields and defaults key to the rendered name", () => {
    const tpl: TemplateObject = {
      name: "pr-{{ number }}",
      base: "{{ base.ref }}",
      project: "{{ clone_url }}",
      prompt: "Review {{ title }}",
    };
    const { definition } = renderDefinition(tpl, data);
    expect(definition.name).toBe("pr-42");
    expect(definition.key).toBe("pr-42");
    expect(definition.base).toBe("main");
    expect(definition.project).toBe("https://github.com/o/r.git");
    expect(definition.prompt).toBe("Review Fix the bug");
  });

  it("uses an explicit key when provided", () => {
    const { definition } = renderDefinition({ name: "{{ title }}", key: "{{ html_url }}" }, data);
    expect(definition.key).toBe("https://github.com/o/r/pull/42");
  });

  it("coerces a string focus and warns on an invalid one", () => {
    expect(renderDefinition({ name: "x", focus: "true" }, data).definition.focus).toBe(true);
    expect(renderDefinition({ name: "x", focus: true }, data).definition.focus).toBe(true);
    const bad = renderDefinition({ name: "x", focus: "maybe" }, data);
    expect(bad.definition.focus).toBeUndefined();
    expect(bad.warnings[0]).toContain("focus");
  });

  it("builds a claude agent spec from the nested agent map", () => {
    const tpl: TemplateObject = {
      name: "x",
      prompt: "go",
      agent: {
        type: "claude",
        "permission-mode": "acceptEdits",
        model: { provider: "anthropic", id: "claude-x" },
      },
    };
    const { definition } = renderDefinition(tpl, data);
    expect(definition.agent).toEqual({
      type: "claude",
      prompt: "go",
      permissionMode: "acceptEdits",
      model: { providerID: "anthropic", modelID: "claude-x" },
    });
  });

  it("assumes claude and warns for an invalid agent.type", () => {
    const { definition, warnings } = renderDefinition({ name: "x", agent: { type: "gpt" } }, data);
    expect(definition.agent?.type).toBe("claude");
    expect(warnings.some((w) => w.includes("assuming claude"))).toBe(true);
  });

  it("ignores permission-mode for opencode with a warning", () => {
    const { definition, warnings } = renderDefinition(
      { name: "x", agent: { type: "opencode", "permission-mode": "acceptEdits" } },
      data
    );
    expect(definition.agent?.type).toBe("opencode");
    expect(warnings.some((w) => w.includes("ignored for opencode"))).toBe(true);
  });

  it("flattens flat string metadata", () => {
    const { definition } = renderDefinition(
      { name: "x", metadata: { title: "{{ title }}", note: "hi" } },
      data
    );
    expect(definition.metadata).toEqual({ title: "Fix the bug", note: "hi" });
  });

  it("JSON-stringifies a nested tag object into tags.<name>", () => {
    const tpl: TemplateObject = {
      name: "x",
      metadata: { tags: { urgent: { color: "#e74c3c" } } },
    };
    const { definition } = renderDefinition(tpl, data);
    expect(definition.metadata).toEqual({ "tags.urgent": '{"color":"#e74c3c"}' });
  });

  it("drops an invalid metadata key with a warning", () => {
    const { definition, warnings } = renderDefinition({ name: "x", metadata: { _bad: "v" } }, data);
    expect(definition.metadata).toBeUndefined();
    expect(warnings.some((w) => w.includes("Invalid metadata key"))).toBe(true);
  });
});
