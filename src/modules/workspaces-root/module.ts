/**
 * WorkspacesRootModule — owns where worktrees and managed clones live.
 *
 * The `paths.workspaces` state key names the root the data is under, and only a
 * migration writes it. The settings dialog shows it read-only; its Change…
 * button opens this module's dialog, which checks the new folder, confirms, then
 * records it as `paths.workspaces-pending` and restarts the app. The app:start
 * `migrations` hook settles a pending folder on the starting screen, before any
 * project is opened: managed clones move, existing workspaces stay in place and
 * stay workspaces (see migrate.ts). A failure is undone and offers Retry,
 * Continue with the current folder, or Quit. A request survives a crash, so the
 * next start runs it again.
 *
 * Two one-time moves arrive as the same request, and run without asking:
 *
 *   - Windows' data root moved (`%APPDATA%` to `%LOCALAPPDATA%`) and left the
 *     source code behind: data-root-relocation.ts records the old root as the one
 *     in use and the new data root as pending.
 *   - Earlier releases kept the wanted folder in config (`paths.workspaces`) and
 *     the one in use in state (`paths.workspaces-current`). The one in use carries
 *     over; a wanted folder that differs becomes the request.
 *
 * Once, before any of that: the external tags earlier migrations wrote become
 * recorded directories (see convert-adoptions.ts).
 */

import type { IntentModule } from "../../intents/lib/module";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import type { DomainEvent } from "../../intents/lib/types";
import type { Config } from "../../boundaries/platform/config";
import type { StateService } from "../../boundaries/platform/state-service";
import type { PathProvider } from "../../boundaries/platform/path-provider";
import type { Logger } from "../../boundaries/platform/logging";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { AppBoundary } from "../../boundaries/shell/app";
import type { DialogBoundary } from "../../boundaries/shell/dialog";
import {
  storeBoolean,
  storeCustom,
  storeFolder,
  storeString,
} from "../../boundaries/platform/store-definition";
import type { DialogConfig, DialogSection, ProgressItem } from "../../shared/dialog-types";
import { getErrorMessage } from "../../shared/errors/service-errors";
import { APP_START_OPERATION_ID } from "../../intents/app-start";
import { INTENT_APP_SHUTDOWN, type AppShutdownIntent } from "../../intents/app-shutdown";
import {
  EVENT_AGENT_STATUS_UPDATED,
  type AgentStatusUpdatedEvent,
} from "../../intents/update-agent-status";
import {
  EVENT_WORKSPACE_DELETED,
  type WorkspaceDeletedEvent,
} from "../../intents/delete-workspace";
import type { UiPresenter } from "../presentation/presentation-module";
import type { DialogHandle } from "../presentation/sessions";
import { notify } from "../presentation/notification-card";
import type { SettingsExtraRow } from "../settings-module";
import { loadAllProjects } from "../local-project-module";
import { Path } from "../../utils/path/path";
import {
  createWorkspacesRoot,
  remotesDirUnder,
  type ProjectMoveListener,
  type WorkspacesRoot,
} from "./workspaces-root";
import {
  MigrationProgress,
  migrateWorkspacesRoot,
  type MigrationDeps,
  type MigrationReport,
} from "./migrate";
import { convertMigrationAdoptions, type ConvertAdoptionsDeps } from "./convert-adoptions";

export const ROOT_STATE_KEY = "paths.workspaces";
export const PENDING_ROOT_STATE_KEY = "paths.workspaces-pending";
export const PREVIOUS_DIRS_STATE_KEY = "paths.workspaces-previous";
export const ADOPTIONS_CONVERTED_STATE_KEY = "paths.workspaces-adoptions-converted";
/** Earlier releases: the wanted folder, a setting. */
export const LEGACY_ROOT_CONFIG_KEY = "paths.workspaces";
/** Earlier releases: the folder in use. */
export const LEGACY_CURRENT_STATE_KEY = "paths.workspaces-current";

/** A list of paths, or undefined when the value is not one. */
function validatePathList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;
}

const FIELD_FOLDER = "folder";
const ACTION_BROWSE = "browse";
const ACTION_MIGRATE = "migrate";
const ACTION_CONFIRM = "confirm";
const ACTION_BACK = "back";
const ACTION_CANCEL = "cancel";
const ACTION_CONTINUE = "continue";
const ACTION_RETRY = "retry";
const ACTION_QUIT = "quit";

