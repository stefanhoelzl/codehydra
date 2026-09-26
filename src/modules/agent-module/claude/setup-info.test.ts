/**
 * Focused tests for Claude's download coordinates: URLs, platform keys and
 * release-manifest parsing.
 */

import { describe, it, expect } from "vitest";
import {
  CLAUDE_DOWNLOAD_BASE,
  createClaudeBinaryDescriptor,
  getClaudeBinaryUrl,
  getClaudeChannelUrl,
  getClaudeManifestUrl,
  getClaudePlatformKey,
  parseClaudeManifest,
} from "./setup-info";
import { createMockHttpClient } from "../../../boundaries/platform/http-client.state-mock";

const SHA = "15e2d05148f801b5774032faad87e624ecd172e9903288bda448b892eb58fa07";

function manifest(platforms: Record<string, unknown>): unknown {
  return { version: "2.1.274", platforms };
}

describe("Claude URLs", () => {
  it("builds channel, manifest and binary URLs on downloads.claude.ai", () => {
    expect(CLAUDE_DOWNLOAD_BASE).toBe("https://downloads.claude.ai/claude-code-releases");
    expect(getClaudeChannelUrl("stable")).toBe(`${CLAUDE_DOWNLOAD_BASE}/stable`);
    expect(getClaudeManifestUrl("2.1.274")).toBe(`${CLAUDE_DOWNLOAD_BASE}/2.1.274/manifest.json`);
    expect(getClaudeBinaryUrl("2.1.274", "win32-x64", "claude.exe")).toBe(
      `${CLAUDE_DOWNLOAD_BASE}/2.1.274/win32-x64/claude.exe`
    );
  });
});

describe("getClaudePlatformKey", () => {
  it.each([
    ["linux", "x64", "linux-x64"],
    ["linux", "arm64", "linux-arm64"],
    ["darwin", "arm64", "darwin-arm64"],
    ["darwin", "x64", "darwin-x64"],
    ["win32", "x64", "win32-x64"],
  ] as const)("maps %s/%s to %s", (platform, arch, key) => {
    expect(getClaudePlatformKey(platform, arch)).toBe(key);
  });

  it("rejects Windows arm64, which CodeHydra does not ship for", () => {
    expect(() => getClaudePlatformKey("win32", "arm64")).toThrow(/x64/);
  });
});

describe("parseClaudeManifest", () => {
  it("returns the platform's binary name and checksum", () => {
    const entry = parseClaudeManifest(
      manifest({ "linux-x64": { binary: "claude", checksum: SHA, size: 1 } }),
      "linux-x64"
    );

    expect(entry).toEqual({ binary: "claude", sha256: SHA });
  });

  it("names the platform when the release has no build for it", () => {
    expect(() =>
      parseClaudeManifest(
        manifest({ "linux-x64": { binary: "claude", checksum: SHA } }),
        "darwin-x64"
      )
    ).toThrow("Claude 2.1.274 has no build for darwin-x64");
  });

  it("rejects a malformed manifest", () => {
    expect(() => parseClaudeManifest({ platforms: "nope" }, "linux-x64")).toThrow(
      /Invalid Claude release manifest/
    );
    expect(() =>
      parseClaudeManifest(
        manifest({ "linux-x64": { binary: "claude", checksum: "not-a-sha" } }),
        "linux-x64"
      )
    ).toThrow(/Invalid Claude release manifest/);
  });
});

describe("createClaudeBinaryDescriptor", () => {
  it("resolves a channel to the version it names", async () => {
    const http = createMockHttpClient({
      responses: { [getClaudeChannelUrl("stable")]: { body: "2.1.274\n" } },
    });

    await expect(
      createClaudeBinaryDescriptor("linux", "x64").resolveChannel("stable", http)
    ).resolves.toBe("2.1.274");
  });

  it("rejects a channel response that is not a version", async () => {
    const http = createMockHttpClient({
      responses: { [getClaudeChannelUrl("latest")]: { body: "<html>error</html>" } },
    });

    await expect(
      createClaudeBinaryDescriptor("linux", "x64").resolveChannel("latest", http)
    ).rejects.toThrow(/Unexpected Claude latest version/);
  });

  it("builds a checksummed raw-file request from the version's manifest", async () => {
    const http = createMockHttpClient({
      responses: {
        [getClaudeManifestUrl("2.1.274")]: {
          body: JSON.stringify(manifest({ "win32-x64": { binary: "claude.exe", checksum: SHA } })),
        },
      },
    });

    const request = await createClaudeBinaryDescriptor("win32", "x64").downloadRequest(
      "2.1.274",
      "C:/bundles/claude/2.1.274",
      http
    );

    expect(request).toEqual({
      name: "claude",
      url: `${CLAUDE_DOWNLOAD_BASE}/2.1.274/win32-x64/claude.exe`,
      destDir: "C:/bundles/claude/2.1.274",
      executablePath: "claude.exe",
      sha256: SHA,
    });
    expect(request.archiveExtension).toBeUndefined();
  });

  it("reports a version that does not exist", async () => {
    const http = createMockHttpClient({ defaultResponse: { status: 404 } });

    await expect(
      createClaudeBinaryDescriptor("linux", "x64").downloadRequest("9.9.9", "/b/claude/9.9.9", http)
    ).rejects.toThrow(/HTTP 404 fetching the 9.9.9 manifest/);
  });

  it("looks for the npm .cmd shim as well as the .exe on Windows", () => {
    expect(createClaudeBinaryDescriptor("win32", "x64").systemCandidates).toEqual([
      "claude.exe",
      "claude.cmd",
    ]);
    expect(createClaudeBinaryDescriptor("linux", "x64").systemCandidates).toEqual(["claude"]);
  });
});
