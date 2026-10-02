/**
 * PluginModule — the one place user-provided scripts attach to CodeHydra.
 *
 * A plugin is a YAML manifest (manifest.ts) found in one of two places
 * (discovery.ts): the user's own in `~/.codehydra/plugins`, which apply to every
 * project and run without asking, and a repository's in the worktree's
 * `.codehydra/plugins`, which apply to that worktree and run once trusted
 * (trust.ts). Every script a plugin contributes runs through one runner
 * (script-runner.ts) in the shell its document names.
 *
 * What a plugin can contribute:
 *
 * - **hooks** at moments in a workspace's life. `hook-map.ts` is the contract —
 *   which moments exist, what each is handed, what each may return. An `on-`
 *   entry reports something that already happened and is fired and forgotten;
 *   every other entry blocks the moment it belongs to:
 *   - `after-worktree-created` at `open-workspace : provision`, for a genuinely
 *     new worktree only. Best-effort: a failure is loud but the workspace
 *     still opens — the worktree exists by then, and a failed `pnpm install`
 *     is a thing you fix *in* the workspace.
 *   - `before-workspace-opened` at `open-workspace : prepare` on every open —
 *     new, app start, project open, wake — supplying the environment the agent
 *     and the editor's terminals get. Same failure rule. It runs each time
 *     because that environment lives in memory only.
 *   - `before-worktree-deleted` at `delete-workspace : pre-delete`, which can
 *     refuse. It fails closed: a script that breaks stops the deletion too.
 *   - `on-workspace-opened` observes `workspace:created` (every open).
 * - **automations** (automations.ts): a script run every poll cycle whose items
 *   each run a registry operation. Local plugins only — a repository's
 *   automations would run from whichever worktree happened to be read.
 *
 * Several plugins may define the same hook entry. They run one after another —
 * local plugins by name, then the workspace's by name, each plugin's documents
 * in file order — and their results merge: `env` key by key and `tags` tag by
 * tag, later winning; the last `title` set wins; the first deletion refusal
 * stops the chain. While a blocking script runs it is registered with the
 * presenter, which offers a Cancel for it; Cancel kills its process tree and
 * counts as that script failing.
 *
 * Quitting cancels every hook script still running, `on-` entries included,
 * and starts no new ones. Nothing else would: a script is a child of the app,
 * and the OS does not take it down with its parent. A setup script or deletion
 * gate that never finishes would then outlive CodeHydra, still sitting in its
 * worktree — which on Windows is enough to keep that directory from ever being
 * removed.
 */

import type { ProjectMoveListener } from "../workspaces-root/workspaces-root";
import type { z } from "zod/v4";
import type { IntentModule, EventDeclarations, HookDeclarations } from "../../intents/lib/module";
import type { DomainEvent } from "../../intents/lib/types";
import type { HookContext, HookOutput } from "../../intents/lib/operation";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import type { UiPresenter } from "../presentation/presentation-module";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { ProcessRunner } from "../../boundaries/platform/process";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { Config } from "../../boundaries/platform/config";
import type { StateService } from "../../boundaries/platform/state-service";
import type { PathProvider } from "../../boundaries/platform/path-provider";
import {
  storeBoolean,
  storeCustom,
  storeFolder,
  type PersistedAccessor,
} from "../../boundaries/platform/store-definition";
import { projectDirName } from "../../boundaries/platform/paths";
import { Path } from "../../utils/path/path";
import { getErrorMessage } from "../../shared/error-utils";
import { TAGS_METADATA_KEY_PREFIX, TITLE_METADATA_KEY } from "../../shared/api/types";
import {
  OPEN_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_CREATED,
  type OpenWorkspaceIntent,
  type PrepareHookInput,
  type PrepareHookResult,
  type ProvisionHookInput,
  type ProvisionHookResult,
  type WorkspaceCreatedEvent,
} from "../../intents/open-workspace";
import {
  CAPABILITY_REPO_HOOK,
  DELETE_WORKSPACE_OPERATION_ID,
  type DeletePipelineHookInput,
  type DeleteWorkspaceIntent,
  type PreDeleteHookResult,
  type PreDeleteStartedFrame,
  type PreflightHookResult,
  EVENT_WORKSPACE_DELETED,
  type WorkspaceDeletedEvent,
} from "../../intents/delete-workspace";
import {
  INTENT_RESOLVE_WORKSPACE,
  type ResolveWorkspaceIntent,
} from "../../intents/resolve-workspace";
import { workspacePathSchema, type WorkspacePath } from "../../intents/contract";
import {
  INTENT_VSCODE_SHOW_MESSAGE,
  type VscodeShowMessageIntent,
} from "../../intents/vscode-show-message";
import { EVENT_APP_STARTED } from "../../intents/app-ready";
import { APP_SHUTDOWN_OPERATION_ID } from "../../intents/app-shutdown";
import type { OperationRegistry } from "../../api/registry";
import type { PluginListing, Plugins } from "../../api/entries/deps";
import { ApiError } from "../../api/errors";
import { invokePluginAction } from "../../api/adapters/plugin-actions";
import { notify } from "../presentation/notification-card";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../../intents/set-metadata";
import {
  AFTER_WORKTREE_CREATED,
  BEFORE_WORKSPACE_OPENED,
  BEFORE_WORKTREE_DELETED,
  ON_WORKSPACE_OPENED,
  afterWorktreeCreatedOutputSchema,
  beforeWorkspaceOpenedOutputSchema,
  beforeWorktreeDeletedOutputSchema,
  type AfterWorktreeCreatedOutput,
  type CoreInput,
} from "./hook-map";
import { HookFailedError, parseHookOutput } from "./hook-output";
import {
  loadPlugins,
  workspacePluginsDir,
  type DiscoveryProblem,
  type LoadedPlugin,
} from "./discovery";
import { manifestJsonSchema, type PluginDocument } from "./manifest";
import { createPluginErrorBook, ERRORS_POINTER, type PluginErrorBook } from "./errors";
import { createPluginTrust, type PluginTrust } from "./trust";
import { createShellResolver, ShellUnavailableError } from "./shells";
import { createScriptRunner, describeStatus, type ScriptRunner } from "./script-runner";
import type { HookOutputSink } from "./output-sink";
import { createItemSchemas, type ItemSchemas } from "./items";
import { parseTemplate, renderInput, type TemplateObject } from "./template-render";
import { createAutomations, type AutomationSource } from "./automations";
import {
  convertLegacySources,
  LEGACY_SOURCES_DIR,
  LEGACY_SOURCES_PLUGIN,
  LEGACY_TEMPLATES_DIR,
} from "./legacy-sources";
import { MANIFEST_FILE, discoverPlugins } from "./discovery";
import {
  LEGACY_HOOKS_DIR,
  MIGRATED_PLUGIN_FILE,
  listLegacyHooks,
  migrateLegacyHooks,
} from "./legacy-hooks";

