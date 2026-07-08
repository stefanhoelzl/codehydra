/**
 * The intent contract vocabulary — shared primitive schemas + inferred types.
 *
 * zod is the single source of truth and stays confined to the intent system here.
 * `shared/api/types.ts` and `shared/ipc.ts` re-export these types **type-only** (from
 * `../intents/contract`), so renderer/preload keep their import paths while zod stays out of
 * their bundles.
 * Per-operation schemas (payloads, hook results, events) live on their operations.
 */

import { z } from "zod/v4";

// =============================================================================
// Branded identifiers
// =============================================================================
// Each id is a `z.string().brand<…>()` schema and its TS type is `z.infer<schema>`.

/** Unique identifier for a project. Format: `<name>-<8-char-hex-hash>`. */
export const projectIdSchema = z.string().brand<"ProjectId">();
export type ProjectId = z.infer<typeof projectIdSchema>;

/** Name of a workspace within a project (typically the git branch name). */
export const workspaceNameSchema = z.string().brand<"WorkspaceName">();
export type WorkspaceName = z.infer<typeof workspaceNameSchema>;

/** Branded type for workspace paths (git worktree directories). */
export const workspacePathSchema = z.string().brand<"WorkspacePath">();
export type WorkspacePath = z.infer<typeof workspacePathSchema>;

/** Branded type for project paths (git repository root directories). */
export const projectPathSchema = z.string().brand<"ProjectPath">();
export type ProjectPath = z.infer<typeof projectPathSchema>;

// =============================================================================
// Agent spec / session
// =============================================================================
// `agentSpecSchema` lives here (not in shared) so zod stays confined to the intent system.

/** Model identifier (provider + model id) carried by an agent spec. */
export const promptModelSchema = z
  .object({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
  })
  .readonly();
export type PromptModel = z.infer<typeof promptModelSchema>;

/**
 * Agent specification for workspace creation — a discriminated union by backend.
 * Discriminated on `type` so each backend only accepts the options it understands
 * (e.g. permissionMode is Claude-only).
 */
export const agentSpecSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("default"),
    prompt: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("claude"),
    prompt: z.string().min(1).optional(),
    model: promptModelSchema.optional(),
    permissionMode: z.string().min(1).optional(),
    agentName: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("opencode"),
    prompt: z.string().min(1).optional(),
    model: promptModelSchema.optional(),
    agentName: z.string().min(1).optional(),
  }),
]);
export type AgentSpec = z.infer<typeof agentSpecSchema>;

/**
 * Agent session information for a workspace — the primary session created/found
 * when the agent server starts.
 */
export const agentSessionSchema = z
  .object({
    port: z.number(),
    sessionId: z.string(),
  })
  .readonly();
export type AgentSession = z.infer<typeof agentSessionSchema>;

// =============================================================================
// Domain value objects
// =============================================================================

/** A workspace within a project (represents a git worktree). */
export const workspaceSchema = z
  .object({
    projectId: projectIdSchema,
    name: workspaceNameSchema,
    /** Current branch name, or null for detached HEAD state. */
    branch: z.string().nullable(),
    /** Workspace metadata stored in git config (always contains `base`). */
    metadata: z.record(z.string(), z.string()).readonly(),
    path: z.string(),
    /** IDE server URL for the iframe. Absent for hibernated workspaces until they wake. */
    url: z.string().optional(),
  })
  .readonly();
export type Workspace = z.infer<typeof workspaceSchema>;

/** A project in CodeHydra (represents a git repository). */
export const projectSchema = z
  .object({
    id: projectIdSchema,
    name: z.string(),
    path: z.string(),
    workspaces: z.array(workspaceSchema).readonly(),
    defaultBaseBranch: z.string().optional(),
    /** Original git remote URL if the project was cloned from a URL. */
    remoteUrl: z.string().optional(),
  })
  .readonly();
export type Project = z.infer<typeof projectSchema>;

/** Reference to a workspace (includes path for efficiency). Used in events. */
export const workspaceRefSchema = z
  .object({
    projectId: projectIdSchema,
    workspaceName: workspaceNameSchema,
    path: z.string(),
  })
  .readonly();
export type WorkspaceRef = z.infer<typeof workspaceRefSchema>;

/** Agent status counts for a workspace. */
export const agentStatusCountsSchema = z
  .object({
    idle: z.number(),
    busy: z.number(),
    total: z.number(),
  })
  .readonly();
export type AgentStatusCounts = z.infer<typeof agentStatusCountsSchema>;

