/**
 * Dependencies the registry entries dispatch through.
 *
 * Entries hold no state of their own. Anything that needs module-level state —
 * notably waiting on a deletion's terminal progress event, which requires a
 * domain-event subscription — is injected here by the module that owns it.
 */

import type { Dispatcher } from "../../intents/lib/dispatcher";
import type { AppBoundary } from "../../boundaries/shell/app";
import type { DeletionProgress } from "../../shared/api/types";
import type { ProjectRef, WorkspaceRef } from "../../intents/contract";
import type { OperationRegistry } from "../registry";
import type { ProjectTypeOptions } from "../../intents/project-type-options";
import type { Config } from "../../boundaries/platform/config";

/**
 * Where a lock name lives.
 *
 * A global lock is contended for by every workspace of every open project; a
 * project-scoped one only by that project's workspaces. The same name in the
 * two namespaces is two different locks.
 */
export interface LockKey {
  /** `[A-Za-z0-9-_]+` — free-form, created on first take. */
  readonly name: string;
  /** The owning project for a project-scoped lock; null for a global one. */
  readonly project: ProjectRef | null;
}

export interface LockTakeOptions {
  /** Why the caller wants it. Shown to waiters and in the sidebar tag's tooltip. */
  readonly reason?: string | undefined;
  /** Queue behind the holder when it is held, instead of failing with `conflict`. */
  readonly wait: boolean;
  /** The caller's connection; aborting it drops a queued waiter. */
  readonly signal: AbortSignal;
  /**
   * Also release when `signal` aborts after the lock was granted.
   *
   * Only `ch lock run` sets this: its process is the hold, so killing it must
   * free the lock. An ordinary take is held by the workspace and outlives the
   * process that asked for it.
   */
  readonly releaseOnDisconnect: boolean;
}

export interface LockTakeResult {
  /**
   * False when the workspace already held the lock. A re-take is reentrant: it
   * succeeds at once and changes nothing, so a caller that did not acquire must
   * not release — which is how `ch lock run` inside a longer hold leaves it intact.
   */
  readonly acquired: boolean;
  readonly waitedMs: number;
}

/** One lock as it stands right now. Locks exist only while held. */
export interface LockSnapshot {
  readonly name: string;
  readonly project: ProjectRef | null;
  readonly holder: WorkspaceRef;
  readonly reason?: string;
  /** Epoch milliseconds. */
  readonly acquiredAt: number;
  /** Queued workspaces, in the order they will be granted. */
  readonly waiting: readonly WorkspaceRef[];
}

/**
 * The lock table: single-holder resources shared across workspaces.
 *
 * Owned by the lock module (in-memory, gone at restart) and reached by the
 * `lock.*` entries through here, like `awaitDeletion`.
 */
export interface Locks {
  /**
   * Take a lock for a workspace. Resolves once it is the holder: at once when the
   * lock is free or already this workspace's, otherwise after waiting its turn
   * (FIFO, granted atomically on release). Rejects with `conflict` when held and
   * `wait` is false.
   */
  take(workspace: WorkspaceRef, key: LockKey, options: LockTakeOptions): Promise<LockTakeResult>;
  /** Release a lock the workspace holds. Throws `not-found` when it does not hold it. */
  release(workspace: WorkspaceRef, key: LockKey): void;
  list(): readonly LockSnapshot[];
}

/** A plugin's enabled state: `ask` = not answered yet (a repository's plugin). */
export type PluginState = "enabled" | "disabled" | "ask";

/** One plugin, as `ch plugin list` shows it. */
export interface PluginListing {
  /** `<type>:<entry>:<name>`, e.g. `remote:acme:deploy`. */
  readonly id: string;
  readonly name: string;
  readonly type: "local" | "remote" | "project";
  /** The `plugins.config` entry it comes from, or its project's name. */
  readonly source: string;
  readonly state: PluginState;
  /** Platforms any of its documents applies on (`linux`, `windows`, `macos`). */
  readonly platforms: readonly string[];
  /** The plugin's directory, or its manifest file. */
  readonly path: string;
  /** The project a repository's plugin belongs to. */
  readonly project?: string;
  /** For a remote's plugin: what is checked out, and when it was fetched. */
  readonly status?: string;
}

/** One `plugins.config` entry that plugins come from. */
export interface PluginSourceListing {
  /** `<type>:<entry>`, e.g. `remote:acme`. */
  readonly id: string;
  readonly type: "local" | "remote";
  readonly name: string;
  /** The folder, or the repository's URL. */
  readonly location: string;
  /** A remote's ref, when it names one. */
  readonly ref?: string;
  /** A remote's checkout (`9f1e2c3, fetched 2m ago`), `cloning`, or why it failed; a folder's is empty. */
  readonly status: string;
}

