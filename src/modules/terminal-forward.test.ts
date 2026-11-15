/**
 * `terminal.forward` against the sidekick manifest: CodeHydra may only offer
 * keys the manifest has a forwarding keybinding for.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { storeEnumList } from "../boundaries/platform/store-definition";
import {
  TERMINAL_FORWARD_DEFAULT,
  TERMINAL_FORWARD_KEYS,
  terminalForwardKeys,
} from "./terminal-forward";

interface Manifest {
  contributes: { keybindings: { key: string; command: string }[] };
}

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "../../extensions/sidekick/package.json"), "utf8")
) as Manifest;

describe("terminal.forward", () => {
  it("offers exactly the keys the sidekick can forward", () => {
    const forwarded = manifest.contributes.keybindings
      .filter((b) => b.command === "workbench.action.terminal.sendSequence")
      .map((b) => b.key);
    expect([...TERMINAL_FORWARD_KEYS].sort()).toEqual([...forwarded].sort());
  });

  it("has a default in the form the config store keeps", () => {
    expect(storeEnumList(TERMINAL_FORWARD_KEYS).validate(TERMINAL_FORWARD_DEFAULT)).toBe(
      TERMINAL_FORWARD_DEFAULT
    );
  });

  it("turns the config value into the list the sidekick gets", () => {
    expect(terminalForwardKeys("ctrl+shift+d,shift+enter")).toEqual([
      "ctrl+shift+d",
      "shift+enter",
    ]);
  });
});
