/**
 * Automations — a plugin script run every poll cycle, whose items each run an
 * action.
 *
 * An automation is a local plugin's `automations.<name>` (manifest.ts): a
 * script that prints a JSON array, the `action` each item runs, and a
 * `template` rendered once per item into that action's input. Its identity is
 * `<plugin>/<name>`. The plugin module supplies the sources and runs the
 * scripts; this file decides what the items mean.
 *
 * `action: workspace.create` (the default) is the auto-workspace behavior — the
 * template is a workspace definition (template-render.ts), and `mode` says
 * what the items mean:
 *
 * `mode: workspaces` (the default) — the script prints the desired workspace
 * list, and the poll reconciles against it:
 *   - a key already tracked in state is skipped
 *   - a new key whose name is already taken adopts that workspace (entry only)
 *   - any other new key creates a workspace (entry written only on success)
 *   - a tracked key absent from this cycle is forgotten only if its workspace is
 *     gone too, so a script that returns a short list for one cycle cannot
 *     orphan a live workspace
 * There is no auto-deletion; a manually deleted workspace's entry simply
 * persists (so it is not recreated while its item is still active) and is
 * forgotten once the item disappears.
 *
 * `mode: events` — the script prints things that happened, and each one fires
 * exactly once. Nothing is tracked in state: the script owns dedup (it acks,
 * pops a queue, or keeps its own cursor), so an event printed twice fires
 * twice. Per event the project is resolved, then the rendered `template.name`
 * is matched against that project's workspaces:
 *   - no match          → create, exactly like the workspaces mode
 *   - match, closing    → skip (a teardown pipeline owns it)
 *   - match             → re-apply the rendered metadata, then wake it if it is
 *                         hibernated, or switch to it if `focus: true`, then
 *                         send the rendered `prompt` (if any) to its agent as a
 *                         message — reopening a closed agent terminal first
 * A failed event is logged and gone: unlike a workspaces-mode item there is no
 * retry, since the script has already consumed it.
 *
 * Any other action runs as events: each item's rendered template is the input
 * of that operation, invoked through the registry like `ch` would.
 *
 * `automations.poll-interval` (seconds, default 60) is the *gap between runs*:
 * the next wait is armed only once a cycle has settled, so a slow poll never
 * stacks. The value is re-read when each wait is armed, so a change made in the
 * settings dialog applies once the current wait elapses.
 */

import { movedPath, type ProjectMoveListener } from "../workspaces-root/workspaces-root";
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
import type { AgentSpec } from "../../shared/api/types";
import type { OperationName } from "../../api/names";
import { getErrorMessage } from "../../shared/error-utils";
import { Path } from "../../utils/path/path";
import { renderDefinition, renderInput, type WorkspaceDefinition } from "./template-render";
import type { AutomationMode, TemplateObject } from "./manifest";
import { projectPathSchema, type ProjectPath, type WorkspacePath } from "../../intents/contract";

// =============================================================================
// State
// =============================================================================

interface StateEntry {
  readonly workspaceName: string;
  readonly createdAt: string;
  /**
   * Project the workspace lives in, so the entry can be dereferenced when its
   * item disappears (see entryWorkspaceExists). Optional: entries written before
   * this field existed carry none, and a downgrade drops it again — both land in
   * the same any-project fallback, and both are repaired the next time the entry
   * is written.
   */
  readonly projectPath?: string;
}

/** Tracking map `${plugin}/${automation}/${itemKey}` -> entry, stored under `auto-workspaces`. */
type AutoWorkspaceEntries = Record<string, StateEntry>;

function isStateEntry(value: unknown): value is StateEntry {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  if (typeof o.workspaceName !== "string" || typeof o.createdAt !== "string") return false;
  return o.projectPath === undefined || typeof o.projectPath === "string";
}

function validateEntries(value: unknown): AutoWorkspaceEntries | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: AutoWorkspaceEntries = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isStateEntry(entry)) {
      out[key] = {
        workspaceName: entry.workspaceName,
        createdAt: entry.createdAt,
        ...(entry.projectPath !== undefined && { projectPath: entry.projectPath }),
      };
    }
  }
  return out;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// =============================================================================
// Constants
// =============================================================================

/** Default gap between the end of one reconcile-and-poll cycle and the next. */
const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const METADATA_SOURCE_KEY = "source";

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
  readonly action: OperationName;
  readonly mode: AutomationMode;
  readonly template: TemplateObject;
}

