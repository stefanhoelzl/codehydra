/**
 * The `ch` command, as a function of its inputs.
 *
 * Kept free of `process` so it can be driven directly in tests: argv, cwd, TTY
 * state and the connection all come in as arguments, and the outcome comes back
 * as text plus an exit code rather than being written and thrown.
 */

import { resolvePath } from "../api/adapters/cli-map";
import { DESCRIBE_CHANNEL, type OperationDescriptor } from "../api/adapters/describe";
import { parseArgs, readFormat, UsageError } from "./args";
import { CallError, UnreachableError, type Client } from "./client";
import { DiscoveryError } from "./discovery";
import type { ApiErrorCategory } from "../api/errors";
import { renderCommandHelp, renderHelp } from "./help";
import { EXIT, render, renderError, useJson, type ExitCode } from "./output";
import { renderEvent } from "./progress";

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: ExitCode;
}

export interface RunOptions {
  readonly argv: readonly string[];
  readonly isTty: boolean;
  /** Opens a connection. Deferred so `--help` alone need not reach the app twice. */
  readonly connect: () => Promise<Client>;
  /**
   * Where progress goes, when there is somewhere to put it.
   *
   * Separate from the result: stdout is what the caller reads, so progress is
   * written to stderr and only when that is a terminal. Omitted means silent.
   */
  readonly onProgress?: (line: string) => void;
  /**
   * Reads all of standard input, for a field given as `-` (see
   * `CliMapping.stdin`). Omitted means there is none to read.
   */
  readonly readStdin?: () => Promise<string>;
}

/** Exit code for each failure category the app reports. */
const EXIT_FOR_CATEGORY: Readonly<Record<ApiErrorCategory, ExitCode>> = {
  usage: EXIT.USAGE,
  // Worth its own code so a script can tell "run it from a workspace" apart
  // from an operation that ran and refused.
  "no-workspace": EXIT.NO_WORKSPACE,
  conflict: EXIT.CONFLICT,
  "not-found": EXIT.NOT_FOUND,
  failed: EXIT.FAILED,
};

/** Which exit code a failure reports. */
export function exitCodeFor(error: unknown): ExitCode {
  if (error instanceof UsageError) return EXIT.USAGE;
  if (error instanceof DiscoveryError || error instanceof UnreachableError) {
    return EXIT.UNREACHABLE;
  }
  if (error instanceof CallError) return EXIT_FOR_CATEGORY[error.category];
  return EXIT.FAILED;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function run(options: RunOptions): Promise<RunResult> {
  const { argv, isTty } = options;

  // The output mode is needed to report a failure, and failures can happen
  // before the command is even resolved — so read the flag from raw argv first.
  // A bad `--format` is itself such a failure, reported in the default mode.
  let json = useJson("auto", isTty);
  const wantsHelp = argv.includes("--help") || argv.includes("-h");

  let client: Client | undefined;
  try {
    json = useJson(readFormat(argv), isTty);
    client = await options.connect();
    const descriptors = await client.call<readonly OperationDescriptor[]>(DESCRIBE_CHANNEL, {
      target: "cli",
    });

    const withPaths = descriptors.filter(
      (d): d is OperationDescriptor & { path: readonly string[] } => d.path !== undefined
    );

    if (argv.length === 0 || (wantsHelp && resolvePath(withPaths, argv) === undefined)) {
      return { stdout: renderHelp(withPaths), stderr: "", exitCode: EXIT.OK };
    }

    const resolved = resolvePath(withPaths, argv);
    if (!resolved) {
      throw new UsageError(
        `unknown command "${argv.join(" ")}". Run "ch --help" to see what is available.`
      );
    }

    if (wantsHelp) {
      return { stdout: renderCommandHelp(resolved.match), stderr: "", exitCode: EXIT.OK };
    }

    const { input } = parseArgs(
      resolved.rest,
      resolved.match.inputSchema as { properties?: Record<string, { type?: string | string[] }> },
      resolved.match.positionals ?? []
    );

    const stdinField = resolved.match.stdin;
    if (stdinField !== undefined && input[stdinField] === "-") {
      if (options.readStdin === undefined) {
        throw new UsageError(`"-" reads ${stdinField} from standard input, and there is none`);
      }
      // Drop the one newline a pipeline's last line ends with.
      input[stdinField] = (await options.readStdin()).replace(/\r?\n$/, "");
    }

    // Watch only for the duration of the call, and only when someone is
    // looking: an unwatched subscription would render nothing and still cost a
    // handler on every invocation.
    // Repeats are dropped: a clone emits an event per chunk, which renders to
    // the same line until the rounded percentage moves. Without this a single
    // clone scrolls hundreds of identical lines past whoever is watching.
    let lastLine: string | undefined;
    const stopWatching = options.onProgress
      ? client.onEvent((event) => {
          const line = renderEvent(event);
          if (line === undefined || line === lastLine) return;
          lastLine = line;
          options.onProgress!(line);
        })
      : undefined;

    try {
      const data = await client.call<unknown>(channelFor(resolved.match), input);
      // A document prints as itself unless JSON was asked for by name.
      const stdout =
        resolved.match.text === true && readFormat(argv) !== "json" && typeof data === "string"
          ? data
          : render(data, json);
      return { stdout, stderr: "", exitCode: EXIT.OK };
    } finally {
      stopWatching?.();
    }
  } catch (error: unknown) {
    const code = exitCodeFor(error);
    return { stdout: "", stderr: renderError(message(error), code, json), exitCode: code };
  } finally {
    client?.close();
  }
}

/**
 * The wire channel a described operation is invoked on.
 *
 * Derived from the operation name rather than carried in the descriptor: the CLI
 * calls operations by name, and the app maps that to its own channel. Keeping
 * the plugin channel out of the CLI's view is what stops the CLI depending on
 * the extension-facing contract.
 */
function channelFor(descriptor: OperationDescriptor): string {
  return `api:operation:${descriptor.name}`;
}
