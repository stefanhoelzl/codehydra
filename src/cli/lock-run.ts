/**
 * `ch lock run <name>[,<name>…] [<reason>] [--scope …] [--no-wait] [-- <cmd…>]`.
 *
 * Take one or more locks, run a command, release them — or, with no command,
 * hold them until this process is killed. It is a built-in rather than a registry
 * operation because only a shell can spawn the command.
 *
 * The lock is taken through `lock.hold`, which ties it to this process's
 * connection: whatever ends the process — the command finishing, Ctrl-C, a
 * `kill` — ends the hold, because the app releases a held lock when the
 * connection that took it closes. The explicit release after the command is
 * only there to hand the lock over at once rather than on disconnect.
 *
 * Several names are taken one `lock.hold` at a time, in name order: two runs
 * taking the same locks then never take them in opposite order, so they cannot
 * deadlock each other. If any take fails, the ones this run already made are
 * released and the command does not run.
 *
 * It releases only what it acquired. When this workspace already held the lock
 * (a `ch lock take` earlier), the take is reentrant and reports `acquired: false`;
 * the command then runs under that outer hold and leaves it in place.
 */

import { getErrorMessage } from "../shared/error-utils";
import { OPERATION_CHANNEL_PREFIX } from "../api/adapters/api-server";
import { DESCRIBE_CHANNEL, type OperationDescriptor } from "../api/adapters/describe";
import { parseArgs, readFormat, UsageError } from "./args";
import { CallError, type Client } from "./client";
import { EXIT, renderError, useJson } from "./output";
import { exitCodeFor } from "./run";

/** What `lock.hold` / `lock.take` answer with. */
interface HoldResult {
  readonly name: string;
  readonly scope: "global" | "project";
  readonly acquired: boolean;
}

const USAGE = "usage: ch lock run <name>[,<name>…] [<reason>] [--scope …] [--no-wait] [-- <cmd…>]";

/** The same rule `lock.take` applies to a name. */
const LOCK_NAME = /^[A-Za-z0-9_-]+$/;

/** The fields `ch lock run` accepts before `--`, as `parseArgs` needs to see them. */
const SCHEMA = {
  properties: {
    name: { type: "string" },
    reason: { type: "string" },
    scope: { type: "string" },
    noWait: { type: "boolean" },
    workspace: { type: "string" },
    project: { type: "string" },
  },
};

export interface LockRunOptions {
  /** Arguments after `lock run`. */
  readonly argv: readonly string[];
  readonly isTty: boolean;
  /** Open a connection. */
  readonly connect: () => Promise<Client>;
  /** Run the command to completion and report its exit status. */
  readonly runCommand: (command: string, args: readonly string[]) => Promise<number>;
  /** Block until the process is killed. Injectable so tests can return. */
  readonly holdForever: () => Promise<void>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export async function lockRun(options: LockRunOptions): Promise<number> {
  const { argv } = options;
  let json = useJson("auto", options.isTty);

  const split = argv.indexOf("--");
  const own = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);

  let client: Client | undefined;
  try {
    json = useJson(readFormat(own), options.isTty);
    const { input } = parseArgs(own, SCHEMA, ["name", "reason"]);
    if (typeof input.name !== "string") throw new UsageError(USAGE);
    const names = [...new Set(input.name.split(","))].sort();
    const invalid = names.find((name) => !LOCK_NAME.test(name));
    if (invalid !== undefined) {
      throw new UsageError(
        `ch lock run: invalid lock name "${invalid}" — letters, digits, hyphens and underscores`
      );
    }
    if (split !== -1 && command.length === 0) {
      throw new UsageError("ch lock run: nothing after --; omit it to hold until killed");
    }

    const connected = await options.connect();
    client = connected;

    // Ask before calling: an app without the channel never answers, and calls
    // have no timeout, so an older CodeHydra would leave this waiting forever.
    // `run` gets the same guarantee by resolving every command against describe.
    const described = await connected.call<readonly OperationDescriptor[]>(DESCRIBE_CHANNEL, {
      target: "cli",
    });
    if (!described.some((descriptor) => descriptor.name === "lock.hold")) {
      throw new CallError("This CodeHydra does not support `ch lock run` — update it.");
    }

    // Only what this run took; a name the workspace already held stays held.
    const acquired: HoldResult[] = [];
    const releaseAcquired = async (): Promise<void> => {
      for (const held of acquired) {
        try {
          // As whoever took it: `--workspace` holds on another's behalf.
          await connected.call(`${OPERATION_CHANNEL_PREFIX}lock.release`, {
            name: held.name,
            scope: held.scope,
            ...(input.workspace !== undefined && { workspace: input.workspace }),
            ...(input.project !== undefined && { project: input.project }),
          });
        } catch {
          // Already gone — hibernated, say — or the app went away. Either way the
          // closing connection leaves nothing held.
        }
      }
    };

    for (const name of names) {
      try {
        const held = await connected.call<HoldResult>(`${OPERATION_CHANNEL_PREFIX}lock.hold`, {
          ...input,
          name,
        });
        if (held.acquired) acquired.push(held);
      } catch (error: unknown) {
        await releaseAcquired();
        throw error;
      }
    }

    const quoted = (held: readonly { name: string }[]) => held.map((h) => `'${h.name}'`).join(", ");

    if (command.length === 0) {
      if (acquired.length === 0) {
        // Holding forever would promise a release-on-kill that cannot happen:
        // the locks belong to the workspace's earlier takes, not to this process.
        const verb = names.length === 1 ? "is" : "are";
        options.stdout(
          `${quoted(names.map((name) => ({ name })))} ${verb} already held by this workspace — nothing to hold`
        );
        return EXIT.OK;
      }
      options.stdout(`held ${quoted(acquired)} — release by killing this process`);
      await options.holdForever();
      return EXIT.OK;
    }

    const status = await options.runCommand(command[0]!, command.slice(1));
    await releaseAcquired();
    return status;
  } catch (error: unknown) {
    const code = exitCodeFor(error);
    const message = getErrorMessage(error);
    options.stderr(renderError(message, code, json));
    return code;
  } finally {
    client?.close();
  }
}
