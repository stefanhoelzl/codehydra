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

/** How output reaches a workspace's IDE — the plugin server's side of `ui:appendOutput`. */
export interface OutputTransport {
  /** Send to the workspace's IDE now; false when it is not connected. */
  appendOutput(workspacePath: string, request: AppendOutputRequest): boolean;
  onWorkspaceConnected(listener: (workspacePath: string) => void): () => void;
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
  write(workspacePath: string, lines: readonly OutputLine[]): void;
  /** The workspace is being opened: hold its output again if it was closed. */
  opening(workspacePath: string): void;
  /** The workspace's editor is gone for good: drop its buffer, hold nothing more. */
  closed(workspacePath: string): void;
}

export function createWorkspaceOutput(options: WorkspaceOutputOptions): WorkspaceOutput {
  const { transport, channel, maxBuffered } = options;
  const buffered = new Map<string, OutputLine[]>();
  // One short string per deleted workspace; see the module comment.
  const closed = new Set<string>();
  /** Lines written this tick, per workspace, when batching. */
  const pending = new Map<string, OutputLine[]>();
  let flushScheduled = false;

  const request = (lines: readonly OutputLine[]): AppendOutputRequest => ({
    channel,
    ...(options.log && { log: true }),
    lines,
  });

  function hold(workspacePath: string, lines: readonly OutputLine[]): void {
    if (closed.has(workspacePath)) return;
    const held = buffered.get(workspacePath) ?? [];
    held.push(...lines);
    if (held.length > maxBuffered) held.splice(0, held.length - maxBuffered);
    buffered.set(workspacePath, held);
  }

  function send(workspacePath: string, lines: readonly OutputLine[]): void {
    if (closed.has(workspacePath)) return;
    // Anything still held goes first, so the channel reads in order.
    const earlier = buffered.get(workspacePath);
    const all = earlier ? [...earlier, ...lines] : lines;
    if (transport.appendOutput(workspacePath, request(all))) {
      buffered.delete(workspacePath);
      return;
    }
    if (earlier) buffered.delete(workspacePath);
    hold(workspacePath, all);
  }

  function flushPending(): void {
    flushScheduled = false;
    const batches = [...pending];
    pending.clear();
    for (const [workspacePath, lines] of batches) send(workspacePath, lines);
  }

  transport.onWorkspaceConnected((workspacePath) => {
    const held = buffered.get(workspacePath);
    if (!held || held.length === 0) return;
    buffered.delete(workspacePath);
    if (!transport.appendOutput(workspacePath, request(held))) {
      // Connected a moment ago and gone already. The log still has every line.
      options.logger
        .scoped({ path: workspacePath })
        .debug("Could not flush buffered output", { channel });
    }
  });

  return {
    write(workspacePath, lines) {
      if (!options.batch) {
        send(workspacePath, lines);
        return;
      }
      const queued = pending.get(workspacePath) ?? [];
      queued.push(...lines);
      pending.set(workspacePath, queued);
      if (!flushScheduled) {
        flushScheduled = true;
        setImmediate(flushPending);
      }
    },

    opening(workspacePath) {
      closed.delete(workspacePath);
    },

    closed(workspacePath) {
      closed.add(workspacePath);
      buffered.delete(workspacePath);
      pending.delete(workspacePath);
    },
  };
}
