/**
 * PluginModule — the one place user-provided scripts attach to CodeHydra.
 *
 * A plugin is a YAML manifest (manifest.ts) found in a source (discovery.ts):
 * the user's own — `~/.codehydra/plugins`, and the folders and git
 * repositories `plugins.config` lists (sources.ts, remotes.ts) — which apply
 * to every project and run without asking, and a repository's in the
 * worktree's `.codehydra/plugins`, which apply to that worktree and run once
 * trusted (trust.ts). Every script a plugin contributes runs through one
 * runner (script-runner.ts) in the shell its document names, with the values
 * `plugins.config` gives its settings (plugin-config.ts) in its environment.
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
 * - **automations** (automations.ts): a script run every poll tick whose items
 *   each run a registry operation. Local and remote plugins only — a
 *   repository's automations would run from whichever worktree happened to be
 *   read. The poll module (poll-module.ts) runs them and announces their
 *   failures; this module says which there are and acts on what they print.
 *
 * Several plugins may define the same hook entry. They run one after another —
 * the user's sources in `plugins.config` order (the default folder first),
 * each by name, then the repository's by name, each plugin's documents in file
 * order — and their results merge: `env` key by key and `tags` tag by
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

import type { z } from "zod/v4";
import type { IntentModule } from "../../intents/lib/module";
import type { HookOutput } from "../../intents/lib/operation";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import type { UiPresenter } from "../presentation/presentation-module";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { Config } from "../../boundaries/platform/config";
import type { StateService } from "../../boundaries/platform/state-service";
import type { PathProvider } from "../../boundaries/platform/path-provider";
import type { IGitClient } from "../../boundaries/platform/git-client";
import { storeBoolean, storeCustom } from "../../boundaries/platform/store-definition";
import { projectDirName } from "../../boundaries/platform/paths";
import { Path } from "../../utils/path/path";
import { getErrorMessage } from "../../shared/error-utils";
import { encodeTag, tagKey, TITLE_METADATA_KEY } from "../../shared/api/types";
import {
  OPEN_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_CREATED,
  schemas as openWorkspaceSchemas,
  type PrepareHookInput,
  type PrepareHookResult,
  type ProvisionHookInput,
  type ProvisionHookResult,
} from "../../intents/open-workspace";
import {
  CAPABILITY_REPO_HOOK,
  DELETE_WORKSPACE_OPERATION_ID,
  schemas as deleteWorkspaceSchemas,
  type PreDeleteHookResult,
  type PreDeleteStartedFrame,
  type PreflightHookResult,
  EVENT_WORKSPACE_DELETED,
} from "../../intents/delete-workspace";
import {
  INTENT_RESOLVE_WORKSPACE,
  type ResolveWorkspaceIntent,
} from "../../intents/resolve-workspace";
import { projectRefSchema, type ProjectRef, type WorkspaceRef } from "../../intents/contract";
import { INTENT_LIST_PROJECTS, type ListProjectsIntent } from "../../intents/list-projects";
import { resolveProjectReference, type ProjectLocation } from "../../api/workspace-lookup";
import { projectNameOf } from "../../utils/ref";
import { expandGitUrl, extractRepoName } from "../../utils/url-utils";
import { looksLikeGitUrl, resolveLocalPath } from "../../utils/project-reference";
import {
  INTENT_VSCODE_SHOW_MESSAGE,
  type VscodeShowMessageIntent,
} from "../../intents/vscode-show-message";
import { EVENT_APP_STARTED } from "../../intents/app-ready";
import { APP_START_OPERATION_ID } from "../../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../../intents/app-shutdown";
import type { OperationRegistry } from "../../api/registry";
import type { PluginListing, PluginSourceListing, Plugins } from "../../api/entries/deps";
import { ApiError } from "../../api/errors";
import { invokePluginAction } from "../../api/adapters/plugin-actions";
import { notify } from "../presentation/notification-card";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../../intents/set-metadata";
import {
  DELETE_WORKSPACE_HOOKS,
  ON_WORKSPACE_OPENED,
  OPEN_WORKSPACE_HOOKS,
  bindHookPoints,
  type AfterWorktreeCreatedOutput,
  type AFTER_WORKTREE_CREATED,
  type BEFORE_WORKSPACE_OPENED,
  type BEFORE_WORKTREE_DELETED,
  type CoreInput,
} from "./hook-map";
import { HookFailedError, parseHookOutput } from "./hook-output";
import {
  loadPlugins,
  sourceId,
  pluginId,
  workspacePluginsDir,
  type DiscoveryProblem,
  type LoadedPlugin,
  type PluginSource,
} from "./discovery";
import {
  DEFAULT_SOURCE,
  SOURCE_NAME,
  SourcesConfigError,
  addSourceEntry,
  localSourcePath,
  parseSourcesConfig,
  removeSourceEntry,
  type LocalSourceEntry,
  type PluginValues,
  type RemoteSourceEntry,
  type SourceEntry,
} from "./sources";
import {
  createRemoteCheckouts,
  type RemoteCheckouts,
  type RemoteSpec,
  type RemoteStatus,
} from "./remotes";
import { settingsEnv } from "./plugin-config";
import { manifestJsonSchema, type PluginDocument } from "./manifest";
import { createPluginErrorBook, ERRORS_POINTER, type PluginErrorBook } from "./errors";
import { createPluginTrust, type PluginTrust, type TrustProject } from "./trust";
import { ShellUnavailableError, type ShellName } from "../scripts/shells";
import {
  describeStatus,
  type PendingRun,
  type ScriptRequest,
  type ScriptRunner,
} from "../scripts/script-runner";
import type { HookOutputSink } from "./output-sink";
import { createItemSchemas, type ItemSchemas } from "./items";
import { parseTemplate, renderInput, type TemplateObject } from "./template-render";
import { safeJsonParse } from "./util";
import { createAutomations, type AutomationSource } from "./automations";
import { POLL_TICK_OPERATION_ID, type PollJob } from "../../intents/poll-tick";
import type { PollError } from "../poll-module";
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
import {
  defineEvents,
  defineHooks,
  type EventFor,
  type HookInput,
} from "../../intents/declarations";

// =============================================================================
// Dependencies
// =============================================================================

export interface PluginModuleDeps {
  readonly fileSystem: FileSystemBoundary;
  /** Runs every hook script (scripts/scripts.ts, shared with the poll module). */
  readonly runner: ScriptRunner;
  /** The automations failing right now, as the poll module recorded them. */
  readonly pollErrors: (owner: string) => readonly PollError[];
  readonly logger: Logger;
  readonly config: Config;
  readonly stateService: StateService;
  readonly dispatcher: Dispatcher;
  readonly ui: Pick<UiPresenter, "dialog" | "trackRunningHook">;
  readonly pathProvider: Pick<PathProvider, "homePath" | "dataPath">;
  /** Git, for the repositories `plugins.config` lists. */
  readonly git: Pick<
    IGitClient,
    | "clone"
    | "fetch"
    | "resolveCommit"
    | "addDetachedWorktree"
    | "removeWorktree"
    | "pruneWorktrees"
  >;
  readonly sink: HookOutputSink;
  /**
   * Subscribe to a workspace's editor connecting (it does on every open). The
   * migration offer for old `.codehydra/hooks` is shown there, so it needs an
   * editor to show in.
   */
  readonly workspaceConnected: (listener: (workspaceRef: WorkspaceRef) => void) => () => void;
  /**
   * The ref of every project with a record, by its path — what the startup
   * migration turns stored project paths into.
   */
  readonly projectRefs: () => Promise<ReadonlyMap<string, ProjectRef>>;
  /**
   * The operation registry, for automations' actions. A getter: the registry's
   * `plugin.*` entries reach this module, so it is built after it.
   */
  readonly registry: () => OperationRegistry;
  /** Which documents apply. Default: this process's platform. */
  readonly platform?: NodeJS.Platform;
  /** The environment legacy sources are converted against. Default: this process's. */
  readonly env?: NodeJS.ProcessEnv;
}

