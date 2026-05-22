/**
 * PowerModule - Prevents the OS from sleeping while any workspace is busy.
 *
 * Mirrors the badge module: it keeps a per-workspace status map, aggregates an
 * app-wide "is anything working?" signal, and drives a single sink — here, the
 * OS sleep blocker via AppBoundary.allowPowerSaving().
 *
 * Behavior: while at least one workspace's agent is "busy" or "mixed", the OS is
 * kept awake (display-sleep blocker). When all workspaces are "idle"/"none" or
 * offline (hibernated/deleted), the OS may sleep normally.
 *
 * Subscribes to:
 * - agent:status-updated: updates internal map, re-aggregates, toggles the blocker.
 *   (Hibernation tears down the agent server, which fires status "none" before
 *   the workspace:hibernated event, so a hibernating busy workspace releases the
 *   blocker without any extra handling here.)
 * - workspace:deleted: evicts the workspace from the map, re-aggregates. Covers
 *   both full deletion and project:close runtime teardown, which both emit it.
 *
 * Hooks:
 * - app-shutdown/stop: releases the blocker (allowPowerSaving(true)).
 *
 * Gating: the feature is controlled by the `experimental.prevent-sleep` config key
 * (default true). When disabled, the module still tracks state but never toggles
 * the blocker — matching the always-register + internal-check pattern used by
 * debug-module / electron-lifecycle-module.
 */

import type { IntentModule } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { AgentStatusUpdatedEvent } from "../intents/update-agent-status";
import { EVENT_AGENT_STATUS_UPDATED } from "../intents/update-agent-status";
import type { WorkspaceDeletedEvent } from "../intents/delete-workspace";
import { EVENT_WORKSPACE_DELETED } from "../intents/delete-workspace";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import type { WorkspacePath, AggregatedAgentStatus } from "../shared/ipc";
import type { AppBoundary } from "../boundaries/shell/app";
import type { Config } from "../boundaries/platform/config";
import { configBoolean } from "../boundaries/platform/config-definition";
import type { Logger } from "../boundaries/platform/logging";

// =============================================================================
// Config
// =============================================================================

export const PREVENT_SLEEP_CONFIG_KEY = "experimental.prevent-sleep";

// =============================================================================
// Aggregation (pure function)
// =============================================================================

/**
 * Determines whether the OS should be prevented from sleeping.
 *
 * Returns true when at least one workspace has active work in progress, i.e. a
 * "busy" or "mixed" status. "idle" and "none" do not count, so workspaces that
 * are waiting for input, have no agent, or have gone offline allow the OS to sleep.
 *
 * @param statuses - Map of workspace paths to their aggregated statuses
 * @returns true if sleep should be prevented
 */
export function shouldPreventSleep(
  statuses: ReadonlyMap<WorkspacePath, AggregatedAgentStatus>
): boolean {
  for (const status of statuses.values()) {
    if (status.status === "busy" || status.status === "mixed") {
      return true;
    }
  }
  return false;
}

// =============================================================================
// Dependencies
// =============================================================================

export interface PowerModuleDeps {
  readonly appLayer: AppBoundary;
  readonly configService: Config;
  readonly logger: Logger;
}

// =============================================================================
// Module Factory
// =============================================================================

/**
 * Create a power module that prevents OS sleep while any workspace is busy.
 *
 * @param deps - AppBoundary (sleep blocker), config service, logger
 * @returns IntentModule with event subscriptions and a shutdown hook
 */
export function createPowerModule(deps: PowerModuleDeps): IntentModule {
  const { appLayer, configService, logger } = deps;

  configService.register(PREVENT_SLEEP_CONFIG_KEY, {
    name: PREVENT_SLEEP_CONFIG_KEY,
    default: true,
    description: "Prevent the OS from sleeping while any workspace's agent is busy",
    ...configBoolean(),
  });

  const workspaceStatuses = new Map<WorkspacePath, AggregatedAgentStatus>();

  function isEnabled(): boolean {
    return configService.get(PREVENT_SLEEP_CONFIG_KEY) === true;
  }

  function applyBlocker(): void {
    if (!isEnabled()) return;
    const prevent = shouldPreventSleep(workspaceStatuses);
    appLayer.allowPowerSaving(!prevent);
  }

  return {
    name: "power",
    events: {
      [EVENT_AGENT_STATUS_UPDATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { workspace, status } = (event as AgentStatusUpdatedEvent).payload;
          workspaceStatuses.set(workspace.path, status);
          applyBlocker();
        },
      },
      [EVENT_WORKSPACE_DELETED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { workspacePath } = (event as WorkspaceDeletedEvent).payload;
          workspaceStatuses.delete(workspacePath as WorkspacePath);
          applyBlocker();
        },
      },
    },
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            // Always release on shutdown, regardless of config, so a slow/hanging
            // shutdown never leaves the OS pinned awake.
            appLayer.allowPowerSaving(true);
            logger.debug("Released sleep blocker on shutdown");
          },
        },
      },
    },
  };
}
