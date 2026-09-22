/**
 * AutoWorkspaceModule — polls user-defined command sources and creates
 * workspaces to match.
 *
 * Sources are data, not code: the `auto-workspace.sources` config value is a
 * multi-document YAML stream (one document per source; see source-config.ts).
 * Each source's `cmd` emits a JSON array of domain objects; the source's
 * `template` renders one workspace definition per object (see template-render.ts).
 *
 * A single chained timer drives everything: each cycle re-reads the config
 * (picking up edits without a restart), then polls every source. What a poll
 * *means* depends on the source's `mode`:
 *
 * `mode: workspaces` (the default) — the cmd emits the desired workspace list,
 * and the poll reconciles against it:
 *   - a key already tracked in state is skipped
 *   - a new key whose name is already taken adopts that workspace (entry only)
 *   - any other new key creates a workspace (entry written only on success)
 *   - a tracked key absent from this cycle is forgotten only if its workspace is
 *     gone too, so a source that returns a short list for one cycle cannot
 *     orphan a live workspace
 * There is no auto-deletion; a manually deleted workspace's entry simply
 * persists (so it is not recreated while its item is still active) and is
 * forgotten once the item disappears.
 *
 * `mode: events` — the cmd emits things that happened, and each one fires
 * exactly once. Nothing is tracked in state: the cmd owns dedup (it acks, pops
 * a queue, or keeps its own cursor), so an event that is emitted twice fires
 * twice. Per event the module resolves the project, then matches the rendered
 * `template.name` against that project's workspaces:
 *   - no match          → create, exactly like the workspaces mode
 *   - match, closing    → skip (a teardown pipeline owns it)
 *   - match             → re-apply the rendered metadata, then wake it if it is
 *                         hibernated, or switch to it if `focus: true`
 * The metadata is the whole signal — no prompt is delivered to an existing
 * workspace's agent, because a prompt only reaches one at launch. A failed
 * event is logged and gone: unlike a workspaces-mode item there is no retry,
 * since the cmd has already consumed it.
 *
 * `auto-workspace.poll-interval` (seconds, default 60) is the *gap between
 * runs*: the next wait is armed only once a cycle has settled, so a slow poll
 * never stacks. The value is re-read when each wait is armed, so a change made
 * in the settings dialog applies once the current wait elapses.
 *
 * Hooks:
 * - app:shutdown -> "stop": stop polling
 *
 * Events:
 * - app:started: load state, run the first cycle, start polling
 */

import type { IntentModule } from "../../intents/lib/module";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import { EVENT_APP_STARTED } from "../../intents/app-ready";
import { APP_SHUTDOWN_OPERATION_ID } from "../../intents/app-shutdown";
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
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../../intents/set-metadata";
import type { Config } from "../../boundaries/platform/config";
import {
  storeText,
  storeCustom,
  storeNumber,
  type PersistedAccessor,
} from "../../boundaries/platform/store-definition";
import { SOURCES_HELP } from "./template-defaults";
import type { StateService } from "../../boundaries/platform/state-service";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { ProcessRunner } from "../../boundaries/platform/process";
import type { UiPresenter } from "../presentation/presentation-module";
import type { NotificationHandle } from "../presentation/sessions";
import type { AgentSpec } from "../../shared/api/types";
import { getErrorMessage } from "../../shared/error-utils";
import { Path } from "../../utils/path/path";
import { parseSources, validateSourcesConfig, type ParsedSource } from "./source-config";
import { renderDefinition, type WorkspaceDefinition } from "./template-render";
import { runCmd } from "./cmd-runner";
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

/** Tracking map `${source}/${itemKey}` -> entry, stored under `auto-workspaces`. */
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

export interface AutoWorkspaceModuleDeps {
  readonly logger: Logger;
  readonly dispatcher: Dispatcher;
  readonly processRunner: ProcessRunner;
  readonly configService: Config;
  readonly stateService: StateService;
  readonly ui: Pick<UiPresenter, "notification">;
}

// =============================================================================
// Helpers
// =============================================================================

function stateKey(sourceName: string, itemKey: string): string {
  return `${sourceName}/${itemKey}`;
}

function sourceOfKey(key: string): string {
  const slash = key.indexOf("/");
  return slash === -1 ? key : key.slice(0, slash);
}

function newEntry(workspaceName: string, projectPath: ProjectPath): StateEntry {
  return { workspaceName, createdAt: new Date().toISOString(), projectPath };
}

// =============================================================================
// Factory
// =============================================================================