/** One automation, as `ch plugin automation list` shows it. */
export interface AutomationListing {
  /** `<plugin>/<name>`, e.g. `local:default:github/reviews`. */
  readonly automation: string;
  readonly plugin: string;
  readonly state: PluginState;
  /** How long it waits between runs (hourly … yearly); absent: every poll. */
  readonly schedule?: Schedule;
  /** ISO time it next runs: its last run plus its wait, or now when it has not run since the app started. */
  readonly nextRun?: string;
  /** The project a repository's automation belongs to. */
  readonly project?: string;
  /** The plugin's directory, or its manifest file. */
  readonly path: string;
}

/** What `ch plugin automation add` was given. */
export interface NewAutomationRequest {
  readonly name: string;
  readonly script: string;
  readonly schedule?: Schedule;
  readonly shell?: ScriptShell;
  /** Into the workspace's `.codehydra/plugins`, instead of `~/.codehydra/plugins`. */
  readonly repo: boolean;
}

/** The file `ch plugin automation add|remove` wrote or deleted. */
export interface AutomationFile {
  readonly automation: string;
  readonly plugin: string;
  readonly path: string;
  /** When the change applies, in words that follow "takes effect". */
  readonly takesEffect: string;
}

/** What `ch plugin add` was given. */
export interface PluginAddRequest {
  /** A git URL (a remote) or a folder (a local entry). */
  readonly source: string;
  readonly name?: string;
  readonly ref?: string;
  /** The folder inside a repository that holds its plugins. */
  readonly path?: string;
  /** The caller's directory, for a relative folder. */
  readonly cwd: string | null;
}

/** Something wrong with a plugin: a problem, or its last failed run. */
export interface PluginError {
  readonly plugin: string;
  readonly project?: string;
  /** The hook entry or automation (`automations.<name>`); absent for a problem. */
  readonly entry?: string;
  readonly message: string;
  /** The failed run's log file. */
  readonly logPath?: string;
  /** ISO time it was recorded. */
  readonly at: string;
}

/** Where a caller stands, for the workspace half of the plugin list. */
export interface PluginScope {
  /** The caller's workspace, resolved: where its repository's plugins are read from. */
  readonly workspace: {
    readonly workspacePath: string;
    readonly projectRef: ProjectRef;
    readonly projectPath: string;
  } | null;
}

/** The plugins, owned by the plugin module. */
export interface Plugins {
  list(scope: PluginScope): Promise<readonly PluginListing[]>;
  /** Every automation: the user's, and each open project's on its default branch. */
  automations(): Promise<readonly AutomationListing[]>;
  /** Write a new automation's manifest (`ch plugin automation add`). */
  addAutomation(scope: PluginScope, request: NewAutomationRequest): Promise<AutomationFile>;
  /** Delete a manifest holding just that automation (`ch plugin automation remove`). */
  removeAutomation(scope: PluginScope, name: string, repo: boolean): Promise<AutomationFile>;
  /** Set a plugin's state. Throws `not-found` when no such plugin exists. */
  setState(scope: PluginScope, id: string, state: PluginState): Promise<PluginListing>;
  /** Add a source to `plugins.config`: a repository is cloned first, and refused if it cannot be. */
  add(request: PluginAddRequest): Promise<PluginSourceListing>;
  /** Remove a source from `plugins.config`; a repository's clone goes with it. */
  remove(name: string): Promise<PluginSourceListing>;
  /** Fetch one remote source, or every one, and switch to what its ref names now. */
  update(name?: string): Promise<readonly PluginSourceListing[]>;
  /** What is wrong right now. */
  errors(): readonly PluginError[];
  /**
   * Past failures, newest first: the failed runs whose logs are kept, apart
   * from the ones entries are failing with now, and the failures since start
   * that left no log.
   */
  pastErrors(): Promise<readonly PluginError[]>;
  /** The JSON Schema of a plugin manifest, or of the items an automation prints. */
  schema(which: "manifest" | "items"): Record<string, unknown>;
  /**
   * Render items through a Liquid template file: each item becomes the
   * template with its string values rendered against that item. `itemsJson`
   * must be a JSON array.
   */
  render(templatePath: string, itemsJson: string): Promise<unknown[]>;
}

/** The shells a script can be written for. */
export const SCRIPT_SHELLS = ["bash", "powershell", "cmd"] as const;
export type ScriptShell = (typeof SCRIPT_SHELLS)[number];

/** How long an automation waits after a run before the next (plugin-module/schedule.ts). */
export const SCHEDULES = ["hourly", "daily", "weekly", "monthly", "yearly"] as const;
export type Schedule = (typeof SCHEDULES)[number];

/** An automation's name: it becomes a log directory and a tracking key, so it stays plain. */
export const AUTOMATION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const AUTOMATION_NAME_RULE =
  "an automation's name uses letters, digits, - and _ (and starts with a letter or digit)";

