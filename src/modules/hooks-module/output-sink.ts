/**
 * Where a hook's human output goes.
 *
 * A hook's stderr is written for a person, and the place that person will look
 * is the workspace it belongs to — so it lands in a `CodeHydra Hooks` output
 * channel in that workspace's IDE.
 *
 * The catch is timing: the open hooks (`after-worktree-created`,
 * `before-workspace-opened`) produce their output *before* the IDE that will
 * show it exists, since they run ahead of `setup` and the `.code-workspace`
 * file is written at `finalize`. So lines are buffered per workspace and
 * flushed the moment that workspace's sidekick connects, which makes the
 * workspace open with its own setup log already in the channel.
 *
 * `before-worktree-deleted` is the opposite case and has no answer: its IDE was
 * torn down in the shutdown stage and is not coming back. The hooks module says
 * so (`closed`) before that hook runs, so its lines reach the log file — and,
 * on failure, the deletion progress row — but are never held for an IDE that
 * will not connect. A deleted workspace's buffer is dropped the same way. Only
 * an open (`opening`) makes a closed workspace's output worth holding again:
 * a deletion that was refused while its project closed leaves the worktree on
 * disk, and the next project open brings its editor back.
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
 * The runner logs every line before it reaches here, so nothing a hook printed
 * is ever only in a buffer that might be dropped.
 */
export function createHookOutputSink(deps: HookOutputSinkDeps): HookOutputSink {
  const buffered = new Map<string, { source: string; text: string }[]>();
  // Workspaces whose editor is gone for good. A path stays here after its
  // workspace is deleted, so a straggling fire-and-forget hook cannot start a
  // buffer nobody will ever flush; one short string per deleted workspace.
  const closed = new Set<string>();

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
      if (closed.has(workspacePath)) return;

      const pending = buffered.get(workspacePath) ?? [];
      pending.push(payload);
      if (pending.length > MAX_BUFFERED_LINES) {
        pending.splice(0, pending.length - MAX_BUFFERED_LINES);
      }
      buffered.set(workspacePath, pending);
    },

    opening(workspacePath: string): void {
      closed.delete(workspacePath);
    },

    closed(workspacePath: string): void {
      closed.add(workspacePath);
      buffered.delete(workspacePath);
    },
  };
}