// =============================================================================
// Public surface
// =============================================================================

export interface PluginModule extends IntentModule {
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
    metadata[tagKey(name)] = encodeTag(tag);
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

/** `plugins.config` text, when it parses; undefined refuses it. */
function validSourcesConfig(text: string): string | undefined {
  try {
    parseSourcesConfig(text);
    return text;
  } catch {
    return undefined;
  }
}

/** Shown beside the `plugins.config` editor. */
const SOURCES_HELP = [
  "default:                 # ~/.codehydra/plugins (listed only to configure it)",
  "  config:",
  "    github: {token: ghp_xxx}",
  "work:                    # another folder of plugins",
  "  path: ~/work/ch-plugins",
  "acme:                    # a git repository of plugins",
  "  type: remote",
  "  url: git@github.com:acme/ch-plugins.git",
  "  ref: main              # branch, tag or commit (default: default branch)",
  "  path: plugins          # its folder of plugins (default: the root)",
  "  config:",
  "    deploy: {region: us} # values for remote:acme:deploy's settings",
  "codehydra:               # a repository's own .codehydra/plugins",
  "  type: project",
  "  project: codehydra     # name, path or origin (default: the key)",
  "  config:",
  "    setup: {db-url: postgres://127.0.0.1/dev}",
].join("\n");

// =============================================================================
// Module
// =============================================================================

/** The migration offer's button. */
const ACTION_MIGRATE = "Migrate";

/** A plugin, with the environment its settings' values make. */
interface ConfiguredPlugin extends LoadedPlugin {
  /** `CH_CONFIG_*` for its scripts. */
  readonly env: Readonly<Record<string, string>>;
  /** The remote checkout it was read from, held while one of its scripts runs. */
  readonly tree?: Path;
}

/** A hook script one plugin contributes to one entry. */
interface HookScript {
  readonly plugin: ConfiguredPlugin;
  readonly doc: PluginDocument;
  readonly script: string;
}

/** An automation, with the plugin and the script that run it. */
interface PluginAutomation extends AutomationSource {
  readonly owner: ConfiguredPlugin;
  readonly shell: ShellName;
  readonly script: string;
}

/** What a script printed and how it ended. */
type ScriptOutput = PendingRun["result"];

/**
 * A judged run: what its output parsed to, or why it failed. `output` is absent
 * only when the script never started; `logPath` when the log could not be written.
 */
type ScriptOutcome<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly output: ScriptOutput;
      readonly logPath?: Path;
    }
  | {
      readonly ok: false;
      readonly failure: string;
      readonly output: ScriptOutput;
      readonly logPath?: Path;
    }
  | {
      readonly ok: false;
      readonly failure: string;
      readonly output?: undefined;
      readonly logPath?: undefined;
    };

/** The poll jobs this module collects: one per automation. */
export const AUTOMATIONS_OWNER = "automations";

/** An automation's identity: its tracking-key prefix and the `source` metadata it writes. */
function automationId(pluginId: string, name: string): string {
  return `${pluginId}/${name}`;
}

/** The default folder's plugins, as older versions named them in tracking keys (`<plugin>/…`). */
const DEFAULT_PLUGIN_PREFIX = `local:${DEFAULT_SOURCE}:`;

/**
 * A tracking key an older version wrote, in today's form: it named a plugin of
 * the default folder by its bare name. Undefined for one already current.
 */
function migratedTrackingKey(key: string): string | undefined {
  const slash = key.indexOf("/");
  if (slash <= 0 || key.slice(0, slash).includes(":")) return undefined;
  return `${DEFAULT_PLUGIN_PREFIX}${key}`;
}

/** An automation's entry name: its run logs and its key in the error book. */
function automationEntry(source: AutomationSource): string {
  return `automations.${source.name}`;
}

/** An automation's stdout: the JSON array of its items. */
function parseItems(stdout: string): readonly unknown[] {
  const parsed = safeJsonParse(stdout);
  if (parsed === undefined) throw new Error("printed something that is not JSON");
  if (!Array.isArray(parsed)) throw new Error("printed JSON that is not an array");
  return parsed;
}

/** The workspace a hook is about: by ref, and by the paths its scripts run in. */
interface HookTarget {
  readonly workspaceRef: WorkspaceRef;
  readonly workspacePath: string;
  readonly projectRef: ProjectRef;
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

