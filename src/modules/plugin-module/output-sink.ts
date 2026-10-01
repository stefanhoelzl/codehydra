/**
 * Where a plugin hook's output goes.
 *
 * A hook's output is written for a person, and the place that person will look
 * is the workspace it belongs to — so its stderr and stdout land in a
 * `CodeHydra Plugins` output channel in that workspace's IDE (the run's log
 * file has them too).
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
 * so (`closed`) before that hook runs, so its lines reach the run log — and,
 * on failure, the deletion progress row — but are never held for an IDE that
 * will not connect. A deleted workspace's buffer is dropped the same way. Only
 * an open (`opening`) makes a closed workspace's output worth holding again:
 * a deletion that was refused while its project closed leaves the worktree on
 * disk, and the next project open brings its editor back.
 */

import type { WorkspaceRef } from "../../intents/contract";
import type { Logger } from "../../boundaries/platform/logging-types";
import { createWorkspaceOutput, type OutputTransport } from "../workspace-output";

/** Where a hook's output should be shown, beyond its run log. */
export interface HookOutputSink {
  /** One line of a hook's output, tagged with the plugin and entry that produced it. */
  write(workspaceRef: WorkspaceRef, source: string, line: string): void;
  /** The workspace is opening: its editor is on the way, so hold output for it. */
  opening(workspaceRef: WorkspaceRef): void;
  /**
   * The workspace's editor is gone and is not coming back (torn down for a
   * deletion, or the workspace is deleted): drop what is held for it, and hold
   * nothing more until it opens again. The run log keeps every line regardless.
   */
  closed(workspaceRef: WorkspaceRef): void;
}

/** The channel plugin hook output appears in. */
export const HOOK_OUTPUT_CHANNEL = "CodeHydra Plugins";

/**
 * Most a single workspace may hold while its IDE starts.
 *
 * A setup hook running a build can print thousands of lines, and a workspace
 * whose creation failed never connects at all — so the buffer is bounded and
 * drops the oldest lines. The log file has the full record either way, which is
 * what makes discarding here safe.
 */
const MAX_BUFFERED_LINES = 500;

export interface HookOutputSinkDeps {
  readonly transport: OutputTransport;
  readonly logger: Logger;
}

/**
 * A sink that writes to a workspace's IDE, buffering until it can.
 *
 * Every line is in the run's log file before it reaches here, so nothing a hook
 * printed is ever only in a buffer that might be dropped.
 */
export function createHookOutputSink(deps: HookOutputSinkDeps): HookOutputSink {
  const output = createWorkspaceOutput({
    transport: deps.transport,
    channel: HOOK_OUTPUT_CHANNEL,
    maxBuffered: MAX_BUFFERED_LINES,
    logger: deps.logger,
  });
  return {
    write(workspaceRef: WorkspaceRef, source: string, line: string): void {
      output.write(workspaceRef, [{ source, text: line }]);
    },
    opening: (workspaceRef) => output.opening(workspaceRef),
    closed: (workspaceRef) => output.closed(workspaceRef),
  };
}
