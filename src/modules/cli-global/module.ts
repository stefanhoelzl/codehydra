/**
 * CliGlobalModule — the `cli.install-global` setting: `ch` in every shell.
 *
 * The setting is the single switch, whichever way it is flipped — the settings
 * dialog's checkbox, the first-run question, `ch config set`. A change installs
 * or uninstalls right away (installer.ts); at every start an enabled setting is
 * repaired quietly (the data folder moved, a file was deleted), without ever
 * showing the macOS administrator prompt.
 *
 * Only an installed build with its normal data folder installs anything: a dev
 * build or a relocated root (`_CHDEV_ROOT_DIR`, e2e) would point every shell at
 * a throwaway instance.
 */

import type { IntentModule } from "../../intents/lib/module";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import { APP_START_OPERATION_ID } from "../../intents/app-start";
import type { HookOutput } from "../../intents/lib/operation";
import { defineHooks } from "../../intents/declarations";
import type { Config } from "../../boundaries/platform/config";
import type { PersistedAccessor } from "../../boundaries/platform/store-definition";
import { storeBoolean } from "../../boundaries/platform/store-definition";
import type { Logger } from "../../boundaries/platform/logging-types";
import {
  INTENT_SHOW_NOTIFICATION,
  type ShowNotificationIntent,
} from "../../intents/show-notification";
import type { NotificationConfig } from "../../shared/notification-types";
import { getErrorMessage } from "../../shared/error-utils";
import type { GlobalCliInstaller } from "./installer";

export const INSTALL_GLOBAL_KEY = "cli.install-global";

export interface CliGlobalModuleDeps {
  readonly config: Pick<Config, "register">;
  readonly installer: Pick<GlobalCliInstaller, "install" | "uninstall">;
  /** False for a dev build or a relocated data root: nothing is installed. */
  readonly allowed: boolean;
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
  readonly logger: Logger;
}

export interface CliGlobalModuleHandle {
  readonly module: IntentModule;
  /** The setting, for the first-run question to answer. */
  readonly installGlobal: PersistedAccessor<boolean>;
  /** Settles once every change so far has been applied (tests). */
  idle(): Promise<void>;
}

export function createCliGlobalModule(deps: CliGlobalModuleDeps): CliGlobalModuleHandle {
  const { logger } = deps;

  const installGlobal = deps.config.register(INSTALL_GLOBAL_KEY, {
    default: false,
    description: "Make the ch command available in every shell, not only in CodeHydra's terminals",
    applies: "live",
    ...storeBoolean(),
  });

  // Changes run one after another: a quick on/off must uninstall after it
  // installed, not race it.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>): void => {
    queue = queue.then(work).catch((error: unknown) => {
      logger.warn("Global ch change failed", { error: getErrorMessage(error) });
    });
  };

  /** A failed change reverts the setting, so the checkbox says what is true. */
  let reverting = false;

  function notify(config: NotificationConfig): void {
    void deps.dispatcher
      .dispatch<ShowNotificationIntent>({ type: INTENT_SHOW_NOTIFICATION, payload: { config } })
      .catch((error: unknown) => {
        logger.debug("Notification failed", { error: getErrorMessage(error) });
      });
  }

  async function apply(enabled: boolean): Promise<void> {
    if (!deps.allowed) {
      notify({
        title: "ch was not installed globally",
        message: "Only an installed CodeHydra with its normal data folder installs the ch command.",
        type: "warning",
      });
      return;
    }
    try {
      if (enabled) {
        const result = await deps.installer.install({ interactive: true });
        logger.info("Installed global ch", { location: result.location });
        notify({
          title: "ch is available globally",
          message:
            result.hint ??
            `Installed at ${result.location}. Shells started from now on find the ch command.`,
          type: result.hint === undefined ? "info" : "warning",
        });
      } else {
        await deps.installer.uninstall({ interactive: true });
        logger.info("Uninstalled global ch");
        notify({ title: "ch was removed from your shells", type: "info" });
      }
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("Global ch change failed", { enabled, error: message });
      notify({
        title: enabled ? "Could not install ch globally" : "Could not remove the global ch",
        message,
        type: "error",
      });
      reverting = true;
      try {
        await installGlobal.set(!enabled);
      } finally {
        reverting = false;
      }
    }
  }

  installGlobal.onChange((enabled) => {
    if (reverting) return;
    enqueue(() => apply(enabled));
  });

  return {
    installGlobal,
    idle: () => queue,
    module: {
      name: "cli-global",
      hooks: defineHooks({
        [APP_START_OPERATION_ID]: {
          start: {
            handler: async (): Promise<HookOutput<void>> => {
              if (!deps.allowed || !installGlobal.get()) return {};
              // Not awaited: a repair (a PowerShell run on Windows) is no
              // reason to hold up startup.
              enqueue(async () => {
                try {
                  const result = await deps.installer.install({ interactive: false });
                  logger.debug("Global ch is in place", { location: result.location });
                } catch (error) {
                  // The setting stays on (a repair is retried every start), so
                  // the checkbox would claim an install that is not there: say so.
                  const message = getErrorMessage(error);
                  logger.warn("Global ch could not be repaired", { error: message });
                  notify({
                    title: "The global ch command is missing",
                    message:
                      `It could not be put back at startup: ${message} ` +
                      "Turn cli › install-global off and on again in the settings to repair it.",
                    type: "warning",
                  });
                }
              });
              return {};
            },
          },
        },
      }),
    },
  };
}
