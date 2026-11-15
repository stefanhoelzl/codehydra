/**
 * CliModule — everything the `ch` binary needs in order to find and talk to this
 * CodeHydra instance.
 *
 * Three jobs, none of which belongs anywhere else:
 *
 * 1. Declare the CLI's scripts, so script-module keeps them in the bin directory
 *    alongside `code` and the agent wrappers.
 * 2. Generate the shared secret that separates a deliberate caller from any
 *    local process that guessed the API server port.
 * 3. Publish the port and that secret in `session.json`, which is how `ch` finds
 *    its instance — it resolves its own path to the data directory and reads
 *    them there, needing no environment variables at all.
 *
 * `ch` is agent-agnostic, so hanging it off an agent provider would be wrong,
 * and ide-server-module owns the bin directory but has nothing to do with the
 * wire.
 */

import { randomBytes } from "node:crypto";

import type { IntentModule } from "../intents/lib/module";
import type { HookOutput } from "../intents/lib/operation";
import { ANY_VALUE } from "../intents/lib/operation";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import type { ConfigureResult, RequiredScript } from "../intents/app-start";
import type { StateService } from "../boundaries/platform/state-service";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import { storeNumber, storeString } from "../boundaries/platform/store-definition";
import type { Logger } from "../boundaries/platform/logging-types";
import { FileSystemError } from "../shared/errors/service-errors";
import { getErrorMessage } from "../shared/error-utils";
import { defineHooks } from "../intents/declarations";
import { Path } from "../utils/path/path";
import type { SessionFile } from "../cli/discovery";

/**
 * Capability announcing that the CLI's port and token have been published.
 *
 * Anything that needs the token — notably the agent modules, which bake it into
 * the MCP config they write — must order itself after this. Requiring only
 * `apiPort` is not enough: both would then be satisfied at the same moment,
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
  readonly fileSystem: FileSystemBoundary;
  /** `<dataRoot>/session.json` (`SESSION_FILE`), where `ch` looks for this instance. */
  readonly sessionPath: Path;
  /** This app's process id, recorded so `ch` can tell a crashed launch's file from a live one. */
  readonly pid: number;
  readonly logger: Logger;
}

export interface CliModuleHandle {
  readonly module: IntentModule;
  /**
   * The token CLI clients must present, or null before app:start has run.
   *
   * Read lazily by the API server, which is constructed before this module
   * has generated anything. Null refuses every CLI connection, which is the
   * right posture while no token exists.
   */
  token(): string | null;
}

export function createCliModule(deps: CliModuleDeps): CliModuleHandle {
  const { stateService, fileSystem, sessionPath, pid, logger } = deps;

  // Where the connection lived before session.json. Still registered, read-only,
  // only so a state.json written by an earlier release can be stripped of them.
  const legacyPort = stateService.register("api.port", {
    default: 0,
    deprecated: true,
    description: "Port the API server bound, from before it moved to session.json",
    ...storeNumber({ min: 0 }),
  });
  const legacyToken = stateService.register("api.token", {
    default: null,
    deprecated: true,
    description: "Shared secret for the ch CLI, from before it moved to session.json",
    redact: true,
    ...storeString({ nullable: true }),
  });

  let token: string | null = null;

  /**
   * Publish the connection in one write: beside the file, then renamed over it,
   * so a reader sees no file or a whole one — never a port without its token.
   * After a clean shutdown there is no file to rename over, so no reader can
   * be holding it open.
   */
  async function publish(session: SessionFile): Promise<void> {
    const tempPath = new Path(sessionPath.dirname, `${sessionPath.basename}.tmp`);
    await fileSystem.writeFile(tempPath, JSON.stringify(session, null, 2));
    await fileSystem.rename(tempPath, sessionPath);
  }

  /** Withdraw the published connection; nothing to withdraw is not a failure. */
  async function withdraw(): Promise<void> {
    try {
      await fileSystem.unlink(sessionPath);
    } catch (error) {
      if (error instanceof FileSystemError && error.fsCode === "ENOENT") return;
      throw error;
    }
  }

  return {
    token: () => token,
    module: {
      name: "cli",
      hooks: defineHooks({
        [APP_START_OPERATION_ID]: {
          "before-ready": {
            handler: async (): Promise<HookOutput<ConfigureResult>> => {
              return { result: { scripts: [...CLI_SCRIPTS] as RequiredScript[] } };
            },
          },

          migrations: {
            handler: async (): Promise<void> => {
              // Each reset rewrites state.json, so only when there is
              // something to strip — not on every start. Best-effort: a
              // failed migration aborts startup, and leftover keys are inert.
              try {
                if (legacyPort.get() !== 0) await legacyPort.reset();
                if (legacyToken.get() !== null) await legacyToken.reset();
              } catch (error) {
                logger.warn("Could not remove the old CLI connection keys from state.json", {
                  error: getErrorMessage(error),
                });
              }
            },
          },

          start: {
            // The port is only known once the API server has bound one.
            requires: { apiPort: ANY_VALUE },
            handler: async (ctx): Promise<HookOutput<void>> => {
              // Capabilities arrive on ctx.capabilities, not on the context
              // itself — the API server provides this one from its own start
              // hook, and `requires` above is what orders us after it.
              const apiPort = (ctx.capabilities?.apiPort as number | null | undefined) ?? null;

              if (apiPort === null) {
                // The API server failed to start. Removing a file a crashed
                // launch left behind is what stops `ch` from attempting a
                // stale port and reporting a confusing connection error
                // instead of "not running".
                try {
                  await withdraw();
                } catch (error) {
                  logger.warn("Could not remove a stale session file", {
                    error: getErrorMessage(error),
                  });
                }
                logger.warn("API server did not start; the ch CLI will report it as offline");
                return { provides: { [CLI_CONNECTION_CAPABILITY]: true } };
              }

              // A fresh secret every launch: a token that outlived its process
              // would authorize a connection to whatever bound the port next.
              token = randomBytes(32).toString("hex");

              try {
                await publish({ port: apiPort, token, pid });
                logger.debug("Published CLI connection details", { port: apiPort });
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
              // Best-effort, like every other stop handler: the dispatcher logs a
              // failure, and `ch` still checks the recorded pid.
              token = null;
              await withdraw();
            },
          },
        },
      }),
    },
  };
}
