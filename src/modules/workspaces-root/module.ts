/**
 * WorkspacesRootModule — owns where worktrees and managed clones live.
 *
 * Two values: the `paths.workspaces` config key (what the user wants) and the
 * `workspaces.current-root` state key (what the data on disk is actually under).
 * They differ only after the user changed the setting. The app:start
 * `migrations` hook settles that before any project is opened, on the starting
 * screen:
 *
 *   - Migrate: move the managed clones there and keep existing workspaces in
 *     place (see migrate.ts). Offered only when the new folder is empty.
 *   - Use as is: switch to the new folder without moving anything; worktrees
 *     under the old one are no longer workspaces (they stay on disk).
 *   - Quit.
 *
 * A folder that cannot be used (not creatable, not writable, inside a project)
 * offers Continue with the current folder instead of Migrate / Use as is. The
 * setting stays as the user left it, so the question returns at the next start.
 */

import type { IntentModule } from "../../intents/lib/module";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import type { Config } from "../../boundaries/platform/config";
import type { StateService } from "../../boundaries/platform/state-service";
import type { PathProvider } from "../../boundaries/platform/path-provider";
import type { Logger } from "../../boundaries/platform/logging";
import { storeFolder, storeString } from "../../boundaries/platform/store-definition";
import type { DialogConfig, DialogSection, ProgressItem } from "../../shared/dialog-types";
import { getErrorMessage } from "../../shared/errors/service-errors";
import { APP_START_OPERATION_ID } from "../../intents/app-start";
import { INTENT_APP_SHUTDOWN, type AppShutdownIntent } from "../../intents/app-shutdown";
import type { UiPresenter } from "../presentation/presentation-module";
import type { DialogHandle } from "../presentation/sessions";
import { notify } from "../presentation/notification-card";
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

export const WORKSPACES_ROOT_KEY = "paths.workspaces";
export const CURRENT_ROOT_STATE_KEY = "workspaces.current-root";

const ACTION_MIGRATE = "migrate";
const ACTION_ADOPT = "adopt";
const ACTION_CONTINUE = "continue";
const ACTION_RETRY = "retry";
const ACTION_QUIT = "quit";

export interface WorkspacesRootModuleDeps {
  readonly config: Config;
  readonly stateService: StateService;
  readonly pathProvider: Pick<PathProvider, "dataPath" | "bundlePath">;
  readonly fs: MigrationDeps["fs"];
  readonly gitClient: MigrationDeps["gitClient"];
  readonly adopt: MigrationDeps["adopt"];
  readonly ui: Pick<UiPresenter, "dialog">;
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
  /** Owners of path-keyed state; read when a migration runs (they are built later). */
  readonly moveListeners: () => readonly ProjectMoveListener[];
  readonly logger: Logger;
}

export interface WorkspacesRootModule {
  readonly module: IntentModule;
  readonly root: WorkspacesRoot;
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

  const configuredRoot = config.register(WORKSPACES_ROOT_KEY, {
    default: null,
    description:
      "Folder for workspaces (git worktrees) and cloned repositories, e.g. a Windows Dev Drive. " +
      "Empty = the app data folder. Changing it asks at the next start whether to move " +
      "cloned repositories there",
    applies: "restart",
    ...folder,
    parse: (raw: string) => acceptable(folder.parse(raw)),
    validate: (value: unknown) => acceptable(folder.validate(value)),
    validValues: "<absolute folder path outside the app data folder>",
  });

  const currentRoot = stateService.register(CURRENT_ROOT_STATE_KEY, {
    default: null,
    description: "The workspaces root the data on disk is under (null = the app data folder)",
    ...storeString({ nullable: true }),
  });

  const rootFrom = (value: string | null): Path => (value === null ? dataRoot : new Path(value));
  const root = createWorkspacesRoot(() => rootFrom(currentRoot.get()));

  // ---------------------------------------------------------------------------
  // Checks on the new folder
  // ---------------------------------------------------------------------------