export function createAutoWorkspaceModule(deps: AutoWorkspaceModuleDeps): IntentModule {
  const sourcesBase = storeText({
    nullable: true,
    rows: 20,
    helpLabel: "Source format reference",
    helpPanel: SOURCES_HELP,
  });
  const sourcesAccessor: PersistedAccessor<string | null> = deps.configService.register(
    "auto-workspace.sources",
    {
      default: null,
      description: "Auto-workspace sources (multi-document YAML; one document per source)",
      applies: "live",
      // May embed secrets (e.g. an inlined API token in a cmd): kept out of bug
      // reports, but shown in the clear in the settings editor — hence omit.
      omit: true,
      ...sourcesBase,
      validate: (v: unknown): string | null | undefined => {
        const parsed = sourcesBase.validate(v);
        if (parsed === undefined) return undefined;
        return validateSourcesConfig(parsed);
      },
    }
  );

  const intervalAccessor: PersistedAccessor<number> = deps.configService.register(
    "auto-workspace.poll-interval",
    {
      default: DEFAULT_POLL_INTERVAL_SECONDS,
      description:
        "Seconds to wait between the end of one auto-workspace poll and the start of the next " +
        "(a change applies after the current wait elapses)",
      applies: "live",
      ...storeNumber({ min: 1 }),
    }
  );

  const stateAccessor = deps.stateService.register("auto-workspaces", {
    default: {} as AutoWorkspaceEntries,
    description: "Auto-workspace tracking entries (app-managed)",
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
      deps.logger.warn("Failed to save auto-workspace state", { error: getErrorMessage(error) });
    }
  }

  // ------ Workspace lifecycle ------

  /**
   * Raise an error card for a per-item failure the log alone would hide. Every
   * poll re-reports it, and the NotificationManager collapses a repeat of the
   * same text into the live card with a count; dismissing retires the card, and
   * the next failing poll raises a fresh one. The handle is shared across those
   * collapsed opens, so its dismiss listener is wired only once.
   */
  const wiredHandles = new WeakSet<NotificationHandle>();
  function notifyItemError(title: string, message: string): void {
    const handle = deps.ui.notification({ type: "error", title, message, dismissible: true });
    if (wiredHandles.has(handle)) return;
    wiredHandles.add(handle);
    handle.onEvent(() => {
      handle.close();
    });
  }

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
   * A template mistake would otherwise retry silently forever, so it also
   * raises an error notification. A failed clone does not: the clone's own card
   * already turns into "Clone failed".
   */
  async function resolveProjectPath(
    source: ParsedSource,
    definition: WorkspaceDefinition,
    key: string
  ): Promise<ProjectPath | null> {
    const title = `Auto-workspace source "${source.name}" cannot open its project`;
    let projectPayload: OpenProjectIntent["payload"];
    if (definition.project) {
      try {
        // A user-authored template value: normalize, then mint the brand by parsing.
        projectPayload = {
          path: projectPathSchema.parse(new Path(definition.project).toString()),
        };
      } catch {
        // The value itself stays out of the log: a URL put here may carry a token.
        deps.logger.warn("Skipping auto-workspace (project is not an absolute path)", { key });
        notifyItemError(
          title,
          `${source.name}: project must be an absolute path — use git: for a URL (got "${definition.project}")`
        );
        return null;
      }
    } else if (definition.git) {
      projectPayload = { git: definition.git };
    } else {
      deps.logger.warn("Skipping auto-workspace (no project/git in template)", { key });
      notifyItemError(title, `${source.name}: the template needs a project: path or a git: URL`);
      return null;
    }

    try {
      const project = await deps.dispatcher.dispatch<OpenProjectIntent>({
        type: INTENT_OPEN_PROJECT,
        payload: projectPayload,
      });
      if (!project) {
        deps.logger.warn("project:open returned null for auto-workspace", { key });
        return null;
      }
      return project.path;
    } catch (error) {
      deps.logger.warn("Failed to open project for auto-workspace", {
        key,
        error: getErrorMessage(error),
      });
      if (projectPayload.path !== undefined) {
        notifyItemError(title, `${source.name}: ${getErrorMessage(error)}`);
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
   * source that acts on a workspace is its current owner as far as the sidebar
   * is concerned, including one the user made by hand under a matching name.
   */
  async function applyMetadata(
    source: ParsedSource,
    workspacePath: WorkspacePath,
    definition: WorkspaceDefinition,
    key: string
  ): Promise<void> {
    const allMetadata: Record<string, string> = {
      [METADATA_SOURCE_KEY]: source.name,
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
    source: ParsedSource,
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

      deps.logger.info("Auto-workspace created", {
        source: source.name,
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
      deps.logger.warn("Failed to create auto-workspace (will retry)", {
        source: source.name,
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
  async function applyEvent(source: ParsedSource, definition: WorkspaceDefinition): Promise<void> {
    const key = stateKey(source.name, definition.name);
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
        deps.logger.warn("Skipping auto-workspace event (workspace is closing)", {
          source: source.name,
          key,
          closing: resolved.closing,
        });
        return;
      }

      // The rendered metadata is the event's only signal — a prompt cannot reach
      // an agent that is already running (it is read from a file at launch).
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

      deps.logger.info("Auto-workspace event applied", {
        source: source.name,
        key,
        workspaceName: definition.name,
        action: hibernated ? "wake" : "update",
      });
    } catch (error) {
      // No retry: the cmd owns dedup, so the event is gone either way.
      deps.logger.warn("Failed to apply auto-workspace event", {
        source: source.name,
        key,
        error: getErrorMessage(error),
      });
    }
  }

  // ------ Poll cycle ------

  /** Run a source's cmd, or null when it failed (the tick is then skipped). */
  async function runSourceCmd(source: ParsedSource): Promise<unknown[] | null> {
    try {
      return await runCmd({ processRunner: deps.processRunner }, source.name, source.cmd);
    } catch (error) {
      deps.logger.warn("Source cmd failed, skipping tick", {
        source: source.name,
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  /**
   * Render one emitted object, logging any template warnings under `key`.
   * Null when Liquid rendering itself failed — that item is skipped.
   */
  function render(
    source: ParsedSource,
    data: unknown,
    keyOf: (definition: WorkspaceDefinition) => string
  ): WorkspaceDefinition | null {
    try {
      const { definition, warnings } = renderDefinition(source.template, data);
      for (const warning of warnings) {
        deps.logger.warn("Template warning", {
          source: source.name,
          key: keyOf(definition),
          warning,
        });
      }
      return definition;
    } catch (error) {
      deps.logger.warn("Failed to render item, skipping it", {
        source: source.name,
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  /** Reconcile a `mode: workspaces` source against the list its cmd emitted. */
  async function pollWorkspacesSource(source: ParsedSource): Promise<boolean> {
    const items = await runSourceCmd(source);
    if (items === null) return false;

    const prefix = `${source.name}/`;
    const activeStateKeys = new Set<string>();
    const newItems: { key: string; definition: WorkspaceDefinition }[] = [];

    for (const data of items) {
      const definition = render(source, data, (d) => stateKey(source.name, d.key));
      if (!definition) continue;
      const fullKey = stateKey(source.name, definition.key);
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
        deps.logger.debug("Keeping auto-workspace entry (workspace still exists)", {
          source: source.name,
          key,
          workspaceName: entry.workspaceName,
        });
        continue;
      }
      delete entries[key];
      changed = true;
      deps.logger.info("Forgot auto-workspace entry (item and workspace both gone)", {
        source: source.name,
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
      // focus, and no prompt, which only ever reaches an agent at launch.
      const existing = await findWorkspaceByName(projectPath, definition.name);
      if (existing) {
        entries[key] = newEntry(definition.name, projectPath);
        changed = true;
        deps.logger.info("Adopted existing workspace for auto-workspace item", {
          source: source.name,
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

  /** Fire every event a `mode: events` source emitted, in order. Writes no state. */
  async function pollEventsSource(source: ParsedSource): Promise<void> {
    const items = await runSourceCmd(source);
    if (items === null) return;

    for (const data of items) {
      const definition = render(source, data, (d) => stateKey(source.name, d.name));
      if (!definition) continue;
      await applyEvent(source, definition);
    }
  }

  async function reconcile(): Promise<void> {
    const { sources, errors } = parseSources(sourcesAccessor.get());
    for (const err of errors) {
      deps.logger.warn("Invalid auto-workspace source, ignoring", {
        source: err.name ?? `#${err.index}`,
        message: err.message,
      });
    }

    let changed = false;

    // Orphan cleanup: drop entries whose source no longer exists in config — or
    // is no longer a workspaces source, since an events source is defined as
    // writing no state and its old entries would resurrect wrongly on a flip back.
    const validNames = new Set(sources.filter((s) => s.mode === "workspaces").map((s) => s.name));
    for (const key of Object.keys(entries)) {
      if (!validNames.has(sourceOfKey(key))) {
        delete entries[key];
        changed = true;
        deps.logger.info("Forgot auto-workspace entry (source removed or now events-mode)", {
          key,
        });
      }
    }

    for (const source of sources) {
      if (source.mode === "events") {
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
      deps.logger.info("Auto-workspace poll interval changed", {
        from: armedIntervalSeconds,
        to: intervalSeconds,
      });
    }
    armedIntervalSeconds = intervalSeconds;
    timer = setTimeout(() => {
      timer = null;
      void reconcile()
        .catch((error: unknown) => {
          deps.logger.warn("Auto-workspace poll failed", { error: getErrorMessage(error) });
        })
        .finally(scheduleNext);
    }, intervalSeconds * 1000);
  }

  function startPolling(): void {
    if (stopped || timer) return;
    deps.logger.info("Auto-workspace polling started", {
      intervalSeconds: intervalAccessor.get(),
    });
    scheduleNext();
  }

  function stopPolling(): void {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
      deps.logger.info("Auto-workspace polling stopped");
    }
  }

  // ------ Module definition ------

  return {
    name: "auto-workspace",
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            stopPolling();
          },
        },
      },
    },
    events: {
      [EVENT_APP_STARTED]: {
        handler: async (): Promise<void> => {
          entries = stateAccessor.get();
          await reconcile();
          startPolling();
        },
      },
    },
  };
}