export interface WorkspacesRootModuleDeps {
  readonly config: Config;
  readonly stateService: StateService;
  readonly pathProvider: Pick<PathProvider, "dataPath" | "bundlePath">;
  readonly fs: MigrationDeps["fs"] & Pick<FileSystemBoundary, "realpath">;
  readonly gitClient: MigrationDeps["gitClient"] & ConvertAdoptionsDeps["gitClient"];
  readonly ui: Pick<UiPresenter, "dialog">;
  /** The folder picker of the Change dialog. */
  readonly dialog: Pick<DialogBoundary, "showDialog">;
  /** Restarts the app once a migration is requested. */
  readonly app: Pick<AppBoundary, "relaunch">;
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
  /** Owners of path-keyed state; read when a migration runs (they are built later). */
  readonly moveListeners: () => readonly ProjectMoveListener[];
  readonly logger: Logger;
}

export interface WorkspacesRootModule {
  readonly module: IntentModule;
  readonly root: WorkspacesRoot;
  /** The settings dialog's row for the root, whose Change… opens the Change dialog. */
  readonly settingsRow: SettingsExtraRow;
}

export function createWorkspacesRootModule(deps: WorkspacesRootModuleDeps): WorkspacesRootModule {
  const { config, stateService, pathProvider, fs, ui, logger } = deps;
  // The providers only resolve paths *under* their roots; a child's parent is the root.
  const dataRoot = pathProvider.dataPath("projects").dirname;
  const bundlesRoot = pathProvider.bundlePath("bin").dirname;
  const projectsDir = pathProvider.dataPath("projects").toString();

  const folder = storeFolder();
  /**
   * The data root itself is the default layout; anything inside it or inside the
   * bundles would nest source code in directories CodeHydra sweeps.
   */
  const acceptable = (value: string | null | undefined): string | null | undefined => {
    if (value === null || value === undefined) return value;
    const path = new Path(value);
    if (path.equals(dataRoot)) return value;
    if (path.isChildOf(dataRoot) || path.equals(bundlesRoot) || path.isChildOf(bundlesRoot)) {
      return undefined;
    }
    return value;
  };

  const rootInUse = stateService.register(ROOT_STATE_KEY, {
    default: null,
    description:
      "The folder worktrees and cloned repositories are under (null = the app data folder). " +
      "Changed only by a migration",
    ...storeString({ nullable: true }),
  });

  const pendingRoot = stateService.register(PENDING_ROOT_STATE_KEY, {
    default: null,
    description: "The folder to migrate to at the next start; cleared once it is settled",
    ...storeString({ nullable: true }),
  });

  const previousDirs = stateService.register(PREVIOUS_DIRS_STATE_KEY, {
    default: [] as readonly string[],
    description:
      "Workspaces directories a migration left under earlier roots; worktrees there stay workspaces",
    ...storeCustom<readonly string[]>({
      parse: (raw) => {
        try {
          return validatePathList(JSON.parse(raw));
        } catch {
          return undefined;
        }
      },
      validate: validatePathList,
    }),
  });

  const adoptionsConverted = stateService.register(ADOPTIONS_CONVERTED_STATE_KEY, {
    default: false,
    description:
      "Whether the external tags earlier migrations wrote were turned into previous workspaces directories",
    ...storeBoolean(),
  });

  const legacyConfigured = config.register(LEGACY_ROOT_CONFIG_KEY, {
    default: null,
    deprecated: true,
    description: "The workspaces folder, from when it was a setting (becomes a migration at start)",
    ...storeCustom<string | null>({
      parse: (raw) => acceptable(folder.parse(raw)),
      validate: (value) => acceptable(folder.validate(value)),
    }),
  });

  const legacyCurrent = stateService.register(LEGACY_CURRENT_STATE_KEY, {
    default: null,
    deprecated: true,
    description: "The workspaces folder in use, from before it moved to paths.workspaces",
    ...storeString({ nullable: true }),
  });

  const rootFrom = (value: string | null): Path => (value === null ? dataRoot : new Path(value));
  /** How a root is stored: null for the data root. */
  const stored = (path: Path): string | null => (path.equals(dataRoot) ? null : path.toNative());
  const root = createWorkspacesRoot(
    () => rootFrom(rootInUse.get()),
    () => previousDirs.get().map((dir) => new Path(dir))
  );

  // ---------------------------------------------------------------------------
  // Agent activity, for the confirmation
  // ---------------------------------------------------------------------------

  /** Names of the workspaces whose agents are working, by workspace path. */
  const busy = new Map<string, string>();

  // ---------------------------------------------------------------------------
  // Checks on the new folder
  // ---------------------------------------------------------------------------

  /** Why the folder cannot be used, or null. Creates it when missing. */
  async function problemWith(target: Path): Promise<string | null> {
    const projects = await loadAllProjects(fs, {
      projectsDir,
      remotesDir: remotesDirUnder(root.current()).toString(),
    });
    const inside = projects.find(
      ({ config: project }) =>
        target.equals(project.path) || target.isChildOf(new Path(project.path))
    );
    if (inside) return `It is inside the project ${inside.config.path}.`;

    try {
      await fs.mkdir(target);
      const probe = new Path(target, ".codehydra-write-test");
      await fs.writeFile(probe, "");
      await fs.unlink(probe);
    } catch (error) {
      return `It cannot be created or written to: ${getErrorMessage(error)}`;
    }
    if (!(await isEmpty(target))) return "It is not empty.";
    return null;
  }

  /**
   * Whether migrating would write into anything already there. Migration writes
   * only `remotes/`, but a folder the user picked should be one we own: any
   * content counts. The data root is never empty, so there only `remotes/` does.
   */
  async function isEmpty(target: Path): Promise<boolean> {
    const dir = target.equals(dataRoot) ? remotesDirUnder(target) : target;
    try {
      return (await fs.readdir(dir)).length === 0;
    } catch {
      return true; // does not exist
    }
  }

  /**
   * The folder as git will report paths under it: symlinks and junctions
   * resolved. A worktree created under an unresolved root would not lie inside it
   * once git names it, and discovery would skip it as unmanaged. Creates the
   * folder, since only an existing one resolves.
   */
  async function resolveFolder(folder: Path): Promise<Path | { problem: string }> {
    try {
      await fs.mkdir(folder);
      return await fs.realpath(folder);
    } catch (error) {
      return { problem: `It cannot be created: ${getErrorMessage(error)}` };
    }
  }

  /** The folder to migrate to, or why it cannot be one. Resolved, checked, created. */
  async function checkTarget(to: Path): Promise<Path | { problem: string }> {
    const resolved = await resolveFolder(to);
    if (!(resolved instanceof Path)) return resolved;
    if (resolved.equals(root.current())) return { problem: "It is the folder in use." };
    const problem = await problemWith(resolved);
    return problem === null ? resolved : { problem };
  }

  // ---------------------------------------------------------------------------
  // Dialog pieces
  // ---------------------------------------------------------------------------

  function buttons(
    items: { id: string; label: string; primary?: boolean; cancel?: boolean }[],
    reverse = false
  ): DialogSection {
    return {
      type: "group",
      ...(reverse && { reverse: true }),
      items: items.map((item) => ({
        type: "button" as const,
        id: item.id,
        label: item.label,
        variant: item.primary === true ? ("primary" as const) : ("secondary" as const),
        ...(item.cancel === true && { role: "cancel" as const }),
      })),
    };
  }

  function header(heading: string, from: Path, to: Path): DialogSection[] {
    return [
      { type: "text", content: heading, style: "heading" },
      { type: "text", content: `From ${from.toNative()}`, style: "subtitle" },
      { type: "text", content: `To ${to.toNative()}`, style: "subtitle" },
    ];
  }

  // ---------------------------------------------------------------------------
  // Change dialog: pick, check, confirm, restart
  // ---------------------------------------------------------------------------

  let changeHandle: DialogHandle | null = null;

  function changeConfig(value: string, error?: string): DialogConfig {
    const current = root.current();
    return {
      sections: [
        { type: "text", content: "Move the workspaces folder", style: "heading" },
        {
          type: "text",
          content: current.equals(dataRoot)
            ? `In use: the app data folder, ${current.toNative()}`
            : `In use: ${current.toNative()}`,
          style: "subtitle",
        },
        {
          type: "group",
          items: [
            {
              type: "input",
              id: FIELD_FOLDER,
              value,
              placeholder: "Empty = the app data folder",
              autofocus: true,
              ...(error !== undefined && { error }),
            },
            {
              type: "button",
              id: ACTION_BROWSE,
              label: "Browse…",
              icon: "folder",
              variant: "secondary",
            },
          ],
        },
        {
          type: "text",
          content:
            "Migrate restarts CodeHydra and moves your cloned repositories to the new folder " +
            "before anything opens. It must be empty. Existing workspaces stay where they are " +
            "and remain in the sidebar; new workspaces are created in the new folder.",
        },
        buttons(
          [
            { id: ACTION_MIGRATE, label: "Migrate…", primary: true },
            { id: ACTION_CANCEL, label: "Cancel", cancel: true },
          ],
          true
        ),
      ],
    };
  }

  function confirmConfig(to: Path): DialogConfig {
    const from = root.current();
    const working = [...busy.values()].sort();
    return {
      sections: [
        ...header("Migrate and restart?", from, to),
        {
          type: "text",
          content:
            "CodeHydra closes and restarts, then moves your cloned repositories before " +
            `anything opens. Existing workspaces stay in ${from.toNative()} with their agent ` +
            "conversations and editor state.",
        },
        ...(working.length > 0
          ? [
              {
                type: "text" as const,
                content: `Agents are still working in ${working.join(", ")}. The restart interrupts them.`,
                style: "warning" as const,
              },
            ]
          : []),
        {
          type: "text",
          content: "Settings, logs and downloaded tools stay in the app data folder.",
          style: "subtitle",
        },
        buttons(
          [
            { id: ACTION_CONFIRM, label: "Migrate and restart", primary: true },
            { id: ACTION_BACK, label: "Back" },
            { id: ACTION_CANCEL, label: "Cancel", cancel: true },
          ],
          true
        ),
      ],
    };
  }

  /** The folder a field value names, or why it names none. Empty = the data root. */
  function parseFolder(value: string): Path | { problem: string } {
    const trimmed = value.trim();
    if (trimmed === "") return dataRoot;
    const native = folder.validate(trimmed);
    if (native === undefined || native === null) return { problem: "Enter an absolute path." };
    if (acceptable(native) === undefined) {
      return { problem: "It is inside the app's own folders." };
    }
    return new Path(native);
  }

  function openChangeDialog(): void {
    if (changeHandle) return;
    const initial = rootInUse.get() ?? "";
    const handle = ui.dialog(changeConfig(initial), { kind: "modal" });
    changeHandle = handle;
    let checking = false;
    /** The folder confirmed for, while the confirmation shows. */
    let confirming: Path | null = null;
    /** The field's text, kept across the confirmation and a Browse. */
    let value = initial;

    const close = (): void => {
      handle.close();
      changeHandle = null;
    };

    handle.onEvent((event) => {
      if (event.actionId === ACTION_CANCEL) {
        close();
        return;
      }
      if (event.actionId === ACTION_BACK) {
        confirming = null;
        handle.update(changeConfig(value));
        return;
      }
      if (event.actionId === ACTION_BROWSE) {
        value = event.data?.[FIELD_FOLDER] ?? value;
        void (async () => {
          const result = await deps.dialog.showDialog({
            properties: ["openDirectory", "createDirectory"],
            ...(value.trim() !== "" && { defaultPath: value.trim() }),
          });
          if (result.canceled || result.filePaths.length === 0) return;
          value = result.filePaths[0]!.toNative();
          handle.update(changeConfig(value));
        })();
        return;
      }
      if (event.actionId === ACTION_MIGRATE && !checking) {
        value = event.data?.[FIELD_FOLDER] ?? value;
        checking = true;
        void (async () => {
          try {
            const parsed = parseFolder(value);
            const target = parsed instanceof Path ? await checkTarget(parsed) : parsed;
            if (!(target instanceof Path)) {
              handle.update(changeConfig(value, `This folder cannot be used. ${target.problem}`));
              return;
            }
            confirming = target;
            handle.update(confirmConfig(target));
          } finally {
            checking = false;
          }
        })();
        return;
      }
      if (event.actionId === ACTION_CONFIRM && confirming !== null) {
        const to = confirming;
        void (async () => {
          logger.info("Workspaces root migration requested", { to: to.toString() });
          await pendingRoot.set(to.toNative());
          deps.app.relaunch();
        })();
      }
    });

    void handle.closed.then(() => {
      if (changeHandle === handle) changeHandle = null;
    });
  }

  const settingsRow: SettingsExtraRow = {
    key: ROOT_STATE_KEY,
    description:
      "Folder for workspaces (git worktrees) and cloned repositories, e.g. a Windows Dev " +
      "Drive. Change… moves the cloned repositories there and restarts; existing workspaces " +
      "stay where they are",
    value: () => rootInUse.get() ?? `${dataRoot.toNative()} (app data folder)`,
    action: { label: "Change…", icon: "folder", run: openChangeDialog },
  };

  // ---------------------------------------------------------------------------
  // Startup: settle a pending folder
  // ---------------------------------------------------------------------------

  /** Quit, and never return: startup must not go on while the app shuts down. */
  async function quit(): Promise<never> {
    void deps.dispatcher
      .dispatch<AppShutdownIntent>({ type: INTENT_APP_SHUTDOWN, payload: {} })
      .catch((error: unknown) => {
        logger.debug("app:shutdown dispatch rejected", { error: getErrorMessage(error) });
      });
    return new Promise<never>(() => {});
  }

  /** Add workspaces directories to the recorded previous ones. */
  async function recordPreviousDirs(dirs: readonly Path[]): Promise<void> {
    const known = previousDirs.get().map((dir) => new Path(dir));
    const added = dirs.filter((dir) => !known.some((other) => other.equals(dir)));
    if (added.length > 0) {
      await previousDirs.set([...previousDirs.get(), ...added.map((dir) => dir.toString())]);
    }
  }

  /** Record the directories a migration left behind, switch to `to`, drop the request. */
  async function commitMigration(to: Path, left: readonly Path[]): Promise<void> {
    await recordPreviousDirs(left);
    await rootInUse.set(stored(to));
    await pendingRoot.reset();
  }

  /** A string value of a deprecated key, or null. */
  function legacyValue(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
  }

  /** Carry the keys of earlier releases over, once: they are reset after. */
  async function convertLegacyKeys(): Promise<void> {
    const configured = legacyValue(legacyConfigured.get());
    const inUse = legacyValue(legacyCurrent.get());
    if (configured === null && inUse === null) return;

    if (inUse !== null) await rootInUse.set(stored(new Path(inUse)));
    // A change of the setting that was never applied; null there meant the data root.
    const wanted = rootFrom(configured);
    if (!wanted.equals(root.current()) && pendingRoot.get() === null) {
      await pendingRoot.set(wanted.toNative());
    }
    logger.info("Converted the workspaces folder of an earlier release", {
      inUse: root.current().toString(),
      pending: pendingRoot.get(),
    });
    await legacyConfigured.reset();
    await legacyCurrent.reset();
  }

  /** Turn the external tags earlier migrations wrote into recorded directories, once. */
  async function convertAdoptions(): Promise<void> {
    if (adoptionsConverted.get()) return;
    try {
      const projects = await loadAllProjects(fs, {
        projectsDir,
        remotesDir: root.remotesDir().toString(),
      });
      const converted = await convertMigrationAdoptions(
        { gitClient: deps.gitClient, logger },
        projects.map(({ config: project }) => new Path(project.path)),
        recordPreviousDirs
      );
      if (converted.length > 0) {
        logger.info("Converted migration adoptions", { count: converted.length });
      }
      await adoptionsConverted.set(true);
    } catch (error) {
      // The tags still keep those worktrees; the next start tries again.
      logger.warn("Could not convert migration adoptions", { error: getErrorMessage(error) });
    }
  }

  function report(result: MigrationReport, to: Path): void {
    const lines: string[] = [];
    if (result.leftovers.length > 0) {
      lines.push(`Old clones that could not be deleted: ${result.leftovers.join(", ")}`);
    }
    lines.push(...result.warnings);
    if (lines.length === 0) return;
    notify(deps.dispatcher, {
      type: "warning",
      title: `Moved to ${to.toNative()}, with problems`,
      message: lines.join("\n"),
      dismissible: true,
    });
  }

  const HEADING = "Moving the workspaces folder";

  function failureConfig(
    from: Path,
    to: Path,
    message: string,
    items?: readonly ProgressItem[]
  ): DialogConfig {
    return {
      sections: [
        ...header(HEADING, from, to),
        ...(items ? [{ type: "progress" as const, style: "bar" as const, items: [...items] }] : []),
        { type: "text", content: message, style: "error" },
        buttons([
          { id: ACTION_RETRY, label: "Retry", primary: true },
          { id: ACTION_CONTINUE, label: "Continue with current folder" },
          { id: ACTION_QUIT, label: "Quit" },
        ]),
      ],
    };
  }

  /** Run the pending migration, until it succeeds or the user stops trying. */
  async function settle(): Promise<void> {
    const requested = pendingRoot.get();
    if (requested === null) return;
    const from = root.current();
    const wanted = new Path(requested);
    // Nothing to move: a request that names the folder in use, maybe through a symlink.
    const first = wanted.equals(from) ? from : await resolveFolder(wanted);
    if (first instanceof Path && first.equals(from)) {
      await pendingRoot.reset();
      return;
    }

    logger.info("Migrating the workspaces root", {
      from: from.toString(),
      to: wanted.toString(),
    });
    const handle = ui.dialog({ sections: header(HEADING, from, wanted) }, { kind: "modal" });
    try {
      for (let resolved = first; ; resolved = await resolveFolder(wanted)) {
        const to = resolved instanceof Path ? resolved : wanted;
        const problem = resolved instanceof Path ? await problemWith(to) : resolved.problem;

        let failure: { message: string; items?: readonly ProgressItem[] };
        if (problem !== null) {
          failure = { message: `The new folder cannot be used. ${problem}` };
        } else {
          let items: readonly ProgressItem[] = [];
          const progress = new MigrationProgress((next) => {
            items = next;
            handle.update({
              sections: [
                ...header(HEADING, from, to),
                { type: "progress", style: "bar", items: [...next] },
              ],
            });
          });
          try {
            const result = await migrateWorkspacesRoot(
              {
                fs,
                gitClient: deps.gitClient,
                projectsDir,
                screenshotsDir: pathProvider.dataPath("screenshots"),
                moveListeners: deps.moveListeners(),
                commit: (left) => commitMigration(to, left),
                logger,
              },
              from,
              to,
              progress
            );
            report(result, to);
            return;
          } catch (error) {
            logger.warn("Workspaces root migration failed", { error: getErrorMessage(error) });
            failure = {
              message: `Migration failed and was undone: ${getErrorMessage(error)}`,
              items,
            };
          }
        }

        handle.update(failureConfig(from, to, failure.message, failure.items));
        const action = await nextAction(handle);
        if (action === ACTION_QUIT) await quit();
        if (action === ACTION_CONTINUE) {
          await pendingRoot.reset();
          return;
        }
      }
    } finally {
      handle.close();
    }
  }

  const module: IntentModule = {
    name: "workspaces-root",
    hooks: {
      [APP_START_OPERATION_ID]: {
        migrations: {
          handler: async (): Promise<void> => {
            await convertLegacyKeys();
            await convertAdoptions();
            await settle();
          },
        },
      },
    },
    events: {
      [EVENT_AGENT_STATUS_UPDATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { workspace, status } = (event as AgentStatusUpdatedEvent).payload;
          if (status.status === "busy" || status.status === "mixed") {
            busy.set(workspace.path, workspace.name);
          } else {
            busy.delete(workspace.path);
          }
        },
      },
      [EVENT_WORKSPACE_DELETED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          busy.delete((event as WorkspaceDeletedEvent).payload.workspacePath);
        },
      },
    },
  };

  return { module, root, settingsRow };
}

/** The id of the next button pressed. Escape (no cancel button here) is ignored. */
async function nextAction(handle: DialogHandle): Promise<string> {
  for (;;) {
    const event = await handle.nextEvent();
    if (event.kind !== "dismiss") return event.actionId;
  }
}