  const sourcesConfig = deps.config.register("plugins.config", {
    default: "",
    description:
      "Where plugins come from — more folders, git repositories — and the values of their settings (YAML)",
    applies: "live",
    // Edited in the clear, but it holds tokens: never in a bug report.
    omit: true,
    ...storeCustom<string>({
      parse: (raw) => validSourcesConfig(raw),
      validate: (value) => (typeof value === "string" ? validSourcesConfig(value) : undefined),
      validValues: "<YAML: entry name → {type, path, url, ref, project, config}>",
      settingsControl: {
        kind: "text",
        rows: 8,
        helpLabel: "Format",
        helpPanel: SOURCES_HELP,
      },
    }),
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

  const runner = deps.runner;

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

  const checkouts: RemoteCheckouts = createRemoteCheckouts({
    git: deps.git,
    fileSystem: deps.fileSystem,
    logger: deps.logger,
    root: deps.pathProvider.dataPath("plugins/remotes"),
    onResult: (spec, status) => {
      const key = { plugin: `remote:${spec.key}`, entry: "fetch" };
      if (status.state === "failed") errors.failure(key, status.message);
      else errors.success(key);
    },
  });

  /** The entries of `plugins.config`; just the default folder when it cannot be read. */
  function sourceEntries(): SourceEntry[] {
    try {
      const entries = parseSourcesConfig(sourcesConfig.get());
      errors.setProblems({ source: "plugins.config" }, []);
      return entries;
    } catch (error) {
      // Validated when set; this is a value that predates a stricter schema.
      errors.setProblems({ source: "plugins.config" }, [
        { plugin: "plugins.config", message: getErrorMessage(error) },
      ]);
      return [{ key: DEFAULT_SOURCE, type: "local", path: null, values: {} }];
    }
  }

  function remoteSpec(entry: RemoteSourceEntry): RemoteSpec {
    return { key: entry.key, url: entry.url, ...(entry.ref !== undefined && { ref: entry.ref }) };
  }

  function remoteSpecs(entries: readonly SourceEntry[]): RemoteSpec[] {
    return entries.flatMap((entry) => (entry.type === "remote" ? [remoteSpec(entry)] : []));
  }

  /** Where a source's plugins are now; undefined for a remote not checked out yet. */
  async function sourceDir(
    entry: LocalSourceEntry | RemoteSourceEntry
  ): Promise<{ dir: Path; tree?: Path } | undefined> {
    if (entry.type === "local") {
      return { dir: entry.path === null ? localDir : localSourcePath(entry.path) };
    }
    const tree = await checkouts.tree(remoteSpec(entry));
    if (tree === undefined) return undefined;
    return { dir: entry.path === undefined ? tree : new Path(tree, entry.path), tree };
  }

  function problemsOf(
    plugins: readonly LoadedPlugin[],
    problems: readonly DiscoveryProblem[]
  ): { plugin: string; message: string }[] {
    return [
      ...problems.map((problem) => ({
        plugin: pluginId(problem.source, problem.name),
        message: problem.message,
      })),
      ...plugins.flatMap((plugin) =>
        plugin.error === undefined ? [] : [{ plugin: plugin.id, message: plugin.error }]
      ),
    ];
  }

  /**
   * Give each plugin the environment its settings' values make. A value that
   * does not fit makes the plugin unable to run, as an invalid manifest does.
   * Values for a plugin the source does not have are reported too: a typo in
   * a plugin's name would otherwise leave it silently unconfigured.
   */
  function configure(
    source: PluginSource,
    plugins: readonly LoadedPlugin[],
    problems: readonly DiscoveryProblem[],
    values: PluginValues
  ): { plugins: ConfiguredPlugin[]; problems: { plugin: string; message: string }[] } {
    const configured = plugins.map((plugin): ConfiguredPlugin => {
      if (plugin.error !== undefined) return { ...plugin, env: {} };
      try {
        return { ...plugin, env: settingsEnv(plugin.settings, values[plugin.name] ?? {}) };
      } catch (error) {
        return { ...plugin, env: {}, error: getErrorMessage(error) };
      }
    });
    const known = new Set([
      ...plugins.map((plugin) => plugin.name),
      ...problems.map((problem) => problem.name),
    ]);
    const unknown = Object.keys(values)
      .filter((name) => !known.has(name))
      .map((name) => ({
        plugin: pluginId(source, name),
        message: `plugins.config sets values for ${name}, which ${sourceId(source)} does not have`,
      }));
    return { plugins: configured, problems: [...problemsOf(configured, problems), ...unknown] };
  }

  /** One of the user's sources: its plugins, configured, with its problems recorded. */
  async function loadSource(
    entry: LocalSourceEntry | RemoteSourceEntry
  ): Promise<ConfiguredPlugin[]> {
    const source: PluginSource = { type: entry.type, entry: entry.key };
    const where = await sourceDir(entry);
    if (where === undefined) {
      errors.setProblems({ source: sourceId(source) }, []);
      return [];
    }
    const loaded = await loadPlugins(deps.fileSystem, where.dir, source, platform);
    const { plugins, problems } = configure(source, loaded.plugins, loaded.problems, entry.values);
    errors.setProblems({ source: sourceId(source) }, problems);
    const tree = where.tree;
    return tree === undefined ? plugins : plugins.map((plugin) => ({ ...plugin, tree }));
  }

  /** Remotes `ch plugin add` is cloning, not yet in plugins.config. */
  const adding = new Set<RemoteSpec>();

  /** Delete the clones of remotes taken out of plugins.config. */
  function forgetRemoved(entries: readonly SourceEntry[] = sourceEntries()): Promise<void> {
    return checkouts.forgetOthers([...remoteSpecs(entries), ...adding]);
  }

  /** The user's plugins — every local and remote source's — in `plugins.config` order. */
  async function loadSources(): Promise<ConfiguredPlugin[]> {
    const entries = sourceEntries();
    void forgetRemoved(entries);
    const plugins: ConfiguredPlugin[] = [];
    for (const entry of entries) {
      if (entry.type === "project") continue;
      plugins.push(...(await loadSource(entry)));
    }
    return plugins;
  }

  /**
   * The values `plugins.config` gives a project's plugins: from the project
   * entry that names it. An entry naming no open project is waiting for it to
   * open; one naming several, or a project two entries name, is a problem.
   */
  async function projectValues(projectRef: ProjectRef): Promise<PluginValues> {
    const entries = sourceEntries().filter((entry) => entry.type === "project");
    if (entries.length === 0) {
      errors.setProblems({ source: "project-entries" }, []);
      return {};
    }
    let projects: readonly ProjectLocation[];
    try {
      projects = ((await deps.dispatcher.dispatch<ListProjectsIntent>({
        type: INTENT_LIST_PROJECTS,
        payload: {} as Record<string, never>,
      })) ?? []) as readonly ProjectLocation[];
    } catch (error) {
      // Without the open projects no entry can be matched; the plugins run unconfigured.
      deps.logger.warn("Could not list projects to match plugins.config entries", {
        error: getErrorMessage(error),
      });
      return {};
    }

    const problems: { plugin: string; message: string }[] = [];
    const matching: SourceEntry[] = [];
    for (const entry of entries) {
      if (entry.type !== "project") continue;
      const resolved = resolveProjectReference(projects, entry.project);
      if ("error" in resolved) {
        if (resolved.category !== "not-found") {
          problems.push({ plugin: `project-entries:${entry.key}`, message: resolved.error });
        }
        continue;
      }
      if (resolved.ref === projectRef) matching.push(entry);
    }
    if (matching.length > 1) {
      problems.push({
        plugin: `project-entries:${matching.map((entry) => entry.key).join(",")}`,
        message: `${matching.map((entry) => entry.key).join(" and ")} name the same project; keep one`,
      });
    }
    errors.setProblems({ source: "project-entries" }, problems);
    return matching.length === 1 ? matching[0]!.values : {};
  }

  /** Repository plugins already warned about for shipping automations. */
  const warnedWorkspaceAutomations = new Set<string>();

  /** A repository's plugins, as its worktree has them now, configured. */
  async function loadWorkspace(
    worktree: Path,
    project: { readonly ref: ProjectRef; readonly path: string }
  ): Promise<ConfiguredPlugin[]> {
    const source: PluginSource = { type: "project", entry: projectNameOf(project.ref) };
    const loaded = await loadPlugins(
      deps.fileSystem,
      workspacePluginsDir(worktree),
      source,
      platform
    );
    const values = loaded.plugins.length === 0 ? {} : await projectValues(project.ref);
    const { plugins, problems } = configure(source, loaded.plugins, loaded.problems, values);
    errors.setProblems({ source: sourceId(source), project: project.path }, problems);
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
    return plugin.source.type === "project"
      ? new Path(logsRoot, "project", projectDirName(projectPath), plugin.name, kind, entry)
      : new Path(logsRoot, plugin.source.type, plugin.source.entry, plugin.name, kind, entry);
  }

  function scriptsFor(plugins: readonly ConfiguredPlugin[], entry: string): HookScript[] {
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
    const own = scriptsFor(await loadSources(), entry).filter(
      (script) => trust.state(script.plugin.source, script.plugin.name) !== "disabled"
    );
    const repository = scriptsFor(
      await loadWorkspace(new Path(target.workspacePath), {
        ref: target.projectRef,
        path: target.projectPath,
      }),
      entry
    );
    if (repository.length === 0) return own;

    if (!options.ask) {
      return [
        ...own,
        ...repository.filter(
          (script) =>
            trust.state(script.plugin.source, script.plugin.name, trustProject(target)) !==
            "disabled"
        ),
      ];
    }

    const names = [...new Set(repository.map((script) => script.plugin.name))];
    const allowed = await trust.check({
      project: trustProject(target),
      workspaceRef: target.workspaceRef,
      plugins: names,
    });
    return [...own, ...repository.filter((script) => allowed.has(script.plugin.name))];
  }

  // ---------------------------------------------------------------------------
  // Running
  // ---------------------------------------------------------------------------

  /** How a plugin's run is named where a person reads it. */
  function label(script: HookScript, entry: string): string {
    return `${entry} (${script.plugin.id})`;
  }

  /**
   * Run one script — a hook's or an automation's — and judge it, recording the
   * verdict in its run log. A shell that is missing or a process that cannot
   * start, an exit other than 0 (worded by `describeExit`), and stdout that
   * `parse` throws on are failures; the caller decides whom to tell.
   */
  async function runScript<T>(
    plugin: ConfiguredPlugin,
    request: ScriptRequest,
    parse: (stdout: string) => T,
    describeExit: (output: ScriptOutput) => string = describeStatus
  ): Promise<ScriptOutcome<T>> {
    // A remote's tree stays while its script runs, whatever an update does meanwhile.
    const release = plugin.tree === undefined ? undefined : checkouts.acquire(plugin.tree);
    try {
      return await runScriptNow({ ...request, env: plugin.env }, parse, describeExit);
    } finally {
      release?.();
    }
  }

  async function runScriptNow<T>(
    request: ScriptRequest,
    parse: (stdout: string) => T,
    describeExit: (output: ScriptOutput) => string
  ): Promise<ScriptOutcome<T>> {
    let pending: PendingRun;
    try {
      pending = await runner.run(request);
    } catch (error) {
      return {
        ok: false,
        failure:
          error instanceof ShellUnavailableError
            ? error.message
            : `could not start: ${getErrorMessage(error)}`,
      };
    }

    const output = pending.result;
    let verdict: { ok: true; value: T } | { ok: false; failure: string };
    if (output.status !== "exited" || output.exitCode !== 0) {
      verdict = { ok: false, failure: describeExit(output) };
    } else {
      try {
        verdict = { ok: true, value: parse(output.stdout) };
      } catch (error) {
        verdict = { ok: false, failure: getErrorMessage(error) };
      }
    }
    const logPath = await pending.finish(
      verdict.ok ? { outcome: "ok" } : { outcome: "failed", reason: verdict.failure }
    );
    return { ...verdict, output, ...(logPath !== undefined && { logPath }) };
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
      ...(script.plugin.source.type === "project" && { project: target.projectPath }),
      entry,
    };
    const worktree = new Path(target.workspacePath);

    const run = await runScript(
      script.plugin,
      {
        source: script.plugin.id,
        entry,
        shell: script.doc.shell,
        script: script.script,
        cwd: worktree,
        input: stdin,
        logDir: logDir(script.plugin, target.projectPath, "hooks", entry),
        workspaceDir: worktree,
        ...(script.plugin.pluginDir !== undefined && { pluginDir: script.plugin.pluginDir }),
        signal,
      },
      (stdout): z.infer<S> | undefined =>
        schema === null ? undefined : parseHookOutput(stdout, schema)
    );

    if (run.output === undefined) {
      // It never started: there is no output and no run log.
      errors.failure(key, run.failure);
      throw new HookFailedError(
        entry,
        `${label(script, entry)} ${run.failure} — ${ERRORS_POINTER}`
      );
    }

    for (const [stream, text] of [
      ["stderr", run.output.stderr],
      ["stdout", run.output.stdout],
    ] as const) {
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() !== "") {
          deps.sink.write(target.workspaceRef, `${script.plugin.id} ${entry} ${stream}`, line);
        }
      }
    }