/** A workspace's wakeup script: run every poll tick while it is hibernated. */
export interface WakeupScript {
  readonly script: string;
  readonly shell: ScriptShell;
  /** Variables of the script's own. */
  readonly env: Readonly<Record<string, string>>;
}

/** A wakeup script, with how it last went. */
export interface WakeupStatus extends WakeupScript {
  /** The last run since it was set, if it has run (one that woke it cleared the script). */
  readonly lastRun?: {
    /** ISO time it finished. */
    readonly at: string;
    readonly outcome: "keep" | "failed";
    /** Why it failed. */
    readonly message?: string;
  };
  /** Its current failure, as announced: the message and the failed run's log file. */
  readonly error?: { readonly message: string; readonly logPath?: string };
}

/** The wakeup scripts, owned by the wakeup module. */
export interface Wakeups {
  /** Set a workspace's script, replacing any it had; null clears it. */
  set(workspace: WorkspaceRef, script: WakeupScript | null): Promise<void>;
  /** A workspace's script and how it last went; null when it has none. */
  show(workspace: WorkspaceRef): Promise<WakeupStatus | null>;
}

/** CPU, memory and count over a set of processes. */
export interface ProcessTotals {
  /**
   * Percent of the whole machine (0–100) over the last interval, summed and
   * capped at 100; null before a second scan.
   */
  readonly cpuPercent: number | null;
  readonly rssBytes: number;
  readonly count: number;
}

/** One process of a workspace, with the workspace's processes it started. */
export interface WorkspaceProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly commandLine: string;
  /** Its working directory; null when the OS would not tell. */
  readonly cwd: string | null;
  /** Percent of the whole machine (0–100) over the last interval; null before a second scan. */
  readonly cpuPercent: number | null;
  readonly rssBytes: number;
  /** ISO time it started; null when unknown. */
  readonly startedAt: string | null;
  /** TCP ports it listens on. */
  readonly ports: readonly number[];
  /** This process and everything below it. */
  readonly subtree: ProcessTotals;
  readonly children: readonly WorkspaceProcess[];
}

/** A workspace's processes as one scan saw them. */
export interface WorkspaceProcesses {
  /** ISO time of the scan. */
  readonly scannedAt: string;
  readonly total: ProcessTotals;
  /** The tree's roots: processes whose parent is not the workspace's. */
  readonly processes: readonly WorkspaceProcess[];
}

/** The process monitor, owned by the process-monitor module. */
export interface ProcessMonitorAccess {
  /** A workspace's processes, from a scan at most a moment old. Null when the scan failed. */
  list(workspace: WorkspaceRef): Promise<WorkspaceProcesses | null>;
}

export interface EntryDeps {
  readonly dispatcher: Dispatcher;
  /**
   * Open a path with the OS. `reveal` shows it in the file manager (selecting a
   * file's containing folder), otherwise it opens with the default application.
   * No intent covers this — the API server calls the app boundary directly.
   */
  readonly appLayer: Pick<AppBoundary, "openPath">;
  /**
   * Wait for the terminal deletion-progress event for a workspace.
   *
   * Deletion reports its real outcome through an event rather than the dispatch
   * result: `ctx.emit` is not awaited inside the delete operation, so reading
   * state after `await handle` races the emit. Returns a promise for the
   * terminal progress plus a cleanup to drop the waiter.
   */
  readonly awaitDeletion: (workspaceRef: WorkspaceRef) => {
    readonly outcome: Promise<DeletionProgress>;
    readonly release: () => void;
  };
  /**
   * The app's config, for the config entries. Called directly rather than
   * through an intent: reading and writing a setting has no hooks to run, and
   * the settings dialog uses the same service the same way.
   */
  readonly config: Pick<
    Config,
    "getDefinitions" | "getEffective" | "getDefault" | "getSource" | "set" | "reset"
  >;
  /**
   * The registry itself, for the entry that describes it.
   *
   * A getter rather than the value because the registry is built FROM these
   * entries: the describe entry has to be able to see the finished registry it
   * is a member of. Set once during construction.
   */
  readonly registry: () => OperationRegistry;
  /** The lock table, owned by the lock module. */
  readonly locks: Locks;
  /** The user guide's markdown (docs/USER_GUIDE.md as shipped), owned by the help module. */
  readonly readUserGuide: () => Promise<string>;
  /**
   * The plugins, owned by the plugin module. A getter: that module runs
   * automations through this registry, so it is built after it.
   */
  readonly plugins: () => Plugins;
  /** The wakeup scripts, owned by the wakeup module. */
  readonly wakeups: Wakeups;
  /** The process monitor, owned by the process-monitor module. */
  readonly processes: ProcessMonitorAccess;
  /**
   * Every project type's workspace create/delete options, sealed by app:start.
   * `workspace.create` / `workspace.delete` merge them into their input.
   */
  readonly projectTypes: ProjectTypeOptions;
}
