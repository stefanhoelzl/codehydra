/**
 * One output channel across every workspace's IDE, buffering until each can show it.
 *
 * Output meant for a workspace is written the moment it is produced, which is
 * often before that workspace's IDE exists (a creation's setup) or while it is
 * away (reloading, hibernated). So lines are held per workspace — bounded,
 * oldest dropped — and flushed the moment its sidekick connects.
 *
 * A workspace whose editor is gone for good (deleted) is `closed`: its buffer
 * is dropped and nothing new is held for it, so a straggling line cannot start
 * a buffer nobody will ever flush. `opening` makes it worth holding again — a
 * deletion that was refused leaves the worktree, and a later open brings its
 * editor back.
 *
 * Whatever is written here is already in the log file, which is what makes
 * dropping safe.
 */

import type { Logger } from "../boundaries/platform/logging-types";
import type { AppendOutputRequest, OutputLine } from "../shared/api-protocol";
import type { WorkspaceRef } from "../intents/contract";

/** How output reaches a workspace's IDE — the plugin server's side of `ui:appendOutput`. */
export interface OutputTransport {
  /** Send to the workspace's IDE now; false when it is not connected. */
  appendOutput(workspaceRef: WorkspaceRef, request: AppendOutputRequest): boolean;
  onWorkspaceConnected(listener: (workspaceRef: WorkspaceRef) => void): () => void;
}

export interface WorkspaceOutputOptions {
  readonly transport: OutputTransport;
  /** The channel's name in each IDE. */
  readonly channel: string;
  /** A log channel (levels, VS Code's "Set Log Level") rather than a plain one. */
  readonly log?: boolean;
  /** Most lines held for one workspace while its IDE is away. */
  readonly maxBuffered: number;
  /**
   * Coalesce the lines written in one tick into one send per workspace. For a
   * source that writes in bursts (a creation logs hundreds of lines at once).
   */
  readonly batch?: boolean;
  readonly logger: Logger;
}

export interface WorkspaceOutput {
  write(workspaceRef: WorkspaceRef, lines: readonly OutputLine[]): void;
  /** The workspace is being opened: hold its output again if it was closed. */
  opening(workspaceRef: WorkspaceRef): void;
  /** The workspace's editor is gone for good: drop its buffer, hold nothing more. */
  closed(workspaceRef: WorkspaceRef): void;
}

export function createWorkspaceOutput(options: WorkspaceOutputOptions): WorkspaceOutput {
  const { transport, channel, maxBuffered } = options;
  const buffered = new Map<WorkspaceRef, OutputLine[]>();
  // One short string per deleted workspace; see the module comment.
  const closed = new Set<WorkspaceRef>();
  /** Lines written this tick, per workspace, when batching. */
  const pending = new Map<WorkspaceRef, OutputLine[]>();
  let flushScheduled = false;

  const request = (lines: readonly OutputLine[]): AppendOutputRequest => ({
    channel,
    ...(options.log && { log: true }),
    lines,
  });

  function hold(workspaceRef: WorkspaceRef, lines: readonly OutputLine[]): void {
    if (closed.has(workspaceRef)) return;
    const held = buffered.get(workspaceRef) ?? [];
    held.push(...lines);
    if (held.length > maxBuffered) held.splice(0, held.length - maxBuffered);
    buffered.set(workspaceRef, held);
  }

  function send(workspaceRef: WorkspaceRef, lines: readonly OutputLine[]): void {
    if (closed.has(workspaceRef)) return;
    // Anything still held goes first, so the channel reads in order.
    const earlier = buffered.get(workspaceRef);
    const all = earlier ? [...earlier, ...lines] : lines;
    if (transport.appendOutput(workspaceRef, request(all))) {
      buffered.delete(workspaceRef);
      return;
    }
    if (earlier) buffered.delete(workspaceRef);
    hold(workspaceRef, all);
  }

  function flushPending(): void {
    flushScheduled = false;
    const batches = [...pending];
    pending.clear();
    for (const [workspaceRef, lines] of batches) send(workspaceRef, lines);
  }

  transport.onWorkspaceConnected((workspaceRef) => {
    const held = buffered.get(workspaceRef);
    if (!held || held.length === 0) return;
    buffered.delete(workspaceRef);
    if (!transport.appendOutput(workspaceRef, request(held))) {
      // Connected a moment ago and gone already. The log still has every line.
      options.logger
        .scoped({ workspace: workspaceRef })
        .debug("Could not flush buffered output", { channel });
    }
  });

  return {
    write(workspaceRef, lines) {
      if (!options.batch) {
        send(workspaceRef, lines);
        return;
      }
      const queued = pending.get(workspaceRef) ?? [];
      queued.push(...lines);
      pending.set(workspaceRef, queued);
      if (!flushScheduled) {
        flushScheduled = true;
        setImmediate(flushPending);
      }
    },

    opening(workspaceRef) {
      closed.delete(workspaceRef);
    },

    closed(workspaceRef) {
      closed.add(workspaceRef);
      buffered.delete(workspaceRef);
      pending.delete(workspaceRef);
    },
  };
}