    if (!run.ok) {
      // Canceled by the quit itself: nobody is left to read a notification.
      if (!shutdown.signal.aborted) errors.failure(key, run.failure, run.logPath?.toNative());
      deps.logger.warn("Plugin hook failed", {
        plugin: script.plugin.id,
        entry,
        reason: run.failure,
      });
      throw new HookFailedError(
        entry,
        `${label(script, entry)} failed: ${run.failure} — ${ERRORS_POINTER}`
      );
    }
    errors.success(key);
    return run.value;
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
      workspaceRef: target.workspaceRef,
      workspaceName: target.workspaceName,
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
    deps.sink.opening(target.workspaceRef);
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

  async function afterWorktreeCreated(
    spec: typeof AFTER_WORKTREE_CREATED,
    input: HookInput<typeof OPEN_WORKSPACE_OPERATION_ID, "provision">
  ): Promise<HookOutput<ProvisionHookResult>> {
    // Activating a discovered workspace is not a creation. Re-running a setup
    // script for every workspace at every project open would be both surprising
    // and slow — that is what `before-workspace-opened` is for.
    if (!input.fresh) return { result: {} };

    const core = coreInput(input);
    const outputs = await runOpenEntry(
      spec.name,
      targetOf(input, core.workspaceName),
      core,
      spec.output
    );

    const merged: AfterWorktreeCreatedOutput = {};
    for (const output of outputs) {
      if (output.title !== undefined) merged.title = output.title;
      if (output.tags !== undefined) merged.tags = { ...merged.tags, ...output.tags };
    }
    const metadata = toMetadata(merged);
    await persistMetadata(input.workspaceRef, metadata);
    return { result: Object.keys(metadata).length > 0 ? { metadata } : {} };
  }

