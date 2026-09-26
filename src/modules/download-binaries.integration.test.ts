// @vitest-environment node
/**
 * Integration tests for `--download-binaries`: every step runs in order, a
 * failed step is reported without stopping the rest, and the exit code says
 * whether everything succeeded.
 */

import { describe, it, expect } from "vitest";
import { downloadBinaries, type DownloadBinariesStep } from "./download-binaries";

function run(steps: readonly DownloadBinariesStep[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  return downloadBinaries({ steps, write: (line) => lines.push(line) }).then((code) => ({
    code,
    lines,
  }));
}

describe("downloadBinaries", () => {
  it("runs every step and exits 0, naming each version", async () => {
    const { code, lines } = await run([
      { name: "vscodium", run: async () => undefined },
      { name: "claude", run: async () => "2.1.274" },
    ]);

    expect(code).toBe(0);
    expect(lines).toEqual([
      "vscodium: checking...",
      "vscodium: ready",
      "claude: checking...",
      "claude: 2.1.274 ready",
    ]);
  });

  it("reports a failed step, still runs the rest, and exits 1", async () => {
    const ran: string[] = [];
    const { code, lines } = await run([
      {
        name: "claude",
        run: async () => {
          throw new Error("HTTP 403");
        },
      },
      {
        name: "opencode",
        run: async () => {
          ran.push("opencode");
          return "1.18.32";
        },
      },
    ]);

    expect(code).toBe(1);
    expect(lines).toContain("claude: failed: HTTP 403");
    expect(ran).toEqual(["opencode"]);
  });

  it("reports download progress in 10% steps", async () => {
    const { lines } = await run([
      {
        name: "opencode",
        run: async (onProgress) => {
          for (const bytes of [0, 5, 10, 15, 50, 100]) {
            onProgress({ phase: "downloading", bytesDownloaded: bytes, totalBytes: 100 });
          }
          return "1.18.32";
        },
      },
    ]);

    expect(lines.filter((line) => line.includes("%"))).toEqual([
      "opencode: downloading 0%",
      "opencode: downloading 10%",
      "opencode: downloading 50%",
      "opencode: downloading 100%",
    ]);
  });
});