  /** Why the folder cannot be used, or null. Creates it when missing. */
  async function problemWith(target: Path): Promise<string | null> {
    const stored = await loadAllProjects(fs, {
      projectsDir,
      remotesDir: remotesDirUnder(root.current()).toString(),
    });
    const inside = stored.find(
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

  // ---------------------------------------------------------------------------
  // Dialog
  // ---------------------------------------------------------------------------

  function buttons(
    items: { id: string; label: string; primary?: boolean; disabled?: boolean }[]
  ): DialogSection {
    return {
      type: "group",
      items: items.map((item) => ({
        type: "button" as const,
        id: item.id,
        label: item.label,
        variant: item.primary === true ? ("primary" as const) : ("secondary" as const),
        ...(item.disabled === true && { disabled: true }),
      })),
    };
  }

  function header(from: Path, to: Path): DialogSection[] {
    return [
      { type: "text", content: "The workspaces folder changed", style: "heading" },
      { type: "text", content: `From ${from.toNative()}`, style: "subtitle" },
      { type: "text", content: `To ${to.toNative()}`, style: "subtitle" },
    ];
  }

  function choiceConfig(from: Path, to: Path, empty: boolean): DialogConfig {
    return {
      sections: [
        ...header(from, to),
        {
          type: "text",
          content:
            "Migrate moves cloned repositories to the new folder. Existing workspaces stay " +
            "where they are and keep working; new workspaces are created in the new folder.",
        },
        empty
          ? {
              type: "text",
              content:
                "Agent conversations and editor state of existing workspaces are unaffected.",
            }
          : {
              type: "text",
              content: "Migrate needs an empty folder, and this one is not.",
              style: "warning",
            },
        {
          type: "text",
          content:
            "Use as is switches to the new folder without moving anything: workspaces in the " +
            "old folder stay on disk but are no longer listed.",
        },
        buttons([
          { id: ACTION_MIGRATE, label: "Migrate", primary: true, disabled: !empty },
          { id: ACTION_ADOPT, label: "Use as is" },
          { id: ACTION_QUIT, label: "Quit" },
        ]),
      ],
    };
  }

  function problemConfig(from: Path, to: Path, problem: string): DialogConfig {
    return {
      sections: [
        ...header(from, to),
        { type: "text", content: `The new folder cannot be used. ${problem}`, style: "error" },
        {
          type: "text",
          content: "Change the setting, or continue with the current folder for now.",
        },
        buttons([
          { id: ACTION_CONTINUE, label: "Continue with current folder", primary: true },
          { id: ACTION_QUIT, label: "Quit" },
        ]),
      ],
    };
  }

  function progressConfig(
    from: Path,
    to: Path,
    items: readonly ProgressItem[],
    failure?: string
  ): DialogConfig {
    const sections: DialogSection[] = [
      ...header(from, to),
      { type: "progress", style: "bar", items: [...items] },
    ];
    if (failure !== undefined) {
      sections.push(
        {
          type: "text",
          content: `Migration failed and was undone: ${failure}`,
          style: "error",
        },
        buttons([
          { id: ACTION_RETRY, label: "Retry", primary: true },
          { id: ACTION_CONTINUE, label: "Continue with current folder" },
          { id: ACTION_QUIT, label: "Quit" },
        ])
      );
    }
    return { sections };
  }

  // ---------------------------------------------------------------------------
  // Flow
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

  async function useRoot(target: Path): Promise<void> {
    await currentRoot.set(target.equals(dataRoot) ? null : target.toNative());
  }

  function report(result: MigrationReport, to: Path): void {
    const lines: string[] = [];
    if (result.notKept.length > 0) {
      lines.push(
        `Not kept as workspaces (detached HEAD, still on disk): ${result.notKept.join(", ")}`
      );
    }
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

  async function settle(): Promise<void> {
    const configured = configuredRoot.get();
    const from = root.current();
    const to = rootFrom(configured);
    if (to.equals(from)) return;

    logger.info("Workspaces root changed", { from: from.toString(), to: to.toString() });
    const handle = ui.dialog({ sections: header(from, to) }, { kind: "modal" });
    try {
      const problem = await problemWith(to);
      if (problem !== null) {
        handle.update(problemConfig(from, to, problem));
        const action = await nextAction(handle);
        if (action === ACTION_QUIT) await quit();
        return; // continue with the current folder
      }

      handle.update(choiceConfig(from, to, await isEmpty(to)));
      const choice = await nextAction(handle);
      if (choice === ACTION_QUIT) await quit();
      if (choice === ACTION_ADOPT) {
        await useRoot(to);
        return;
      }

      // Migrate, until it succeeds or the user stops trying.
      for (;;) {
        let items: readonly ProgressItem[] = [];
        const progress = new MigrationProgress((next) => {
          items = next;
          handle.update(progressConfig(from, to, next));
        });
        try {
          const result = await migrateWorkspacesRoot(
            {
              fs,
              gitClient: deps.gitClient,
              adopt: deps.adopt,
              projectsDir,
              screenshotsDir: pathProvider.dataPath("screenshots"),
              moveListeners: deps.moveListeners(),
              commit: () => useRoot(to),
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
          handle.update(progressConfig(from, to, items, getErrorMessage(error)));
          const action = await nextAction(handle);
          if (action === ACTION_QUIT) await quit();
          if (action === ACTION_CONTINUE) return;
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
            await settle();
          },
        },
      },
    },
  };

  return { module, root };
}

/** The id of the next button pressed. Escape (no cancel button here) is ignored. */
async function nextAction(handle: DialogHandle): Promise<string> {
  for (;;) {
    const event = await handle.nextEvent();
    if (event.kind !== "dismiss") return event.actionId;
  }
}
