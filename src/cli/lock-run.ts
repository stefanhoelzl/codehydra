/**
 * `ch lock run <name> [<reason>] [--scope …] [--no-wait] [-- <cmd…>]`.
 *
 * Take a lock, run a command, release it — or, with no command, hold the lock
 * until this process is killed. It is a built-in rather than a registry
 * operation because only a shell can spawn the command.
 *
 * The lock is taken through `lock.hold`, which ties it to this process's
 * connection: whatever ends the process — the command finishing, Ctrl-C, a
 * `kill` — ends the hold, because the app releases a held lock when the
 * connection that took it closes. The explicit release after the command is
 * only there to hand the lock over at once rather than on disconnect.
 *
 * It releases only what it acquired. When this workspace already held the lock
 * (a `ch lock take` earlier), the take is reentrant and reports `acquired: false`;
 * the command then runs under that outer hold and leaves it in place.
 */

import { OPERATION_CHANNEL_PREFIX } from "../api/adapters/plugin";
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
    if (typeof input.name !== "string") {
      throw new UsageError(
        "usage: ch lock run <name> [<reason>] [--scope …] [--no-wait] [-- <cmd…>]"
      );
    }
    if (split !== -1 && command.length === 0) {
      throw new UsageError("ch lock run: nothing after --; omit it to hold until killed");
    }

    client = await options.connect();

    // Ask before calling: an app without the channel never answers, and calls
    // have no timeout, so an older CodeHydra would leave this waiting forever.
    // `run` gets the same guarantee by resolving every command against describe.
    const described = await client.call<readonly OperationDescriptor[]>(DESCRIBE_CHANNEL, {
      target: "cli",
    });
    if (!described.some((descriptor) => descriptor.name === "lock.hold")) {
      throw new CallError("This CodeHydra does not support `ch lock run` — update it.");
    }

    const held = await client.call<HoldResult>(`${OPERATION_CHANNEL_PREFIX}lock.hold`, input);

    if (command.length === 0) {
      if (!held.acquired) {
        // Holding forever would promise a release-on-kill that cannot happen:
        // the lock belongs to the workspace's earlier take, not to this process.
        options.stdout(`'${held.name}' is already held by this workspace — nothing to hold`);
        return EXIT.OK;
      }
      options.stdout(`held '${held.name}' — release by killing this process`);
      await options.holdForever();
      return EXIT.OK;
    }

    const status = await options.runCommand(command[0]!, command.slice(1));

    if (held.acquired) {
      try {
        // As whoever took it: `--workspace` holds on another's behalf.
        await client.call(`${OPERATION_CHANNEL_PREFIX}lock.release`, {
          name: held.name,
          scope: held.scope,
          ...(input.workspace !== undefined && { workspace: input.workspace }),
          ...(input.project !== undefined && { project: input.project }),
        });
      } catch {
        // Already gone — hibernated, say — or the app went away. Either way the
        // closing connection below leaves nothing held.
      }
    }
    return status;
  } catch (error: unknown) {
    const code = exitCodeFor(error);
    const message = error instanceof Error ? error.message : String(error);
    options.stderr(renderError(message, code, json));
    return code;
  } finally {
    client?.close();
  }
}