// =============================================================================
// Dependencies
// =============================================================================

export interface PluginModuleDeps {
  readonly fileSystem: FileSystemBoundary;
  readonly processRunner: ProcessRunner;
  readonly logger: Logger;
  readonly config: Config;
  readonly stateService: StateService;
  readonly dispatcher: Dispatcher;
  readonly ui: Pick<UiPresenter, "dialog" | "trackRunningHook">;
  readonly pathProvider: Pick<PathProvider, "homePath" | "dataPath" | "tempPath">;
  /** Directory holding the `ch` CLI, prepended to every script's PATH. */
  readonly binDir: Path;
  readonly sink: HookOutputSink;
  /**
   * Subscribe to a workspace's editor connecting (it does on every open). The
   * migration offer for old `.codehydra/hooks` is shown there, so it needs an
   * editor to show in.
   */
  readonly workspaceConnected: (listener: (workspacePath: string) => void) => () => void;
  /**
   * The operation registry, for automations' actions. A getter: the registry's
   * `plugin.*` entries reach this module, so it is built after it.
   */
  readonly registry: () => OperationRegistry;
  /** Which documents apply. Default: this process's platform. */
  readonly platform?: NodeJS.Platform;
  /** The environment scripts inherit and shells are searched in. Default: this process's. */
  readonly env?: NodeJS.ProcessEnv;
}

// =============================================================================
// Public surface
// =============================================================================

export interface PluginModule extends IntentModule {
  /** Carry stored answers over to projects whose path changed. */
  readonly moveProjects: ProjectMoveListener;
  /** What the `plugin.*` registry entries reach (`ch plugin`). */
  readonly api: Plugins;
}

// =============================================================================
// Output mapping
// =============================================================================

/** The `codehydra.*` metadata keys a setup hook's `title`/`tags` map to. */
export function toMetadata(output: AfterWorktreeCreatedOutput): Record<string, string> {
  const metadata: Record<string, string> = {};
  if (output.title !== undefined) {
    metadata[TITLE_METADATA_KEY] = output.title;
  }
  for (const [name, tag] of Object.entries(output.tags ?? {})) {
    metadata[`${TAGS_METADATA_KEY_PREFIX}${name}`] = JSON.stringify(tag);
  }
  return metadata;
}

/** Prefix of CodeHydra's own variables, which a plugin's env may not override. */
const RESERVED_ENV_PREFIX = "_CH_";

/**
 * A hook's `env`, minus the keys CodeHydra owns.
 *
 * Dropped here, once, rather than left to each consumer's merge order: the
 * environment goes to several places (the agent terminal, the OpenCode server,
 * the editor's terminals), and one of them getting the precedence wrong would
 * let a repository point `ch` at another workspace or another instance.
 */
export function splitReservedEnv(env: Readonly<Record<string, string>>): {
  readonly env: Record<string, string>;
  readonly dropped: readonly string[];
} {
  const kept: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(RESERVED_ENV_PREFIX)) dropped.push(key);
    else kept[key] = value;
  }
  return { env: kept, dropped };
}

// =============================================================================
// State + config
// =============================================================================

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Keep only string→boolean pairs; a hand-edited oddity costs its own entry. */
function parseBooleanMap(value: unknown): Record<string, boolean> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") result[key] = entry;
  }
  return result;
}

const booleanMapStore = storeCustom<Record<string, boolean>>({
  parse: (raw) => parseBooleanMap(safeJsonParse(raw)),
  validate: (value) => parseBooleanMap(value),
  validValues: "<plugin → boolean>",
});

// =============================================================================
// Module
// =============================================================================

/** The migration offer's button. */
const ACTION_MIGRATE = "Migrate";

/** How long an automation's script may run before it is killed. */
const AUTOMATION_TIMEOUT_MS = 30_000;

/**
 * The exit an automation uses to say "temporary, try again next poll" —
 * `EX_TEMPFAIL` from sysexits.h, as mail servers use it.
 */
const TEMPORARY_FAILURE_EXIT = 75;

/** How long temporary failures may go on before they are worth a card. */
const TEMPORARY_FAILURE_GRACE_MS = 10 * 60_000;

/** A hook script one plugin contributes to one entry. */
interface HookScript {
  readonly plugin: LoadedPlugin;
  readonly doc: PluginDocument;
  readonly script: string;
}

/** The workspace a hook is about. */
interface HookTarget {
  readonly workspacePath: string;
  readonly projectPath: string;
  readonly workspaceName: string;
}

