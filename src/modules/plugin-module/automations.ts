/**
 * Automations — a plugin script run every poll cycle, whose printed items each
 * run an action.
 *
 * An automation is a local plugin's `automations.<name>: <script>`; its identity
 * is `<plugin>/<name>`. The script prints a JSON array of items, each naming its
 * `action` and carrying that action's input (items.ts). The plugin module
 * supplies the automations, runs the scripts and validates the items; this file
 * decides what they mean.
 *
 * A `workspace.create` item says one of two things, by its `event` flag:
 *
 * `event: false` (the default) — this workspace should exist. The script prints
 * the whole desired list every poll, and the poll reconciles against it:
 *   - a key already tracked in state is skipped
 *   - a new key whose name is already taken adopts that workspace (entry only)
 *   - any other new key creates a workspace (entry written only on success)
 *   - a tracked key absent from this poll's list is forgotten only if its
 *     workspace is gone too, so a script that returns a short list for one
 *     cycle cannot orphan a live workspace
 * There is no auto-deletion; a manually deleted workspace's entry simply
 * persists (so it is not recreated while its item is still listed) and is
 * forgotten once the item disappears. "The list" is this automation's
 * non-event create items of this poll.
 *
 * `event: true` — something happened, and each printed item fires. Nothing is
 * tracked: the script owns dedup (it acks, pops a queue, or keeps its own
 * cursor). Per event the project is resolved, then `name` is matched against
 * that project's workspaces:
 *   - no match          → create, exactly like a non-event item
 *   - match, closing    → skip (a teardown pipeline owns it)
 *   - match             → re-apply the metadata, then wake it if it is
 *                         hibernated, or switch to it if `stealFocus`, then send
 *                         the `prompt` (if any) to its agent as a message —
 *                         reopening a closed agent terminal first
 * A failed event is logged and gone: there is no retry, since the script has
 * already consumed it.
 *
 * Any other action runs once per item, invoked through the registry like `ch`.
 * A refused item is reported and the next one still runs.
 *
 * `automations.poll-interval` (seconds, default 60) is the *gap between runs*:
 * the next wait is armed only once a cycle has settled, so a slow poll never
 * stacks. The value is re-read when each wait is armed, so a change made in the
 * settings dialog applies once the current wait elapses.
 */

import type { Dispatcher } from "../../intents/lib/dispatcher";
import { INTENT_OPEN_WORKSPACE, type OpenWorkspaceIntent } from "../../intents/open-workspace";
import {
  INTENT_GET_PROJECT_BASES,
  type GetProjectBasesIntent,
} from "../../intents/get-project-bases";
import { INTENT_OPEN_PROJECT, type OpenProjectIntent } from "../../intents/open-project";
import { INTENT_LIST_PROJECTS, type ListProjectsIntent } from "../../intents/list-projects";
import {
  INTENT_RESOLVE_WORKSPACE,
  type ResolveWorkspaceIntent,
} from "../../intents/resolve-workspace";
import { INTENT_WAKE_WORKSPACE, type WakeWorkspaceIntent } from "../../intents/wake-workspace";
import {
  INTENT_SWITCH_WORKSPACE,
  type SwitchWorkspaceIntent,
} from "../../intents/switch-workspace";
import { HIBERNATED_METADATA_KEY } from "../../intents/hibernate-workspace";
import {
  INTENT_SEND_AGENT_MESSAGE,
  type SendAgentMessageIntent,
} from "../../intents/send-agent-message";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../../intents/set-metadata";
import type { Config } from "../../boundaries/platform/config";
import {
  storeCustom,
  storeNumber,
  type PersistedAccessor,
} from "../../boundaries/platform/store-definition";
import type { StateService } from "../../boundaries/platform/state-service";
import type { Logger } from "../../boundaries/platform/logging-types";
import { encodeTag, tagKey, TITLE_METADATA_KEY, type AgentSpec } from "../../shared/api/types";
import type { OperationName } from "../../api/names";
import { buildAgentSpec } from "../../api/entries/workspace";
import { getErrorMessage } from "../../shared/error-utils";
import { Path } from "../../utils/path/path";
import { looksLikeGitUrl, matchOpenProject } from "../../utils/project-reference";
import { CREATE_ACTION, type AutomationItem, type CreateItem } from "./items";
import { safeJsonParse } from "./util";
import { projectPathSchema, type ProjectRef, type WorkspaceRef } from "../../intents/contract";