  // ---------------------------------------------------------------------------
  // before-workspace-opened
  // ---------------------------------------------------------------------------

  async function beforeWorkspaceOpened(
    spec: typeof BEFORE_WORKSPACE_OPENED,
    input: HookInput<typeof OPEN_WORKSPACE_OPERATION_ID, "prepare">
  ): Promise<HookOutput<PrepareHookResult>> {
    const core = coreInput(input);
    const outputs = await runOpenEntry(
      spec.name,
      targetOf(input, core.workspaceName),
      { ...core, reopened: !input.fresh },
      spec.output
    );

    const merged: Record<string, string> = {};
    for (const output of outputs) Object.assign(merged, output.env ?? {});
    if (outputs.every((output) => output.env === undefined)) return { result: {} };

    const { env: kept, dropped } = splitReservedEnv(merged);
    if (dropped.length > 0) {
      deps.logger.warn("Plugin env may not set CodeHydra's own variables", {
        entry: spec.name,
        dropped: dropped.join(","),
      });
    }
    return { result: { env: kept } };
  }

  /** The core every open entry is handed. `branch`/`base` stay absent when unknown. */
  function coreInput(input: ProvisionHookInput | PrepareHookInput): CoreInput {
    return {
      workspaceName: input.workspaceName,
      workspacePath: input.workspacePath,
      projectPath: input.projectPath,
      workspace: input.workspaceRef,
      project: input.projectRef,
      ...(input.branch !== undefined && { branch: input.branch }),
      ...(input.base !== undefined && { base: input.base }),
    };
  }

  function targetOf(
    input: {
      workspaceRef: WorkspaceRef;
      workspacePath: string;
      projectRef: ProjectRef;
      projectPath: string;
    },
    workspaceName: string
  ): HookTarget {
    return {
      workspaceRef: input.workspaceRef,
      workspacePath: input.workspacePath,
      projectRef: input.projectRef,
      projectPath: input.projectPath,
      workspaceName,
    };
  }

  /** A target's project, as trust asks about it. */
  function trustProject(target: HookTarget): TrustProject {
    return { ref: target.projectRef, path: target.projectPath };
  }

  // ---------------------------------------------------------------------------
  // before-worktree-deleted
  // ---------------------------------------------------------------------------

