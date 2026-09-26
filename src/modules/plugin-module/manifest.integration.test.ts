// @vitest-environment node
/**
 * The manifest contract: what parses, what it means, and what is refused.
 */

import { describe, it, expect } from "vitest";
import { documentsFor, manifestJsonSchema, parseManifest } from "./manifest";

describe("parseManifest", () => {
  it("fills the defaults: bash, every platform; an automation is its script", () => {
    const [doc] = parseManifest(
      ["hooks:", "  on-workspace-opened: echo hi", "automations:", "  prs: ./prs.sh"].join("\n")
    );

    expect(doc).toMatchObject({
      index: 1,
      shell: "bash",
      platforms: ["linux", "windows", "macos"],
      hooks: { "on-workspace-opened": "echo hi" },
      automations: [{ name: "prs", script: "./prs.sh" }],
    });
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
      "an automation that is not a script",
      "automations:\n  a:\n    action: workspace.create\n    script: x\n",
      /automations\.a/,
    ],
    ["an automation name that is not plain", "automations:\n  a b: x\n", /automation names/],
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
