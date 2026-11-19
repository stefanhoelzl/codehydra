/**
 * SecretsModule — a password manager's secrets in what runs for a repository.
 *
 * Password managers ship a CLI that starts a command with the secrets added to
 * its environment: `op run --env-file .env.tpl -- <cmd>`, `doppler run --
 * <cmd>`, … The user picks one in `secrets.command` (a preset or a custom
 * command line). Which secrets apply is the repository's business: the command
 * reads a template file in the worktree, or names the vault by
 * `${CH_GIT_SERVER}` / `${CH_GIT_PROJECT}`, the repository's origin.
 *
 * To learn what the manager injects, CodeHydra runs `<command> <itself as
 * Node, printing its environment>` and keeps the variables that differ from
 * what it passed in. The environment is printed base64-encoded, so a manager
 * that conceals secret values in its child's output (1Password does) does not
 * conceal them here.
 *
 * Nothing is cached: every caller resolves afresh — a workspace open (also a
 * wake and the reopen at startup), every automation run, every wakeup-script
 * poll, a deletion's hooks. Callers that run several scripts for one occasion
 * pass a `share` object (the open's intent) and get one resolution between
 * them, dropped with that object.
 *
 * Without an `origin` remote there is no repository to resolve for: neither
 * the variables nor any secrets, and no error. A failing manager adds nothing
 * and raises an error card; the workspace still opens and the script still
 * runs. A caller that repeats every tick passes a `repeatKey`, so only the
 * first failure in a row is shown.
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookOutput } from "../intents/lib/operation";
import type { Dispatcher } from "../intents/lib/dispatcher";
import { OPEN_WORKSPACE_OPERATION_ID, type PrepareHookResult } from "../intents/open-workspace";
import { defineHooks } from "../intents/declarations";
import type { Config } from "../boundaries/platform/config";
import { storeCustom, type SettingsOption } from "../boundaries/platform/store-definition";
import type { Logger } from "../boundaries/platform/logging";
import type { ProcessRunner } from "../boundaries/platform/process";
import type { IGitClient } from "../boundaries/platform/git-client";
import { Path } from "../utils/path/path";
import { CommandLineError, splitCommandLine } from "../utils/command-line";
import { gitServerProject } from "../utils/url-utils";
import { getErrorMessage } from "../shared/error-utils";
import { notify } from "./presentation/notification-card";

/** The repository's server (host, with a non-default port), e.g. `github.com`. */
export const GIT_SERVER_ENV_VAR = "CH_GIT_SERVER";
/** The repository's path on its server, e.g. `org/repo`. */
export const GIT_PROJECT_ENV_VAR = "CH_GIT_PROJECT";

/**
 * The password managers offered in the settings dialog. Each value is the
 * command line the command to run is appended to.
 */
export const SECRETS_PRESETS: readonly SettingsOption[] = [
  { label: "1Password", value: "op run --env-file .env.tpl --" },
  { label: "Bitwarden Secrets Manager", value: "bws run --" },
  { label: "Doppler", value: "doppler run --" },
  { label: "Infisical", value: "infisical run --" },
  { label: "Keeper Secrets Manager", value: "ksm exec --" },
  {
    label: "Heylogin",
    value: `uvx heyl --project heyl://\${${GIT_SERVER_ENV_VAR}}/\${${GIT_PROJECT_ENV_VAR}}`,
  },
];

/** How long a manager may take, unlock prompts included. */
export const SECRETS_TIMEOUT_MS = 120_000;

/** Frames the printed environment, so other output around it is ignored. */
const ENV_MARK = "<<CH-ENV>>";
/** Run by CodeHydra's own executable as Node: prints its environment, base64 JSON. */
const PRINT_ENV_SCRIPT =
  `process.stdout.write('${ENV_MARK}'+` +
  `Buffer.from(JSON.stringify(process.env)).toString('base64')+'${ENV_MARK}')`;
/** Makes Electron's executable run as plain Node. */
const RUN_AS_NODE_ENV_VAR = "ELECTRON_RUN_AS_NODE";
/** CodeHydra's own variables: never taken from a manager. */
const RESERVED_ENV_PREFIX = "_CH_";
/** Most of a manager's error output a card shows. */
const MAX_REASON_LENGTH = 600;

/** What a resolution is for. */
export interface SecretsTarget {
  /** The repository whose `origin` names it. */
  readonly projectPath: string;
  /** Where the manager runs: the worktree, or the default branch's checkout. */
  readonly cwd: string;
  /** Names the target in an error card: `workspace "feature-x"`. */
  readonly label: string;
}

