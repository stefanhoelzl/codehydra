/**
 * Test utilities for the windows-file-lock module.
 */

/** The JSON `codehydra-procs.exe detect` prints for a run listing `blocking`. */
export function createDetectJson(
  blocking: Array<{
    pid: number;
    name: string;
    commandLine: string;
    files?: string[];
    cwd?: string | null;
  }>
): string {
  return JSON.stringify({
    blocking: blocking.map((p) => ({
      pid: p.pid,
      name: p.name,
      commandLine: p.commandLine,
      files: p.files ?? [],
      cwd: p.cwd ?? null,
    })),
  });
}
