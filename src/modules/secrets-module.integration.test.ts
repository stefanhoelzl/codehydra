// @vitest-environment node
/**
 * Integration tests for the secrets module.
 *
 * The password manager is the mock process runner: a spawn behaves like
 * `<manager> run -- <command>` — it adds its secrets to the environment it was
 * given and runs the command it was handed (CodeHydra's print-environment
 * script, evaluated here as the child would) — or fails as a test says.
 */

import { describe, it, expect } from "vitest";
import { runInNewContext } from "node:vm";
import { createMockConfig } from "../boundaries/platform/config.test-utils";
import { SILENT_LOGGER } from "../boundaries/platform/logging.test-utils";
import {
  createMockProcessRunner,
  type MockProcessRunner,
  type SpawnConfig,
} from "../boundaries/platform/process.state-mock";
import type { IGitClient } from "../boundaries/platform/git-client";
import type { Config } from "../boundaries/platform/config";
import {
  createMockNotificationManager,
  type MockNotificationManager,
} from "./presentation/notification-manager.state-mock";
import { OPEN_WORKSPACE_OPERATION_ID, type PrepareHookInput } from "../intents/open-workspace";
import type { HookContext } from "../intents/lib/operation";
import { createSecretsModule, SECRETS_PRESETS, type SecretsModule } from "./secrets-module";
import { workspaceRefIn } from "../shared/test-fixtures";

const SELF = "/opt/codehydra/codehydra";
const PROJECT = "/projects/app";
const WORKTREE = "/workspaces/feature-x";
const ORIGIN = "git@github.com:Org/App.git";
const ONE_PASSWORD = SECRETS_PRESETS.find((preset) => preset.label === "1Password")!.value;
const HEYLOGIN = SECRETS_PRESETS.find((preset) => preset.label === "Heylogin")!.value;
const TARGET = { projectPath: PROJECT, cwd: WORKTREE, label: 'workspace "feature-x"' };

/** What the manager does when spawned. */
type Manager =
  | { readonly injects: Record<string, string> }
  | { readonly fails: SpawnConfig }
  | { readonly ignoresCommand: true };

interface Harness {
  readonly secrets: SecretsModule;
  readonly runner: MockProcessRunner;
  readonly cards: MockNotificationManager;
  readonly config: Config;
}

/** Runs the command the manager was handed, in `env`; its stdout. */
function runHandedCommand(args: readonly string[], env: NodeJS.ProcessEnv): string {
  const at = args.indexOf(SELF);
  expect(args[at + 1]).toBe("-e");
  let stdout = "";
  runInNewContext(args[at + 2]!, {
    Buffer,
    process: { env, stdout: { write: (text: string) => (stdout += text) } },
  });
  return stdout;
}

