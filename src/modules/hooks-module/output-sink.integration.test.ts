// @vitest-environment node
/**
 * Integration tests for the hook output sink: what is held for a workspace
 * whose editor has not connected yet, and when it is let go.
 */

import { describe, it, expect } from "vitest";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createHookOutputSink, HOOK_OUTPUT_CHANNEL } from "./output-sink";

const WS = "/workspaces/feature-x";

/** A plugin server stand-in: workspaces are connected or not, and appends land in `shown`. */
function createTransport() {
  const connected = new Set<string>();
  const shown: Array<{ workspacePath: string; channel: string; lines: string[] }> = [];
  let onConnected: (workspacePath: string) => void = () => {};
  return {
    shown,
    connect(workspacePath: string): void {
      connected.add(workspacePath);
      onConnected(workspacePath);
    },
    transport: {
      appendOutput(
        workspacePath: string,
        request: { channel: string; lines: readonly { source: string; text: string }[] }
      ): boolean {
        if (!connected.has(workspacePath)) return false;
        shown.push({
          workspacePath,
          channel: request.channel,
          lines: request.lines.map((line) => `${line.source}: ${line.text}`),
        });
        return true;
      },
      onWorkspaceConnected(listener: (workspacePath: string) => void): () => void {
        onConnected = listener;
        return () => {};
      },
    },
  };
}

describe("hook output sink", () => {
  it("holds a workspace's lines until its editor connects, then shows them", () => {
    const host = createTransport();
    const sink = createHookOutputSink({ transport: host.transport, logger: SILENT_LOGGER });

    sink.opening(WS);
    sink.write(WS, "after-worktree-created", "installing");
    expect(host.shown).toEqual([]);

    host.connect(WS);
    expect(host.shown).toEqual([
      {
        workspacePath: WS,
        channel: HOOK_OUTPUT_CHANNEL,
        lines: ["after-worktree-created: installing"],
      },
    ]);
  });

  it("drops what it held for a workspace that is deleted", () => {
    const host = createTransport();
    const sink = createHookOutputSink({ transport: host.transport, logger: SILENT_LOGGER });

    sink.write(WS, "after-worktree-created", "installing");
    sink.closed(WS);
    host.connect(WS);

    expect(host.shown).toEqual([]);
  });

  it("holds nothing for a workspace whose editor is gone for good", () => {
    const host = createTransport();
    const sink = createHookOutputSink({ transport: host.transport, logger: SILENT_LOGGER });

    sink.closed(WS);
    sink.write(WS, "before-worktree-deleted", "checking the lock");
    sink.opening(WS);
    host.connect(WS);

    // Written while closed, so never held — reopening does not resurrect it.
    expect(host.shown).toEqual([]);
  });

  it("holds output again once a closed workspace opens again", () => {
    const host = createTransport();
    const sink = createHookOutputSink({ transport: host.transport, logger: SILENT_LOGGER });

    sink.closed(WS);
    sink.opening(WS);
    sink.write(WS, "before-workspace-opened", "minting a token");
    host.connect(WS);

    expect(host.shown.map((entry) => entry.lines)).toEqual([
      ["before-workspace-opened: minting a token"],
    ]);
  });

  it("writes straight through to a connected editor", () => {
    const host = createTransport();
    const sink = createHookOutputSink({ transport: host.transport, logger: SILENT_LOGGER });

    host.connect(WS);
    sink.write(WS, "on-workspace-opened", "registered");

    expect(host.shown.map((entry) => entry.lines)).toEqual([["on-workspace-opened: registered"]]);
  });

  it("keeps only the newest 500 lines while waiting", () => {
    const host = createTransport();
    const sink = createHookOutputSink({ transport: host.transport, logger: SILENT_LOGGER });

    for (let i = 0; i < 501; i++) sink.write(WS, "after-worktree-created", `line ${i}`);
    host.connect(WS);

    const lines = host.shown[0]!.lines;
    expect(lines).toHaveLength(500);
    expect(lines[0]).toBe("after-worktree-created: line 1");
  });
});
