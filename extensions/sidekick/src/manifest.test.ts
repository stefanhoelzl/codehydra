/**
 * Tests for the sidekick manifest's terminal keyboard setup.
 *
 * The kitty keyboard protocol is off: with it on, xterm.js encodes keys such as
 * Ctrl+Shift+E and sends them to the program in the focused terminal, so every
 * editor shortcut without a legacy terminal encoding died while the agent
 * terminal had focus. The keys an agent does want (Shift+Enter, …) are listed in
 * CodeHydra's `terminal.forward` config, which reaches the sidekick in its
 * `config` message and is published as the `codehydra.terminalForward` context
 * key, a JSON array string. One keybinding per forwardable key sends its kitty
 * encoding to the agent terminal while its when clause finds the key, quoted, in
 * that string. CodeHydra's key list is checked against these bindings in
 * `src/modules/terminal-forward.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Keybinding {
  key: string;
  command: string;
  args?: { text?: string };
  when?: string;
}

interface Manifest {
  contributes: {
    configurationDefaults: Record<string, unknown>;
    keybindings: Keybinding[];
  };
}

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf8")
) as Manifest;

const forwarders = manifest.contributes.keybindings.filter(
  (b) => b.command === "workbench.action.terminal.sendSequence"
);
const forwardable = forwarders.map((b) => b.key);

/** The kitty keyboard protocol's CSI u encoding of a key (disambiguate mode). */
function kittyEncoding(key: string): string {
  const parts = key.split("+");
  const name = parts.pop()!;
  const code = { enter: 13, tab: 9, space: 32 }[name] ?? name.charCodeAt(0);
  const modifiers =
    1 +
    (parts.includes("shift") ? 1 : 0) +
    (parts.includes("alt") ? 2 : 0) +
    (parts.includes("ctrl") ? 4 : 0);
  return `\x1b[${code};${modifiers}u`;
}

/** Whether a binding's when clause lets it fire for the given forwarded keys. */
function firesFor(binding: Keybinding, value: string[]): boolean {
  const match = /=~ \/(.*)\/(\w*)$/.exec(binding.when ?? "");
  expect(match, `when clause of ${binding.key}`).not.toBeNull();
  return new RegExp(match![1]!, match![2]).test(JSON.stringify(value));
}

describe("sidekick terminal keyboard setup", () => {
  it("turns the kitty keyboard protocol off", () => {
    expect(
      manifest.contributes.configurationDefaults["terminal.integrated.enableKittyKeyboardProtocol"]
    ).toBe(false);
  });

  it("has one forwarding keybinding per key", () => {
    expect(new Set(forwardable).size).toBe(forwardable.length);
  });

  it.each(forwardable)("forwards %s as its kitty encoding", (key) => {
    const binding = forwarders.find((b) => b.key === key)!;
    expect(binding.args?.text).toBe(kittyEncoding(key));
  });

  // terminalEditorFocus is VS Code's own focus state: CodeHydra opens only the
  // agent terminal in the editor area. (`window.activeTerminal` is not: a panel
  // terminal revived after a restart becomes "active" without taking focus.)
  it.each(forwardable)("forwards %s only from a focused terminal in the editor area", (key) => {
    const binding = forwarders.find((b) => b.key === key)!;
    expect(binding.when).toMatch(/^terminalEditorFocus && codehydra\.terminalForward =~ /);
  });

  it.each(forwardable)("forwards %s only while it is listed", (key) => {
    const binding = forwarders.find((b) => b.key === key)!;
    const others = forwardable.filter((k) => k !== key);

    expect(firesFor(binding, [key])).toBe(true);
    expect(firesFor(binding, [key.toUpperCase()])).toBe(true);
    expect(firesFor(binding, [...others, key])).toBe(true);
    expect(firesFor(binding, others)).toBe(false);
    expect(firesFor(binding, [])).toBe(false);
  });
});
