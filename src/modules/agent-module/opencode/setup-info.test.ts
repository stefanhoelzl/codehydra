/**
 * Focused tests for OpenCode's download coordinates: release URLs and reading
 * the latest version from the `releases/latest` redirect.
 */

import { describe, it, expect } from "vitest";
import {
  OPENCODE_LATEST_URL,
  createOpencodeBinaryDescriptor,
  getOpencodeUrlForVersion,
  parseOpencodeReleaseTagUrl,
} from "./setup-info";
import { createMockHttpClient } from "../../../boundaries/platform/http-client.state-mock";

const RELEASES = "https://github.com/anomalyco/opencode/releases";

describe("getOpencodeUrlForVersion", () => {
  it.each([
    ["linux", "x64", "opencode-linux-x64.tar.gz"],
    ["linux", "arm64", "opencode-linux-arm64.tar.gz"],
    ["darwin", "arm64", "opencode-darwin-arm64.zip"],
    ["win32", "x64", "opencode-windows-x64.zip"],
  ] as const)("names the %s/%s asset", (platform, arch, asset) => {
    expect(getOpencodeUrlForVersion("1.18.32", platform, arch)).toBe(
      `${RELEASES}/download/v1.18.32/${asset}`
    );
  });
});

describe("parseOpencodeReleaseTagUrl", () => {
  it("reads the version from a tag page URL", () => {
    expect(parseOpencodeReleaseTagUrl(`${RELEASES}/tag/v1.18.32`)).toBe("1.18.32");
    expect(parseOpencodeReleaseTagUrl(`${RELEASES}/tag/1.19.0-beta.1/`)).toBe("1.19.0-beta.1");
  });

  it("returns null for a URL that is not a tag page", () => {
    expect(parseOpencodeReleaseTagUrl(`${RELEASES}/latest`)).toBeNull();
    expect(parseOpencodeReleaseTagUrl("")).toBeNull();
  });
});

describe("createOpencodeBinaryDescriptor", () => {
  it("resolves latest from where releases/latest redirected", async () => {
    const http = createMockHttpClient({
      responses: { [OPENCODE_LATEST_URL]: { body: "<html/>", url: `${RELEASES}/tag/v1.18.32` } },
    });

    await expect(
      createOpencodeBinaryDescriptor("linux", "x64").resolveChannel("latest", http)
    ).resolves.toBe("1.18.32");
  });

  it("fails when the redirect does not land on a tag page", async () => {
    const http = createMockHttpClient({ responses: { [OPENCODE_LATEST_URL]: { body: "" } } });

    await expect(
      createOpencodeBinaryDescriptor("linux", "x64").resolveChannel("latest", http)
    ).rejects.toThrow(/Could not read the latest OpenCode version/);
  });

  it("knows no channel but latest", async () => {
    await expect(
      createOpencodeBinaryDescriptor("linux", "x64").resolveChannel(
        "stable",
        createMockHttpClient()
      )
    ).rejects.toThrow("Unknown OpenCode channel: stable");
  });

  it("builds an archive request for the platform", async () => {
    const request = await createOpencodeBinaryDescriptor("darwin", "arm64").downloadRequest(
      "1.18.32",
      "/b/opencode/1.18.32",
      createMockHttpClient()
    );

    expect(request).toEqual({
      name: "opencode",
      url: `${RELEASES}/download/v1.18.32/opencode-darwin-arm64.zip`,
      destDir: "/b/opencode/1.18.32",
      archiveExtension: ".zip",
      executablePath: "opencode",
    });
  });
});