export interface AutomationsDeps {
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
  readonly sources: () => Promise<readonly AutomationSource[]>;
  /** Run a source's script: its items, or null when it failed (already reported). */
  readonly runScript: (source: AutomationSource) => Promise<unknown[] | null>;
  /** Run a non-create action with a rendered input. Throws on failure. */
  readonly invokeAction: (action: OperationName, input: Record<string, unknown>) => Promise<void>;
  /**
   * An item of a source failed in a way the user must hear about (a template
   * mistake, an action that was refused). Repeats of the same text collapse.
   */
  readonly reportError: (source: AutomationSource, message: string) => void;
}

// =============================================================================
// Helpers
// =============================================================================

function stateKey(sourceId: string, itemKey: string): string {
  return `${sourceId}/${itemKey}`;
}

function newEntry(workspaceName: string, projectPath: ProjectPath): StateEntry {
  return { workspaceName, createdAt: new Date().toISOString(), projectPath };
}

// =============================================================================
// Factory
// =============================================================================

export interface Automations {
  /** Load state, run the first cycle, start polling. */
  start(): Promise<void>;
  /** Stop polling. */
  stop(): void;
  /** Point tracking entries at projects whose path changed. */
  readonly moveProjects: ProjectMoveListener;
  /**
   * Rename tracking keys (`undefined` keeps a key as it is). For moving the
   * entries of the pre-plugin setting over to its automations, before `start`.
   */
  renameTracking(rename: (key: string) => string | undefined): Promise<void>;
}

/** The pre-plugin name of the poll interval, still honored. */
const LEGACY_INTERVAL_KEY = "auto-workspace.poll-interval";

