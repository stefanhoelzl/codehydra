/**
 * Workspace registry entries.
 *
 * These carry the divergence resolutions from planning/CLI.md. Where MCP and the
 * plugin server previously disagreed, one behavior is defined here and any
 * remaining difference is expressed as an adapter `defaults`/`pick` rather than
 * as a second implementation.
 */

import { z } from "zod/v4";
import { ApiError } from "../errors";
import { defineEntry } from "../types";
import type { AnyOperationEntry, OperationContext } from "../types";
import type { EntryDeps } from "./deps";
import {
  workspacePathSchema,
  type AgentSpec,
  type PromptModel,
  type WorkspacePath,
} from "../../intents/contract";
import type { DeletionProgress, Workspace } from "../../shared/api/types";

import { INTENT_GET_WORKSPACE_STATUS } from "../../intents/get-workspace-status";
import type { GetWorkspaceStatusIntent } from "../../intents/get-workspace-status";
import { INTENT_HIBERNATE_WORKSPACE } from "../../intents/hibernate-workspace";
import type { HibernateWorkspaceIntent } from "../../intents/hibernate-workspace";
import { INTENT_WAKE_WORKSPACE } from "../../intents/wake-workspace";
import type { WakeWorkspaceIntent } from "../../intents/wake-workspace";
import { INTENT_OPEN_WORKSPACE } from "../../intents/open-workspace";
import type { OpenWorkspaceIntent } from "../../intents/open-workspace";
import { INTENT_DELETE_WORKSPACE } from "../../intents/delete-workspace";
import type { DeleteWorkspaceIntent } from "../../intents/delete-workspace";
import { INTENT_RESOLVE_WORKSPACE } from "../../intents/resolve-workspace";
import { INTENT_SWITCH_WORKSPACE } from "../../intents/switch-workspace";
import type { SwitchWorkspaceIntent } from "../../intents/switch-workspace";
import { INTENT_LIST_PROJECTS } from "../../intents/list-projects";
import type { ListProjectsIntent } from "../../intents/list-projects";
import { resolveWorkspaceReference, type ProjectLocation } from "../workspace-lookup";
import type { ResolveWorkspaceIntent } from "../../intents/resolve-workspace";

/**
 * Optional target for operations that can act on a workspace other than the
 * caller's own. Absent means "the workspace I am in".
 */
const targetWorkspace = workspacePathSchema
  .min(1)
  .optional()
  .describe("Workspace to act on. Omit to target the current workspace.");

/** Resolve the effective target: an explicit path wins over the caller's own. */
function targetOf(ctx: OperationContext, explicit: WorkspacePath | undefined): WorkspacePath {
  const target = explicit ?? ctx.workspacePath;
  if (target === null || target === undefined) {
    throw new ApiError("no-workspace", "No workspace to act on.");
  }
  return target;
}

/** The agent options `workspace.create` accepts, as the caller typed them. */
interface AgentInput {
  readonly prompt?: string | undefined;
  readonly agent?: string | undefined;
  readonly model?: string | undefined;
  readonly permissionMode?: string | undefined;
  readonly agentName?: string | undefined;
}

/**
 * Split a `provider/model` reference into the contract's `PromptModel`.
 *
 * The command line wants one token, the contract wants two fields. Split on the
 * FIRST slash so a model id that contains slashes (`anthropic/claude-x/beta`)
 * keeps them. Claude reads only `modelID` (server-manager projects the spec onto
 * `--model`), so a bare id is accepted there and the provider is a placeholder;
 * OpenCode addresses models as `provider/model` and cannot guess one.
 */
function parseModel(model: string, backend: "claude" | "opencode"): PromptModel {
  const slash = model.indexOf("/");
  if (slash > 0 && slash < model.length - 1) {
    return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
  }
  if (backend === "opencode") {
    throw new ApiError(
      "usage",
      `Invalid model "${model}" for opencode: use 'provider/model', e.g. 'anthropic/claude-sonnet-4-5'.`
    );
  }
  return { providerID: "anthropic", modelID: model };
}

