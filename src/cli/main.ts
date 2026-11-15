/**
 * `ch` entry point.
 *
 * Compiled to a standalone CJS bundle and shipped in the instance's bin
 * directory. Everything with a decision in it lives in `run.ts` and `mcp.ts`;
 * this file only reads the process, picks a mode, and writes the outcome.
 */

import { getErrorMessage } from "../shared/error-utils";
import { readFileSync, realpathSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

import { runClaudeWrapper } from "../modules/agent-module/claude/wrapper";
import { runOpencodeWrapper } from "../modules/agent-module/opencode/wrapper";
import { connect } from "./client";
import { homedir } from "node:os";
import {
  chooseConnection,
  DiscoveryError,
  inheritsConnection,
  readStartupInfo,
  resolveDataDir,
  type DiscoveryFs,
} from "./discovery";
import { connectOrStart, probeRunning, renderRunningText } from "./autostart";
import { childExitCode } from "./child-exit";
import { lockRun } from "./lock-run";
import { connectMcp, reconnecting, serveMcp } from "./mcp";
import { EXIT, renderError, useJson } from "./output";
import { readFormat } from "./args";
import { run } from "./run";

const VERSION = "1.0.0";

const fs: DiscoveryFs = { readFileSync, realpathSync };

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

/**
 * Start CodeHydra detached from this process: it outlives `ch`, and closing the
 * shell `ch` ran in does not take it down. Resolves once the process exists,
 * rejects when it cannot be spawned at all (uninstalled, moved).
 *
 * The app clears every inherited `_CH_*` at startup, so the caller's
 * environment is passed on as it is — except `_CHDEV_ROOT_DIR`, which picks the
 * instance and so must be exactly the one the instance ran under.
 */
function launchApp(executable: string, rootOverride: string | null): Promise<void> {
  const env = { ...process.env };
  delete env["_CHDEV_ROOT_DIR"];
  if (rootOverride !== null) env["_CHDEV_ROOT_DIR"] = rootOverride;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      detached: true,
      stdio: "ignore",
      cwd: homedir(),
      env,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** All of standard input, as text — for a field given as `-`. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
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

  /** See chooseConnection: `_CH_DATA_DIR`, then port + token, then state.json. */
  const connection = () => chooseConnection(process.argv[1] ?? __filename, process.env, fs);

  /**
   * Open a connection. It says only where `ch` was run — the app resolves that
   * to the caller's own workspace. What a command acts on is its own
   * `--workspace` field, sent with the call.
   *
   * `_CH_WORKSPACE` is deliberately NOT consulted here. Every CodeHydra
   * terminal sets it to that terminal's workspace, so using it would make `ch`
   * ignore the directory it was run in — `cd` into another workspace and
   * commands would silently act on the terminal's own. The environment is only
   * the right answer for `ch mcp` (see connectMcp), whose agent config passes
   * it explicitly and which has no meaningful working directory.
   */
  const selfPath = process.argv[1] ?? __filename;
  const autostart = {
    connection,
    connect: (target: Parameters<typeof connect>[0]["connection"]) =>
      connect({ connection: target, cwd: process.cwd() }),
    startupInfo: () =>
      readStartupInfo(resolveDataDir(selfPath, fs, process.env._CH_DATA_DIR || undefined), fs),
  };

  /**
   * Connect, starting CodeHydra first when it is not running (see autostart.ts).
   * Only a person at a terminal is told; a script reads stdout and the exit code.
   */
  const openConnection = () =>
    connectOrStart({
      ...autostart,
      canStart: !inheritsConnection(process.env),
      launch: launchApp,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      ...(process.stderr.isTTY === true && {
        onStarting: () => process.stderr.write("Starting CodeHydra…\n"),
      }),
    });

  // `running` is the one command that must never start the app: it is how a
  // script asks whether it is up.
  if (argv[0] === "running") {
    let json: boolean;
    try {
      json = useJson(readFormat(argv), process.stdout.isTTY === true);
    } catch (error) {
      process.stderr.write(`${getErrorMessage(error)}\n`);
      return EXIT.USAGE;
    }
    const status = await probeRunning(autostart);
    process.stdout.write(`${json ? JSON.stringify(status) : renderRunningText(status)}\n`);
    return status.running ? EXIT.OK : EXIT.UNREACHABLE;
  }

  if (argv[0] === "lock" && argv[1] === "run") {
    return lockRun({
      argv: argv.slice(2),
      isTty: process.stdout.isTTY === true,
      connect: openConnection,
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
    const open = () => connectMcp(connection(), process.env, process.cwd());
    const client = reconnecting(await open(), open);
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
    connect: openConnection,
    ...(process.stdin.isTTY !== true && { readStdin: readAllStdin }),
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
    const message = getErrorMessage(error);
    process.stderr.write(`${renderError(message, code, json)}\n`);
    process.exitCode = code;
  });
