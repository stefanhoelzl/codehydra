/**
 * Domain events forwarded to out-of-process clients.
 *
 * The registry answers questions; these are the things that happen while it is
 * answering. A `ch ws delete` runs a multi-step pipeline and a `ch project open
 * <url>` clones from the network — both take long enough that silence reads as
 * a hang, and both already emit exactly the detail a caller wants.
 *
 * Forwarding is opt-in per event rather than a firehose: an event reaches a
 * client only if it is named here, so adding one is a decision rather than a
 * side effect of emitting it.
 */

/** Channel non-sidekick clients receive forwarded events on. */
export const EVENT_CHANNEL = "api:event";

/** One forwarded event, as it appears on the wire. */
export interface ClientEvent {
  readonly type: string;
  readonly payload: unknown;
}

/**
 * The events clients may see.
 *
 * Deliberately narrow: progress and outcomes for the operations that take long
 * enough to need them. Status churn (`agent:status-updated`) is left out — it
 * fires constantly and tells a CLI caller nothing about the command it ran.
 */
export const FORWARDED_EVENTS = [
  // Cloning, which is the longest thing any command does.
  "clone:progress",
  "project:opened",
  "project:open-failed",
  // Workspace creation: worktree, then IDE server, then agent.
  "workspace:loading",
  "workspace:created",
  "workspace:create-failed",
  // Deletion reports full state on every step, including what is blocking it.
  "workspace:deletion-progress",
] as const;

export type ForwardedEvent = (typeof FORWARDED_EVENTS)[number];

/**
 * The workspace an event concerns, when it names one.
 *
 * Used to keep a workspace-scoped client from seeing another workspace's
 * activity. An event with no workspace — a clone, a project opening — concerns
 * the instance as a whole and reaches every client.
 */
export function eventWorkspacePath(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;

  if (typeof record.workspacePath === "string") return record.workspacePath;
  // workspace:created carries the workspace itself rather than a bare path.
  const workspace = record.workspace;
  if (workspace !== null && typeof workspace === "object") {
    const path = (workspace as Record<string, unknown>).path;
    if (typeof path === "string") return path;
  }
  return undefined;
}
