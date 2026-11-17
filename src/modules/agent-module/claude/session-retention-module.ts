/**
 * Session retention — keeps a hibernated workspace's Claude session resumable.
 *
 * Claude Code deletes session transcripts older than `cleanupPeriodDays`
 * (default 30) in a sweep after any session starts, in any directory. A
 * hibernated workspace's transcript stops changing, so a workspace that sleeps
 * past that period wakes to `claude --continue` finding nothing, and the
 * wrapper starts an empty session.
 *
 * This module raises `cleanupPeriodDays` in the settings file CodeHydra passes
 * every Claude it launches (`--settings`, which overrides the user's own
 * files; managed settings still win) far enough to cover the oldest hibernated
 * workspace in the open projects. It recomputes whenever that set can change:
 * a project opens or closes, a workspace hibernates, wakes or is deleted.
 *
 * Not covered: workspaces hibernated before `hibernated-at` was recorded (their
 * age is unknown), hibernated workspaces of closed projects, and sweeps run by
 * a `claude` started outside CodeHydra, which still use the user's setting.
 */

import type { Dispatcher } from "../../../intents/lib/dispatcher";
import type { IntentModule } from "../../../intents/lib/module";
import type { Logger } from "../../../boundaries/platform/logging-types";
import { defineEvents } from "../../../intents/declarations";
import { INTENT_LIST_PROJECTS, type ListProjectsIntent } from "../../../intents/list-projects";
import { EVENT_PROJECT_OPENED } from "../../../intents/open-project";
import { EVENT_PROJECT_CLOSED } from "../../../intents/close-project";
import {
  EVENT_WORKSPACE_HIBERNATED,
  HIBERNATED_AT_METADATA_KEY,
  HIBERNATED_METADATA_KEY,
} from "../../../intents/hibernate-workspace";
import { EVENT_WORKSPACE_WOKEN } from "../../../intents/wake-workspace";
import { EVENT_WORKSPACE_DELETED } from "../../../intents/delete-workspace";
import type { Project } from "../../../shared/api/types";
import { getErrorMessage } from "../../../shared/error-utils";
import type { ClaudeCodeServerManager } from "./server-manager";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Claude Code's own default for `cleanupPeriodDays`. */
export const CLAUDE_DEFAULT_CLEANUP_DAYS = 30;

/**
 * Days added to the oldest hibernation's age. A transcript can be up to the
 * default period old when its workspace hibernates (it survived the sweeps
 * until then), and the value written now must still hold if the app runs that
 * long again without recomputing it: one default period for each.
 */
export const RETENTION_MARGIN_DAYS = 2 * CLAUDE_DEFAULT_CLEANUP_DAYS;

/**
 * The `cleanupPeriodDays` that keeps every hibernated workspace's transcript,
 * or undefined when Claude's default already does (no hibernation timestamps).
 *
 * @param hibernatedAt - `hibernated-at` values (ISO-8601); unparsable ones are skipped
 * @param now - Current time (ms since epoch)
 */
export function cleanupPeriodDaysFor(
  hibernatedAt: readonly string[],
  now: number
): number | undefined {
  const times = hibernatedAt.map((value) => Date.parse(value)).filter((t) => !Number.isNaN(t));
  if (times.length === 0) return undefined;
  const ageDays = Math.max(0, Math.ceil((now - Math.min(...times)) / DAY_MS));
  const days = ageDays + RETENTION_MARGIN_DAYS;
  return days > CLAUDE_DEFAULT_CLEANUP_DAYS ? days : undefined;
}

/** The `hibernated-at` of every hibernated workspace in `projects`. */
function hibernationTimes(projects: readonly Project[]): string[] {
  const times: string[] = [];
  for (const project of projects) {
    for (const workspace of project.workspaces) {
      if (workspace.metadata[HIBERNATED_METADATA_KEY] !== "true") continue;
      const at = workspace.metadata[HIBERNATED_AT_METADATA_KEY];
      if (at !== undefined) times.push(at);
    }
  }
  return times;
}

export interface SessionRetentionModuleDeps {
  readonly dispatcher: Dispatcher;
  readonly serverManager: Pick<ClaudeCodeServerManager, "setCleanupPeriodDays">;
  readonly logger: Logger;
  /** Current time (ms since epoch); injectable for tests. */
  readonly now?: () => number;
}

export function createSessionRetentionModule(deps: SessionRetentionModuleDeps): IntentModule {
  const now = deps.now ?? Date.now;

  /**
   * Recompute from the open projects. `extra` adds a project the list may not
   * carry yet (the one `project:opened` announces).
   */
  async function refresh(extra?: Project): Promise<void> {
    try {
      const projects =
        (await deps.dispatcher.dispatch<ListProjectsIntent>({
          type: INTENT_LIST_PROJECTS,
          payload: {},
        })) ?? [];
      const all =
        extra === undefined || projects.some((p) => p.ref === extra.ref)
          ? projects
          : [...projects, extra];
      await deps.serverManager.setCleanupPeriodDays(
        cleanupPeriodDaysFor(hibernationTimes(all), now())
      );
    } catch (error) {
      deps.logger.warn("Could not update Claude session retention", {
        error: getErrorMessage(error),
      });
    }
  }

  const events = defineEvents({
    [EVENT_PROJECT_OPENED]: { handler: (event) => refresh(event.payload.project) },
    [EVENT_PROJECT_CLOSED]: { handler: () => refresh() },
    [EVENT_WORKSPACE_HIBERNATED]: { handler: () => refresh() },
    [EVENT_WORKSPACE_WOKEN]: { handler: () => refresh() },
    [EVENT_WORKSPACE_DELETED]: { handler: () => refresh() },
  });

  return { name: "claude-session-retention", events };
}
