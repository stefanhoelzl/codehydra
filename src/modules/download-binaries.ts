/**
 * `codehydra --download-binaries`: fetch every binary a first start could need
 * — the IDE server and both agents — then exit. Agents are downloaded whatever
 * is installed on the system (the configured version, else the default
 * channel), so the result does not depend on the machine: it seeds a data root
 * for CI, e2e and offline machines.
 *
 * Runs before app:start, with no window.
 */

import type { DownloadProgressCallback } from "../utils/binary-download";
import { getErrorMessage } from "../shared/error-utils";

/** One binary to fetch. Resolves to the version fetched, when it has one. */
export interface DownloadBinariesStep {
  readonly name: string;
  run(onProgress: DownloadProgressCallback): Promise<string | void>;
}

export interface DownloadBinariesDeps {
  readonly steps: readonly DownloadBinariesStep[];
  /** Where progress lines go (stdout). */
  readonly write: (line: string) => void;
}

/**
 * Run every step in order; a failed step is reported and the rest still run.
 *
 * @returns The process exit code: 0 when every step succeeded, else 1
 */
export async function downloadBinaries(deps: DownloadBinariesDeps): Promise<number> {
  let failed = 0;
  for (const step of deps.steps) {
    deps.write(`${step.name}: checking...`);
    let lastReported = -1;
    try {
      const version = await step.run((progress) => {
        if (progress.phase !== "downloading" || !progress.totalBytes) return;
        // Every 10%: enough to show it is alive without flooding a CI log.
        const pct = Math.floor((progress.bytesDownloaded / progress.totalBytes) * 10) * 10;
        if (pct === lastReported) return;
        lastReported = pct;
        deps.write(`${step.name}: downloading ${pct}%`);
      });
      deps.write(`${step.name}: ${version ? `${version} ` : ""}ready`);
    } catch (error) {
      failed++;
      deps.write(`${step.name}: failed: ${getErrorMessage(error)}`);
    }
  }
  return failed === 0 ? 0 : 1;
}