// =============================================================================
// State
// =============================================================================

interface StateEntry {
  readonly workspaceName: string;
  readonly createdAt: string;
  /**
   * Ref of the project the workspace lives in, so the entry can be dereferenced
   * when its item disappears (see entryWorkspaceExists). Optional: entries
   * written before projects were recorded carry none, and a downgrade drops it
   * again — both land in the same any-project fallback, and both are repaired the
   * next time the entry is written.
   */
  readonly projectRef?: string;
  /**
   * The project by path, as versions before refs recorded it. Turned into
   * `projectRef` at startup (`migrateEntries`); one whose project is unknown is
   * left, and never read: the entry falls back like one with no project.
   */
  readonly projectPath?: string;
}

/** Tracking map `${plugin}/${automation}/${itemKey}` -> entry, stored under `auto-workspaces`. */
type AutoWorkspaceEntries = Record<string, StateEntry>;

function isStateEntry(value: unknown): value is StateEntry {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  if (typeof o.workspaceName !== "string" || typeof o.createdAt !== "string") return false;
  return (
    (o.projectRef === undefined || typeof o.projectRef === "string") &&
    (o.projectPath === undefined || typeof o.projectPath === "string")
  );
}

function validateEntries(value: unknown): AutoWorkspaceEntries | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: AutoWorkspaceEntries = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isStateEntry(entry)) {
      out[key] = {
        workspaceName: entry.workspaceName,
        createdAt: entry.createdAt,
        ...(entry.projectRef !== undefined && { projectRef: entry.projectRef }),
        ...(entry.projectPath !== undefined && { projectPath: entry.projectPath }),
      };
    }
  }
  return out;
}

// =============================================================================
// Constants
// =============================================================================

/** Default gap between the end of one reconcile-and-poll cycle and the next. */
const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const METADATA_SOURCE_KEY = "source";

/**
 * The exit an automation uses to say "temporary, try again next poll" —
 * `EX_TEMPFAIL` from sysexits.h, as mail servers use it.
 */
export const TEMPORARY_FAILURE_EXIT = 75;

/** How long temporary failures may go on before they are worth a card. */
const TEMPORARY_FAILURE_GRACE_MS = 10 * 60_000;

// =============================================================================
// Dependencies
// =============================================================================

/** One automation, as the plugin module hands it over. */
export interface AutomationSource {
  /** `<plugin>/<name>` — the identity, the tracking-key prefix and the `source` metadata. */
  readonly id: string;
  /** The plugin's id (`local:<name>`), for error reporting. */
  readonly plugin: string;
  /** The automation's name within its plugin. */
  readonly name: string;
}

/** How one run of an automation's script went. */
export type AutomationRun =
  | { readonly ok: true; readonly items: readonly unknown[] }
  | {
      readonly ok: false;
      /** Why, in the words `ch plugin errors` uses. */
      readonly failure: string;
      /** It exited {@link TEMPORARY_FAILURE_EXIT}: retry next poll, quietly at first. */
      readonly temporary: boolean;
      /** The run's log file (native path), when there is one. */
      readonly logPath?: string;
    };

/**
 * Where an automation's failures are recorded (`ch plugin errors`, and a card
 * unless `quiet`), and cleared once it runs a cycle without one.
 */
export interface AutomationErrors {
  failure(
    source: AutomationSource,
    message: string,
    logPath?: string,
    options?: { readonly quiet?: boolean }
  ): void;
  success(source: AutomationSource): void;
}

