/**
 * Tests for the VSCodium (reh-web) IdeServer descriptor: download coordinates,
 * serve args, readiness probe, paths, and workspace settings.
 */

import { describe, it, expect } from "vitest";
import { createVscodiumIdeServer, VSCODIUM_VERSION } from "./vscodium";

describe("VSCODIUM_VERSION", () => {
  it("is a valid <major>.<minor>.<build> string", () => {
    expect(VSCODIUM_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("vscodium descriptor: downloadUrl", () => {
  const ide = createVscodiumIdeServer();
  const base = `https://github.com/VSCodium/vscodium/releases/download/${VSCODIUM_VERSION}`;

  it("linux x64 / arm64", () => {
    expect(ide.downloadUrl("linux", "x64")).toBe(
      `${base}/vscodium-reh-web-linux-x64-${VSCODIUM_VERSION}.tar.gz`
    );
    expect(ide.downloadUrl("linux", "arm64")).toBe(
      `${base}/vscodium-reh-web-linux-arm64-${VSCODIUM_VERSION}.tar.gz`
    );
  });

  it("darwin x64 / arm64", () => {
    expect(ide.downloadUrl("darwin", "x64")).toBe(
      `${base}/vscodium-reh-web-darwin-x64-${VSCODIUM_VERSION}.tar.gz`
    );
    expect(ide.downloadUrl("darwin", "arm64")).toBe(
      `${base}/vscodium-reh-web-darwin-arm64-${VSCODIUM_VERSION}.tar.gz`
    );
  });

  it("win32 x64", () => {
    expect(ide.downloadUrl("win32", "x64")).toBe(
      `${base}/vscodium-reh-web-win32-x64-${VSCODIUM_VERSION}.tar.gz`
    );
  });

  it("throws on win32 arm64 (no such build)", () => {
    expect(() => ide.downloadUrl("win32", "arm64")).toThrow(
      "Windows vscodium builds only support x64"
    );
  });

  it("honors an explicit version", () => {
    const pinned = createVscodiumIdeServer("1.200.00000");
    expect(pinned.downloadUrl("linux", "x64")).toBe(
      "https://github.com/VSCodium/vscodium/releases/download/1.200.00000/vscodium-reh-web-linux-x64-1.200.00000.tar.gz"
    );
    expect(pinned.bundleSubdir()).toBe("vscodium/1.200.00000");
  });
});

describe("vscodium descriptor: paths", () => {
  const ide = createVscodiumIdeServer();

  it("launches the bundled node with the server entry point, never the wrapper", () => {
    // Never bin/codium-server: on win32 the .cmd cannot parse a quoted first argument,
    // and elsewhere the wrapper only execs this same node anyway.
    expect(ide.executablePath("win32")).toBe("node.exe");
    expect(ide.executablePath("linux")).toBe("node");
    expect(ide.executablePath("darwin")).toBe("node");
    expect(ide.entryArgs()).toEqual(["out/server-main.js"]);
  });

  it("bundleSubdir uses the built-in version by default", () => {
    expect(ide.bundleSubdir()).toBe(`vscodium/${VSCODIUM_VERSION}`);
  });

  it("archiveSubPath is undefined (flat tarball)", () => {
    expect(ide.archiveSubPath("linux", "x64")).toBeUndefined();
    expect(ide.archiveSubPath("win32", "x64")).toBeUndefined();
  });
});

describe("vscodium descriptor: serve + URL scheme", () => {
  const ide = createVscodiumIdeServer();

  it("builds reh-web serve arguments (no connection token, license accepted, trust off)", () => {
    expect(
      ide.buildServeArgs({ port: 25449, extensionsDir: "/ext", userDataDir: "/user" })
    ).toEqual([
      "--host",
      "127.0.0.1",
      "--port",
      "25449",
      "--without-connection-token",
      "--accept-server-license-terms",
      "--disable-workspace-trust",
      "--server-data-dir",
      "/user",
      "--extensions-dir",
      "/ext",
      "--telemetry-level",
      "off",
    ]);
  });

  it("probes /version for readiness (no /healthz)", () => {
    expect(ide.healthUrl(25449)).toBe("http://127.0.0.1:25449/version");
  });

  it("opens folders and workspaces via the shared query-param scheme", () => {
    expect(ide.urlForFolder(25449, "/home/me/ws")).toBe(
      "http://127.0.0.1:25449/?folder=/home/me/ws"
    );
    expect(ide.urlForWorkspace(25449, "/home/me/ws.code-workspace")).toBe(
      "http://127.0.0.1:25449/?workspace=/home/me/ws.code-workspace"
    );
    expect(ide.urlForFolder(25449, "C:\\Users\\me\\ws")).toBe(
      "http://127.0.0.1:25449/?folder=/C:/Users/me/ws"
    );
  });

  it("adds no distribution-specific env", () => {
    expect(ide.serveEnv()).toEqual({});
  });
});

describe("vscodium descriptor: wrapper invocations", () => {
  const ide = createVscodiumIdeServer();

  it("remoteCli is a single directly-runnable script (no prefix args)", () => {
    expect(ide.remoteCli("/b/vsc", "linux")).toEqual({
      exe: "/b/vsc/bin/remote-cli/codium",
      args: [],
    });
    expect(ide.remoteCli("C:\\b\\vsc", "win32")).toEqual({
      exe: "C:\\b\\vsc\\bin\\remote-cli\\codium.cmd",
      args: [],
    });
  });

  it("nodeBinary sits at the archive root", () => {
    expect(ide.nodeBinary("/b/vsc", "linux")).toBe("/b/vsc/node");
    expect(ide.nodeBinary("C:\\b\\vsc", "win32")).toBe("C:\\b\\vsc\\node.exe");
  });
});