export interface SecretsResolveOptions {
  /** Callers passing the same object share one resolution while it lives. */
  readonly share?: object;
  /** Identifies a caller that repeats (a poll job): only its first failure in a row is shown. */
  readonly repeatKey?: string;
}

/** The secrets (and repository variables) for something about to run. */
export interface SecretsProvider {
  /**
   * `CH_GIT_SERVER`, `CH_GIT_PROJECT` and the secrets the configured manager
   * injects, for `target`. Empty without an `origin`. Never throws: a failing
   * manager contributes nothing and is reported by an error card.
   */
  env(target: SecretsTarget, options?: SecretsResolveOptions): Promise<Record<string, string>>;
}

export interface SecretsModuleDeps {
  readonly config: Config;
  readonly processRunner: ProcessRunner;
  readonly gitClient: Pick<IGitClient, "getGitConfig">;
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
  readonly logger: Logger;
  /** CodeHydra's own executable, run as Node to print the environment. */
  readonly selfExecutable: string;
  /** The environment the manager starts from. Default: `process.env`. */
  readonly baseEnv?: () => NodeJS.ProcessEnv;
  /** Default: `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Default: SECRETS_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

export interface SecretsModule {
  readonly module: IntentModule;
  readonly secrets: SecretsProvider;
}

/** A nullable command line that splits into at least an executable. */
function validCommand(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  try {
    return splitCommandLine(trimmed).length > 0 ? trimmed : undefined;
  } catch (error) {
    if (error instanceof CommandLineError) return undefined;
    throw error;
  }
}

/** The environment framed by ENV_MARK in `stdout`; undefined when absent or unreadable. */
function parsePrintedEnv(stdout: string): Record<string, string> | undefined {
  const end = stdout.lastIndexOf(ENV_MARK);
  if (end < 0) return undefined;
  const start = stdout.lastIndexOf(ENV_MARK, end - 1);
  if (start < 0) return undefined;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(stdout.slice(start + ENV_MARK.length, end), "base64").toString("utf8")
    );
    if (typeof decoded !== "object" || decoded === null) return undefined;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(decoded)) {
      if (typeof value === "string") env[key] = value;
    }
    return env;
  } catch {
    return undefined;
  }
}

/** The last part of a manager's error output, for a card. */
function errorExcerpt(stderr: string): string {
  const text = stderr.trim();
  return text.length <= MAX_REASON_LENGTH ? text : `…${text.slice(-MAX_REASON_LENGTH)}`;
}

/** A failed resolution: why, worded for a card. */
class SecretsFailure extends Error {
  override readonly name = "SecretsFailure";
}