  async function* beforeWorktreeDeleted(
    spec: typeof BEFORE_WORKTREE_DELETED,
    input: HookInput<typeof DELETE_WORKSPACE_OPERATION_ID, "pre-delete">
  ): AsyncGenerator<PreDeleteStartedFrame, HookOutput<PreDeleteHookResult>, void> {
    const { intent } = input;
    if (!allowed()) return { result: {} };

    const entry = spec.name;
    const target = targetOf(input, input.workspaceName);

    // Claim a row on the deletion panel before anything slow happens — the
    // trust dialog included, so a question raised here has something to explain
    // it. Without a script nothing is yielded and no row ever appears.
    if ((await hookScripts(entry, target, { ask: false })).length === 0) return { result: {} };
    yield { started: true };

    const scripts = await hookScripts(entry, target, { ask: true });
    if (scripts.length === 0) return { result: {} };

    const identity = await resolveBranchAndBase(input.workspaceRef);

    // The editor was torn down at "shutdown" and is not coming back: whatever
    // these scripts print belongs in their run logs, not in a buffer nobody
    // will flush.
    deps.sink.closed(input.workspaceRef);

    const stdin = {
      workspaceName: input.workspaceName,
      workspacePath: input.workspacePath,
      projectPath: input.projectPath,
      workspace: input.workspaceRef,
      project: input.projectRef,
      ...identity,
      keepBranch: intent.payload.keepBranch,
    };

    for (const script of scripts) {
      // A throw is the "could not tell" half of the gate and stops the deletion
      // by itself; a returned `blocked` is the deliberate refusal.
      const output = await runCancelable(script, entry, target, "delete", (signal) =>
        runHookScript(script, entry, target, stdin, spec.output, signal)
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
  async function announceDeleteHook(
    spec: typeof BEFORE_WORKTREE_DELETED,
    input: HookInput<typeof DELETE_WORKSPACE_OPERATION_ID, "preflight">
  ): Promise<HookOutput<PreflightHookResult>> {
    const { payload } = input.intent;

    // Exactly the conditions under which the stage will actually run.
    if (!payload.removeWorktree || payload.force || !allowed()) return {};

    const scripts = await hookScripts(spec.name, targetOf(input, input.workspaceName), {
      ask: false,
    });
    return scripts.length > 0 ? { provides: { [CAPABILITY_REPO_HOOK]: true } } : {};
  }

  // ---------------------------------------------------------------------------
  // on-workspace-opened (fire-and-forget)
  // ---------------------------------------------------------------------------

  function onWorkspaceOpened(event: EventFor<typeof EVENT_WORKSPACE_CREATED>): void {
    const payload = event.payload;
    const entry = ON_WORKSPACE_OPENED.name;

    void (async (): Promise<void> => {
      try {
        if (!allowed()) return;
        // The event names the workspace by ref; its scripts run in its directory.
        const resolved = await deps.dispatcher.dispatch<ResolveWorkspaceIntent>({
          type: INTENT_RESOLVE_WORKSPACE,
          payload: { workspaceRef: payload.workspaceRef },
        });
        const target = targetOf(resolved, payload.workspaceName);
        const stdin = {
          workspaceName: payload.workspaceName,
          workspacePath: resolved.workspacePath,
          projectPath: resolved.projectPath,
          workspace: payload.workspaceRef,
          project: payload.projectRef,
          ...(payload.branch !== undefined && { branch: payload.branch }),
          ...(payload.base !== undefined && { base: payload.base }),
          reopened: !payload.fresh,
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
    workspaceRef: WorkspaceRef,
    metadata: Record<string, string>
  ): Promise<void> {
    for (const [key, value] of Object.entries(metadata)) {
      try {
        await deps.dispatcher.dispatch<SetMetadataIntent>({
          type: INTENT_SET_METADATA,
          payload: { workspaceRef, key, value },
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
    workspaceRef: WorkspaceRef
  ): Promise<{ branch?: string; base?: string }> {
    try {
      const resolved = await deps.dispatcher.dispatch<ResolveWorkspaceIntent>({
        type: INTENT_RESOLVE_WORKSPACE,
        payload: { workspaceRef },
      });
      const base = resolved.metadata["base"];
      return {
        ...(resolved.branch !== null && { branch: resolved.branch }),
        ...(base !== undefined && { base }),
      };
    } catch (error) {
      deps.logger
        .scoped({ workspace: workspaceRef })
        .debug("Could not resolve branch/base for a hook", { error: getErrorMessage(error) });
      return {};
    }
  }

  // ---------------------------------------------------------------------------
  // Automations
  // ---------------------------------------------------------------------------

  /** The automations to run this cycle: every enabled local and remote plugin's, for this platform. */
  async function automationSources(): Promise<readonly PluginAutomation[]> {
    const sources: PluginAutomation[] = [];
    const seen = new Set<string>();
    for (const plugin of await loadSources()) {
      if (plugin.error !== undefined || trust.state(plugin.source, plugin.name) === "disabled") {
        continue;
      }
      for (const doc of plugin.applied) {
        for (const spec of doc.automations) {
          const id = automationId(plugin.id, spec.name);
          if (seen.has(id)) {
            deps.logger.warn("Automation defined twice for this platform; running the first", {
              plugin: plugin.id,
              automation: spec.name,
            });
            continue;
          }
          seen.add(id);
          sources.push({
            id,
            plugin: plugin.id,
            name: spec.name,
            owner: plugin,
            shell: doc.shell,
            script: spec.script,
          });
        }
      }
    }
    return sources;
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
    stateService: deps.stateService,
    enabled: allowed,
    sources: automationSources,
    parseItem: (raw) => items().parse(raw),
    invokeAction: async (action, input) => {
      await invokePluginAction({ registry: deps.registry() }, action, input);
    },
  });

  /** The automations of the tick in progress, by id, for their results. */
  let collected = new Map<string, PluginAutomation>();

  /**
   * The remote checkouts the tick's scripts run in, by job id: held from
   * collect until the job's result, so an update cannot remove one meanwhile.
   */
  const leases = new Map<string, () => void>();

  function releaseLease(id: string): void {
    leases.get(id)?.();
    leases.delete(id);
  }

  /** Read once, before the first tick reads them: legacy sources moved, tracking loaded. */
  let prepared: Promise<void> | undefined;
  function prepare(): Promise<void> {
    prepared ??= (async () => {
      await moveLegacySources();
      automations.load();
    })();
    return prepared;
  }

  /** The poll job that runs an automation's script. */
  function automationJob(source: PluginAutomation): PollJob {
    const { owner } = source;
    return {
      owner: AUTOMATIONS_OWNER,
      id: source.id,
      source: owner.id,
      entry: automationEntry(source),
      shell: source.shell,
      script: source.script,
      // A one-file plugin runs in the folder that holds it.
      cwd: (owner.pluginDir ?? owner.manifestPath.dirname).toString(),
      input: {},
      logDir: logDir(owner, "", "automations", source.name).toString(),
      ...(Object.keys(owner.env).length > 0 && { env: { ...owner.env } }),
      ...(owner.pluginDir !== undefined && { pluginDir: owner.pluginDir.toString() }),
      failure: { title: "Plugin failed", pointer: ERRORS_POINTER },
    };
  }

  async function collectAutomations(): Promise<readonly PollJob[]> {
    await prepare();
    const sources = await automations.collect();
    collected = new Map(sources.map((source) => [source.id, source]));
    // A tick that never reached a job's result holds nothing past the next.
    for (const id of [...leases.keys()]) releaseLease(id);
    for (const { id, owner } of sources) {
      if (owner.tree !== undefined) leases.set(id, checkouts.acquire(owner.tree));
    }
    return sources.map(automationJob);
  }

  /** Act on what an automation printed; what went wrong is the poll module's to announce. */
  async function automationResult(
    job: PollJob,
    run: { readonly stdout: string; readonly failure?: string | undefined }
  ): Promise<readonly string[]> {
    if (run.failure !== undefined) return [];
    const source = collected.get(job.id);
    if (source === undefined) return [];
    let printed: readonly unknown[];
    try {
      printed = parseItems(run.stdout);
    } catch (error) {
      return [getErrorMessage(error)];
    }
    return automations.handle(source, printed);
  }

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
            : `${automationId(`${DEFAULT_PLUGIN_PREFIX}${LEGACY_SOURCES_PLUGIN}`, name)}/${key.slice(slash + 1)}`;
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
  const offering = new Set<WorkspaceRef>();

  /**
   * Offer to migrate a worktree's old `.codehydra/hooks`, which no longer run.
   *
   * Raised on every open while the hook files are there and the repository
   * has no plugin — loud on purpose: the hooks stopped running silently, and
   * a setup step that no longer happens is easy to miss. Migrate writes
   * `.codehydra/plugins/hooks.yaml` (legacy-hooks.ts) for the user to commit.
   */
  async function offerHookMigration(workspaceRef: WorkspaceRef): Promise<void> {
    if (offering.has(workspaceRef)) return;
    offering.add(workspaceRef);
    try {
      const { workspacePath, projectRef: resolvedProject } =
        await deps.dispatcher.dispatch<ResolveWorkspaceIntent>({
          type: INTENT_RESOLVE_WORKSPACE,
          payload: { workspaceRef },
        });
      const worktree = new Path(workspacePath);
      const files = await listLegacyHooks(deps.fileSystem, worktree);
      if (files.length === 0) return;
      const pluginsDir = workspacePluginsDir(worktree);
      const repository: PluginSource = {
        type: "project",
        entry: projectNameOf(resolvedProject),
      };
      if ((await discoverPlugins(deps.fileSystem, pluginsDir, repository)).plugins.length > 0) {
        return;
      }

      const answer = await deps.dispatcher.dispatch<VscodeShowMessageIntent>({
        type: INTENT_VSCODE_SHOW_MESSAGE,
        payload: {
          workspaceRef,
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
          workspaceRef,
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
        .scoped({ workspace: workspaceRef })
        .warn("Could not offer to migrate .codehydra/hooks", { error: getErrorMessage(error) });
    } finally {
      offering.delete(workspaceRef);
    }
  }

  deps.workspaceConnected((workspaceRef) => {
    void offerHookMigration(workspaceRef);
  });

  // ---------------------------------------------------------------------------
  // `ch plugin`
  // ---------------------------------------------------------------------------

  /** How long ago an ISO time was, the way a person says it. */
  function ago(iso: string): string {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  /** A remote's status, in a few words. */
  function describeRemote(status: RemoteStatus | undefined): string {
    if (status === undefined || status.state === "cloning") return "cloning";
    if (status.state === "ready") {
      return `${status.commit.slice(0, 7)}, fetched ${ago(status.fetchedAt)}`;
    }
    const kept =
      status.commit === undefined
        ? ""
        : ` (running ${status.commit.slice(0, 7)}${status.fetchedAt === undefined ? "" : `, fetched ${ago(status.fetchedAt)}`})`;
    return `fetch failed: ${status.message}${kept}`;
  }

  function sourceListing(entry: LocalSourceEntry | RemoteSourceEntry): PluginSourceListing {
    const id = sourceId({ type: entry.type, entry: entry.key });
    if (entry.type === "local") {
      return {
        id,
        type: "local",
        name: entry.key,
        location: (entry.path === null ? localDir : localSourcePath(entry.path)).toNative(),
        status: "",
      };
    }
    return {
      id,
      type: "remote",
      name: entry.key,
      location: entry.url,
      ...(entry.ref !== undefined && { ref: entry.ref }),
      status: describeRemote(checkouts.status(remoteSpec(entry))),
    };
  }

  function listing(plugin: ConfiguredPlugin, project?: TrustProject): PluginListing {
    const remote =
      plugin.source.type === "remote"
        ? sourceEntries().find(
            (entry): entry is RemoteSourceEntry =>
              entry.type === "remote" && entry.key === plugin.source.entry
          )
        : undefined;
    return {
      id: plugin.id,
      name: plugin.name,
      type: plugin.source.type,
      source: plugin.source.entry,
      state: trust.state(plugin.source, plugin.name, project),
      platforms: plugin.platforms,
      path: (plugin.pluginDir ?? plugin.manifestPath).toNative(),
      ...(plugin.source.type === "project" && project !== undefined && { project: project.ref }),
      ...(remote !== undefined && {
        status: describeRemote(checkouts.status(remoteSpec(remote))),
      }),
    };
  }

  /** The user's sources: what `plugins.config` lists, the default folder first. */
  function userSources(): (LocalSourceEntry | RemoteSourceEntry)[] {
    return sourceEntries().filter(
      (entry): entry is LocalSourceEntry | RemoteSourceEntry => entry.type !== "project"
    );
  }

  /** Write `plugins.config`, turning a refusal into the caller's error. */
  async function writeSources(text: string): Promise<void> {
    try {
      await sourcesConfig.set(text);
    } catch (error) {
      throw new ApiError("usage", `plugins.config: ${getErrorMessage(error)}`);
    }
  }

  /** A name made from a repository's or a folder's, usable as an entry name. */
  function entryNameFrom(text: string): string {
    return (
      text
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .replace(/^[^A-Za-z0-9]+/, "")
        .replace(/-+/g, "-") || "plugins"
    );
  }

  async function addSource(request: Parameters<Plugins["add"]>[0]): Promise<PluginSourceListing> {
    const remote = looksLikeGitUrl(request.source);
    if (!remote && request.ref !== undefined) {
      throw new ApiError("usage", "--ref is for a git repository; a folder has no ref");
    }
    if (!remote && request.path !== undefined) {
      throw new ApiError(
        "usage",
        "--path is for a git repository's folder; name the folder itself"
      );
    }

    let entry: Record<string, unknown>;
    let defaultName: string;
    if (remote) {
      entry = {
        type: "remote",
        url: request.source,
        ...(request.ref !== undefined && { ref: request.ref }),
        ...(request.path !== undefined && { path: request.path }),
      };
      defaultName = entryNameFrom(extractRepoName(expandGitUrl(request.source)));
    } else {
      const folder = resolveLocalPath(request.source, request.cwd);
      if (!new Path(folder).toString().startsWith("/") && !/^[A-Za-z]:/.test(folder)) {
        throw new ApiError("usage", `${request.source}: name the folder by an absolute path`);
      }
      try {
        await deps.fileSystem.readdir(new Path(folder));
      } catch {
        throw new ApiError("not-found", `${request.source}: no such folder`);
      }
      entry = { path: new Path(folder).toNative() };
      defaultName = entryNameFrom(new Path(folder).basename);
    }

    const name = request.name ?? defaultName;
    if (!SOURCE_NAME.test(name)) {
      throw new ApiError("usage", `"${name}" is not a usable name (letters, digits, ., - and _)`);
    }
    if (name === DEFAULT_SOURCE || sourceEntries().some((existing) => existing.key === name)) {
      throw new ApiError(
        "conflict",
        `There is already a plugins.config entry named ${name}; pass --name to choose another`
      );
    }

    let text: string;
    try {
      text = addSourceEntry(sourcesConfig.get(), name, entry);
    } catch (error) {
      throw new ApiError(
        error instanceof SourcesConfigError ? "usage" : "failed",
        `plugins.config: ${getErrorMessage(error)}`
      );
    }

    if (remote) {
      // Cloned before it is listed: a repository that cannot be reached is refused.
      const spec: RemoteSpec = {
        key: name,
        url: request.source,
        ...(request.ref !== undefined && { ref: request.ref }),
      };
      adding.add(spec);
      try {
        const status = await checkouts.update(spec);
        if (status.state !== "ready") {
          adding.delete(spec);
          await forgetRemoved();
          throw new ApiError(
            "failed",
            `Could not add ${request.source}: ${status.state === "failed" ? status.message : status.state}`
          );
        }
        await writeSources(text);
      } finally {
        adding.delete(spec);
      }
    } else {
      await writeSources(text);
    }

    const added = userSources().find((existing) => existing.key === name);
    if (added === undefined) throw new ApiError("failed", `${name} was not added`);
    return sourceListing(added);
  }

  async function removeSource(name: string): Promise<PluginSourceListing> {
    if (name === DEFAULT_SOURCE) {
      throw new ApiError("usage", "The default folder cannot be removed");
    }
    const entry = sourceEntries().find((existing) => existing.key === name);
    if (entry === undefined || entry.type === "project") {
      throw new ApiError(
        "not-found",
        `No plugins.config entry ${name}. \`ch plugin list\` shows them.`
      );
    }
    const removed = sourceListing(entry);
    const text = removeSourceEntry(sourcesConfig.get(), name);
    if (text === undefined) throw new ApiError("not-found", `No plugins.config entry ${name}`);
    await writeSources(text);
    await forgetRemoved();
    return removed;
  }

  async function updateSources(name?: string): Promise<PluginSourceListing[]> {
    const remotes = userSources().filter(
      (entry): entry is RemoteSourceEntry => entry.type === "remote"
    );
    let targets = remotes;
    if (name !== undefined) {
      targets = remotes.filter((entry) => entry.key === name);
      if (targets.length === 0) {
        throw new ApiError(
          userSources().some((entry) => entry.key === name) ? "usage" : "not-found",
          userSources().some((entry) => entry.key === name)
            ? `${name} is a folder: there is nothing to fetch`
            : `No remote plugins.config entry ${name}`
        );
      }
    }
    await Promise.all(targets.map((entry) => checkouts.update(remoteSpec(entry))));
    return targets.map(sourceListing);
  }

  const api: Plugins = {
    async list(scope) {
      const own = await loadSources();
      const listings = own.map((plugin) => listing(plugin));
      // A remote with nothing checked out yet still shows, saying why.
      for (const entry of userSources()) {
        if (entry.type !== "remote" || own.some((plugin) => plugin.source.entry === entry.key)) {
          continue;
        }
        const source = sourceListing(entry);
        listings.push({
          id: `${source.id}:*`,
          name: "*",
          type: "remote",
          source: entry.key,
          state: "enabled",
          platforms: [],
          path: "",
          status: source.status,
        });
      }
      if (scope.workspace !== null) {
        const { workspacePath, projectRef, projectPath } = scope.workspace;
        const repository = await loadWorkspace(new Path(workspacePath), {
          ref: projectRef,
          path: projectPath,
        });
        listings.push(
          ...repository.map((plugin) => listing(plugin, { ref: projectRef, path: projectPath }))
        );
      }
      return listings;
    },
    async setState(scope, id, state) {
      const found = (await api.list(scope)).find(
        (plugin) => plugin.id === id && plugin.name !== "*"
      );
      if (found === undefined) {
        if (id.startsWith("project:") && scope.workspace === null) {
          throw new ApiError(
            "no-workspace",
            `${id}: a repository's plugins are named from inside one of its workspaces (or with --workspace)`
          );
        }
        throw new ApiError("not-found", `No plugin ${id}. \`ch plugin list\` shows them.`);
      }
      await trust.set(
        { type: found.type, entry: found.source },
        found.name,
        state,
        found.project === undefined ? undefined : projectRefSchema.parse(found.project)
      );
      return { ...found, state };
    },
    add: addSource,
    remove: removeSource,
    update: updateSources,
    errors: () => [
      ...errors.list(),
      // An automation's failures are the poll module's, which runs them.
      ...deps.pollErrors(AUTOMATIONS_OWNER).map((failure) => ({
        plugin: failure.source,
        entry: failure.entry,
        message: failure.message,
        ...(failure.logPath !== undefined && { logPath: failure.logPath }),
        at: failure.at,
      })),
    ],
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

  /**
   * Bring what older versions stored to today's form before anything reads it:
   * project paths become project refs (trust answers, automation tracking
   * entries), and plugins named before sources existed (`local:<name>`,
   * `workspace:…`, `<name>/<automation>`) get their source. Best-effort, since
   * an entry left behind only costs a question or a looser match, never the
   * start.
   */
  async function migrateProjectKeys(): Promise<void> {
    try {
      const refs = await deps.projectRefs();
      await trust.migrateKeys(refs);
      await automations.migrateEntries(refs);
      await automations.renameTracking(migratedTrackingKey);
    } catch (error) {
      deps.logger.warn("Could not move plugin state from project paths to refs", {
        error: getErrorMessage(error),
      });
    }
  }

  const hooks = defineHooks({
    [APP_START_OPERATION_ID]: {
      migrations: { handler: migrateProjectKeys },
    },
    [APP_SHUTDOWN_OPERATION_ID]: {
      stop: { handler: cancelAllHooks },
    },
    [POLL_TICK_OPERATION_ID]: {
      collect: { handler: async () => ({ result: { jobs: await collectAutomations() } }) },
      result: {
        handler: async (ctx) => {
          if (ctx.job.owner !== AUTOMATIONS_OWNER) return;
          try {
            return { result: { errors: await automationResult(ctx.job, ctx.run) } };
          } finally {
            releaseLease(ctx.job.id);
          }
        },
      },
    },
    // Driven by the hook maps: exposing an entry at another point fails to
    // compile here until it is bound.
    [OPEN_WORKSPACE_OPERATION_ID]: bindHookPoints(openWorkspaceSchemas, OPEN_WORKSPACE_HOOKS, {
      provision: (spec) => ({ handler: (ctx) => afterWorktreeCreated(spec, ctx) }),
      prepare: (spec) => ({ handler: (ctx) => beforeWorkspaceOpened(spec, ctx) }),
    }),
    [DELETE_WORKSPACE_OPERATION_ID]: {
      ...bindHookPoints(deleteWorkspaceSchemas, DELETE_WORKSPACE_HOOKS, {
        "pre-delete": (spec) => ({ handler: (ctx) => beforeWorktreeDeleted(spec, ctx) }),
      }),
      // Not an entry of its own: claims the deletion panel's row for the gate.
      preflight: {
        handler: (ctx) => announceDeleteHook(DELETE_WORKSPACE_HOOKS["pre-delete"], ctx),
      },
    },
  });

  const events = defineEvents({
    [EVENT_APP_STARTED]: {
      // The once-a-start fetch of every remote source, in the background.
      handler: async (): Promise<void> => {
        if (allowed()) checkouts.refresh(remoteSpecs(sourceEntries()));
      },
    },
    [EVENT_WORKSPACE_CREATED]: {
      // Returns immediately: the emitter must never wait on a plugin's script,
      // least of all one that may park on a trust dialog.
      handler: async (event): Promise<void> => {
        onWorkspaceOpened(event);
      },
    },
    [EVENT_WORKSPACE_DELETED]: {
      // Its editor is never coming back, so neither is a reason to hold its output.
      handler: async (event): Promise<void> => {
        deps.sink.closed(event.payload.workspaceRef);
      },
    },
  });

  return { name: "plugins", hooks, events, api };
}
