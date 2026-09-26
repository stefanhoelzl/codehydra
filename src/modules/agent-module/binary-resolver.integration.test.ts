// @vitest-environment node
/**
 * Integration tests for the agent binary resolver: which executable an agent
 * runs (pin → system install → latest download), channel re-resolution,
 * offline fallback, background updates and `--download-binaries` seeding.
 *
 * Behavioral mocks throughout: an in-memory filesystem, an HTTP mock serving a
 * fake release host, and a process runner answering `--version`.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  compareVersions,
  createAgentBinaryResolver,
  pathEntries,
  type AgentBinaryDescriptor,
} from "./binary-resolver";
import {
  createFileSystemMock,
  directory,
  file,
} from "../../boundaries/platform/filesystem.state-mock";
import { createMockHttpClient } from "../../boundaries/platform/http-client.state-mock";
import { createArchiveExtractorMock } from "../../boundaries/platform/archive-extractor.state-mock";
import { createMockProcessRunner } from "../../boundaries/platform/process.state-mock";
import { createMockPathProvider } from "../../boundaries/platform/path-provider.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging";
import type { SupportedPlatform } from "../../boundaries/platform/platform-info";
import { Path } from "../../utils/path/path";

// =============================================================================
// A fake release host: `<host>/<channel>` → version, `<host>/<v>/agent` → bytes
// =============================================================================

const HOST = "https://releases.test";
const BUNDLES = "/test/bundles";
const BINARY = Buffer.from("#!/bin/sh\necho agent\n");
const SHA256 = createHash("sha256").update(BINARY).digest("hex");

const descriptor: AgentBinaryDescriptor = {
  name: "agent",
  channels: ["latest", "stable"],
  defaultChannel: "stable",
  executablePath: "agent",
  systemCandidates: ["agent"],
  async resolveChannel(channel, httpClient) {
    const response = await httpClient.fetch(`${HOST}/${channel}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.text()).trim();
  },
  async downloadRequest(version, destDir) {
    return {
      name: "agent",
      url: `${HOST}/${version}/agent`,
      destDir,
      executablePath: "agent",
      sha256: SHA256,
    };
  },
};

function native(path: string): string {
  return new Path(path).toNative();
}

function bundle(version: string): string {
  return native(`${BUNDLES}/agent/${version}/agent`);
}

interface SetupOptions {
  version?: string | null;
  /** Version directories already downloaded (with their executable). */
  downloaded?: readonly string[];
  /** Channel → version the host currently serves. */
  channels?: Record<string, string>;
  /** Directories on PATH, and which of them hold a working/broken `agent`. */
  path?: readonly string[];
  systemAgents?: Record<string, "works" | "broken">;
  platform?: SupportedPlatform;
  env?: Record<string, string>;
  systemCandidates?: readonly string[];
}

function setup(options: SetupOptions = {}) {
  const entries: Record<string, ReturnType<typeof directory> | ReturnType<typeof file>> = {
    [BUNDLES]: directory(),
  };
  if ((options.downloaded ?? []).length > 0) {
    entries[`${BUNDLES}/agent`] = directory();
  }
  for (const version of options.downloaded ?? []) {
    entries[`${BUNDLES}/agent/${version}`] = directory();
    entries[`${BUNDLES}/agent/${version}/agent`] = file("old");
  }
  for (const dir of options.path ?? []) {
    entries[dir] = directory();
  }
  const systemAgents = options.systemAgents ?? {};
  for (const [executable] of Object.entries(systemAgents)) {
    entries[executable] = file("#!/bin/sh");
  }
  const fileSystem = createFileSystemMock({ entries });

  const responses: Record<string, { body: string | Buffer; status?: number }> = {};
  for (const [channel, version] of Object.entries(options.channels ?? { stable: "2.0.0" })) {
    responses[`${HOST}/${channel}`] = { body: `${version}\n` };
  }
  const httpClient = createMockHttpClient({
    responses,
    defaultResponse: { body: BINARY, headers: { "content-length": String(BINARY.length) } },
  });

  const processRunner = createMockProcessRunner({
    onSpawn: (command) => {
      const known = Object.entries(systemAgents).find(([executable]) =>
        command.includes(native(executable))
      );
      return { exitCode: known?.[1] === "works" ? 0 : 1 };
    },
  });

  const platform = options.platform ?? "linux";
  const resolver = createAgentBinaryResolver({
    descriptor: {
      ...descriptor,
      ...(options.systemCandidates && { systemCandidates: options.systemCandidates }),
    },
    version: { get: () => options.version ?? null },
    pathProvider: createMockPathProvider({ bundlesRootDir: BUNDLES }),
    fileSystem,
    processRunner,
    downloadDeps: {
      httpClient,
      fileSystemLayer: fileSystem,
      archiveExtractor: createArchiveExtractorMock(),
    },
    env: options.env ?? { PATH: (options.path ?? []).join(platform === "win32" ? ";" : ":") },
    platform,
    logger: SILENT_LOGGER,
  });

  return { resolver, fileSystem, httpClient, processRunner };
}