/** A create item, turned into what creating or matching a workspace needs. */
interface WorkspaceDefinition {
  readonly name: string;
  /** Dedup identity of a non-event item. */
  readonly key: string;
  /** An open project's name, a path or a git URL. */
  readonly project: string;
  readonly base?: string;
  readonly tracking?: string;
  readonly focus: boolean;
  readonly prompt?: string;
  readonly agent?: AgentSpec;
  /** Flattened `codehydra.*` metadata keys to values. */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface AutomationsDeps<S extends AutomationSource> {
  readonly logger: Logger;
  readonly dispatcher: Dispatcher;
  readonly configService: Config;
  readonly stateService: StateService;
  /**
   * Whether automations run at all (`plugins.enabled`). Read at the start of
   * each cycle; a cycle it stops is skipped whole, so nothing tracked is
   * forgotten while plugins are switched off.
   */
  readonly enabled: () => boolean;
  /** Every automation that may run now; read at the start of each cycle. */
  readonly sources: () => Promise<readonly S[]>;
  /** Run a source's script and read its items. Reports nothing itself. */
  readonly runScript: (source: S) => Promise<AutomationRun>;
  /** Validate one printed item. Throws a message naming the action and field. */
  readonly parseItem: (raw: unknown) => AutomationItem;
  /** Run a non-create action with a rendered input. Throws on failure. */
  readonly invokeAction: (action: OperationName, input: Record<string, unknown>) => Promise<void>;
  /**
   * Where a failure the user must hear about goes: a script that failed, an
   * invalid item, an action that was refused. Repeats of the same text collapse.
   */
  readonly errors: AutomationErrors;
}

// =============================================================================
// Helpers
// =============================================================================

function stateKey(sourceId: string, itemKey: string): string {
  return `${sourceId}/${itemKey}`;
}

function newEntry(workspaceName: string, projectRef: ProjectRef): StateEntry {
  return { workspaceName, createdAt: new Date().toISOString(), projectRef };
}

/** `metadata` as the workspace's flat keys: a tag becomes `tags.<name>` holding its JSON. */
function flattenMetadata(metadata: CreateItem["metadata"]): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (key === "title") {
      if (typeof value === "string") flat[TITLE_METADATA_KEY] = value;
    } else if (key === "tags") {
      for (const [name, tag] of Object.entries(metadata?.tags ?? {})) {
        flat[tagKey(name)] = encodeTag(tag);
      }
    } else if (typeof value === "string") {
      flat[key] = value;
    }
  }
  return flat;
}

/**
 * Turn a create item into a workspace definition. Throws a message for a
 * combination the item's schema cannot express (no project, an agent option
 * without an agent) — the same checks `ch ws create` makes.
 */
function definitionOf(item: CreateItem): WorkspaceDefinition {
  if (item.project === undefined) {
    throw new Error("an automation has no project of its own: name one in project");
  }
  const agent = buildAgentSpec(item);
  return {
    name: item.name,
    key: item.key ?? item.name,
    project: item.project,
    focus: item.stealFocus,
    metadata: flattenMetadata(item.metadata),
    ...(item.base !== undefined && { base: item.base }),
    ...(item.tracking !== undefined && { tracking: item.tracking }),
    ...(item.prompt !== undefined && { prompt: item.prompt }),
    ...(agent !== undefined && { agent }),
  };
}

// =============================================================================
// Factory
// =============================================================================

export interface Automations {
  /** Load state, run the first cycle, start polling. */
  start(): Promise<void>;
  /** Stop polling. */
  stop(): void;
  /**
   * Turn the projects tracking entries recorded by path, as versions before
   * refs did, into refs. Before `start`.
   */
  migrateEntries(refsByPath: ReadonlyMap<string, ProjectRef>): Promise<void>;
  /**
   * Rename tracking keys (`undefined` keeps a key as it is). For moving the
   * entries of the pre-plugin setting over to its automations, before `start`.
   */
  renameTracking(rename: (key: string) => string | undefined): Promise<void>;
}

/** The pre-plugin name of the poll interval, still honored. */
const LEGACY_INTERVAL_KEY = "auto-workspace.poll-interval";