/**
 * Build the typed AgentSpec arm from the create input.
 *
 * The creation panel emits a backend-specific arm carrying prompt, model,
 * permission mode and named agent; this is the same projection for callers that
 * come in through the CLI, MCP or the plugin, so the two surfaces offer the same
 * options. Only with no backend named at all do we fall back to the option-less
 * "default" arm — which is why an option that needs a backend is a usage error
 * rather than a silent drop.
 */
function buildAgentSpec(input: AgentInput): AgentSpec | undefined {
  const { prompt, agent, model, permissionMode, agentName } = input;

  if (agent === undefined) {
    const needsBackend = [
      ["model", model],
      ["permissionMode", permissionMode],
      ["agentName", agentName],
    ].find(([, value]) => value !== undefined);
    if (needsBackend) {
      throw new ApiError(
        "usage",
        `${needsBackend[0]} needs an agent backend — pass agent=claude or agent=opencode.`
      );
    }
    return prompt === undefined ? undefined : { type: "default", prompt };
  }

  if (agent !== "claude" && agent !== "opencode") {
    throw new ApiError("usage", `Unknown agent "${agent}", expected "claude" or "opencode".`);
  }

  const parsed = model === undefined ? undefined : parseModel(model, agent);

  if (agent === "opencode") {
    if (permissionMode !== undefined) {
      throw new ApiError("usage", "permissionMode is a Claude option; opencode does not take one.");
    }
    return {
      type: "opencode",
      ...(prompt !== undefined && { prompt }),
      ...(parsed !== undefined && { model: parsed }),
      ...(agentName !== undefined && { agentName }),
    };
  }

  return {
    type: "claude",
    ...(prompt !== undefined && { prompt }),
    ...(parsed !== undefined && { model: parsed }),
    ...(permissionMode !== undefined && { permissionMode }),
    ...(agentName !== undefined && { agentName }),
  };
}

/** Build a human-readable failure from a terminal deletion-progress event. */
function formatDeletionFailure(progress: DeletionProgress): string {
  const blockers = progress.blockingProcesses;
  if (blockers && blockers.length > 0) {
    const list = blockers.map((p) => `pid ${p.pid} (${p.name})`).join(", ");
    return `Workspace deletion blocked by ${blockers.length} process(es): ${list}`;
  }
  const stepErrors = progress.operations
    .filter((op) => op.error)
    .map((op) => `${op.label}: ${op.error}`);
  if (stepErrors.length > 0) {
    return `Workspace deletion failed: ${stepErrors.join("; ")}`;
  }
  return "Workspace deletion failed";
}