function createHarness(options: {
  command: string | null;
  manager?: Manager;
  origin?: string | null;
  platform?: NodeJS.Platform;
  baseEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Harness {
  const manager = options.manager ?? { injects: { API_TOKEN: "s3cret" } };
  const runner = createMockProcessRunner({
    onSpawn: (_command, args, _cwd, env) => {
      if ("fails" in manager) return manager.fails;
      if ("ignoresCommand" in manager) return { exitCode: 0, stdout: "ok\n" };
      const stdout = runHandedCommand(args, { ...env, ...manager.injects });
      return { exitCode: 0, stdout: `unlocking…\n${stdout}\n` };
    },
  });
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  const gitClient: Pick<IGitClient, "getGitConfig"> = {
    getGitConfig: async () =>
      new Map(origin === null ? [] : [["remote.origin.url", origin] as const]),
  };
  const cards = createMockNotificationManager();
  const config = createMockConfig({ defaults: { "secrets.command": options.command } });
  const secrets = createSecretsModule({
    config,
    processRunner: runner,
    gitClient,
    dispatcher: cards.dispatcher,
    logger: SILENT_LOGGER,
    selfExecutable: SELF,
    baseEnv: () => options.baseEnv ?? { PATH: "/usr/bin", HOME: "/home/me" },
    platform: options.platform ?? "linux",
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
  });
  return { secrets, runner, cards, config };
}

describe("SecretsModule", () => {
  it("adds what the manager injects, and the repository's variables", async () => {
    const harness = createHarness({
      command: ONE_PASSWORD,
      manager: {
        injects: {
          API_TOKEN: "s3cret",
          HOME: "/home/vault",
          PATH: "/usr/bin",
          _CH_WORKSPACE: "spoofed",
        },
      },
    });

    const env = await harness.secrets.secrets.env(TARGET);

    expect(env).toEqual({
      CH_GIT_SERVER: "github.com",
      CH_GIT_PROJECT: "org/app",
      API_TOKEN: "s3cret",
      HOME: "/home/vault",
    });
    const spawned = harness.runner.$.spawned(0).$;
    expect(spawned.command).toBe("op");
    expect(spawned.args.slice(0, 5)).toEqual(["run", "--env-file", ".env.tpl", "--", SELF]);
    expect(spawned.cwd).toBe(WORKTREE);
    expect(spawned.shell).toBe(false);
    expect(spawned.redactBy).toBeDefined();
  });

  it("reads values a manager conceals in its child's output", async () => {
    // 1Password replaces secret values it sees in the output; the environment
    // comes back encoded, so it never sees them.
    const runner = createMockProcessRunner({
      onSpawn: (_command, args, _cwd, env) => {
        const stdout = runHandedCommand(args, { ...env, API_TOKEN: "s3cret" });
        return { exitCode: 0, stdout: stdout.replaceAll("s3cret", "<concealed>") };
      },
    });
    const cards = createMockNotificationManager();
    const secrets = createSecretsModule({
      config: createMockConfig({ defaults: { "secrets.command": ONE_PASSWORD } }),
      processRunner: runner,
      gitClient: { getGitConfig: async () => new Map([["remote.origin.url", ORIGIN]]) },
      dispatcher: cards.dispatcher,
      logger: SILENT_LOGGER,
      selfExecutable: SELF,
      baseEnv: () => ({}),
      platform: "linux",
    });

    expect(await secrets.secrets.env(TARGET)).toMatchObject({ API_TOKEN: "s3cret" });
  });

  it("names the repository in the command line", async () => {
    const harness = createHarness({ command: HEYLOGIN });

    await harness.secrets.secrets.env(TARGET);

    expect(harness.runner.$.spawned(0).$.command).toBe("uvx");
    expect(harness.runner.$.spawned(0).$.args.slice(0, 3)).toEqual([
      "heyl",
      "--project",
      "heyl://github.com/org/app",
    ]);
  });

  it("compares variable names case-insensitively on Windows", async () => {
    const harness = createHarness({
      command: "op run --",
      platform: "win32",
      baseEnv: { Path: "C:\\bin" },
      manager: { injects: { PATH: "C:\\bin", API_TOKEN: "s3cret" } },
    });

    const env = await harness.secrets.secrets.env(TARGET);

    expect(env).not.toHaveProperty("PATH");
    expect(env).toMatchObject({ API_TOKEN: "s3cret" });
  });

  it("runs nothing without a password manager, but names the repository", async () => {
    const harness = createHarness({ command: null });

    const env = await harness.secrets.secrets.env(TARGET);

    expect(env).toEqual({ CH_GIT_SERVER: "github.com", CH_GIT_PROJECT: "org/app" });
    expect(harness.runner.$.spawnedCount).toBe(0);
  });

  it.each([null, "/srv/git/app"])(
    "inserts nothing, quietly, for a repository whose origin is %s",
    async (origin) => {
      const harness = createHarness({ command: ONE_PASSWORD, origin });

      const env = await harness.secrets.secrets.env(TARGET);
      await harness.cards.settle();

      expect(env).toEqual({});
      expect(harness.runner.$.spawnedCount).toBe(0);
      expect(harness.cards.notifications).toHaveLength(0);
    }
  );

  it("adds no secrets and shows the manager's error when it fails", async () => {
    const harness = createHarness({
      command: ONE_PASSWORD,
      manager: { fails: { exitCode: 1, stderr: "[ERROR] not signed in\n" } },
    });

    const env = await harness.secrets.secrets.env(TARGET);
    await harness.cards.settle();

    expect(env).toEqual({ CH_GIT_SERVER: "github.com", CH_GIT_PROJECT: "org/app" });
    expect(harness.cards.lastNotification!.opened).toEqual({
      type: "error",
      title: 'Secrets for workspace "feature-x" could not be loaded',
      message: "exit 1: [ERROR] not signed in",
      dismissible: true,
    });
  });

  it("fails when the manager does not run the command it was given", async () => {
    const harness = createHarness({ command: "op --", manager: { ignoresCommand: true } });

    expect(await harness.secrets.secrets.env(TARGET)).not.toHaveProperty("API_TOKEN");
    await harness.cards.settle();

    expect(harness.cards.notifications).toHaveLength(1);
  });

  it("fails when the manager cannot be started", async () => {
    const harness = createHarness({
      command: ONE_PASSWORD,
      manager: { fails: { pid: undefined, exitCode: null, spawnError: "ENOENT" } },
    });

    await harness.secrets.secrets.env(TARGET);
    await harness.cards.settle();

    expect(harness.cards.lastNotification!.opened.message).toContain("could not start op");
  });

  it("kills a manager that does not finish in time", async () => {
    const harness = createHarness({
      command: ONE_PASSWORD,
      manager: { fails: { untilKilled: true } },
      timeoutMs: 5,
    });

    expect(await harness.secrets.secrets.env(TARGET)).not.toHaveProperty("API_TOKEN");
    await harness.cards.settle();

    expect(harness.runner.$.spawned(0).$.killCalls).toHaveLength(1);
    expect(harness.cards.notifications).toHaveLength(1);
  });

  it("resolves once per share object and afresh for every other call", async () => {
    const harness = createHarness({ command: ONE_PASSWORD });
    const open = {};

    await harness.secrets.secrets.env(TARGET, { share: open });
    await harness.secrets.secrets.env(TARGET, { share: open });
    await harness.secrets.secrets.env(TARGET, { share: {} });
    await harness.secrets.secrets.env(TARGET);

    expect(harness.runner.$.spawnedCount).toBe(3);
  });

  it("shows a repeating caller's failure once until it succeeds again", async () => {
    let failing = true;
    let attempt = 0;
    const runner = createMockProcessRunner({
      onSpawn: (_command, args, _cwd, env) =>
        failing
          ? { exitCode: 1, stderr: `locked ${++attempt}` }
          : { exitCode: 0, stdout: runHandedCommand(args, { ...env, API_TOKEN: "s3cret" }) },
    });
    const cards = createMockNotificationManager();
    const secrets = createSecretsModule({
      config: createMockConfig({ defaults: { "secrets.command": ONE_PASSWORD } }),
      processRunner: runner,
      gitClient: { getGitConfig: async () => new Map([["remote.origin.url", ORIGIN]]) },
      dispatcher: cards.dispatcher,
      logger: SILENT_LOGGER,
      selfExecutable: SELF,
      baseEnv: () => ({}),
      platform: "linux",
    }).secrets;
    const poll = async (): Promise<void> => {
      await secrets.env(TARGET, { repeatKey: "automation:a" });
      await cards.settle();
    };

    await poll();
    await poll();
    expect(cards.notifications).toHaveLength(1);

    failing = false;
    await poll();
    failing = true;
    await poll();
    expect(cards.notifications).toHaveLength(2);
  });

  it("puts the secrets into the workspace environment on open", async () => {
    const harness = createHarness({ command: ONE_PASSWORD });
    const intent = { type: "workspace:open", payload: {} };
    const input = {
      intent,
      projectPath: PROJECT,
      workspacePath: WORKTREE,
      workspaceName: "feature-x",
      workspaceRef: workspaceRefIn(PROJECT, "feature-x"),
    } as unknown as PrepareHookInput;
    const handler = harness.secrets.module.hooks![OPEN_WORKSPACE_OPERATION_ID]!["prepare"]!
      .handler as (ctx: HookContext) => Promise<unknown>;

    const output = await handler(input);
    // A hook of the same open shares the resolution.
    await harness.secrets.secrets.env(TARGET, { share: intent });

    expect(output).toEqual({
      result: {
        env: { CH_GIT_SERVER: "github.com", CH_GIT_PROJECT: "org/app", API_TOKEN: "s3cret" },
      },
    });
    expect(harness.runner.$.spawnedCount).toBe(1);
  });

  it("refuses a command line with an unclosed quote", () => {
    const harness = createHarness({ command: null });
    const definition = harness.config.getDefinitions().get("secrets.command")!;

    expect(definition.validate('op run "--')).toBeUndefined();
    expect(definition.validate("  ")).toBeNull();
    expect(definition.validate(" doppler run -- ")).toBe("doppler run --");
  });
});
