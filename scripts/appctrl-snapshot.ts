/**
 * Named snapshots of a worktree's app-data, for appctrl.
 *
 * Everything in app-data is state except the short exclusion list below, so a folder
 * the app adds later is saved and restored without a change here. A snapshot is
 * only consistent while no app runs: callers save after a clean stop, never on a
 * crash.
 *
 * Layout: `app-data/snapshots/<name>/{files/,meta.json,commands.jsonl}`.
 * `commands.jsonl` is the command log of the whole chain that built the state:
 * restoring a snapshot copies its log into the live one, and every later appctrl
 * command is appended to that, a `start` entry marking each launch.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const SNAPSHOTS_DIRNAME = "snapshots";

/** The live command log, in app-data. `appctrl*`, so never part of the state itself. */
const COMMAND_LOG = "appctrl-commands.jsonl";

/** Never saved, never cleared, never restored: output and appctrl's own files. */
function isExcluded(entry: string): boolean {
  return (
    entry === "logs" ||
    entry === "screenshots" ||
    entry === "temp" ||
    entry === SNAPSHOTS_DIRNAME ||
    entry.startsWith("appctrl")
  );
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function validateSnapshotName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid snapshot name "${name}": letters, digits, '.', '_' and '-', starting with a letter or digit`
    );
  }
  return name;
}

/** The name of an automatic snapshot: its time, sortable and filename-safe. */
export function timestampName(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** How the live state was set up at a launch: from a snapshot, from scratch, or kept. */
export type StartOrigin = { snapshot: string } | { fresh: true };

/** One line of the command log. */
export interface CommandLogEntry {
  ts: string;
  command: string;
  params: unknown;
  error?: string;
}

/** The `start` request as the daemon logs it. */
interface StartParams {
  headless?: boolean;
  packaged?: string;
  flags?: string[];
  origin?: StartOrigin;
}

export interface SnapshotMeta {
  name: string;
  createdAt: string;
  /** Saved by a clean exit, not on request. */
  auto: boolean;
  /** HEAD and whether the worktree had uncommitted changes, when saved. */
  head: string | null;
  dirty: boolean | null;
  /** From the last launch before the save. */
  flags: string[];
  headless: boolean | null;
  packaged: string | null;
  /** The snapshot the state was last restored from; null if it was built from scratch. */
  source: string | null;
}

export interface Snapshots {
  /** Append one entry to the live command log. */
  logCommand(entry: CommandLogEntry): void;
  /** Delete the live state and empty the command log. */
  clear(): void;
  /** Copy the live state to `snapshots/<name>`, replacing one of that name. */
  save(name: string, options: { auto: boolean }): SnapshotMeta;
  /** Replace the live state (and command log) with a snapshot's. */
  restore(name: string): void;
  list(): SnapshotMeta[];
  show(name: string): { meta: SnapshotMeta; commands: CommandLogEntry[] };
  remove(name: string): void;
}

export function createSnapshots(dataDir: string, repoDir: string): Snapshots {
  const snapshotsDir = join(dataDir, SNAPSHOTS_DIRNAME);
  const commandLog = join(dataDir, COMMAND_LOG);

  function dirOf(name: string): string {
    return join(snapshotsDir, validateSnapshotName(name));
  }

  function requireSnapshot(name: string): string {
    const dir = dirOf(name);
    if (!existsSync(join(dir, "meta.json"))) {
      throw new Error(`no snapshot "${name}" — \`pnpm -s appctrl snapshot list\` shows them`);
    }
    return dir;
  }

  function stateEntries(): string[] {
    if (!existsSync(dataDir)) return [];
    return readdirSync(dataDir).filter((entry) => !isExcluded(entry));
  }

  /** Recursive copy keeping symlinks, modes and times. Sockets and FIFOs are runtime-only. */
  function copyTree(src: string, dest: string): void {
    cpSync(src, dest, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      filter: (path) => {
        const stats = lstatSync(path);
        return !stats.isSocket() && !stats.isFIFO();
      },
    });
  }

  function readCommands(file: string): CommandLogEntry[] {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      return [];
    }
    const entries: CommandLogEntry[] = [];
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        entries.push(JSON.parse(line) as CommandLogEntry);
      } catch {
        // A line torn by a crash mid-write; the rest is still worth reading.
      }
    }
    return entries;
  }

  function git(args: string[]): string | null {
    try {
      return execFileSync("git", args, {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  }

  /** Launch settings and origin, read back from the command log's `start` entries. */
  function launchInfo(
    commands: CommandLogEntry[]
  ): Pick<SnapshotMeta, "flags" | "headless" | "packaged" | "source"> {
    const starts = commands
      .filter((entry) => entry.command === "start" && entry.error === undefined)
      .map((entry) => entry.params as StartParams);
    const last = starts.at(-1);
    let source: string | null = null;
    for (const start of [...starts].reverse()) {
      if (start.origin === undefined) continue;
      source = "snapshot" in start.origin ? start.origin.snapshot : null;
      break;
    }
    return {
      flags: last?.flags ?? [],
      headless: last?.headless ?? null,
      packaged: last?.packaged ?? null,
      source,
    };
  }

  function clear(): void {
    for (const entry of stateEntries())
      rmSync(join(dataDir, entry), { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(commandLog, "");
  }

  return {
    logCommand(entry) {
      mkdirSync(dataDir, { recursive: true });
      appendFileSync(commandLog, JSON.stringify(entry) + "\n");
    },

    clear,

    save(name, { auto }) {
      const dir = dirOf(name);
      // Built beside the target, then swapped in: a failed copy leaves the old one intact.
      const staging = join(snapshotsDir, `.staging-${name}-${process.pid}`);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(join(staging, "files"), { recursive: true });
      try {
        for (const entry of stateEntries()) {
          copyTree(join(dataDir, entry), join(staging, "files", entry));
        }
        const commands = readCommands(commandLog);
        if (existsSync(commandLog)) copyFileSync(commandLog, join(staging, "commands.jsonl"));
        else writeFileSync(join(staging, "commands.jsonl"), "");

        const head = git(["rev-parse", "HEAD"]);
        const status = git(["status", "--porcelain"]);
        const meta: SnapshotMeta = {
          name,
          createdAt: new Date().toISOString(),
          auto,
          head,
          dirty: status === null ? null : status.length > 0,
          ...launchInfo(commands),
        };
        writeFileSync(join(staging, "meta.json"), JSON.stringify(meta, null, 2) + "\n");

        rmSync(dir, { recursive: true, force: true });
        renameSync(staging, dir);
        return meta;
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    },

    restore(name) {
      const dir = requireSnapshot(name);
      clear();
      copyTree(join(dir, "files"), dataDir);
      copyFileSync(join(dir, "commands.jsonl"), commandLog);
    },

    list() {
      if (!existsSync(snapshotsDir)) return [];
      return readdirSync(snapshotsDir)
        .filter(
          (entry) => !entry.startsWith(".") && existsSync(join(snapshotsDir, entry, "meta.json"))
        )
        .map(
          (entry) =>
            JSON.parse(
              readFileSync(join(snapshotsDir, entry, "meta.json"), "utf-8")
            ) as SnapshotMeta
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    show(name) {
      const dir = requireSnapshot(name);
      return {
        meta: JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8")) as SnapshotMeta,
        commands: readCommands(join(dir, "commands.jsonl")),
      };
    },

    remove(name) {
      rmSync(requireSnapshot(name), { recursive: true, force: true });
    },
  };
}
