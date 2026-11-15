/**
 * `terminal.forward`: the keys the agent terminal sends to the agent instead of
 * the editor.
 *
 * The sidekick turns the terminal's kitty keyboard protocol off, so every
 * editor shortcut reaches the editor again. Keys an agent wants that have no
 * legacy terminal encoding are forwarded instead: the sidekick's manifest
 * carries one keybinding per key in {@link TERMINAL_FORWARD_KEYS}, which sends
 * the key's kitty encoding to the agent terminal while the key is listed. The
 * list reaches the sidekick in its `config` message (`ApiConfig.terminalForward`),
 * which it publishes as the `codehydra.terminalForward` context key.
 *
 * Keep {@link TERMINAL_FORWARD_KEYS} in step with the manifest's keybindings
 * (checked by `terminal-forward.test.ts`).
 */

/** The keys that can be forwarded, in VS Code keybinding syntax. */
export const TERMINAL_FORWARD_KEYS: readonly string[] = [
  "shift+enter",
  "ctrl+enter",
  "ctrl+shift+enter",
  "shift+space",
  "ctrl+tab",
  "ctrl+shift+tab",
  ..."abcdefghijklmnopqrstuvwxyz".split("").map((letter) => `ctrl+shift+${letter}`),
];

/**
 * The agents' keys that no editor shortcut needs while a terminal has focus: a
 * default must not take a shortcut away. Ctrl+Enter matters most: unforwarded
 * it arrives as a plain Enter and submits instead of adding a line. Normalized
 * as `storeEnumList` stores it (sorted, comma-separated).
 */
export const TERMINAL_FORWARD_DEFAULT = "ctrl+enter,ctrl+shift+a,shift+enter,shift+space";

/** The `terminal.forward` value as the list `ApiConfig.terminalForward` carries. */
export function terminalForwardKeys(value: string): string[] {
  return value.split(",").filter((key) => key.length > 0);
}