/** Agent status for a workspace (discriminated union by `type`). */
export const agentStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("idle"), counts: agentStatusCountsSchema }),
  z.object({ type: z.literal("busy"), counts: agentStatusCountsSchema }),
  z.object({ type: z.literal("mixed"), counts: agentStatusCountsSchema }),
]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/** Combined status of a workspace. */
export const workspaceStatusSchema = z
  .object({
    isDirty: z.boolean(),
    unmergedCommits: z.number(),
    agent: agentStatusSchema,
  })
  .readonly();
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;

/** Information about a base branch. */
export const baseInfoSchema = z
  .object({
    /** Full branch reference (e.g., "main" or "origin/main"). */
    name: z.string(),
    /** Whether this is a remote-tracking branch. */
    isRemote: z.boolean(),
    /** Suggested base branch for creating a workspace from this branch. */
    base: z.string().optional(),
    /** Derivable workspace name if a workspace can be created from this branch. */
    derives: z.string().optional(),
  })
  .readonly();
export type BaseInfo = z.infer<typeof baseInfoSchema>;

/** Agent types that can be selected by the user. */
export const configAgentTypeSchema = z.enum(["claude", "opencode"]);
export type ConfigAgentType = z.infer<typeof configAgentTypeSchema>;

// =============================================================================
// Setup screen progress
// =============================================================================

/** Identifiers for setup screen rows. */
export const setupRowIdSchema = z.enum(["vscode", "agent", "setup"]);
export type SetupRowId = z.infer<typeof setupRowIdSchema>;

/** Status of a setup row. */
export const setupRowStatusSchema = z.enum(["pending", "running", "done", "failed"]);
export type SetupRowStatus = z.infer<typeof setupRowStatusSchema>;

// =============================================================================
// Deletion progress
// =============================================================================

/** Information about a process blocking workspace deletion (Windows). */
export const blockingProcessSchema = z
  .object({
    pid: z.number(),
    name: z.string(),
    commandLine: z.string(),
    /** Files locked by this process, relative to workspace (max 20). */
    files: z.array(z.string()).readonly(),
    /** CWD relative to workspace, or null if outside the workspace. */
    cwd: z.string().nullable(),
  })
  .readonly();
export type BlockingProcess = z.infer<typeof blockingProcessSchema>;

/** Identifiers for deletion operations. */
export const deletionOperationIdSchema = z.enum([
  "killing-blockers",
  "kill-terminals",
  "stop-server",
  "cleanup-vscode",
  "detecting-blockers",
  "cleanup-workspace",
]);
export type DeletionOperationId = z.infer<typeof deletionOperationIdSchema>;

/** Status of a deletion operation. */
export const deletionOperationStatusSchema = z.enum(["pending", "in-progress", "done", "error"]);
export type DeletionOperationStatus = z.infer<typeof deletionOperationStatusSchema>;

/** A single operation in the deletion process. */
export const deletionOperationSchema = z
  .object({
    id: deletionOperationIdSchema,
    label: z.string(),
    status: deletionOperationStatusSchema,
    error: z.string().optional(),
  })
  .readonly();
export type DeletionOperation = z.infer<typeof deletionOperationSchema>;

/** Progress state for workspace deletion (full state, emitted with each update). */
export const deletionProgressSchema = z
  .object({
    workspacePath: workspacePathSchema,
    workspaceName: workspaceNameSchema,
    projectId: projectIdSchema,
    keepBranch: z.boolean(),
    operations: z.array(deletionOperationSchema).readonly(),
    completed: z.boolean(),
    hasErrors: z.boolean(),
    /** Processes blocking deletion (Windows only), present when cleanup fails with EBUSY/EACCES/EPERM. */
    blockingProcesses: z.array(blockingProcessSchema).readonly().optional(),
  })
  .readonly();
export type DeletionProgress = z.infer<typeof deletionProgressSchema>;

// =============================================================================
// Hook input-context helpers
// =============================================================================
// Per the item-2 design, the dispatcher validates the whole hook input context at every
// hook point: the `intent` re-affirmed against its payload schema, the accumulated
// `capabilities` bag as a scalar-only shape check, and the operation-added enrichment fields.

/**
 * The accumulated capability bag: scalar primitives only (`string|number|boolean|null`).
 * Values are already validated against their per-hook-point `provides` schema at merge time,
 * so this is a shape check, not a re-validation of each value.
 */
export const capabilitiesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
);

/**
 * Build the whole-context schema for a hook input point: the base HookContext
 * (`intent` + scalar `capabilities`) extended with the operation-added enrichment fields.
 *
 * @param payload the operation's intent payload schema (re-affirms `ctx.intent.payload`)
 * @param enrichment the extra fields the operation puts on the context for this hook point
 */
export function hookCtxSchema<E extends z.ZodRawShape>(payload: z.ZodType, enrichment: E) {
  return z.object({
    intent: z.object({ type: z.string(), payload }),
    capabilities: capabilitiesSchema.optional(),
    ...enrichment,
  });
}
