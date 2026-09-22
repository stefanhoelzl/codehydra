/**
 * `ch` entry point.
 *
 * Compiled to a standalone CJS bundle and shipped in the instance's bin
 * directory. Everything with a decision in it lives in `run.ts` and `mcp.ts`;
 * this file only reads the process, picks a mode, and writes the outcome.
 */

import { readFileSync, realpathSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

import { runClaudeWrapper } from "../modules/agent-module/claude/wrapper";
import { runOpencodeWrapper } from "../modules/agent-module/opencode/wrapper";
import { connect } from "./client";
import { chooseConnection, DiscoveryError, type DiscoveryFs } from "./discovery";
import { childExitCode } from "./child-exit";
import { lockRun } from "./lock-run";
import { serveMcp } from "./mcp";
import { EXIT, renderError, useJson } from "./output";
import { run } from "./run";

const VERSION = "1.0.0";

const fs: DiscoveryFs = { readFileSync, realpathSync };

/** Read `--workspace` before anything else: the handshake carries it. */
function workspaceFlag(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--workspace");
  if (index !== -1) return argv[index + 1];
  const inline = argv.find((token) => token.startsWith("--workspace="));
  return inline?.slice("--workspace=".length);
}

/**
 * Run a command transparently: same stdio, same exit code.
 *
 * `ch bg` is the background wrapper. Its only job is to put a recognizable
 * marker into the command string CodeHydra sees, so a long-lived background
 * shell can opt out of keeping the workspace busy.
 */
function passthrough(command: string, args: readonly string[]): number {
  const result = spawnSync(command, [...args], { stdio: "inherit" });
  return childExitCode(result.status, result.signal);
}

/**
 * Run a command to completion without blocking the event loop.
 *
 * `ch lock run` must NOT do what `bg` does with `spawnSync`: a blocked event
 * loop stops the socket's heartbeats, the app drops the connection after its
 * ping timeout, and the lock tied to that connection is released while the
 * command is still using the resource.
 *
 * Signals aimed at `ch` are passed on to the command, so the lock is held until
 * the command has actually stopped rather than until `ch` was asked to.
 */
function runCommand(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: "inherit" });
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(
      (signal) => [signal, forward(signal)] as const
    );
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const done = (status: number) => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolve(status);
    };

    child.on("error", (error) => {
      process.stderr.write(`ch lock run: ${error.message}\n`);
      done(127);
    });
    child.on("exit", (code, signal) => {
      done(childExitCode(code, signal));
    });
  });
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  // The agent launchers never touch the app either: they are how an agent
  // starts, so they must work before anything is listening.
  if (argv[0] === "claude") {
    await runClaudeWrapper();
  }
  if (argv[0] === "opencode") {
    runOpencodeWrapper(argv.slice(1));
  }

  // `bg` never touches the app: it is a passthrough, and requiring a running
  // CodeHydra to wrap a command would make it useless during startup.
  if (argv[0] === "bg") {
    const [, command, ...rest] = argv;
    if (command === undefined) {
      process.stderr.write("ch bg needs a command to run\n");
      return EXIT.USAGE;
    }
    return passthrough(command, rest);
  }

  // Flags are read only up to `--`: past it is a command `ch lock run` passes
  // through, and its own `--workspace` is not ours.
  const flagArgv = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;

  /** See chooseConnection: `_CH_DATA_DIR`, then port + token, then state.json. */
  const connection = () => chooseConnection(process.argv[1] ?? __filename, process.env, fs);

  /**
   * Open a connection, naming a workspace only when one was asked for.
   *
   * `_CH_WORKSPACE_PATH` is deliberately NOT a fallback here. Every CodeHydra
   * terminal sets it to that terminal's workspace, so using it would make `ch`
   * ignore the directory it was run in — `cd` into another workspace and
   * commands would silently act on the terminal's own. The environment is only
   * the right answer for `ch mcp`, whose agent config passes it explicitly and
   * which has no meaningful working directory.
   */
  const openConnection = async (workspace?: string) =>
    connect({
      connection: connection(),
      cwd: process.cwd(),
      ...(workspace !== undefined && { workspace }),
    });

  if (argv[0] === "lock" && argv[1] === "run") {
    return lockRun({
      argv: argv.slice(2),
      isTty: process.stdout.isTTY === true,
      connect: (workspace) => openConnection(workspace),
      runCommand,
      // The open socket keeps the process alive; the default signal handling
      // ends it, and the closing connection releases the lock.
      holdForever: () => new Promise<void>(() => {}),
      stdout: (line) => process.stdout.write(`${line}\n`),
      stderr: (line) => process.stderr.write(`${line}\n`),
    });
  }

  if (argv[0] === "mcp") {
    // Failing here would leave the agent with a dead MCP server, so the reason
    // goes to stderr where the agent's logs will show it.
    const client = await openConnection(process.env._CH_WORKSPACE_PATH);
    try {
      await serveMcp(client, VERSION);
    } finally {
      client.close();
    }
    // Exit rather than return: the socket client can leave handles that keep the
    // event loop alive, and a stdio MCP server that does not exit when its agent
    // closes stdin leaks a process per session. Nothing is pending on stdout
    // here — the transport writes each response as it is produced.
    process.exit(EXIT.OK);
  }

  // Progress goes to stderr, and only when a person is watching it: a pipeline
  // reads stdout, and mixing progress into stderr it captures would be just as
  // unwelcome. --progress / --no-progress override.
  const showProgress = argv.includes("--progress")
    ? true
    : argv.includes("--no-progress")
      ? false
      : process.stderr.isTTY === true;

  const result = await run({
    argv,
    isTty: process.stdout.isTTY === true,
    connect: () => openConnection(workspaceFlag(flagArgv)),
    ...(showProgress && {
      onProgress: (line: string) => process.stderr.write(`${line}\n`),
    }),
  });

  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  return result.exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Only reached by a failure outside run()'s own handling — `ch mcp` startup,
    // or discovery for it.
    const json = useJson("auto", process.stdout.isTTY === true);
    const code = error instanceof DiscoveryError ? EXIT.UNREACHABLE : EXIT.FAILED;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${renderError(message, code, json)}\n`);
    process.exitCode = code;
  });
