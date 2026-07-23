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
// Errors
// =============================================================================

/**
 * A thrown value reduced to plain, serializable data.
 *
 * The intent contract never carries a live `Error`: an `Error` is a class instance, so it
 * cannot cross a backend tunnel. Producers convert with `toSerializedError()`
 * (`shared/error-utils`); consumers that need a real `Error` (e.g. the telemetry boundary,
 * which reads `name`/`message`/`stack` to group issues) rebuild one with
 * `fromSerializedError()`.
 *
 * `cause` is recursive so a wrapped failure keeps its chain — `app:start` wraps setup and
 * agent-selection failures with `{ cause }`, and that context is worth keeping in a crash
 * report. The recursion uses a getter, zod v4's form for self-referential object schemas.
 */
export const serializedErrorSchema: z.ZodType<SerializedError> = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  get cause() {
    return serializedErrorSchema.optional();
  },
});

/**
 * Plain-data form of a thrown value. See {@link serializedErrorSchema}.
 *
 * The optional members spell `| undefined` explicitly: under `exactOptionalPropertyTypes`
 * a bare `?` means "may be absent" but not "may be undefined", which is narrower than what
 * `z.optional()` produces and would not satisfy the schema's annotation.
 */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string | undefined;
  readonly cause?: SerializedError | undefined;
}

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
    path: workspacePathSchema,
    /** IDE server URL for the iframe. Absent for hibernated workspaces until they wake. */
    url: z.string().optional(),
  })
  .readonly();
export type Workspace = z.infer<typeof workspaceSchema>;

/**
 * A workspace as found on disk by a `discover` / `list-workspaces` hook — the internal
 * git-worktree shape (`boundaries/platform/git-types`) reduced to plain data.
 *
 * Distinct from {@link workspaceSchema}, which is the IPC form and additionally carries
 * `projectId` and the optional IDE `url`. Both `project:open` and `project:list` used to
 * declare this shape privately, one with `z.instanceof(Path)` and one with `z.custom<Path>()`
 * — the same type spelled two different ways, both of them opt-outs. Converted from the
 * internal form by `toDiscoveredWorkspace()`.
 */
export const discoveredWorkspaceSchema = z
  .object({
    name: workspaceNameSchema,
    path: workspacePathSchema,
    branch: z.string().nullable(),
    metadata: z.record(z.string(), z.string()).readonly(),
  })
  .readonly();
export type DiscoveredWorkspace = z.infer<typeof discoveredWorkspaceSchema>;

/** A project in CodeHydra (represents a git repository). */
export const projectSchema = z
  .object({
    id: projectIdSchema,
    name: z.string(),
    path: projectPathSchema,
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
    path: workspacePathSchema,
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

/**
 * The agent backends CodeHydra can run. Single source of truth: `ConfigAgentType`
 * (the persisted `agent` config value) and `LifecycleAgentType` (the runtime/IPC name)
 * are the same set and are both derived from this schema — see the type-only re-exports
 * in `shared/api/types.ts`, `shared/ipc.ts` and `boundaries/platform/config.ts`.
 */
export const agentTypeSchema = z.enum(["claude", "opencode"]);
export type AgentType = z.infer<typeof agentTypeSchema>;

/**
 * The binaries CodeHydra resolves and downloads. Source of truth for
 * `utils/binary-resolution`'s `BinaryType`, which re-exports this type.
 */
export const binaryTypeSchema = z.enum(["vscodium", "opencode", "claude"]);
export type BinaryType = z.infer<typeof binaryTypeSchema>;

/** An agent backend plus its presentation fields, as shown in the first-run picker. */
export const agentInfoSchema = z
  .object({
    agent: agentTypeSchema,
    label: z.string(),
    icon: z.string(),
  })
  .readonly();
export type AgentInfo = z.infer<typeof agentInfoSchema>;

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
 * **Strict.** A non-declared field on the context is an error, not something to strip. A
 * plain `z.object` would silently drop it — and since the dispatcher parses the input for
 * its throw only (the un-parsed context is what reaches the handler), stripping would let an
 * undeclared value travel on regardless. Strict makes the declaration the whole truth about
 * what a hook point receives, which is what a backend tunnel has to serialize.
 *
 * Every hook point declares one of these, including those whose context is just the intent
 * (`hookCtxSchema(payloadSchema, {})`) — a hook point with no schema is a hook point with no
 * contract, and `InputOf` has nothing to derive its handler's context type from.
 *
 * @param payload the operation's intent payload schema (re-affirms `ctx.intent.payload`)
 * @param enrichment the extra fields the operation puts on the context for this hook point
 */
export function hookCtxSchema<E extends z.ZodRawShape>(payload: z.ZodType, enrichment: E) {
  return z.strictObject({
    intent: z.strictObject({ type: z.string(), payload }),
    capabilities: capabilitiesSchema.optional(),
    ...enrichment,
  });
}
