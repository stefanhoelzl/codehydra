/**
 * Focused tests for streamDownloadProgress: the setup rows a binary download yields.
 */

import { describe, it, expect } from "vitest";
import { streamDownloadProgress } from "./setup-progress";
import type { SetupProgressPayload } from "../../intents/setup";
import type { DownloadProgress, DownloadProgressCallback } from "./types";

async function collect(
  download: (onProgress: DownloadProgressCallback) => Promise<void>
): Promise<{ frames: SetupProgressPayload[]; error?: unknown }> {
  const frames: SetupProgressPayload[] = [];
  try {
    for await (const frame of streamDownloadProgress("vscode", download)) frames.push(frame);
    return { frames };
  } catch (error) {
    return { frames, error };
  }
}

function reporting(updates: readonly DownloadProgress[]) {
  return async (onProgress: DownloadProgressCallback): Promise<void> => {
    await Promise.resolve();
    for (const update of updates) onProgress(update);
  };
}

describe("streamDownloadProgress", () => {
  it("forwards a frame only when the phase or integer percentage changes", async () => {
    const { frames, error } = await collect(
      reporting([
        { phase: "downloading", bytesDownloaded: 0, totalBytes: 1000 },
        { phase: "downloading", bytesDownloaded: 5, totalBytes: 1000 },
        { phase: "downloading", bytesDownloaded: 500, totalBytes: 1000 },
        { phase: "extracting", bytesDownloaded: 500, totalBytes: 1000 },
        { phase: "extracting", bytesDownloaded: 1, totalBytes: null },
        { phase: "extracting", bytesDownloaded: 2, totalBytes: null },
      ])
    );

    expect(error).toBeUndefined();
    expect(frames).toEqual([
      { id: "vscode", status: "running", message: "Downloading..." },
      { id: "vscode", status: "running", message: "Downloading...", progress: 0 },
      { id: "vscode", status: "running", message: "Downloading...", progress: 50 },
      { id: "vscode", status: "running", message: "Extracting...", progress: 50 },
      { id: "vscode", status: "running", message: "Extracting..." },
      { id: "vscode", status: "done" },
    ]);
  });

  it("yields a failed row and rethrows the download's error", async () => {
    const failure = new Error("connection reset");
    const { frames, error } = await collect(async () => {
      await Promise.resolve();
      throw failure;
    });

    expect(error).toBe(failure);
    expect(frames).toEqual([
      { id: "vscode", status: "running", message: "Downloading..." },
      { id: "vscode", status: "failed", error: "connection reset" },
    ]);
  });
});
