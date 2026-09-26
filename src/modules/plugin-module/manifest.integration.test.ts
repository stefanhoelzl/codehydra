// @vitest-environment node
/**
 * The manifest contract: what parses, what it means, and what is refused.
 */

import { describe, it, expect } from "vitest";
import { documentsFor, manifestJsonSchema, parseManifest } from "./manifest";

describe("parseManifest", () => {
  it("fills the defaults: bash, every platform, workspace.create reconciled", () => {
    const [doc] = parseManifest(
      [
        "hooks:",
        "  on-workspace-opened: echo hi",
        "automations:",
        "  prs:",
        "    script: gh pr list --json title",
        '    template: { name: "{{ title }}" }',
      ].join("\n")
    );

    expect(doc).toMatchObject({
      index: 1,
      shell: "bash",
      platforms: ["linux", "windows", "macos"],
      hooks: { "on-workspace-opened": "echo hi" },
      automations: [{ name: "prs", action: "workspace.create", mode: "workspaces" }],
    });
  });

  it("makes any other action fire per item", () => {
    const [doc] = parseManifest(
      [
        "automations:",
        "  stale:",
        "    action: workspace.hibernate",
        "    script: ./find-stale",
        '    template: { workspace: "{{ ws }}" }',
      ].join("\n")
    );

    expect(doc?.automations[0]).toMatchObject({ action: "workspace.hibernate", mode: "events" });
  });

  it("reads a stream of documents, skipping empty ones", () => {
    const docs = parseManifest("shell: cmd\nplatform: windows\n---\nplatform: [linux]\n---\n");

    expect(docs.map((doc) => [doc.index, doc.shell, doc.platforms])).toEqual([
      [1, "cmd", ["windows"]],
      [2, "bash", ["linux"]],
    ]);
    expect(documentsFor(docs, "linux").map((doc) => doc.index)).toEqual([2]);
    expect(documentsFor(docs, "win32").map((doc) => doc.index)).toEqual([1]);
  });

  it.each([
    ["an unknown section", "triggers: {}\n", /document 1: unknown key triggers/],
    ["an unknown hook", "hooks:\n  after-open: x\n", /hooks: unknown key after-open/],
    ["an unknown shell", "shell: zsh\n", /document 1: shell:/],
    [
      "an action no automation may run",
      "automations:\n  a:\n    action: config.set\n    script: x\n    template: {}\n",
      /automations\.a\.action/,
    ],
    [
      "reconciling anything but workspace.create",
      "automations:\n  a:\n    action: workspace.wake\n    mode: workspaces\n    script: x\n    template: {}\n",
      /mode: workspaces only applies to workspace\.create/,
    ],
    [
      "a workspace.create without a name",
      "automations:\n  a:\n    script: x\n    template: { base: main }\n",
      /workspace\.create needs template\.name/,
    ],
    [
      "invalid Liquid",
      'automations:\n  a:\n    script: x\n    template: { name: "{{ title" }\n',
      /invalid Liquid/,
    ],
    [
      "an automation name that is not plain",
      "automations:\n  a b:\n    script: x\n    template: { name: x }\n",
      /automation names/,
    ],
    ["broken YAML", "hooks: [\n", /document 1:/],
    ["the second document", "hooks: {}\n---\nshell: fish\n", /document 2:/],
  ])("refuses %s", (_what, text, message) => {
    expect(() => parseManifest(text)).toThrow(message);
  });
});

describe("manifestJsonSchema", () => {
  it("is strict and lists every contribution kind", () => {
    const schema = manifestJsonSchema();

    expect(schema["additionalProperties"]).toBe(false);
    const properties = schema["properties"] as Record<string, { properties?: object }>;
    expect(Object.keys(properties.hooks?.properties ?? {})).toEqual([
      "after-worktree-created",
      "before-workspace-opened",
      "before-worktree-deleted",
      "on-workspace-opened",
    ]);
  });
});