export function createSecretsModule(deps: SecretsModuleDeps): SecretsModule {
  const platform = deps.platform ?? process.platform;
  const baseEnv = deps.baseEnv ?? ((): NodeJS.ProcessEnv => process.env);
  const timeoutMs = deps.timeoutMs ?? SECRETS_TIMEOUT_MS;
  const logger = deps.logger;

  const command = deps.config.register("secrets.command", {
    default: null,
    description:
      "Password manager whose secrets every workspace and repository script gets: the command " +
      "line the command to run is appended to (e.g. `op run --env-file .env.tpl --`). " +
      "${CH_GIT_SERVER} and ${CH_GIT_PROJECT} name the repository's origin",
    applies: "live",
    // A custom command line may carry a token: kept out of diagnostics, edited in the clear.
    omit: true,
    ...storeCustom<string | null>({
      parse: (raw) => validCommand(raw),
      validate: validCommand,
      validValues: "<command line>",
      settingsControl: { kind: "preset-text", presets: SECRETS_PRESETS },
    }),
  });

  /** Resolutions in flight or done, per share object. */
  const shared = new WeakMap<object, Promise<Record<string, string>>>();
  /** Repeat keys whose last resolution failed (and was shown). */
  const failing = new Set<string>();

  /** The repository's server and project, from its origin; undefined without one. */
  async function repositoryVariables(
    projectPath: string
  ): Promise<Record<string, string> | undefined> {
    let url: string | undefined;
    try {
      const config = await deps.gitClient.getGitConfig(new Path(projectPath), {
        key: "remote.origin.url",
      });
      url = config.get("remote.origin.url");
    } catch (error) {
      logger.warn("Could not read the repository's origin", {
        project: projectPath,
        error: getErrorMessage(error),
      });
      return undefined;
    }
    const parts = url === undefined ? undefined : gitServerProject(url);
    if (parts === undefined) return undefined;
    return { [GIT_SERVER_ENV_VAR]: parts.server, [GIT_PROJECT_ENV_VAR]: parts.project };
  }

  /** Whether two variable names are the same variable (case-insensitive on Windows). */
  function nameKey(name: string): string {
    return platform === "win32" ? name.toUpperCase() : name;
  }

  /** Run the manager; the variables it injected. Throws SecretsFailure. */
  async function runManager(
    line: string,
    cwd: string,
    variables: Record<string, string>
  ): Promise<Record<string, string>> {
    const env: NodeJS.ProcessEnv = { ...baseEnv(), ...variables, [RUN_AS_NODE_ENV_VAR]: "1" };
    let args: string[];
    try {
      args = splitCommandLine(line, { ...env });
    } catch (error) {
      throw new SecretsFailure(getErrorMessage(error));
    }
    const [executable, ...rest] = args;
    if (executable === undefined) throw new SecretsFailure("the command line is empty");

    const proc = deps.processRunner.run(
      executable,
      [...rest, deps.selfExecutable, "-e", PRINT_ENV_SCRIPT],
      // The command line is the user's and its output is the secrets: never logged.
      { cwd, env, redactBy: `secrets manager (${executable})` }
    );
    const result = await proc.wait(timeoutMs);
    if (result.running === true) {
      await proc.kill(1000, 1000);
      throw new SecretsFailure(`${executable} did not finish within ${timeoutMs / 1000}s`);
    }
    if (result.spawnError !== undefined) {
      throw new SecretsFailure(`could not start ${executable} (${result.spawnError})`);
    }
    if (result.exitCode !== 0) {
      const excerpt = errorExcerpt(result.stderr);
      const status =
        result.exitCode === null ? `${executable} was killed` : `exit ${result.exitCode}`;
      throw new SecretsFailure(excerpt === "" ? status : `${status}: ${excerpt}`);
    }
    const printed = parsePrintedEnv(result.stdout);
    if (printed === undefined) {
      throw new SecretsFailure(
        `${executable} did not run the command it was given (no environment came back)`
      );
    }

    const before = new Map<string, string | undefined>();
    for (const [name, value] of Object.entries(env)) before.set(nameKey(name), value);
    const injected: Record<string, string> = {};
    for (const [name, value] of Object.entries(printed)) {
      if (name.startsWith(RESERVED_ENV_PREFIX)) continue;
      if (nameKey(name) === nameKey(RUN_AS_NODE_ENV_VAR)) continue;
      if (before.get(nameKey(name)) === value) continue;
      injected[name] = value;
    }
    return injected;
  }

  async function resolve(
    target: SecretsTarget,
    repeatKey: string | undefined
  ): Promise<Record<string, string>> {
    const variables = await repositoryVariables(target.projectPath);
    if (variables === undefined) return {};
    const line = command.get();
    if (line === null) return variables;

    try {
      const secrets = await runManager(line, target.cwd, variables);
      if (repeatKey !== undefined) failing.delete(repeatKey);
      logger.debug("Secrets loaded", { for: target.label, count: Object.keys(secrets).length });
      return { ...variables, ...secrets };
    } catch (error) {
      const reason = getErrorMessage(error);
      logger.warn("Secrets could not be loaded", { for: target.label, reason });
      const repeated = repeatKey !== undefined && failing.has(repeatKey);
      if (repeatKey !== undefined) failing.add(repeatKey);
      if (!repeated) {
        notify(deps.dispatcher, {
          type: "error",
          title: `Secrets for ${target.label} could not be loaded`,
          message: reason,
          dismissible: true,
        });
      }
      return variables;
    }
  }

  const secrets: SecretsProvider = {
    env(target, options) {
      const share = options?.share;
      if (share === undefined) return resolve(target, options?.repeatKey);
      let pending = shared.get(share);
      if (pending === undefined) {
        pending = resolve(target, options?.repeatKey);
        shared.set(share, pending);
      }
      return pending.then((env) => ({ ...env }));
    },
  };

  const module: IntentModule = {
    name: "secrets",
    hooks: defineHooks({
      [OPEN_WORKSPACE_OPERATION_ID]: {
        prepare: {
          handler: async (ctx): Promise<HookOutput<PrepareHookResult>> => {
            const env = await secrets.env(
              {
                projectPath: ctx.projectPath,
                cwd: ctx.workspacePath,
                label: `workspace "${ctx.workspaceName}"`,
              },
              { share: ctx.intent }
            );
            return { result: Object.keys(env).length > 0 ? { env } : {} };
          },
        },
      },
    }),
  };

  return { module, secrets };
}
