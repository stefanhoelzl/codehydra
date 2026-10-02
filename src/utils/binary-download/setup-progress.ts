/**
 * Setup-screen progress for one binary download: the frames a `setup → binary`
 * hook yields while its download runs.
 */

import { streamProgress } from "../../intents/lib/hook-helpers";
import type { SetupProgressPayload } from "../../intents/setup";
import { getErrorMessage } from "../../shared/error-utils";
import type { DownloadProgressCallback } from "./types";

/**
 * Run `download` and stream its progress as setup rows with this `id`:
 * "Downloading..." up front, then a frame whenever the phase or the integer
 * percentage changes (the download reports far more often than a row can
 * usefully redraw), then `done` — or `failed`, after which the download's error
 * is rethrown for the caller to wrap.
 */
export async function* streamDownloadProgress(
  id: SetupProgressPayload["id"],
  download: (onProgress: DownloadProgressCallback) => Promise<void>
): AsyncGenerator<SetupProgressPayload, void, void> {
  yield { id, status: "running", message: "Downloading..." };
  try {
    yield* streamProgress<SetupProgressPayload>(async (emit) => {
      let lastKey = "";
      await download((p) => {
        const pct = p.totalBytes ? Math.floor((p.bytesDownloaded / p.totalBytes) * 100) : undefined;
        const key = `${p.phase}:${pct ?? "x"}`;
        if (key === lastKey) return;
        lastKey = key;
        emit({
          id,
          status: "running",
          message: p.phase === "downloading" ? "Downloading..." : "Extracting...",
          ...(pct !== undefined && { progress: pct }),
        });
      });
    });
  } catch (error) {
    yield { id, status: "failed", error: getErrorMessage(error) };
    throw error;
  }
  yield { id, status: "done" };
}