export function workspaceEntries(deps: EntryDeps): readonly AnyOperationEntry[] {
  const { dispatcher } = deps;

  /**
   * Turn a workspace reference into a path.
   *
   * A name is the ergonomic form — `ch ws switch test-0` beats pasting a
   * worktree path — and a path still works, so a workspace that has not been
   * listed yet stays reachable.
   */
  const resolveReference = async (reference: string): Promise<WorkspacePath> => {
    const projects = await dispatcher.dispatch<ListProjectsIntent>({
      type: INTENT_LIST_PROJECTS,
      payload: {} as Record<string, never>,
    });
    const resolved = resolveWorkspaceReference(
      (projects ?? []) as readonly ProjectLocation[],
      reference
    );
    if ("error" in resolved) throw new ApiError("usage", resolved.error);
    return workspacePathSchema.parse(resolved.path);
  };

  const status = defineEntry({
    name: "workspace.status",
    kind: "command",
    description: "Get workspace status, including the dirty flag and agent status.",
    input: z.object({
      workspacePath: targetWorkspace,
      refresh: z
        .boolean()
        .optional()
        .describe("Fetch the remote before reading status (best-effort)."),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const result = await dispatcher.dispatch<GetWorkspaceStatusIntent>({
        type: INTENT_GET_WORKSPACE_STATUS,
        payload: {
          workspacePath: targetOf(ctx, input.workspacePath),
          ...(typeof input.refresh === "boolean" && { refresh: input.refresh }),
        },
      });
      if (!result) throw new Error("Get workspace status returned no result");
      return result;
    },
  });

  const hibernate = defineEntry({
    name: "workspace.hibernate",
    kind: "command",
    description: "Hibernate a workspace, freeing its view and agent server.",
    instructions:
      "Tears down the workspace's view and agent server to free resources while keeping the " +
      "git worktree on disk. The workspace stays listed and can be brought back with wake. " +
      "Returns { started: true } once hibernation has begun; teardown completes in the background.",
    input: z.object({ workspacePath: targetWorkspace }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const intent: HibernateWorkspaceIntent = {
        type: INTENT_HIBERNATE_WORKSPACE,
        payload: { workspacePath: targetOf(ctx, input.workspacePath) },
      };
      const handle = dispatcher.dispatch(intent);
      if (!(await handle.accepted)) return { started: false };
      await handle;
      return { started: true };
    },
  });

  const wake = defineEntry({
    name: "workspace.wake",
    kind: "command",
    description: "Wake a hibernated workspace and bring it back online.",
    instructions:
      "Clears the hibernated flag, recreates the view and restarts the agent server. " +
      "Returns the reopened workspace. Does not steal focus.",
    input: z.object({ workspacePath: targetWorkspace }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const result = await dispatcher.dispatch<WakeWorkspaceIntent>({
        type: INTENT_WAKE_WORKSPACE,
        payload: {
          workspacePath: targetOf(ctx, input.workspacePath),
          stealFocus: false,
          source: "mcp",
        },
      });
      if (!result) throw new Error("Wake workspace returned no result");
      return result as Workspace;
    },
  });

  const create = defineEntry({
    name: "workspace.create",
    kind: "command",
    description: "Create a new workspace in a project.",
    instructions:
      "Creates a git worktree and brings the workspace online. Omit projectPath to create the " +
      "workspace in the caller's own project; pass one to target another (use project list to " +
      "discover paths).",
    input: z.object({
      // Divergence 4: optional, inferred from the caller when absent, so the MCP
      // caller can target a project and the plugin caller can stay implicit.
      project: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Project: an open project's name, a local path, or a git URL. " +
            "Opened (or cloned) if it is not open yet. Omit to use the caller's own project."
        ),
      name: z.string().min(1).describe("Name for the new workspace (becomes the branch name)"),
      base: z
        .string()
        .min(1)
        .optional()
        .describe("Base branch. Omit to use the project's default branch."),
      tracking: z
        .string()
        .min(1)
        .optional()
        .describe("Remote branch to check out, e.g. 'origin/feature-login'."),
      prompt: z.string().min(1).optional().describe("Initial prompt to send once created."),
      // Divergence 5: the rich shape is the definition; MCP now sees it too.
      agent: z.string().min(1).optional().describe("Agent backend to launch: claude or opencode."),
      model: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Model for the initial prompt: 'provider/model' (opencode requires the provider; " +
            "claude accepts a bare model id)."
        ),
      permissionMode: z
        .string()
        .min(1)
        .optional()
        .describe("Claude permission mode to start in, e.g. 'plan'. Requires agent=claude."),
      agentName: z
        .string()
        .min(1)
        .optional()
        .describe("Named agent (persona) to launch. Requires an agent backend."),
      stealFocus: z.boolean().optional().default(false).describe("Switch to the new workspace."),
    }),
    requiresWorkspace: false,
    handler: async (ctx, input) => {
      // A reference is passed straight through: resolving it — including
      // opening or cloning a project that is not open — belongs to the
      // operation, so every surface gets the same behavior rather than each
      // adapter reimplementing it.
      let project = input.project;
      if (project === undefined) {
        if (ctx.workspacePath === null) {
          throw new ApiError(
            "usage",
            "No project given, and no workspace to infer one from. " +
              "Run this from inside a workspace, or name a project."
          );
        }
        const resolved = await dispatcher.dispatch<ResolveWorkspaceIntent>({
          type: INTENT_RESOLVE_WORKSPACE,
          payload: { workspacePath: ctx.workspacePath },
        });
        project = resolved.projectPath;
      }

      const agentSpec = buildAgentSpec(input);

      const intent: OpenWorkspaceIntent = {
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          project,
          workspaceName: input.name,
          // Omitted means "the project's default branch", which the worktree
          // module detects — the same default the creation panel offers.
          ...(input.base !== undefined && { base: input.base }),
          ...(input.tracking !== undefined && { tracking: input.tracking }),
          ...(agentSpec !== undefined && { agent: agentSpec }),
          stealFocus: input.stealFocus,
          source: "mcp",
        },
      };
      const result = await dispatcher.dispatch(intent);
      if (!result) throw new Error("Create workspace returned no result");
      return result as Workspace;
    },
  });

  const remove = defineEntry({
    name: "workspace.delete",
    kind: "command",
    description: "Delete a workspace: terminate its agent and remove the git worktree.",
    instructions:
      "This removes the entire workspace, not a label — to change or clear a workspace's " +
      "display title use the title command, NOT this one. Fails if the target has uncommitted " +
      "changes, or unmerged commits on a branch that is not kept (pass ignoreWarnings to " +
      "override), or if processes block worktree removal.",
    input: z.object({
      workspacePath: targetWorkspace,
      // Divergence 1: one default everywhere. `api:workspace:delete` has no
      // caller today, so nothing real relied on the plugin's inverted `true`.
      keepBranch: z.boolean().optional().default(false),
      // Divergence 3: the plugin surface gains this.
      ignoreWarnings: z.boolean().optional().default(false),
      // Divergence 2: blocking is the single behavior; opt out per call.
      wait: z.boolean().optional().default(true),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const workspacePath = targetOf(ctx, input.workspacePath);
      const waiter = input.wait ? deps.awaitDeletion(workspacePath) : undefined;

      try {
        const intent: DeleteWorkspaceIntent = {
          type: INTENT_DELETE_WORKSPACE,
          payload: {
            workspacePath,
            keepBranch: input.keepBranch,
            force: false,
            removeWorktree: true,
            ignoreWarnings: input.ignoreWarnings,
          },
        };
        const handle = dispatcher.dispatch(intent);
        if (!(await handle.accepted)) return { started: false };

        // Preflight failures reject the handle (no terminal event is emitted).
        await handle;
        if (!waiter) return { started: true };

        // Blocker and shutdown failures resolve the handle but report hasErrors
        // through the terminal event, so the real outcome only arrives here.
        const progress = await waiter.outcome;
        if (progress.hasErrors) throw new Error(formatDeletionFailure(progress));
        return { started: true };
      } finally {
        waiter?.release();
      }
    },
  });

  const switchTo = defineEntry({
    name: "workspace.switch",
    kind: "command",
    description: "Make a workspace the active one.",
    instructions:
      "Brings the workspace to the front in the sidebar and shows its editor. Accepts a name or " +
      "a path. Focus follows by default; pass focus false to switch without taking the window.",
    input: z.object({
      workspace: z.string().min(1).describe("Workspace name or path to switch to"),
      focus: z.boolean().optional().default(true).describe("Take window focus as well"),
    }),
    // The target is named outright, so this works from anywhere.
    requiresWorkspace: false,
    handler: async (_ctx, input) => {
      const workspacePath = await resolveReference(input.workspace);
      await dispatcher.dispatch<SwitchWorkspaceIntent>({
        type: INTENT_SWITCH_WORKSPACE,
        payload: { workspacePath, focus: input.focus },
      });
      return { switched: true };
    },
  });

  return [status, hibernate, wake, create, remove, switchTo];
}
