/**
 * Tests for the code-server IdeServer descriptor: version, download
 * coordinates, executable paths, and the folder/workspace URL scheme.
 */

import { describe, it, expect } from "vitest";
import { createCodeServerIdeServer, CODE_SERVER_VERSION } from "./code-server";

describe("CODE_SERVER_VERSION", () => {
  it("is a valid semver string", () => {
    expect(CODE_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("code-server descriptor: downloadUrl", () => {
  const ide = createCodeServerIdeServer();

  it("generates correct URL for darwin-x64", () => {
    expect(ide.downloadUrl("darwin", "x64")).toBe(
      `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-macos-amd64.tar.gz`
    );
  });

  it("generates correct URL for darwin-arm64", () => {
    expect(ide.downloadUrl("darwin", "arm64")).toBe(
      `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-macos-arm64.tar.gz`
    );
  });

  it("generates correct URL for linux-x64", () => {
    expect(ide.downloadUrl("linux", "x64")).toBe(
      `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-amd64.tar.gz`
    );
  });

  it("generates correct URL for linux-arm64", () => {
    expect(ide.downloadUrl("linux", "arm64")).toBe(
      `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-arm64.tar.gz`
    );
  });

  it("generates correct URL for win32-x64", () => {
    expect(ide.downloadUrl("win32", "x64")).toBe(
      `https://github.com/stefanhoelzl/codehydra/releases/download/code-server-windows-v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-win32-x64.tar.gz`
    );
  });

  it("throws on win32-arm64", () => {
    expect(() => ide.downloadUrl("win32", "arm64")).toThrow(
      "Windows code-server builds only support x64"
    );
  });

  it("honors an explicit version", () => {
    const pinned = createCodeServerIdeServer("4.200.0");
    expect(pinned.downloadUrl("linux", "x64")).toBe(
      "https://github.com/coder/code-server/releases/download/v4.200.0/code-server-4.200.0-linux-amd64.tar.gz"
    );
    expect(pinned.downloadUrl("win32", "x64")).toBe(
      "https://github.com/stefanhoelzl/codehydra/releases/download/code-server-windows-v4.200.0/code-server-4.200.0-win32-x64.tar.gz"
    );
    expect(pinned.bundleSubdir()).toBe("code-server/4.200.0");
  });
});

describe("code-server descriptor: paths", () => {
  const ide = createCodeServerIdeServer();

  it("returns bin/code-server for unix platforms", () => {
    expect(ide.executablePath("darwin")).toBe("bin/code-server");
    expect(ide.executablePath("linux")).toBe("bin/code-server");
  });

  it("returns bin/code-server.cmd for Windows", () => {
    expect(ide.executablePath("win32")).toBe("bin/code-server.cmd");
  });

  it("bundleSubdir uses the built-in version by default", () => {
    expect(ide.bundleSubdir()).toBe(`code-server/${CODE_SERVER_VERSION}`);
  });

  it("archiveSubPath matches the release layout", () => {
    expect(ide.archiveSubPath("linux", "x64")).toBe(
      `code-server-${CODE_SERVER_VERSION}-linux-amd64`
    );
    expect(ide.archiveSubPath("win32", "x64")).toBe(`code-server-${CODE_SERVER_VERSION}-win32-x64`);
  });
});

describe("code-server descriptor: serve + URL scheme", () => {
  const ide = createCodeServerIdeServer();

  it("builds the serve arguments", () => {
    expect(
      ide.buildServeArgs({ port: 25448, extensionsDir: "/ext", userDataDir: "/user" })
    ).toEqual([
      "--bind-addr",
      "127.0.0.1:25448",
      "--auth",
      "none",
      "--disable-workspace-trust",
      "--disable-update-check",
      "--disable-telemetry",
      "--extensions-dir",
      "/ext",
      "--user-data-dir",
      "/user",
    ]);
  });

  it("probes /healthz for readiness", () => {
    expect(ide.healthUrl(25448)).toBe("http://127.0.0.1:25448/healthz");
  });

  it("opens folders and workspaces via query params", () => {
    expect(ide.urlForFolder(25448, "/home/me/ws")).toBe(
      "http://127.0.0.1:25448/?folder=/home/me/ws"
    );
    expect(ide.urlForWorkspace(25448, "/home/me/ws.code-workspace")).toBe(
      "http://127.0.0.1:25448/?workspace=/home/me/ws.code-workspace"
    );
  });

  it("normalizes Windows drive paths (leading slash, forward slashes, kept colon)", () => {
    expect(ide.urlForFolder(25448, "C:\\Users\\me\\ws")).toBe(
      "http://127.0.0.1:25448/?folder=/C:/Users/me/ws"
    );
  });

  it("adds no extra workspace settings (trust handled via CLI flag)", () => {
    expect(ide.extraWorkspaceSettings()).toEqual({});
  });
});
