/**
 * One log file per script run — a plugin's hook or automation, a wakeup script.
 *
 * A script's output never reaches the app log: an automation's can carry the
 * credentials its script inlines (a 401 body, a usage line quoting argv), and a
 * notification or `ch plugin errors` row is read by agents whose transcripts
 * leave the machine. So each run writes its own file — the header, the JSON it
 * was handed, its stderr and its stdout — and everything that reports a failure
 * points at that file instead of quoting it. The environment is never written:
 * `before-workspace-opened` returns secrets there.
 *
 * Retention is per entry and by outcome: the newest ten failures, and only the
 * newest success. An automation runs every poll cycle, so keeping every
 * success would bury the one failure worth reading; keeping one shows what a
 * good run looks like. The outcome is in the file name, so pruning is a listing
 * and a sort, with no file read.
 */

import { randomBytes } from "node:crypto";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import { Path } from "../../utils/path/path";
import type { ShellName } from "./shells";

/** Failed runs kept per entry. */
export const KEEP_FAILED_RUNS = 10;
/** Successful runs kept per entry. */
export const KEEP_OK_RUNS = 1;

export type RunOutcome = "ok" | "failed";

export interface RunRecord {
  /** Whose script it is, for people: a plugin's id (`local:default:github`), or `wakeup`. */
  readonly source: string;
  readonly entry: string;
  readonly shell: ShellName;
  readonly cwd: string;
  readonly startedAt: Date;
  readonly endedAt: Date;
  /** Null when the process was killed or never started. */
  readonly exitCode: number | null;
  /** Why it failed, when it did (non-zero exit, canceled, timed out, bad output). */
  readonly reason?: string;
  readonly outcome: RunOutcome;
  readonly input: string;
  readonly stdout: string;
  readonly stderr: string;
}

// Case-insensitive: `Path` lowercases on Windows, so a log is written as `…t…z-….log` there.
const LOG_NAME = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]+\.(ok|failed)\.log$/i;

/** A sortable, collision-free file name for a run. */
function logFileName(startedAt: Date, outcome: RunOutcome): string {
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${randomBytes(3).toString("hex")}.${outcome}.log`;
}

function section(title: string, body: string): string {
  const text = body.trim() === "" ? "(empty)" : body.replace(/\s+$/, "");
  return `--- ${title} ---\n${text}\n`;
}

export function formatRunLog(record: RunRecord): string {
  const header = [
    `source:   ${record.source}`,
    `entry:    ${record.entry}`,
    `shell:    ${record.shell}`,
    `cwd:      ${record.cwd}`,
    `started:  ${record.startedAt.toISOString()}`,
    `ended:    ${record.endedAt.toISOString()}`,
    `exit:     ${record.exitCode === null ? "none (killed or never started)" : record.exitCode}`,
    `outcome:  ${record.outcome}${record.reason !== undefined ? ` — ${record.reason}` : ""}`,
  ].join("\n");
  return [
    `${header}\n`,
    section("stdin", record.input),
    section("stderr", record.stderr),
    section("stdout", record.stdout),
  ].join("\n");
}

/** Write a run's log into `dir` and prune the directory. Returns the file written. */
export async function writeRunLog(
  fileSystem: Pick<FileSystemBoundary, "mkdir" | "writeFile" | "readdir" | "rm">,
  dir: Path,
  record: RunRecord
): Promise<Path> {
  await fileSystem.mkdir(dir);
  const file = new Path(dir, logFileName(record.startedAt, record.outcome));
  await fileSystem.writeFile(file, formatRunLog(record));
  await pruneRunLogs(fileSystem, dir);
  return file;
}

/**
 * Keep the newest {@link KEEP_FAILED_RUNS} failures and {@link KEEP_OK_RUNS}
 * successes. Files that are not run logs are left alone.
 */
export async function pruneRunLogs(
  fileSystem: Pick<FileSystemBoundary, "readdir" | "rm">,
  dir: Path
): Promise<void> {
  const names = (await fileSystem.readdir(dir))
    .filter((entry) => entry.isFile && LOG_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  const kept: Record<RunOutcome, number> = { ok: 0, failed: 0 };
  const limit: Record<RunOutcome, number> = { ok: KEEP_OK_RUNS, failed: KEEP_FAILED_RUNS };
  for (const name of names) {
    const outcome: RunOutcome = name.endsWith(".failed.log") ? "failed" : "ok";
    kept[outcome]++;
    if (kept[outcome] > limit[outcome]) {
      await fileSystem.rm(new Path(dir, name), { force: true });
    }
  }
}