// =============================================================================
// Tests
// =============================================================================

describe("agent binary resolver", () => {
  describe("a pinned version", () => {
    it("runs an already-downloaded pin without touching the network", async () => {
      const { resolver, httpClient } = setup({ version: "1.5.0", downloaded: ["1.5.0"] });

      expect(await resolver.prepare()).toEqual({ needsDownload: false });
      expect(resolver.current()).toEqual({
        path: bundle("1.5.0"),
        source: "download",
        version: "1.5.0",
      });
      expect(httpClient).toHaveRequestCount(0);
    });

    it("downloads a missing pin, verifying its checksum", async () => {
      const { resolver, fileSystem, httpClient } = setup({ version: "1.5.0" });

      expect(await resolver.prepare()).toEqual({ needsDownload: true });
      expect(resolver.current()).toBeNull();
      await resolver.download();

      expect(httpClient).toHaveRequested(`${HOST}/1.5.0/agent`);
      expect(fileSystem).toHaveFile(bundle("1.5.0"), BINARY);
      expect(resolver.current()?.path).toBe(bundle("1.5.0"));
      expect(await resolver.prepare()).toEqual({ needsDownload: false });
    });

    it("beats a system install", async () => {
      const { resolver } = setup({
        version: "1.5.0",
        downloaded: ["1.5.0"],
        path: ["/usr/bin"],
        systemAgents: { "/usr/bin/agent": "works" },
      });

      await resolver.prepare();

      expect(resolver.current()?.source).toBe("download");
    });

    it("treats a version directory without the executable as not downloaded", async () => {
      const { resolver, fileSystem } = setup({ version: "1.5.0" });
      await fileSystem.mkdir(native(`${BUNDLES}/agent/1.5.0`));

      expect(await resolver.prepare()).toEqual({ needsDownload: true });
    });
  });

  describe("the system install", () => {
    it("is used when nothing is pinned, with no network and no download", async () => {
      const { resolver, httpClient } = setup({
        downloaded: ["2.0.0"],
        path: ["/opt/nothing", "/usr/bin"],
        systemAgents: { "/usr/bin/agent": "works" },
      });

      expect(await resolver.prepare()).toEqual({ needsDownload: false });
      expect(resolver.current()).toEqual({
        path: native("/usr/bin/agent"),
        source: "system",
        version: null,
      });
      expect(httpClient).toHaveRequestCount(0);
      // Nothing downloaded is in use: cleanup may sweep every version.
      expect(resolver.bundleVersionsInUse()).toEqual([]);
    });

    it("is skipped when its --version fails, falling back to a download", async () => {
      const { resolver } = setup({
        path: ["/usr/bin"],
        systemAgents: { "/usr/bin/agent": "broken" },
      });

      expect(await resolver.prepare()).toEqual({ needsDownload: true });
    });

    it("takes the first working match in PATH order", async () => {
      const { resolver } = setup({
        path: ["/home/me/.local/bin", "/usr/bin"],
        systemAgents: { "/home/me/.local/bin/agent": "broken", "/usr/bin/agent": "works" },
      });

      await resolver.prepare();

      expect(resolver.current()?.path).toBe(native("/usr/bin/agent"));
    });

    it("finds an npm .cmd shim on Windows through a `Path` key and runs it via a shell", async () => {
      const { resolver, processRunner } = setup({
        platform: "win32",
        path: ["/npm"],
        systemAgents: { "/npm/agent.cmd": "works" },
        env: { Path: native("/npm") },
        systemCandidates: ["agent.exe", "agent.cmd"],
      });

      await resolver.prepare();

      expect(resolver.current()?.path).toBe(native("/npm/agent.cmd"));
      expect(processRunner.$.spawned(0).$.shell).toBe(true);
    });
  });

  describe("tracking a channel", () => {
    it("downloads the default channel's version when nothing is installed", async () => {
      const { resolver, httpClient } = setup({ channels: { stable: "2.0.0", latest: "2.1.0" } });

      expect(await resolver.prepare()).toEqual({ needsDownload: true });
      await resolver.download();

      expect(httpClient).toHaveRequested(`${HOST}/2.0.0/agent`);
      expect(resolver.current()?.version).toBe("2.0.0");
    });

    it("uses the channel's version when it is already downloaded", async () => {
      const { resolver, httpClient } = setup({ downloaded: ["1.0.0", "2.0.0"] });

      expect(await resolver.prepare()).toEqual({ needsDownload: false });
      expect(resolver.current()?.version).toBe("2.0.0");
      expect(httpClient).not.toHaveRequested(`${HOST}/2.0.0/agent`);
    });

    it("tracks a channel named in the setting, even over a system install", async () => {
      const { resolver } = setup({
        version: "latest",
        channels: { stable: "2.0.0", latest: "2.1.0" },
        downloaded: ["2.1.0"],
        path: ["/usr/bin"],
        systemAgents: { "/usr/bin/agent": "works" },
      });

      await resolver.prepare();

      expect(resolver.current()).toMatchObject({ source: "download", version: "2.1.0" });
    });

    it("starts on the older download and switches new launches once the newer one lands", async () => {
      const { resolver, fileSystem } = setup({
        downloaded: ["1.0.0"],
        channels: { stable: "2.0.0" },
      });

      expect(await resolver.prepare()).toEqual({ needsDownload: false });
      expect(resolver.current()?.version).toBe("1.0.0");
      // Both are kept while the newer one is still downloading.
      expect(resolver.bundleVersionsInUse()).toEqual(expect.arrayContaining(["1.0.0", "2.0.0"]));

      await resolver.idle();

      expect(fileSystem).toHaveFile(bundle("2.0.0"), BINARY);
      expect(resolver.current()?.version).toBe("2.0.0");
      expect(resolver.bundleVersionsInUse()).toEqual(["2.0.0"]);
    });

    it("keeps the older download when the background download fails", async () => {
      const { resolver, httpClient } = setup({ downloaded: ["1.0.0"] });
      httpClient.setResponse(`${HOST}/2.0.0/agent`, { status: 500 });

      await resolver.prepare();
      await resolver.idle();

      expect(resolver.current()?.version).toBe("1.0.0");
    });

    it("falls back to the newest download when the lookup fails", async () => {
      const { resolver, httpClient } = setup({ downloaded: ["1.0.0", "1.10.0", "1.9.0"] });
      httpClient.simulateNetworkDown();

      expect(await resolver.prepare()).toEqual({ needsDownload: false });
      expect(resolver.current()?.version).toBe("1.10.0");
    });

    it("retries the lookup on download when there was nothing to fall back on", async () => {
      const { resolver, httpClient } = setup({ channels: { stable: "2.0.0" } });
      httpClient.simulateNetworkDown();

      expect(await resolver.prepare()).toEqual({ needsDownload: true });
      await expect(resolver.download()).rejects.toThrow();

      httpClient.simulateNetworkUp();
      await resolver.download();

      expect(resolver.current()?.version).toBe("2.0.0");
    });

    it("resolves once per launch", async () => {
      const { resolver, httpClient } = setup({ downloaded: ["2.0.0"] });

      await resolver.prepare();
      await resolver.prepare();

      expect(httpClient).toHaveRequestCount(1);
    });
  });

  describe("cleanup", () => {
    it("reports nothing to keep before this launch has resolved", () => {
      const { resolver } = setup({ downloaded: ["1.0.0"] });

      expect(resolver.bundleVersionsInUse()).toBeNull();
    });
  });

  describe("seed (--download-binaries)", () => {
    it("downloads the default channel even when a system install exists", async () => {
      const { resolver, fileSystem } = setup({
        path: ["/usr/bin"],
        systemAgents: { "/usr/bin/agent": "works" },
      });

      await expect(resolver.seed()).resolves.toBe("2.0.0");

      expect(fileSystem).toHaveFile(bundle("2.0.0"), BINARY);
    });

    it("downloads the pinned version, and skips one already present", async () => {
      const { resolver, httpClient } = setup({ version: "1.5.0", downloaded: ["1.5.0"] });

      await expect(resolver.seed()).resolves.toBe("1.5.0");

      expect(httpClient).toHaveRequestCount(0);
    });
  });
});

describe("compareVersions", () => {
  it("orders numerically, a release above its prereleases", () => {
    const sorted = ["1.10.0", "1.9.0", "2.0.0-beta.1", "2.0.0", "1.9.10"].sort((a, b) =>
      compareVersions(b, a)
    );

    expect(sorted).toEqual(["2.0.0", "2.0.0-beta.1", "1.10.0", "1.9.10", "1.9.0"]);
  });
});

describe("pathEntries", () => {
  it("splits PATH with the platform's delimiter, whatever the key's case", () => {
    expect(pathEntries({ PATH: "/a::/b" }, "linux")).toEqual(["/a", "/b"]);
    expect(pathEntries({ Path: "C:\\a;C:\\b" }, "win32")).toEqual(["C:\\a", "C:\\b"]);
    expect(pathEntries({}, "linux")).toEqual([]);
  });
});
