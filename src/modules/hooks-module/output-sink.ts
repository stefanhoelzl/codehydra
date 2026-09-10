/**
 * Where a hook's human output goes.
 *
 * A hook's stderr is written for a person, and the place that person will look
 * is the workspace it belongs to — so it lands in a `CodeHydra Hooks` output
 * channel in that workspace's IDE.
 *
 * The catch is timing: `after-worktree-created` produces its output *before*
 * the IDE that will show it exists, since it runs during `setup` and the
 * `.code-workspace` file is written at `finalize`. So lines are buffered per
 * workspace and flushed the moment that workspace's sidekick connects, which
 * makes the new workspace open with its own setup log already in the channel.
 *
 * `before-worktree-deleted` is the opposite case and has no answer: its IDE was
 * torn down in the shutdown stage and is not coming back. Its output reaches
 * the log file and the deletion progress row's error text, and its buffer is
 * dropped rather than kept for an IDE that will never connect.
 */

import type { Logger } from "../../boundaries/platform/logging-types";
import type { HookOutputSink } from "./runner";

/** The channel a repository's hook output appears in. */
export const HOOK_OUTPUT_CHANNEL = "CodeHydra Hooks";

/**
 * Most a single workspace may hold while its IDE starts.
 *
 * A setup hook running a build can print thousands of lines, and a workspace
 * whose creation failed never connects at all — so the buffer is bounded and
 * drops the oldest lines. The log file has the full record either way, which is
 * what makes discarding here safe.
 */
const MAX_BUFFERED_LINES = 500;

interface OutputTransport {
  appendOutput(
    workspacePath: string,
    request: { channel: string; lines: readonly { source: string; text: string }[] }
  ): boolean;
  onWorkspaceConnected(listener: (workspacePath: string) => void): () => void;
}

export interface HookOutputSinkDeps {
  readonly transport: OutputTransport;
  readonly logger: Logger;
}

/**
 * A sink that writes to a workspace's IDE, buffering until it can.
 *
 * Everything also goes to the log at debug, so nothing a hook printed is ever
 * only in a buffer that might be dropped.
 */
export function createHookOutputSink(deps: HookOutputSinkDeps): HookOutputSink {
  const buffered = new Map<string, { source: string; text: string }[]>();

  deps.transport.onWorkspaceConnected((workspacePath) => {
    const pending = buffered.get(workspacePath);
    if (!pending || pending.length === 0) return;
    buffered.delete(workspacePath);
    if (
      !deps.transport.appendOutput(workspacePath, { channel: HOOK_OUTPUT_CHANNEL, lines: pending })
    ) {
      // Connected a moment ago and gone already. The log still has every line.
      deps.logger.debug("Could not flush buffered hook output", { workspace: workspacePath });
    }
  });

  return {
    write(workspacePath: string, entry: string, line: string): void {
      const payload = { source: entry, text: line };
      if (
        deps.transport.appendOutput(workspacePath, {
          channel: HOOK_OUTPUT_CHANNEL,
          lines: [payload],
        })
      ) {
        return;
      }

      const pending = buffered.get(workspacePath) ?? [];
      pending.push(payload);
      if (pending.length > MAX_BUFFERED_LINES) {
        pending.splice(0, pending.length - MAX_BUFFERED_LINES);
      }
      buffered.set(workspacePath, pending);
    },
  };
}
