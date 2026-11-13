/**
 * Tests for the sidekick manifest's configuration defaults.
 *
 * VS Code gives a key pressed in a focused terminal to the workbench only when
 * its command is on `terminal.integrated.commandsToSkipShell` (plus a built-in
 * list). With the kitty keyboard protocol (on by default since VSCodium 1.126,
 * and enabled by Claude Code) xterm.js encodes Ctrl+Shift+<letter> and sends it
 * to the program, so the side-bar view shortcuts died while the agent terminal
 * had focus. The sidekick's configuration defaults put those commands back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Manifest {
  contributes: { configurationDefaults: Record<string, unknown> };
}

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf8")
) as Manifest;

describe("sidekick configuration defaults", () => {
  it("lets the side-bar view shortcuts through a focused terminal", () => {
    const skip =
      manifest.contributes.configurationDefaults["terminal.integrated.commandsToSkipShell"];

    expect(skip).toEqual(
      expect.arrayContaining([
        "workbench.view.explorer", // Ctrl+Shift+E
        "workbench.view.scm", // Ctrl+Shift+G
        "workbench.view.search", // Ctrl+Shift+F
        "workbench.view.extensions", // Ctrl+Shift+X
        "workbench.view.debug", // Ctrl+Shift+D
      ])
    );
  });

  it("does not turn off the kitty keyboard protocol the agents rely on", () => {
    expect(manifest.contributes.configurationDefaults).not.toHaveProperty(
      "terminal.integrated.enableKittyKeyboardProtocol"
    );
  });
});