export function createAutomations<S extends AutomationSource>(
  deps: AutomationsDeps<S>
): Automations {
  const intervalAccessor: PersistedAccessor<number> = deps.configService.register(
    "automations.poll-interval",
    {
      default: DEFAULT_POLL_INTERVAL_SECONDS,
      description:
        "Seconds to wait between the end of one automations poll and the start of the next " +
        "(a change applies after the current wait elapses)",
      applies: "live",
      ...storeNumber({ min: 1 }),
      legacyNames: {
        [LEGACY_INTERVAL_KEY]: (value) =>
          typeof value === "number" && Number.isFinite(value) && value >= 1 ? value : undefined,
      },
    }
  );

  const stateAccessor = deps.stateService.register("auto-workspaces", {
    default: {} as AutoWorkspaceEntries,
    description: "Automation tracking entries for workspace.create (app-managed)",
    ...storeCustom<AutoWorkspaceEntries>({
      parse: (raw) => validateEntries(safeJsonParse(raw)),
      validate: validateEntries,
    }),
  });

  let entries: AutoWorkspaceEntries = {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  /** Interval the last wait was armed with, so a live change can be logged once. */
  let armedIntervalSeconds: number | null = null;

  // ------ Error bookkeeping ------

  /** Automations that failed in the current cycle, and the ones run in the last. */
  let failedThisCycle = new Set<string>();
  let ranLastCycle: readonly S[] = [];
  /**
   * When each automation's current run of temporary failures began. Any other
   * outcome — a success or a real failure — ends it.
   */
  const temporarySince = new Map<string, number>();

  /**
   * Start a cycle by settling the last one: an automation that ran then
   * without failing is no longer failing. (Settling here, rather than the
   * moment its script succeeds, keeps an item error found after a good run
   * from being cleared and re-notified every cycle.)
   */
  function settleLastCycle(): void {
    for (const source of ranLastCycle) {
      if (!failedThisCycle.has(source.id)) deps.errors.success(source);
    }
    failedThisCycle = new Set();
  }

  function failed(source: S, message: string, logPath?: string): void {
    failedThisCycle.add(source.id);
    deps.errors.failure(source, message, logPath);
  }

  /**
   * An automation exited 75: skip it this poll and try again next. Listed in
   * `ch plugin errors` straight away, but raised as a card only once the
   * failures have gone on for the grace period — then as an ordinary `exit 75`,
   * whose new message is what raises the card.
   */
  function failedTemporarily(source: S, logPath?: string): void {
    const now = Date.now();
    const since = temporarySince.get(source.id) ?? now;
    temporarySince.set(source.id, since);
    failedThisCycle.add(source.id);
    deps.logger.debug("Automation failed temporarily, retrying next cycle", {
      automation: source.id,
    });
    if (now - since >= TEMPORARY_FAILURE_GRACE_MS) {
      deps.errors.failure(source, `exit ${TEMPORARY_FAILURE_EXIT}`, logPath);
    } else {
      deps.errors.failure(
        source,
        `temporary failure (exit ${TEMPORARY_FAILURE_EXIT}), retrying`,
        logPath,
        { quiet: true }
      );
    }
  }

  /** Run a source's script: its items, or null when it failed (and was reported). */
  async function runSource(source: S): Promise<readonly unknown[] | null> {
    const run = await deps.runScript(source);
    if (run.ok) {
      temporarySince.delete(source.id);
      return run.items;
    }
    if (run.temporary) {
      failedTemporarily(source, run.logPath);
      return null;
    }
    temporarySince.delete(source.id);
    deps.logger.warn("Automation script failed, skipping its items this cycle", {
      automation: source.id,
      reason: run.failure,
    });
    failed(source, run.failure, run.logPath);
    return null;
  }

  // ------ State persistence ------

  async function persist(): Promise<void> {
    try {
      await stateAccessor.set(entries);
    } catch (error) {
      deps.logger.warn("Failed to save automation state", { error: getErrorMessage(error) });
    }
  }

  // ------ Workspace lifecycle ------

  /**
   * Find, open or clone the project a create item names — an open project's
   * name, a path or a git URL, as `ch ws create` takes it — and return its
   * path. Null when it is none of those, when project:open yields nothing, or
   * when it fails.
   *
   * Failure is swallowed rather than thrown because this is the first step of
   * handling one item, and one item must never take the cycle down with it: a
   * bad `project` path or an unreachable clone URL would otherwise abandon every
   * later item AND every later source. Null leaves a non-event item
   * unrecorded (retried next tick) and drops an event (there is no retry).
   *
   * An item mistake would otherwise retry silently forever, so it is also
   * reported. A failed clone is not: the clone's own card already turns into
   * "Clone failed".
   */
  async function resolveProject(
    source: S,
    definition: WorkspaceDefinition,
    key: string
  ): Promise<ProjectRef | null> {
    const reference = definition.project;
    try {
      const projects = await deps.dispatcher.dispatch<ListProjectsIntent>({
        type: INTENT_LIST_PROJECTS,
        payload: {},
      });
      const matched = matchOpenProject(projects ?? [], reference);
      if (matched !== undefined) {
        if ("error" in matched) throw new Error(matched.error);
        const open = (projects ?? []).find((project) => project.path === matched.path);
        if (open !== undefined) return open.ref;
      }
    } catch (error) {
      deps.logger.warn("Could not look the automation's project up", {
        key,
        error: getErrorMessage(error),
      });
      failed(source, `project ${reference}: ${getErrorMessage(error)}`);
      return null;
    }

    let projectPayload: OpenProjectIntent["payload"];
    if (looksLikeGitUrl(reference)) {
      projectPayload = { git: reference };
    } else {
      try {
        // A user-authored value: normalize, then mint the brand by parsing.
        projectPayload = { path: projectPathSchema.parse(new Path(reference).toString()) };
      } catch {
        // The value itself stays out of the log: a URL put here may carry a token.
        deps.logger.warn("Skipping automation item (project is not a path, name or URL)", { key });
        failed(
          source,
          `project must be an open project's name, an absolute path or a git URL (got "${reference}")`
        );
        return null;
      }
    }

    try {
      const project = await deps.dispatcher.dispatch<OpenProjectIntent>({
        type: INTENT_OPEN_PROJECT,
        payload: projectPayload,
      });
      if (!project) {
        deps.logger.warn("project:open returned null for an automation", { key });
        return null;
      }
      return project.ref;
    } catch (error) {
      deps.logger.warn("Failed to open project for an automation", {
        key,
        error: getErrorMessage(error),
      });
      // A failed clone already turns its own card into "Clone failed".
      if (projectPayload.path !== undefined) {
        failed(source, `cannot open its project: ${getErrorMessage(error)}`);
      }
      return null;
    }
  }

  /**
   * Write the automation's identity plus the item's metadata onto a
   * workspace. Best-effort per key: metadata is cosmetic, so one bad key never
   * fails the create (or the event) around it.
   *
   * `source` is rewritten on every hit, not only at create — an event
   * automation that acts on a workspace is its current owner as far as the
   * sidebar is concerned, including one the user made by hand under a matching
   * name.
   */
  async function applyMetadata(
    source: S,
    workspaceRef: WorkspaceRef,
    definition: WorkspaceDefinition,
    key: string
  ): Promise<void> {
    const allMetadata: Record<string, string> = {
      [METADATA_SOURCE_KEY]: source.id,
      ...definition.metadata,
    };
    for (const [metaKey, value] of Object.entries(allMetadata)) {
      try {
        await deps.dispatcher.dispatch<SetMetadataIntent>({
          type: INTENT_SET_METADATA,
          payload: { workspaceRef, key: metaKey, value },
        });
      } catch (error) {
        deps.logger.warn("Failed to set workspace metadata", {
          key: metaKey,
          stateKey: key,
          error: getErrorMessage(error),
        });
      }
    }
  }

  /**
   * Create a workspace for a rendered definition. Returns the state entry on
   * success, or null on any failure — a non-event caller then does NOT
   * record the item, so it is retried next tick.
   */
  async function createWorkspace(
    source: S,
    key: string,
    definition: WorkspaceDefinition,
    projectRef: ProjectRef
  ): Promise<StateEntry | null> {
    try {
      await deps.dispatcher.dispatch<GetProjectBasesIntent>({
        type: INTENT_GET_PROJECT_BASES,
        payload: { projectRef, refresh: true, wait: true },
      });

      const agent: AgentSpec = definition.agent ?? { type: "default" };

      const wsResult = await deps.dispatcher.dispatch<OpenWorkspaceIntent>({
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          workspaceName: definition.name,
          ...(definition.base !== undefined && { base: definition.base }),
          ...(definition.tracking !== undefined && { tracking: definition.tracking }),
          stealFocus: definition.focus,
          projectRef,
          agent,
          source: "auto-workspace",
        },
      });

      await applyMetadata(source, wsResult.ref, definition, key);

      deps.logger.info("Automation created a workspace", {
        source: source.id,
        key,
        workspaceName: definition.name,
      });
      return newEntry(definition.name, projectRef);
    } catch (error) {
      // No entry written → retried next tick in workspaces mode. A name that is
      // already taken no longer reaches here — the caller adopts instead — so
      // what lands here is a real failure: an invalid name, a branch checked out
      // in a worktree CodeHydra does not manage, or a transient git error. It
      // raises a user-facing error notification like any other failed create;
      // repeats of the same one collapse into a single card with a count.
      deps.logger.warn("Automation failed to create a workspace (will retry)", {
        source: source.id,
        key,
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  /**
   * Find a workspace of the project whose name is exactly `name`.
   *
   * Name is the whole match identity for events mode: it is the worktree and
   * branch identity, and the thing a create would collide on anyway. Nothing is
   * persisted to match on, so a renamed workspace simply stops matching.
   * Comparison is case-sensitive, like every other workspace-name match.
   */
  async function findWorkspaceByName(
    projectRef: ProjectRef,
    name: string
  ): Promise<WorkspaceRef | null> {
    const projects = await deps.dispatcher.dispatch<ListProjectsIntent>({
      type: INTENT_LIST_PROJECTS,
      payload: {},
    });
    const project = projects.find((candidate) => candidate.ref === projectRef);
    return project?.workspaces.find((workspace) => workspace.name === name)?.ref ?? null;
  }

  /**
   * Does the workspace an entry points at still exist?
   *
   * This is what makes a truncated poll survivable. A cmd that returns a short
   * list — `gh` does, with exit 0, empty stderr and valid JSON — would otherwise
   * retire entries whose worktrees are still there, and every later cycle would
   * try to recreate them and collide, forever. Nothing a cmd prints can delete a
   * worktree, so existence is the signal rather than the shape of the response.
   *
   * A project that is not open answers "unknown", which counts as existing:
   * project:close tears workspaces down at runtime without touching the disk, so
   * an absent project says nothing about whether the worktree survived.
   *
   * A legacy entry has no project to look in and falls back to "does any open
   * project have a workspace by this name". Loose — two projects sharing a
   * workspace name make such an entry un-forgettable — but it only ever errs
   * toward keeping an entry, and the entry is rewritten with its project the
   * next time it is created or adopted.
   */
  async function entryWorkspaceExists(entry: StateEntry): Promise<boolean> {
    const projects = await deps.dispatcher.dispatch<ListProjectsIntent>({
      type: INTENT_LIST_PROJECTS,
      payload: {},
    });
    if (entry.projectRef === undefined) {
      return projects.some((project) =>
        project.workspaces.some((workspace) => workspace.name === entry.workspaceName)
      );
    }
    const project = projects.find((candidate) => candidate.ref === entry.projectRef);
    if (!project) return true;
    return project.workspaces.some((workspace) => workspace.name === entry.workspaceName);
  }

  /**
   * Apply one event: create the workspace it names, or act on the existing one.
   *
   * Nothing here writes state — an event fires once and is then gone, so a
   * failure is logged rather than retried (the cmd has already consumed it).
   */
  async function applyEvent(source: S, definition: WorkspaceDefinition): Promise<void> {
    const key = stateKey(source.id, definition.name);
    try {
      const projectRef = await resolveProject(source, definition, key);
      if (!projectRef) return;

      const workspaceRef = await findWorkspaceByName(projectRef, definition.name);
      if (!workspaceRef) {
        await createWorkspace(source, key, definition, projectRef);
        return;
      }

      const resolved = await deps.dispatcher.dispatch<ResolveWorkspaceIntent>({
        type: INTENT_RESOLVE_WORKSPACE,
        payload: { workspaceRef },
      });
      if (resolved.closing !== null) {
        // A teardown pipeline owns it: waking fights the deletion, and creating
        // would collide on the worktree that is still there. The next event
        // about it lands cleanly once the teardown finishes.
        deps.logger.warn("Skipping automation event (workspace is closing)", {
          source: source.id,
          key,
          closing: resolved.closing,
        });
        return;
      }

      await applyMetadata(source, workspaceRef, definition, key);

      const hibernated = resolved.metadata[HIBERNATED_METADATA_KEY] === "true";
      if (hibernated) {
        await deps.dispatcher.dispatch<WakeWorkspaceIntent>({
          type: INTENT_WAKE_WORKSPACE,
          payload: {
            workspaceRef,
            stealFocus: definition.focus,
            source: "auto-workspace",
          },
        });
      } else if (definition.focus) {
        await deps.dispatcher.dispatch<SwitchWorkspaceIntent>({
          type: INTENT_SWITCH_WORKSPACE,
          payload: { workspaceRef, focus: true },
        });
      }

      // The agent is already running (or just woke), so the prompt goes in as
      // a message rather than a launch prompt. `wake` also reopens an agent
      // terminal the user closed, and waits for a woken agent to start.
      if (definition.prompt !== undefined) {
        const message = await deps.dispatcher.dispatch<SendAgentMessageIntent>({
          type: INTENT_SEND_AGENT_MESSAGE,
          payload: {
            workspaceRef,
            text: definition.prompt,
            from: `CodeHydra · automation ${source.id}`,
            wake: true,
          },
        });
        if (!message.sent) {
          deps.logger.warn("Automation prompt not delivered", {
            source: source.id,
            key,
            reason: message.reason ?? "",
          });
        }
      }

      deps.logger.info("Automation event applied", {
        source: source.id,
        key,
        workspaceName: definition.name,
        action: hibernated ? "wake" : "update",
      });
    } catch (error) {
      // No retry: the cmd owns dedup, so the event is gone either way.
      deps.logger.warn("Failed to apply an automation event", {
        source: source.id,
        key,
        error: getErrorMessage(error),
      });
    }
  }

  // ------ Poll cycle ------

  /**
   * Run one automation's script and act on every item it printed, in order.
   * Returns whether tracking state changed.
   *
   * Non-event create items are collected into this poll's list and reconciled
   * once the list is complete; everything else acts as it is read. An invalid
   * item — or one its action refuses — is reported, and the next one still runs.
   */
  async function pollSource(source: S): Promise<boolean> {
    const raws = await runSource(source);
    if (raws === null) return false;

    const prefix = `${source.id}/`;
    const activeStateKeys = new Set<string>();
    const newItems: { key: string; definition: WorkspaceDefinition }[] = [];
    const report = (index: number, message: string): void => {
      deps.logger.warn("Automation item refused", { source: source.id, index, error: message });
      failed(source, `item ${index}: ${message}`);
    };

    for (const [index, raw] of raws.entries()) {
      let item: AutomationItem;
      try {
        item = deps.parseItem(raw);
      } catch (error) {
        report(index, getErrorMessage(error));
        continue;
      }

      if (item.action !== CREATE_ACTION) {
        try {
          await deps.invokeAction(item.action, item.input);
        } catch (error) {
          report(index, `${item.action}: ${getErrorMessage(error)}`);
        }
        continue;
      }

      const create = item.input as unknown as CreateItem;
      let definition: WorkspaceDefinition;
      try {
        definition = definitionOf(create);
      } catch (error) {
        report(index, `${CREATE_ACTION}: ${getErrorMessage(error)}`);
        continue;
      }

      if (create.event) {
        await applyEvent(source, definition);
        continue;
      }
      const fullKey = stateKey(source.id, definition.key);
      activeStateKeys.add(fullKey);
      if (!(fullKey in entries)) newItems.push({ key: fullKey, definition });
    }

    let changed = false;

    // Forget entries for this automation whose item is no longer listed — but
    // only once the workspace is gone too, so one short list cannot orphan a
    // live workspace into a permanent create-and-collide loop.
    for (const key of Object.keys(entries)) {
      if (!key.startsWith(prefix) || activeStateKeys.has(key)) continue;
      const entry = entries[key];
      if (entry !== undefined && (await entryWorkspaceExists(entry))) {
        deps.logger.debug("Keeping automation entry (workspace still exists)", {
          source: source.id,
          key,
          workspaceName: entry.workspaceName,
        });
        continue;
      }
      delete entries[key];
      changed = true;
      deps.logger.info("Forgot automation entry (item and workspace both gone)", {
        source: source.id,
        key,
      });
    }

    // Create workspaces for new items — or adopt, when the name is already taken.
    for (const { key, definition } of newItems) {
      const projectRef = await resolveProject(source, definition, key);
      if (!projectRef) continue;

      // An entry can go missing while its workspace stays: a legacy entry the
      // any-project fallback missed, or a workspace made by hand under an
      // incoming item's name. Creating would then collide on the branch every
      // cycle, forever, so take ownership of what is already there instead.
      // Adopting writes the entry and nothing else — no metadata, no wake, no
      // focus, and no prompt: it is bookkeeping, not news for the agent.
      const existing = await findWorkspaceByName(projectRef, definition.name);
      if (existing) {
        entries[key] = newEntry(definition.name, projectRef);
        changed = true;
        deps.logger.info("Adopted existing workspace for an automation item", {
          source: source.id,
          key,
          workspaceName: definition.name,
        });
        continue;
      }

      const entry = await createWorkspace(source, key, definition, projectRef);
      if (entry) {
        entries[key] = entry;
        changed = true;
      }
    }

    return changed;
  }

  /** One poll cycle; everything it dispatches has origin "auto-workspace". */
  function reconcile(): Promise<void> {
    return deps.dispatcher.withOrigin({ origin: "auto-workspace" }, reconcileSources);
  }

  async function reconcileSources(): Promise<void> {
    if (!deps.enabled()) return;
    settleLastCycle();
    const sources = await deps.sources();
    ranLastCycle = sources;

    let changed = false;

    // Orphan cleanup: drop entries whose automation no longer exists (removed,
    // or its plugin disabled or broken).
    for (const key of Object.keys(entries)) {
      if (!sources.some((source) => key.startsWith(`${source.id}/`))) {
        delete entries[key];
        changed = true;
        deps.logger.info("Forgot automation entry (automation removed)", { key });
      }
    }

    for (const source of sources) {
      if (await pollSource(source)) changed = true;
    }

    if (changed) await persist();
  }

  /**
   * Arm the next wait. Chained rather than periodic: the wait is the gap between
   * the end of one cycle and the start of the next, so a slow poll never stacks.
   * The interval is re-read here, so a live change applies from the next wait on.
   */
  function scheduleNext(): void {
    if (stopped || timer) return;
    const intervalSeconds = intervalAccessor.get();
    if (armedIntervalSeconds !== null && armedIntervalSeconds !== intervalSeconds) {
      deps.logger.info("Automations poll interval changed", {
        from: armedIntervalSeconds,
        to: intervalSeconds,
      });
    }
    armedIntervalSeconds = intervalSeconds;
    timer = setTimeout(() => {
      timer = null;
      void reconcile()
        .catch((error: unknown) => {
          deps.logger.warn("Automations poll failed", { error: getErrorMessage(error) });
        })
        .finally(scheduleNext);
    }, intervalSeconds * 1000);
  }

  function startPolling(): void {
    if (stopped || timer) return;
    deps.logger.info("Automations polling started", {
      intervalSeconds: intervalAccessor.get(),
    });
    scheduleNext();
  }

  function stopPolling(): void {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
      deps.logger.info("Automations polling stopped");
    }
  }

  // ------ Module definition ------

  async function migrateEntries(refsByPath: ReadonlyMap<string, ProjectRef>): Promise<void> {
    const current = stateAccessor.get();
    let changed = false;
    const next: AutoWorkspaceEntries = {};
    for (const [key, entry] of Object.entries(current)) {
      const ref = entry.projectPath === undefined ? undefined : refOfPath(entry.projectPath);
      if (ref === undefined) {
        next[key] = entry;
        continue;
      }
      changed = true;
      next[key] = {
        workspaceName: entry.workspaceName,
        createdAt: entry.createdAt,
        projectRef: ref,
      };
    }
    if (!changed) return;
    entries = next;
    await stateAccessor.set(next);

    function refOfPath(path: string): ProjectRef | undefined {
      try {
        return refsByPath.get(new Path(path).toString());
      } catch {
        return undefined;
      }
    }
  }

  return {
    migrateEntries,
    async renameTracking(rename): Promise<void> {
      const current = stateAccessor.get();
      let changed = false;
      const next: AutoWorkspaceEntries = {};
      for (const [key, entry] of Object.entries(current)) {
        const to = rename(key);
        if (to !== undefined && to !== key) changed = true;
        next[to ?? key] = entry;
      }
      if (!changed) return;
      entries = next;
      await stateAccessor.set(next);
    },
    async start(): Promise<void> {
      entries = stateAccessor.get();
      await reconcile();
      startPolling();
    },
    stop: stopPolling,
  };
}
