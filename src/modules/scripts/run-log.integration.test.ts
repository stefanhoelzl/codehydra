// @vitest-environment node
/**
 * Per-run log files: what one holds, and what survives pruning.
 */

import { describe, it, expect } from "vitest";
import {
  createFileSystemMock,
  directory,
  file,
} from "../../boundaries/platform/filesystem.state-mock";
import { Path } from "../../utils/path/path";
import {
  KEEP_FAILED_RUNS,
  formatRunLog,
  pruneRunLogs,
  writeRunLog,
  type RunRecord,
} from "./run-log";

const DIR = new Path("/logs/plugins/local/github/prs");

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    source: "local:github",
    entry: "prs",
    shell: "bash",
    cwd: "/home/user/.codehydra/plugins/github",
    startedAt: new Date("2026-09-26T10:00:00.000Z"),
    endedAt: new Date("2026-09-26T10:00:01.500Z"),
    exitCode: 1,
    outcome: "failed",
    reason: "exit 1",
    input: '{"poll":1}',
    stdout: "",
    stderr: "gh: HTTP 401 Bad credentials\n",
    ...overrides,
  };
}

describe("formatRunLog", () => {
  it("holds the header, stdin, stderr and stdout", () => {
    const text = formatRunLog(record({ stdout: '{"ok":true}' }));

    expect(text).toContain("source:   local:github");
    expect(text).toContain("entry:    prs");
    expect(text).toContain("exit:     1");
    expect(text).toContain("outcome:  failed — exit 1");
    expect(text).toContain('--- stdin ---\n{"poll":1}');
    expect(text).toContain("--- stderr ---\ngh: HTTP 401 Bad credentials");
    expect(text).toContain('--- stdout ---\n{"ok":true}');
  });

  it("says when a stream was empty or the process was killed", () => {
    const text = formatRunLog(record({ exitCode: null, stderr: "" }));

    expect(text).toContain("exit:     none (killed or never started)");
    expect(text).toContain("--- stderr ---\n(empty)");
  });
});

describe("writeRunLog", () => {
  it("keeps the newest failures and only the newest success", async () => {
    const fs = createFileSystemMock({ entries: { "/logs": directory() } });
    const written: Path[] = [];
    let second = 0;
    const at = (): Date => new Date(Date.UTC(2026, 8, 26, 10, 0, second++));

    for (let i = 0; i < KEEP_FAILED_RUNS + 3; i++) {
      written.push(await writeRunLog(fs, DIR, record({ startedAt: at() })));
    }
    const firstOk = await writeRunLog(fs, DIR, record({ outcome: "ok", startedAt: at() }));
    const lastOk = await writeRunLog(fs, DIR, record({ outcome: "ok", startedAt: at() }));

    const names = (await fs.readdir(DIR)).map((entry) => entry.name).sort();
    expect(names.filter((name) => name.endsWith(".failed.log"))).toHaveLength(KEEP_FAILED_RUNS);
    expect(names.filter((name) => name.endsWith(".ok.log"))).toEqual([lastOk.basename]);
    // The oldest failures went, the newest stayed.
    expect(names).not.toContain(written[0]!.basename);
    expect(names).toContain(written.at(-1)!.basename);
    expect(names).not.toContain(firstOk.basename);
  });

  it("prunes logs named in lower case, as Windows paths are", async () => {
    const fs = createFileSystemMock({
      entries: {
        "/logs/plugins/local/github/prs": directory(),
        "/logs/plugins/local/github/prs/2026-09-26t10-00-00-000z-aaaaaa.ok.log": file("old"),
        "/logs/plugins/local/github/prs/2026-09-26t10-00-01-000z-bbbbbb.ok.log": file("new"),
      },
    });

    await pruneRunLogs(fs, DIR);

    const names = (await fs.readdir(DIR)).map((entry) => entry.name);
    expect(names).toEqual(["2026-09-26t10-00-01-000z-bbbbbb.ok.log"]);
  });

  it("leaves files that are not run logs alone", async () => {
    const fs = createFileSystemMock({
      entries: { "/logs/plugins/local/github/prs/notes.txt": file("mine") },
    });

    for (let i = 0; i < 3; i++) {
      await writeRunLog(fs, DIR, record({ outcome: "ok" }));
    }

    const names = (await fs.readdir(DIR)).map((entry) => entry.name);
    expect(names).toContain("notes.txt");
  });
});