export function createPluginModule(deps: PluginModuleDeps): PluginModule {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;

  const pluginsEnabled = deps.config.register("plugins.enabled", {
    default: true,
    description: "Run plugins: hooks and automations (the switch for when one is broken)",
    applies: "live",
    ...storeBoolean(),
    legacyNames: { "hooks.enabled": (value) => (typeof value === "boolean" ? value : undefined) },
  });

  const folder = storeFolder();
  const bashPath: PersistedAccessor<string | null> = deps.config.register("paths.bash", {
    default: null,
    description:
      "bash for plugin scripts on Windows (default: Git Bash, found next to git on PATH)",
    applies: "live",
    parse: folder.parse,
    validate: folder.validate,
    validValues: "<absolute path to bash.exe>",
    // A file, not a folder: a plain text field rather than the folder picker.
    settingsControl: { kind: "string" },
  });

  const enabledState = deps.stateService.register<Record<string, boolean>>("plugins.state", {
    default: {},
    description: "Plugins enabled or disabled (unlisted: local enabled, workspace asked)",
    ...booleanMapStore,
  });
  const legacyTrusted = deps.stateService.register("hooks.trusted", {
    default: {},
    deprecated: true,
    description: "Per-project hook trust from before plugins (read as the project's default)",
    ...booleanMapStore,
  });

  const trust: PluginTrust = createPluginTrust({
    enabled: enabledState,
    legacyTrusted,
    ui: deps.ui,
    logger: deps.logger,
  });
  const errors: PluginErrorBook = createPluginErrorBook({ dispatcher: deps.dispatcher });

  const runner: ScriptRunner = createScriptRunner({
    fileSystem: deps.fileSystem,
    processRunner: deps.processRunner,
    shells: createShellResolver({
      fileSystem: deps.fileSystem,
      platform,
      env,
      bashOverride: () => bashPath.get(),
    }),
    logger: deps.logger,
    tempDir: deps.pathProvider.tempPath("plugins"),
    binDir: deps.binDir,
    env,
    platform,
  });

  const localDir = deps.pathProvider.homePath("plugins");
  const logsRoot = deps.pathProvider.dataPath("logs/plugins");

  /**
   * The setting automations replaced. Read once at start to move it into a
   * plugin, then reset: readable, never settable.
   */
  const legacySources = deps.config.register("auto-workspace.sources", {
    default: null,
    deprecated: true,
    description: "Auto-workspace sources, from before plugins (moved into a plugin at start)",
    omit: true,
    ...storeCustom<string | null>({
      parse: (raw) => raw,
      validate: (value) => (value === null || typeof value === "string" ? value : undefined),
    }),
  });

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  function problemsOf(
    plugins: readonly LoadedPlugin[],
    problems: readonly DiscoveryProblem[]
  ): { plugin: string; message: string }[] {
    return [
      ...problems.map((problem) => ({
        plugin: `${problem.origin}:${problem.name}`,
        message: problem.message,
      })),
      ...plugins.flatMap((plugin) =>
        plugin.error === undefined ? [] : [{ plugin: plugin.id, message: plugin.error }]
      ),
    ];
  }

  async function loadLocal(): Promise<LoadedPlugin[]> {
    const { plugins, problems } = await loadPlugins(deps.fileSystem, localDir, "local", platform);
    errors.setProblems({ origin: "local" }, problemsOf(plugins, problems));
    return plugins;
  }

  async function loadWorkspace(worktree: Path, projectPath: string): Promise<LoadedPlugin[]> {
    const { plugins, problems } = await loadPlugins(
      deps.fileSystem,
      workspacePluginsDir(worktree),
      "workspace",
      platform
    );
    errors.setProblems(
      { origin: "workspace", project: projectPath },
      problemsOf(plugins, problems)
    );
    for (const plugin of plugins) {
      const key = plugin.manifestPath.toString();
      if (plugin.applied.some((doc) => doc.automations.length > 0)) {
        if (!warnedWorkspaceAutomations.has(key)) {
          warnedWorkspaceAutomations.add(key);
          deps.logger
            .scoped({ path: key })
            .warn("A repository's plugin may not run automations; ignoring them", {
              plugin: plugin.id,
            });
        }
      }
    }
    return plugins;
  }

  function logDir(plugin: LoadedPlugin, projectPath: string, kind: string, entry: string): Path {
    return plugin.origin === "local"
      ? new Path(logsRoot, "local", plugin.name, kind, entry)
      : new Path(logsRoot, "workspace", projectDirName(projectPath), plugin.name, kind, entry);
  }

  function scriptsFor(plugins: readonly LoadedPlugin[], entry: string): HookScript[] {
    const scripts: HookScript[] = [];
    for (const plugin of plugins) {
      if (plugin.error !== undefined) continue;
      for (const doc of plugin.applied) {
        const script = doc.hooks[entry];
        if (script !== undefined) scripts.push({ plugin, doc, script });
      }
    }
    return scripts;
  }

  /**
   * Every script to run for an entry, in order, with trust applied.
   *
   * `ask: false` answers the question without raising it: an `ask` plugin
   * counts as present, for callers that must only know whether anything could
   * run (the deletion panel claiming its row).
   */
  async function hookScripts(
    entry: string,
    target: HookTarget,
    options: { ask: boolean }
  ): Promise<HookScript[]> {
    const local = scriptsFor(await loadLocal(), entry).filter(
      (script) => trust.state("local", script.plugin.name) !== "disabled"
    );
    const workspace = scriptsFor(
      await loadWorkspace(new Path(target.workspacePath), target.projectPath),
      entry
    );
    if (workspace.length === 0) return local;

    if (!options.ask) {
      return [
        ...local,
        ...workspace.filter(
          (script) =>
            trust.state("workspace", script.plugin.name, target.projectPath) !== "disabled"
        ),
      ];
    }

    const names = [...new Set(workspace.map((script) => script.plugin.name))];
    const allowed = await trust.check({ ...target, plugins: names });
    return [...local, ...workspace.filter((script) => allowed.has(script.plugin.name))];
  }

  // ---------------------------------------------------------------------------
  // Running
  // ---------------------------------------------------------------------------

  /** How a plugin's run is named where a person reads it. */
  function label(script: HookScript, entry: string): string {
    return `${entry} (${script.plugin.id})`;
  }

  // ---------------------------------------------------------------------------
  // Runs in flight, for shutdown
  // ---------------------------------------------------------------------------

  /** One promise per hook run in progress, settling once that run is over. */
  const inFlight = new Set<Promise<void>>();
  /** Aborted at shutdown: every run started from then on is canceled before it spawns. */
  const shutdown = new AbortController();

  /** Cancel every hook script still running and wait until each one's kill is done. */
  async function cancelAllHooks(): Promise<void> {
    shutdown.abort();
    const pending = [...inFlight.values()];
    if (pending.length > 0) {
      deps.logger.info("Canceling plugin hooks at shutdown", { count: pending.length });
    }
    await Promise.all(pending);
  }

  /**
   * Run one plugin's script for an entry and return its validated output.
   * Throws `HookFailedError` naming the plugin; records the outcome either way.
   * A null schema is an event entry: its stdout is not read at all.
   *
   * The run is listed for shutdown and killed when the app quits, as well as
   * when `signal` aborts.
   */
  async function runHookScript<S extends z.ZodType>(
    script: HookScript,
    entry: string,
    target: HookTarget,
    stdin: unknown,
    schema: S | null,
    signal?: AbortSignal
  ): Promise<z.infer<S> | undefined> {
    // Canceled before it started (the app is quitting): nothing to spawn and kill.
    if (shutdown.signal.aborted) {
      throw new HookFailedError(entry, `${label(script, entry)} was canceled`);
    }
    const running = runHookScriptNow(
      script,
      entry,
      target,
      stdin,
      schema,
      signal === undefined ? shutdown.signal : AbortSignal.any([signal, shutdown.signal])
    );
    const settled = running.then(
      () => undefined,
      () => undefined
    );
    inFlight.add(settled);
    try {
      return await running;
    } finally {
      inFlight.delete(settled);
    }
  }

  async function runHookScriptNow<S extends z.ZodType>(
    script: HookScript,
    entry: string,
    target: HookTarget,
    stdin: unknown,
    schema: S | null,
    signal: AbortSignal
  ): Promise<z.infer<S> | undefined> {
    const key = {
      plugin: script.plugin.id,
      ...(script.plugin.origin === "workspace" && { project: target.projectPath }),
      entry,
    };
    const worktree = new Path(target.workspacePath);

    let pending;
    try {
      pending = await runner.run({
        plugin: script.plugin.id,
        entry,
        shell: script.doc.shell,
        script: script.script,
        cwd: worktree,
        input: stdin,
        logDir: logDir(script.plugin, target.projectPath, "hooks", entry),
        workspaceDir: worktree,
        ...(script.plugin.pluginDir !== undefined && { pluginDir: script.plugin.pluginDir }),
        signal,
      });
    } catch (error) {
      const message =
        error instanceof ShellUnavailableError
          ? error.message
          : `could not start: ${getErrorMessage(error)}`;
      errors.failure(key, message);
      throw new HookFailedError(entry, `${label(script, entry)} ${message} — ${ERRORS_POINTER}`);
    }

    const { result } = pending;
    for (const [stream, text] of [
      ["stderr", result.stderr],
      ["stdout", result.stdout],
    ] as const) {
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() !== "") {
          deps.sink.write(target.workspacePath, `${script.plugin.id} ${entry} ${stream}`, line);
        }
      }
    }

    let failure: string | undefined;
    let output: z.infer<S> | undefined;
    if (result.status !== "exited" || result.exitCode !== 0) {
      failure = describeStatus(result);
    } else if (schema !== null) {
      try {
        output = parseHookOutput(result.stdout, schema);
      } catch (error) {
        failure = getErrorMessage(error);
      }
    }

    const logPath = await pending.finish(
      failure === undefined ? { outcome: "ok" } : { outcome: "failed", reason: failure }
    );
    if (failure !== undefined) {
      // Canceled by the quit itself: nobody is left to read a notification.
      if (!shutdown.signal.aborted) errors.failure(key, failure, logPath?.toNative());
      deps.logger.warn("Plugin hook failed", {
        plugin: script.plugin.id,
        entry,
        reason: failure,
      });
      throw new HookFailedError(
        entry,
        `${label(script, entry)} failed: ${failure} — ${ERRORS_POINTER}`
      );
    }
    errors.success(key);
    return output;
  }

  /** Run a blocking script with a Cancel on offer for as long as it runs. */
  async function runCancelable<T>(
    script: HookScript,
    entry: string,
    target: HookTarget,
    phase: "open" | "delete",
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const untrack = deps.ui.trackRunningHook({
      ...target,
      entry: label(script, entry),
      phase,
      cancel: () => controller.abort(),
    });
    try {
      return await run(controller.signal);
    } finally {
      untrack();
    }
  }

  /**
   * Run every script for a blocking open entry, loud but never fatal: a
   * failed plugin contributes nothing and the next one still runs. The
   * worktree exists by now, so failing the open would either strand it or
   * need a teardown path — and a workspace you can open is where you fix
   * whatever went wrong.
   */
  async function runOpenEntry<S extends z.ZodType>(
    entry: string,
    target: HookTarget,
    stdin: CoreInput & Record<string, unknown>,
    schema: S
  ): Promise<z.infer<S>[]> {
    // Whatever happened to this workspace's editor before, it is coming now.
    deps.sink.opening(target.workspacePath);
    if (!allowed()) return [];

    const outputs: z.infer<S>[] = [];
    for (const script of await hookScripts(entry, target, { ask: true })) {
      try {
        const output = await runCancelable(script, entry, target, "open", (signal) =>
          runHookScript(script, entry, target, stdin, schema, signal)
        );
        if (output !== undefined) outputs.push(output);
      } catch {
        // Recorded and notified by runHookScript; the next plugin still runs.
      }
    }
    return outputs;
  }

  // ---------------------------------------------------------------------------
  // after-worktree-created
  // ---------------------------------------------------------------------------

  async function afterWorktreeCreated(ctx: HookContext): Promise<HookOutput<ProvisionHookResult>> {
    const input = ctx as ProvisionHookInput;
    const intent = ctx.intent as OpenWorkspaceIntent;

    // Activating a discovered workspace is not a creation. Re-running a setup
    // script for every workspace at every project open would be both surprising
    // and slow — that is what `before-workspace-opened` is for.
    if (intent.payload.existingWorkspace !== undefined) return { result: {} };

    const core = coreInput(input, intent);
    const outputs = await runOpenEntry(
      AFTER_WORKTREE_CREATED.name,
      targetOf(input, core.workspaceName),
      core,
      afterWorktreeCreatedOutputSchema
    );

    const merged: AfterWorktreeCreatedOutput = {};
    for (const output of outputs) {
      if (output.title !== undefined) merged.title = output.title;
      if (output.tags !== undefined) merged.tags = { ...merged.tags, ...output.tags };
    }
    const metadata = toMetadata(merged);
    await persistMetadata(input.workspacePath, metadata);
    return { result: Object.keys(metadata).length > 0 ? { metadata } : {} };
  }

  // ---------------------------------------------------------------------------
  // before-workspace-opened
  // ---------------------------------------------------------------------------

  async function beforeWorkspaceOpened(ctx: HookContext): Promise<HookOutput<PrepareHookResult>> {
    const input = ctx as PrepareHookInput;
    const intent = ctx.intent as OpenWorkspaceIntent;

    const core = coreInput(input, intent);
    const outputs = await runOpenEntry(
      BEFORE_WORKSPACE_OPENED.name,
      targetOf(input, core.workspaceName),
      { ...core, reopened: intent.payload.existingWorkspace !== undefined },
      beforeWorkspaceOpenedOutputSchema
    );

    const merged: Record<string, string> = {};
    for (const output of outputs) Object.assign(merged, output.env ?? {});
    if (outputs.every((output) => output.env === undefined)) return { result: {} };

    const { env: kept, dropped } = splitReservedEnv(merged);
    if (dropped.length > 0) {
      deps.logger.warn("Plugin env may not set CodeHydra's own variables", {
        entry: BEFORE_WORKSPACE_OPENED.name,
        dropped: dropped.join(","),
      });
    }
    return { result: { env: kept } };
  }

  /** The core every open entry is handed. `branch`/`base` stay absent when unknown. */
  function coreInput(
    input: ProvisionHookInput | PrepareHookInput,
    intent: OpenWorkspaceIntent
  ): CoreInput {
    return {
      workspaceName: intent.payload.existingWorkspace?.name ?? intent.payload.workspaceName,
      workspacePath: input.workspacePath,
      projectPath: input.projectPath,
      ...(input.branch !== undefined && { branch: input.branch }),
      ...(input.base !== undefined && { base: input.base }),
    };
  }

  function targetOf(
    input: { workspacePath: string; projectPath: string },
    workspaceName: string
  ): HookTarget {
    return { workspacePath: input.workspacePath, projectPath: input.projectPath, workspaceName };
  }

  // ---------------------------------------------------------------------------
  // before-worktree-deleted
  // ---------------------------------------------------------------------------

  async function* beforeWorktreeDeleted(
    ctx: HookContext
  ): AsyncGenerator<PreDeleteStartedFrame, HookOutput<PreDeleteHookResult>, void> {
    const input = ctx as DeletePipelineHookInput;
    const intent = ctx.intent as DeleteWorkspaceIntent;
    if (!allowed()) return { result: {} };

    const entry = BEFORE_WORKTREE_DELETED.name;
    const target = targetOf(input, input.workspaceName);

    // Claim a row on the deletion panel before anything slow happens — the
    // trust dialog included, so a question raised here has something to explain
    // it. Without a script nothing is yielded and no row ever appears.
    if ((await hookScripts(entry, target, { ask: false })).length === 0) return { result: {} };
    yield { started: true };

    const scripts = await hookScripts(entry, target, { ask: true });
    if (scripts.length === 0) return { result: {} };

    const identity = await resolveBranchAndBase(input.workspacePath);

    // The editor was torn down at "shutdown" and is not coming back: whatever
    // these scripts print belongs in their run logs, not in a buffer nobody
    // will flush.
    deps.sink.closed(input.workspacePath);

    const stdin = {
      workspaceName: input.workspaceName,
      workspacePath: input.workspacePath,
      projectPath: input.projectPath,
      ...identity,
      keepBranch: intent.payload.keepBranch,
    };

    for (const script of scripts) {
      // A throw is the "could not tell" half of the gate and stops the deletion
      // by itself; a returned `blocked` is the deliberate refusal.
      const output = await runCancelable(script, entry, target, "delete", (signal) =>
        runHookScript(script, entry, target, stdin, beforeWorktreeDeletedOutputSchema, signal)
      );
      if (output?.blocked === true) {
        return {
          result: {
            blocked: true,
            ...(output.reason !== undefined && { reason: output.reason }),
          },
        };
      }
    }
    return { result: {} };
  }

  /**
   * Claim the deletion panel's row, if any plugin has a gate to run.
   *
   * Runs at "preflight" purely for its timing: that is the last hook point
   * before the first progress event, so it is the only place the row can be
   * claimed early enough to be listed alongside the other steps. It never
   * blocks — the decision belongs to `before-worktree-deleted` itself — and it
   * asks nothing about trust, because a question raised here would arrive
   * before the user has even seen a deletion start.
   */
  async function announceDeleteHook(ctx: HookContext): Promise<HookOutput<PreflightHookResult>> {
    const input = ctx as DeletePipelineHookInput;
    const { payload } = ctx.intent as DeleteWorkspaceIntent;

    // Exactly the conditions under which the stage will actually run.
    if (!payload.removeWorktree || payload.force || !allowed()) return {};

    const scripts = await hookScripts(
      BEFORE_WORKTREE_DELETED.name,
      targetOf(input, input.workspaceName),
      { ask: false }
    );
    return scripts.length > 0 ? { provides: { [CAPABILITY_REPO_HOOK]: true } } : {};
  }

  // ---------------------------------------------------------------------------
  // on-workspace-opened (fire-and-forget)
  // ---------------------------------------------------------------------------

  function onWorkspaceOpened(event: DomainEvent): void {
    const payload = (event as WorkspaceCreatedEvent).payload;
    const entry = ON_WORKSPACE_OPENED.name;
    const target = targetOf(payload, payload.workspaceName);

    void (async (): Promise<void> => {
      try {
        if (!allowed()) return;
        const stdin = {
          workspaceName: payload.workspaceName,
          workspacePath: payload.workspacePath,
          projectPath: payload.projectPath,
          ...(payload.branch !== undefined && { branch: payload.branch }),
          ...(payload.base !== undefined && { base: payload.base }),
          reopened: payload.reopened === true,
        };
        for (const script of await hookScripts(entry, target, { ask: true })) {
          // Output is ignored: nothing waits for an event hook's answer.
          await runHookScript(script, entry, target, stdin, null).catch(() => undefined);
        }
      } catch (error) {
        deps.logger.warn("Event hook could not be dispatched", {
          entry,
          error: getErrorMessage(error),
        });
      }
    })();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Write a hook's title and tags to the workspace's git config.
   *
   * Done during `provision`, so WorktreeModule's finalize re-read — which folds
   * in after every setup result — sees them and reports the same values.
   * Best-effort per key: a tag that could not be written should not cost the
   * title, and none of it should cost the workspace.
   */
  async function persistMetadata(
    workspacePath: WorkspacePath,
    metadata: Record<string, string>
  ): Promise<void> {
    for (const [key, value] of Object.entries(metadata)) {
      try {
        await deps.dispatcher.dispatch<SetMetadataIntent>({
          type: INTENT_SET_METADATA,
          payload: { workspacePath, key, value },
        });
      } catch (error) {
        deps.logger.warn("Could not persist metadata from a hook", {
          key,
          error: getErrorMessage(error),
        });
      }
    }
  }

  /** The global switch — the way out when a plugin is broken. */
  function allowed(): boolean {
    if (pluginsEnabled.get()) return true;
    deps.logger.debug("Plugins are disabled by configuration");
    return false;
  }

  /**
   * The branch and base for a workspace being deleted.
   *
   * Read here rather than threaded through the deletion contract: the pipeline
   * resolves identity for its own purposes and has no use for either, and this
   * is a git-config read on a path that is already doing far slower work.
   * Best-effort — a workspace we cannot resolve still gets its gate, just
   * without the two optional fields.
   */
  async function resolveBranchAndBase(
    workspacePath: WorkspacePath
  ): Promise<{ branch?: string; base?: string }> {
    try {
      const resolved = await deps.dispatcher.dispatch<ResolveWorkspaceIntent>({
        type: INTENT_RESOLVE_WORKSPACE,
        payload: { workspacePath },
      });
      const base = resolved.metadata["base"];
      return {
        ...(resolved.branch !== null && { branch: resolved.branch }),
        ...(base !== undefined && { base }),
      };
    } catch (error) {
      deps.logger
        .scoped({ path: workspacePath })
        .debug("Could not resolve branch/base for a hook", { error: getErrorMessage(error) });
      return {};
    }
  }

  // ---------------------------------------------------------------------------
  // Automations
  // ---------------------------------------------------------------------------

  /** An automation's script, and the plugin it runs for. */
  interface AutomationScript {
    readonly plugin: LoadedPlugin;
    readonly doc: PluginDocument;
    readonly script: string;
  }
  let automationScripts = new Map<string, AutomationScript>();
  /** Automations that failed in the current cycle, and the ones run in the last. */
  let failedThisCycle = new Set<string>();
  let ranLastCycle: readonly AutomationSource[] = [];
  /**
   * When each automation's current run of temporary failures began. Any other
   * outcome — a success or a real failure — ends it.
   */
  const temporarySince = new Map<string, number>();
  /** Workspace plugins already warned about for shipping automations. */
  const warnedWorkspaceAutomations = new Set<string>();

  /** An automation's key in the error book. */
  function automationKey(source: AutomationSource): { plugin: string; entry: string } {
    return { plugin: source.plugin, entry: `automations.${source.name}` };
  }

  /**
   * The automations to run this cycle: every enabled local plugin's, for this
   * platform. Also settles the last cycle's error book: an automation that ran
   * then without failing is no longer failing. (Settling here, rather than the
   * moment its script succeeds, keeps an item error found after a good run
   * from being cleared and re-notified every cycle.)
   */
  async function automationSources(): Promise<readonly AutomationSource[]> {
    for (const source of ranLastCycle) {
      if (!failedThisCycle.has(source.id)) errors.success(automationKey(source));
    }
    failedThisCycle = new Set();

    const scripts = new Map<string, AutomationScript>();
    const sources: AutomationSource[] = [];
    for (const plugin of await loadLocal()) {
      if (plugin.error !== undefined || trust.state("local", plugin.name) === "disabled") continue;
      for (const doc of plugin.applied) {
        for (const spec of doc.automations) {
          const id = `${plugin.name}/${spec.name}`;
          if (scripts.has(id)) {
            deps.logger.warn("Automation defined twice for this platform; running the first", {
              plugin: plugin.id,
              automation: spec.name,
            });
            continue;
          }
          scripts.set(id, { plugin, doc, script: spec.script });
          sources.push({ id, plugin: plugin.id, name: spec.name });
        }
      }
    }
    automationScripts = scripts;
    ranLastCycle = sources;
    return sources;
  }

  function automationFailed(source: AutomationSource, message: string, logPath?: Path): void {
    failedThisCycle.add(source.id);
    errors.failure(automationKey(source), message, logPath?.toNative());
  }

  /**
   * An automation exited 75: skip it this poll and try again next. Listed in
   * `ch plugin errors` straight away, but raised as a card only once the
   * failures have gone on for the grace period — then as an ordinary `exit 75`,
   * whose new message is what raises the card.
   */
  function temporaryFailure(source: AutomationSource, logPath?: Path): void {
    const now = Date.now();
    const since = temporarySince.get(source.id) ?? now;
    temporarySince.set(source.id, since);
    failedThisCycle.add(source.id);
    deps.logger.debug("Automation failed temporarily, retrying next cycle", {
      automation: source.id,
    });
    if (now - since >= TEMPORARY_FAILURE_GRACE_MS) {
      errors.failure(automationKey(source), `exit ${TEMPORARY_FAILURE_EXIT}`, logPath?.toNative());
    } else {
      errors.failure(
        automationKey(source),
        `temporary failure (exit ${TEMPORARY_FAILURE_EXIT}), retrying`,
        logPath?.toNative(),
        { quiet: true }
      );
    }
  }

  /** Run an automation's script and read the array it prints; null when it failed. */
  async function runAutomationScript(source: AutomationSource): Promise<unknown[] | null> {
    const entry = automationScripts.get(source.id);
    if (entry === undefined) return null;
    const { plugin, doc, script } = entry;

    let pending;
    try {
      pending = await runner.run({
        plugin: plugin.id,
        entry: `automations.${source.name}`,
        shell: doc.shell,
        script,
        cwd: plugin.pluginDir ?? localDir,
        input: {},
        logDir: logDir(plugin, "", "automations", source.name),
        ...(plugin.pluginDir !== undefined && { pluginDir: plugin.pluginDir }),
        timeoutMs: AUTOMATION_TIMEOUT_MS,
      });
    } catch (error) {
      temporarySince.delete(source.id);
      automationFailed(
        source,
        error instanceof ShellUnavailableError ? error.message : getErrorMessage(error)
      );
      return null;
    }

    const { result } = pending;
    const temporary = result.status === "exited" && result.exitCode === TEMPORARY_FAILURE_EXIT;
    if (!temporary) temporarySince.delete(source.id);
    let failure: string | undefined;
    let items: unknown[] | undefined;
    if (temporary) {
      failure = `temporary failure (exit ${TEMPORARY_FAILURE_EXIT})`;
    } else if (result.status !== "exited" || result.exitCode !== 0) {
      failure = describeStatus(result);
    } else {
      try {
        const parsed: unknown = JSON.parse(result.stdout);
        if (Array.isArray(parsed)) items = parsed;
        else failure = "printed JSON that is not an array";
      } catch {
        failure = "printed something that is not JSON";
      }
    }
    const logPath = await pending.finish(
      failure === undefined ? { outcome: "ok" } : { outcome: "failed", reason: failure }
    );
    if (temporary) {
      temporaryFailure(source, logPath);
      return null;
    }
    if (failure !== undefined || items === undefined) {
      deps.logger.warn("Automation script failed, skipping its items this cycle", {
        automation: source.id,
        reason: failure ?? "",
      });
      automationFailed(source, failure ?? "failed", logPath);
      return null;
    }
    return items;
  }

  /** Item schemas, built from the registry the first time they are needed. */
  let itemSchemas: ItemSchemas | undefined;
  function items(): ItemSchemas {
    itemSchemas ??= createItemSchemas(deps.registry());
    return itemSchemas;
  }

  const automations = createAutomations({
    logger: deps.logger,
    dispatcher: deps.dispatcher,
    configService: deps.config,
    stateService: deps.stateService,
    enabled: allowed,
    sources: automationSources,
    runScript: runAutomationScript,
    parseItem: (raw) => items().parse(raw),
    invokeAction: async (action, input) => {
      await invokePluginAction({ registry: deps.registry() }, action, input);
    },
    reportError: (source, message) => automationFailed(source, message),
  });

  /**
   * Move the pre-plugin `auto-workspace.sources` setting into a local plugin,
   * `auto-workspaces`, once — and its tracking entries with it, so nothing it
   * already created is created again. A plugin of that name that already
   * exists is left alone (a move that wrote it but could not clear the setting
   * has nothing left to do). A failed move keeps the setting for next time.
   */
  async function moveLegacySources(): Promise<void> {
    const raw = legacySources.get();
    if (typeof raw !== "string" || raw.trim() === "") return;

    const pluginDir = new Path(localDir, LEGACY_SOURCES_PLUGIN);
    const manifestPath = new Path(pluginDir, MANIFEST_FILE);
    try {
      let exists = true;
      try {
        await deps.fileSystem.readFile(manifestPath);
      } catch {
        exists = false;
      }
      if (!exists) {
        const converted = convertLegacySources(raw, platform, env);
        // The templates and sources first and the manifest last: the manifest
        // is what says the move happened, so a move cut short is redone on the
        // next start.
        const templatesDir = new Path(pluginDir, LEGACY_TEMPLATES_DIR);
        await deps.fileSystem.mkdir(templatesDir);
        for (const [file, text] of Object.entries(converted.templates)) {
          await deps.fileSystem.writeFile(new Path(templatesDir, file), text);
        }
        const sourcesDir = new Path(pluginDir, LEGACY_SOURCES_DIR);
        for (const [file, text] of Object.entries(converted.sources)) {
          await deps.fileSystem.mkdir(sourcesDir);
          await deps.fileSystem.writeFile(new Path(sourcesDir, file), text);
        }
        await deps.fileSystem.writeFile(manifestPath, converted.manifest);
        await automations.renameTracking((key) => {
          const slash = key.indexOf("/");
          if (slash === -1) return undefined;
          const name = converted.renames.get(key.slice(0, slash));
          return name === undefined
            ? undefined
            : `${LEGACY_SOURCES_PLUGIN}/${name}/${key.slice(slash + 1)}`;
        });
        for (const error of converted.errors) {
          deps.logger.warn("Auto-workspace source could not be moved (invalid)", {
            source: error.name ?? `#${error.index}`,
            message: error.message,
          });
        }
        const dropped = converted.dropped.map((item) => `${item.source}: ${item.field}`);
        if (dropped.length > 0) {
          deps.logger.warn("Auto-workspace template fields could not be moved", {
            fields: dropped.join(", "),
          });
        }
        notify(deps.dispatcher, {
          type: dropped.length > 0 || converted.errors.length > 0 ? "warning" : "info",
          title: "Auto-workspace sources are now a plugin",
          message:
            `They moved to ${manifestPath.toNative()}` +
            (converted.errors.length > 0
              ? ` (${converted.errors.length} invalid source(s) left out)`
              : "") +
            (dropped.length > 0 ? `. Template fields left out: ${dropped.join(", ")}` : ""),
          dismissible: true,
        });
        deps.logger
          .scoped({ path: manifestPath.toString() })
          .info("Moved auto-workspace.sources into a plugin");
      }
      await legacySources.reset();
    } catch (error) {
      deps.logger.warn("Could not move auto-workspace.sources into a plugin", {
        error: getErrorMessage(error),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Repository hooks from before plugins
  // ---------------------------------------------------------------------------

  /** Workspaces with an offer on screen, so a reconnect does not stack a second. */
  const offering = new Set<string>();

  /**
   * Offer to migrate a worktree's old `.codehydra/hooks`, which no longer run.
   *
   * Raised on every open while the hook files are there and the repository
   * has no plugin — loud on purpose: the hooks stopped running silently, and
   * a setup step that no longer happens is easy to miss. Migrate writes
   * `.codehydra/plugins/hooks.yaml` (legacy-hooks.ts) for the user to commit.
   */
  async function offerHookMigration(workspacePath: string): Promise<void> {
    if (offering.has(workspacePath)) return;
    offering.add(workspacePath);
    try {
      const worktree = new Path(workspacePath);
      const files = await listLegacyHooks(deps.fileSystem, worktree);
      if (files.length === 0) return;
      const pluginsDir = workspacePluginsDir(worktree);
      if ((await discoverPlugins(deps.fileSystem, pluginsDir, "workspace")).plugins.length > 0) {
        return;
      }

      const target = workspacePathSchema.parse(workspacePath);
      const answer = await deps.dispatcher.dispatch<VscodeShowMessageIntent>({
        type: INTENT_VSCODE_SHOW_MESSAGE,
        payload: {
          workspacePath: target,
          type: "warning",
          message:
            `This repository's ${LEGACY_HOOKS_DIR.join("/")} (${files.join(", ")}) no longer ` +
            `run: CodeHydra runs plugins now. Migrate writes .codehydra/plugins/` +
            `${MIGRATED_PLUGIN_FILE}, which runs them again.`,
          options: [ACTION_MIGRATE],
        },
      });
      if (answer !== ACTION_MIGRATE) return;

      const migrated = migrateLegacyHooks(files);
      await deps.fileSystem.mkdir(pluginsDir);
      await deps.fileSystem.writeFile(
        new Path(pluginsDir, MIGRATED_PLUGIN_FILE),
        migrated.manifest,
        {
          exclusive: true,
        }
      );
      const skipped = migrated.ambiguous.map(
        (item) => `${item.entry} on ${item.platform} (${item.files.join(", ")})`
      );
      await deps.dispatcher.dispatch<VscodeShowMessageIntent>({
        type: INTENT_VSCODE_SHOW_MESSAGE,
        payload: {
          workspacePath: target,
          type: "info",
          message:
            `Wrote .codehydra/plugins/${MIGRATED_PLUGIN_FILE}: commit it. The hooks run again ` +
            `from the next time a workspace opens.` +
            (skipped.length > 0
              ? ` Left out, since several files claimed them: ${skipped.join("; ")}.`
              : ""),
        },
      });
    } catch (error) {
      deps.logger
        .scoped({ path: workspacePath })
        .warn("Could not offer to migrate .codehydra/hooks", { error: getErrorMessage(error) });
    } finally {
      offering.delete(workspacePath);
    }
  }

  deps.workspaceConnected((workspacePath) => {
    void offerHookMigration(workspacePath);
  });

  // ---------------------------------------------------------------------------
  // `ch plugin`
  // ---------------------------------------------------------------------------

  function listing(plugin: LoadedPlugin, projectPath?: string): PluginListing {
    return {
      id: plugin.id,
      name: plugin.name,
      origin: plugin.origin,
      state: trust.state(plugin.origin, plugin.name, projectPath),
      platforms: plugin.platforms,
      path: (plugin.pluginDir ?? plugin.manifestPath).toNative(),
      ...(plugin.origin === "workspace" && projectPath !== undefined && { project: projectPath }),
    };
  }

  const api: Plugins = {
    async list(scope) {
      const listings = (await loadLocal()).map((plugin) => listing(plugin));
      if (scope.workspacePath !== null && scope.projectPath !== null) {
        const workspace = await loadWorkspace(new Path(scope.workspacePath), scope.projectPath);
        listings.push(
          ...workspace.map((plugin) => listing(plugin, scope.projectPath ?? undefined))
        );
      }
      return listings;
    },
    async setState(scope, id, state) {
      const found = (await api.list(scope)).find((plugin) => plugin.id === id);
      if (found === undefined) {
        if (id.startsWith("workspace:") && scope.workspacePath === null) {
          throw new ApiError(
            "no-workspace",
            `${id}: a repository's plugins are named from inside one of its workspaces (or with --workspace)`
          );
        }
        throw new ApiError("not-found", `No plugin ${id}. \`ch plugin list\` shows them.`);
      }
      await trust.set(found.origin, found.name, state, found.project);
      return { ...found, state };
    },
    errors: () => errors.list(),
    schema: (which) => (which === "items" ? items().jsonSchema() : manifestJsonSchema()),
    async render(templatePath, itemsJson) {
      let template: TemplateObject;
      try {
        template = parseTemplate(await deps.fileSystem.readFile(new Path(templatePath)));
      } catch (error) {
        throw new ApiError("usage", `${templatePath}: ${getErrorMessage(error)}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(itemsJson);
      } catch {
        throw new ApiError("usage", "the items to render are not JSON");
      }
      // A command that failed and printed nothing must not read as "no items":
      // in cmd.exe a pipe reports only this, its last command's, exit.
      if (!Array.isArray(parsed)) {
        throw new ApiError("usage", "the items to render must be a JSON array");
      }
      return parsed.map((item) => renderInput(template, item));
    },
  };

  // ---------------------------------------------------------------------------
  // Declarations
  // ---------------------------------------------------------------------------

  const hooks: HookDeclarations = {
    [APP_SHUTDOWN_OPERATION_ID]: {
      stop: {
        handler: async () => {
          automations.stop();
          await cancelAllHooks();
        },
      },
    },
    [OPEN_WORKSPACE_OPERATION_ID]: {
      provision: { handler: afterWorktreeCreated },
      prepare: { handler: beforeWorkspaceOpened },
    },
    [DELETE_WORKSPACE_OPERATION_ID]: {
      preflight: { handler: announceDeleteHook },
      "pre-delete": { handler: beforeWorktreeDeleted },
    },
  };

  const events: EventDeclarations = {
    [EVENT_APP_STARTED]: {
      handler: async (): Promise<void> => {
        await moveLegacySources();
        await automations.start();
      },
    },
    [EVENT_WORKSPACE_CREATED]: {
      // Returns immediately: the emitter must never wait on a plugin's script,
      // least of all one that may park on a trust dialog.
      handler: async (event: DomainEvent): Promise<void> => {
        onWorkspaceOpened(event);
      },
    },
    [EVENT_WORKSPACE_DELETED]: {
      // Its editor is never coming back, so neither is a reason to hold its output.
      handler: async (event: DomainEvent): Promise<void> => {
        deps.sink.closed((event as WorkspaceDeletedEvent).payload.workspacePath);
      },
    },
  };

  const moveProjects: ProjectMoveListener = async (moves) => {
    await trust.moveProjects(moves);
    await automations.moveProjects(moves);
  };

  return { name: "plugins", hooks, events, moveProjects, api };
}
