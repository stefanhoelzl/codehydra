/**
 * CliModule — everything the `ch` binary needs in order to find and talk to this
 * CodeHydra instance.
 *
 * Three jobs, none of which belongs anywhere else:
 *
 * 1. Declare the CLI's scripts, so script-module keeps them in the bin directory
 *    alongside `code` and the agent wrappers.
 * 2. Generate the shared secret that separates a deliberate caller from any
 *    local process that guessed the plugin port.
 * 3. Publish the port and that secret into state.json, which is how `ch` finds
 *    its instance — it resolves its own path to the data directory and reads
 *    them there, needing no environment variables at all.
 *
 * `ch` is agent-agnostic, so hanging it off an agent provider would be wrong,
 * and ide-server-module owns the bin directory but has nothing to do with the
 * wire.
 */

import { randomBytes } from "node:crypto";

import type { IntentModule } from "../intents/lib/module";
import type { HookContext, HookOutput } from "../intents/lib/operation";
import { ANY_VALUE } from "../intents/lib/operation";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import type { ConfigureResult, RequiredScript } from "../intents/app-start";
import type { StateService } from "../boundaries/platform/state-service";
import { storeNumber, storeString } from "../boundaries/platform/store-definition";
import type { Logger } from "../boundaries/platform/logging-types";
import { getErrorMessage } from "../shared/error-utils";

/**
 * Capability announcing that the CLI's port and token have been published.
 *
 * Anything that needs the token — notably the agent modules, which bake it into
 * the MCP config they write — must order itself after this. Requiring only
 * `pluginPort` is not enough: both would then be satisfied at the same moment,
 * so an agent could read a token that had not been minted yet and write an MCP
 * config with an empty command and no credentials, leaving that agent with no
 * CodeHydra tools at all.
 */
export const CLI_CONNECTION_CAPABILITY = "cliConnection";

/**
 * Scripts the CLI ships.
 *
 * The two wrappers are templates: the bundled interpreter's path is baked into
 * them at sync time so `ch` runs from a shell that inherited none of CodeHydra's
 * environment. `ch.cjs` is the bundle both of them invoke.
 */
export const CLI_SCRIPTS = [
  { name: "ch", template: true },
  { name: "ch.cmd", template: true },
  "ch.cjs",
] as const;

export interface CliModuleDeps {
  readonly stateService: StateService;
  readonly logger: Logger;
}

export interface CliModuleHandle {
  readonly module: IntentModule;
  /**
   * The token CLI clients must present, or null before app:start has run.
   *
   * Read lazily by the plugin server, which is constructed before this module
   * has generated anything. Null refuses every CLI connection, which is the
   * right posture while no token exists.
   */
  token(): string | null;
}

export function createCliModule(deps: CliModuleDeps): CliModuleHandle {
  const { stateService, logger } = deps;

  // 0 means "not published": the plugin server never binds port 0, so the
  // sentinel cannot be mistaken for a real value, and storeNumber has no
  // nullable form.
  const portState = stateService.register("plugin.port", {
    default: 0,
    description: "Port the plugin server bound, published for the ch CLI (0 = not running)",
    ...storeNumber({ min: 0 }),
  });

  const tokenState = stateService.register("plugin.token", {
    default: null,
    description: "Shared secret the ch CLI presents when connecting",
    // Never leaves the machine in a bug report: possession of it is authority
    // to run every operation against this instance.
    redact: true,
    ...storeString({ nullable: true }),
  });

  let token: string | null = null;

  return {
    token: () => token,
    module: {
      name: "cli",
      hooks: {
        [APP_START_OPERATION_ID]: {
          "before-ready": {
            handler: async (): Promise<HookOutput<ConfigureResult>> => {
              return { result: { scripts: [...CLI_SCRIPTS] as RequiredScript[] } };
            },
          },

          start: {
            // The port is only known once the plugin server has bound one.
            requires: { pluginPort: ANY_VALUE },
            handler: async (ctx: HookContext): Promise<HookOutput> => {
              // Capabilities arrive on ctx.capabilities, not on the context
              // itself — the plugin server provides this one from its own start
              // hook, and `requires` above is what orders us after it.
              const pluginPort =
                (ctx.capabilities?.pluginPort as number | null | undefined) ?? null;

              if (pluginPort === null) {
                // The plugin server failed to start. Clearing the published
                // details is what stops `ch` from attempting a stale port and
                // reporting a confusing connection error instead of "not running".
                await portState.set(0);
                await tokenState.set(null);
                logger.warn("Plugin server did not start; the ch CLI will report it as offline");
                return { provides: { [CLI_CONNECTION_CAPABILITY]: true } };
              }

              // A fresh secret every launch: a token that outlived its process
              // would authorize a connection to whatever bound the port next.
              token = randomBytes(32).toString("hex");

              try {
                await portState.set(pluginPort);
                await tokenState.set(token);
                logger.debug("Published CLI connection details", { port: pluginPort });
              } catch (error) {
                // Not fatal: the app runs fine, only `ch` cannot find it.
                logger.warn("Could not publish CLI connection details", {
                  error: getErrorMessage(error),
                });
              }

              return { provides: { [CLI_CONNECTION_CAPABILITY]: true } };
            },
          },
        },

        [APP_SHUTDOWN_OPERATION_ID]: {
          stop: {
            handler: async (): Promise<void> => {
              // Withdraw the published details on the way out. A port outlives
              // the process that bound it, so leaving them behind would have
              // `ch` present this instance's token to whatever binds that port
              // next — and would make it report a connection error rather than
              // the truth, which is that CodeHydra is not running.
              token = null;
              try {
                await portState.set(0);
                await tokenState.set(null);
              } catch (error) {
                // Best-effort, like every other shutdown step: a stale entry
                // costs a confusing message, not correctness.
                logger.debug("Could not withdraw CLI connection details", {
                  error: getErrorMessage(error),
                });
              }
            },
          },
        },
      },
    },
  };
}
