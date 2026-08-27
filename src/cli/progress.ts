/**
 * Rendering forwarded events as progress.
 *
 * Written to stderr, never stdout: stdout is the command's result, and a
 * pipeline reading it must not have progress lines mixed in. Shown only when
 * stderr is a terminal, so `ch ws create … | jq` and an agent's shell call both
 * stay clean.
 */

import type { ClientEvent } from "../api/events";

/** A line to show, or nothing when the event says nothing a person needs. */
export function renderEvent(event: ClientEvent): string | undefined {
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  switch (event.type) {
    case "clone:progress": {
      // The longest thing any command does, and the only one with a percentage.
      const stage = typeof payload.stage === "string" ? payload.stage : "cloning";
      const percent =
        typeof payload.progress === "number" ? Math.round(payload.progress) : undefined;
      const name = typeof payload.name === "string" ? payload.name : "";
      return percent === undefined
        ? `cloning ${name}: ${stage}`
        : `cloning ${name}: ${stage} ${percent}%`;
    }

    case "project:opened":
      return `opened project ${nameOf(payload.project) ?? ""}`.trimEnd();

    case "project:open-failed":
      return `could not open project: ${textOf(payload.error) ?? "unknown error"}`;

    case "workspace:loading":
      return `creating ${textOf(payload.workspaceName) ?? "workspace"}…`;

    case "workspace:created":
      // The event carries the name directly, not a nested workspace object.
      return `created ${textOf(payload.workspaceName) ?? ""}`.trimEnd();

    case "workspace:create-failed":
      return `could not create workspace: ${textOf(payload.error) ?? "unknown error"}`;

    case "workspace:deletion-progress":
      return renderDeletion(payload);

    default:
      return undefined;
  }
}

/**
 * The deletion pipeline, as the step that is currently running.
 *
 * The event carries full state every time, so rather than replaying the whole
 * list on each update this reports the step in flight — and, at the end, what
 * went wrong and what is holding the worktree open.
 */
function renderDeletion(payload: Record<string, unknown>): string | undefined {
  const operations = Array.isArray(payload.operations)
    ? (payload.operations as Record<string, unknown>[])
    : [];

  if (payload.completed === true) {
    if (payload.hasErrors !== true) return "deleted";

    const blockers = Array.isArray(payload.blockingProcesses)
      ? (payload.blockingProcesses as Record<string, unknown>[])
      : [];
    if (blockers.length > 0) {
      const list = blockers.map((p) => `${String(p.name)} (pid ${String(p.pid)})`).join(", ");
      return `blocked by ${list}`;
    }
    const failed = operations.find((op) => typeof op.error === "string");
    return failed ? `failed: ${String(failed.label)}: ${String(failed.error)}` : "failed";
  }

  const running = operations.find((op) => op.status === "running" || op.status === "in-progress");
  return running ? `${String(running.label)}…` : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nameOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return textOf((value as Record<string, unknown>).name);
}