export function createAutomations(deps: AutomationsDeps): Automations {
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
   * Open (cloning if needed) the project a rendered definition points at, and
   * return its path. Null when the template names neither `project` nor `git`,
   * when `project` is not an absolute path, when project:open yields nothing,
   * or when it fails.
   *
   * Failure is swallowed rather than thrown because this is the first step of
   * handling one item, and one item must never take the cycle down with it: a
   * bad `project` path or an unreachable clone URL would otherwise abandon every
   * later item AND every later source. Null leaves a workspaces-mode item
   * unrecorded (retried next tick) and drops an event (there is no retry).
   *
   * A template mistake would otherwise retry silently forever, so it is also
   * reported. A failed clone is not: the clone's own card already turns into
   * "Clone failed".
   */
  async function resolveProjectPath(
    source: AutomationSource,
    definition: WorkspaceDefinition,
    key: string
  ): Promise<ProjectPath | null> {
    let projectPayload: OpenProjectIntent["payload"];
    if (definition.project) {
      try {
        // A user-authored template value: normalize, then mint the brand by parsing.
        projectPayload = {
          path: projectPathSchema.parse(new Path(definition.project).toString()),
        };
      } catch {
        // The value itself stays out of the log: a URL put here may carry a token.
        deps.logger.warn("Skipping automation item (project is not an absolute path)", { key });
        deps.reportError(
          source,
          `project must be an absolute path — use git: for a URL (got "${definition.project}")`
        );
        return null;
      }
    } else if (definition.git) {
      projectPayload = { git: definition.git };
    } else {
      deps.logger.warn("Skipping automation item (no project/git in template)", { key });
      deps.reportError(source, "the template needs a project: path or a git: URL");
      return null;
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
      return project.path;
    } catch (error) {
      deps.logger.warn("Failed to open project for an automation", {
        key,
        error: getErrorMessage(error),
      });
      if (projectPayload.path !== undefined) {
        deps.reportError(source, `cannot open its project: ${getErrorMessage(error)}`);
      }
      return null;
    }
  }

  /**
   * Write the source identity plus the template's rendered metadata onto a
   * workspace. Best-effort per key: metadata is cosmetic, so one bad key never
   * fails the create (or the event) around it.
   *
   * `source` is rewritten on every hit, not only at create — an events-mode
   * automation that acts on a workspace is its current owner as far as the
   * sidebar is concerned, including one the user made by hand under a matching
   * name.
   */
  async function applyMetadata(
    source: AutomationSource,
    workspacePath: WorkspacePath,
    definition: WorkspaceDefinition,
    key: string
  ): Promise<void> {
    const allMetadata: Record<string, string> = {
      [METADATA_SOURCE_KEY]: source.id,
      ...(definition.metadata ?? {}),
    };
    for (const [metaKey, value] of Object.entries(allMetadata)) {
      try {
        await deps.dispatcher.dispatch<SetMetadataIntent>({
          type: INTENT_SET_METADATA,
          payload: { workspacePath, key: metaKey, value },
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
   * success, or null on any failure — a workspaces-mode caller then does NOT
   * record the item, so it is retried next tick.
   */
  async function createWorkspace(
    source: AutomationSource,
    key: string,
    definition: WorkspaceDefinition,
    projectPath: ProjectPath
  ): Promise<StateEntry | null> {
    try {
      await deps.dispatcher.dispatch<GetProjectBasesIntent>({
        type: INTENT_GET_PROJECT_BASES,
        payload: { projectPath, refresh: true, wait: true },
      });

      const agent: AgentSpec = definition.agent ?? {
        type: "default",
        ...(definition.prompt !== "" && { prompt: definition.prompt }),
      };

      const wsResult = await deps.dispatcher.dispatch<OpenWorkspaceIntent>({
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          workspaceName: definition.name,
          ...(definition.base !== undefined && { base: definition.base }),
          ...(definition.tracking !== undefined && { tracking: definition.tracking }),
          stealFocus: definition.focus ?? false,
          projectPath,
          agent,
          source: "auto-workspace",
        },
      });

      await applyMetadata(source, wsResult.path, definition, key);

      deps.logger.info("Automation created a workspace", {
        source: source.id,
        key,
        workspaceName: definition.name,
      });
      return newEntry(definition.name, projectPath);
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
   * Find a workspace of `projectPath` whose name is exactly `name`.
   *
   * Name is the whole match identity for events mode: it is the worktree and
   * branch identity, and the thing a create would collide on anyway. Nothing is
   * persisted to match on, so a renamed workspace simply stops matching.
   * Comparison is case-sensitive, like every other workspace-name match.
   */
  async function findWorkspaceByName(
    projectPath: ProjectPath,
    name: string
  ): Promise<WorkspacePath | null> {
    const projects = await deps.dispatcher.dispatch<ListProjectsIntent>({
      type: INTENT_LIST_PROJECTS,
      payload: {},
    });
    const target = new Path(projectPath);
    for (const project of projects) {
      if (!target.equals(new Path(project.path))) continue;
      for (const workspace of project.workspaces) {
        if (workspace.name === name) return workspace.path;
      }
    }
    return null;
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
    if (entry.projectPath === undefined) {
      return projects.some((project) =>
        project.workspaces.some((workspace) => workspace.name === entry.workspaceName)
      );
    }
    const target = new Path(entry.projectPath);
    const project = projects.find((candidate) => target.equals(new Path(candidate.path)));
    if (!project) return true;
    return project.workspaces.some((workspace) => workspace.name === entry.workspaceName);
  }

  /**
   * Apply one event: create the workspace it names, or act on the existing one.
   *
   * Nothing here writes state — an event fires once and is then gone, so a
   * failure is logged rather than retried (the cmd has already consumed it).
   */
  async function applyEvent(
    source: AutomationSource,
    definition: WorkspaceDefinition
  ): Promise<void> {
    const key = stateKey(source.id, definition.name);
    try {
      const projectPath = await resolveProjectPath(source, definition, key);
      if (!projectPath) return;

      const workspacePath = await findWorkspaceByName(projectPath, definition.name);
      if (!workspacePath) {
        await createWorkspace(source, key, definition, projectPath);
        return;
      }

      const resolved = await deps.dispatcher.dispatch<ResolveWorkspaceIntent>({
        type: INTENT_RESOLVE_WORKSPACE,
        payload: { workspacePath },
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

      await applyMetadata(source, workspacePath, definition, key);

      const hibernated = resolved.metadata[HIBERNATED_METADATA_KEY] === "true";
      if (hibernated) {
        await deps.dispatcher.dispatch<WakeWorkspaceIntent>({
          type: INTENT_WAKE_WORKSPACE,
          payload: {
            workspacePath,
            stealFocus: definition.focus ?? false,
            source: "auto-workspace",
          },
        });
      } else if (definition.focus === true) {
        await deps.dispatcher.dispatch<SwitchWorkspaceIntent>({
          type: INTENT_SWITCH_WORKSPACE,
          payload: { workspacePath, focus: true },
        });
      }

      // The agent is already running (or just woke), so the prompt goes in as
      // a message rather than a launch prompt. `wake` also reopens an agent
      // terminal the user closed, and waits for a woken agent to start.
      if (definition.prompt !== "") {
        const message = await deps.dispatcher.dispatch<SendAgentMessageIntent>({
          type: INTENT_SEND_AGENT_MESSAGE,
          payload: {
            workspacePath,
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
   * Render one emitted object, logging any template warnings under `key`.
   * Null when Liquid rendering itself failed — that item is skipped.
   */
  function render(
    source: AutomationSource,
    data: unknown,
    keyOf: (definition: WorkspaceDefinition) => string
  ): WorkspaceDefinition | null {
    try {
      const { definition, warnings } = renderDefinition(source.template, data);
      for (const warning of warnings) {
        deps.logger.warn("Template warning", {
          source: source.id,
          key: keyOf(definition),
          warning,
        });
      }
      return definition;
    } catch (error) {
      deps.logger.warn("Failed to render item, skipping it", {
        source: source.id,
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  /** Reconcile a `mode: workspaces` source against the list its script printed. */
  async function pollWorkspacesSource(source: AutomationSource): Promise<boolean> {
    const items = await deps.runScript(source);
    if (items === null) return false;

    const prefix = `${source.id}/`;
    const activeStateKeys = new Set<string>();
    const newItems: { key: string; definition: WorkspaceDefinition }[] = [];

    for (const data of items) {
      const definition = render(source, data, (d) => stateKey(source.id, d.key));
      if (!definition) continue;
      const fullKey = stateKey(source.id, definition.key);
      activeStateKeys.add(fullKey);
      if (!(fullKey in entries)) newItems.push({ key: fullKey, definition });
    }

    let changed = false;

    // Forget entries for this source whose item is no longer active — but only
    // once the workspace is gone too, so one short cmd result cannot orphan a
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
      const projectPath = await resolveProjectPath(source, definition, key);
      if (!projectPath) continue;

      // An entry can go missing while its workspace stays: a legacy entry the
      // any-project fallback missed, or a workspace made by hand under an
      // incoming item's name. Creating would then collide on the branch every
      // cycle, forever, so take ownership of what is already there instead.
      // Adopting writes the entry and nothing else — no metadata, no wake, no
      // focus, and no prompt: it is bookkeeping, not news for the agent.
      const existing = await findWorkspaceByName(projectPath, definition.name);
      if (existing) {
        entries[key] = newEntry(definition.name, projectPath);
        changed = true;
        deps.logger.info("Adopted existing workspace for an automation item", {
          source: source.id,
          key,
          workspaceName: definition.name,
        });
        continue;
      }

      const entry = await createWorkspace(source, key, definition, projectPath);
      if (entry) {
        entries[key] = entry;
        changed = true;
      }
    }

    return changed;
  }

  /** Fire every event a `mode: events` workspace.create source printed, in order. */
  async function pollEventsSource(source: AutomationSource): Promise<void> {
    const items = await deps.runScript(source);
    if (items === null) return;

    for (const data of items) {
      const definition = render(source, data, (d) => stateKey(source.id, d.name));
      if (!definition) continue;
      await applyEvent(source, definition);
    }
  }

  /**
   * Run any other action once per printed item. Each failure is reported —
   * a refused input is a template mistake the user must see — and the next
   * item still runs. Writes no state.
   */
  async function pollActionSource(source: AutomationSource): Promise<void> {
    const items = await deps.runScript(source);
    if (items === null) return;

    for (const data of items) {
      let input: Record<string, unknown>;
      try {
        input = renderInput(source.template, data);
      } catch (error) {
        deps.logger.warn("Failed to render item, skipping it", {
          source: source.id,
          error: getErrorMessage(error),
        });
        continue;
      }
      try {
        await deps.invokeAction(source.action, input);
      } catch (error) {
        deps.logger.warn("Automation action failed", {
          source: source.id,
          action: source.action,
          error: getErrorMessage(error),
        });
        deps.reportError(source, `${source.action}: ${getErrorMessage(error)}`);
      }
    }
  }

  async function reconcile(): Promise<void> {
    if (!deps.enabled()) return;
    const sources = await deps.sources();

    let changed = false;

    // Orphan cleanup: drop entries whose automation no longer exists — or is no
    // longer a reconciling one, since an events automation is defined as
    // writing no state and its old entries would resurrect wrongly on a flip back.
    const reconciling = sources.filter(
      (s) => s.action === "workspace.create" && s.mode === "workspaces"
    );
    for (const key of Object.keys(entries)) {
      if (!reconciling.some((s) => key.startsWith(`${s.id}/`))) {
        delete entries[key];
        changed = true;
        deps.logger.info("Forgot automation entry (automation removed or now events)", { key });
      }
    }

    for (const source of sources) {
      if (source.action !== "workspace.create") {
        await pollActionSource(source);
      } else if (source.mode === "events") {
        await pollEventsSource(source);
      } else if (await pollWorkspacesSource(source)) {
        changed = true;
      }
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

  const moveProjects: ProjectMoveListener = async (moves) => {
    const current = stateAccessor.get();
    let changed = false;
    const next: AutoWorkspaceEntries = {};
    for (const [key, entry] of Object.entries(current)) {
      const to = entry.projectPath === undefined ? undefined : movedPath(moves, entry.projectPath);
      if (to !== undefined) changed = true;
      next[key] = to === undefined ? entry : { ...entry, projectPath: to };
    }
    if (!changed) return;
    entries = next;
    await stateAccessor.set(next);
  };

  return {
    moveProjects,
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
