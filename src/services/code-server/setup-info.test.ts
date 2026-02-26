/**
 * Tests for code-server setup information: version, URL generation, executable paths.
 */

import { describe, it, expect } from "vitest";
import {
  CODE_SERVER_VERSION,
  getCodeServerUrl,
  getCodeServerUrlForVersion,
  getCodeServerExecutablePath,
} from "./setup-info";

describe("CODE_SERVER_VERSION", () => {
  it("is a valid semver string", () => {
    expect(CODE_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("getCodeServerUrl", () => {
  it("generates correct URL for darwin-x64", () => {
    const url = getCodeServerUrl("darwin", "x64");
    expect(url).toBe(
      `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-macos-amd64.tar.gz`
    );
  });

  it("generates correct URL for darwin-arm64", () => {
    const url = getCodeServerUrl("darwin", "arm64");
    expect(url).toBe(
      `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-macos-arm64.tar.gz`
    );
  });

  it("generates correct URL for linux-x64", () => {
    const url = getCodeServerUrl("linux", "x64");
    expect(url).toBe(
      `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-amd64.tar.gz`
    );
  });

  it("generates correct URL for linux-arm64", () => {
    const url = getCodeServerUrl("linux", "arm64");
    expect(url).toBe(
      `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-arm64.tar.gz`
    );
  });

  it("generates correct URL for win32-x64", () => {
    const url = getCodeServerUrl("win32", "x64");
    expect(url).toBe(
      `https://github.com/stefanhoelzl/codehydra/releases/download/code-server-windows-v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-win32-x64.tar.gz`
    );
  });

  it("throws on win32-arm64", () => {
    expect(() => getCodeServerUrl("win32", "arm64")).toThrow(
      "Windows code-server builds only support x64"
    );
  });
});

describe("getCodeServerUrlForVersion", () => {
  it("generates URL with explicit version for linux-x64", () => {
    const url = getCodeServerUrlForVersion("4.200.0", "linux", "x64");
    expect(url).toBe(
      "https://github.com/coder/code-server/releases/download/v4.200.0/code-server-4.200.0-linux-amd64.tar.gz"
    );
  });

  it("generates URL with explicit version for win32-x64", () => {
    const url = getCodeServerUrlForVersion("4.200.0", "win32", "x64");
    expect(url).toBe(
      "https://github.com/stefanhoelzl/codehydra/releases/download/code-server-windows-v4.200.0/code-server-4.200.0-win32-x64.tar.gz"
    );
  });

  it("delegates correctly when called with CODE_SERVER_VERSION", () => {
    const direct = getCodeServerUrlForVersion(CODE_SERVER_VERSION, "linux", "arm64");
    const wrapper = getCodeServerUrl("linux", "arm64");
    expect(direct).toBe(wrapper);
  });

  it("throws on win32-arm64", () => {
    expect(() => getCodeServerUrlForVersion("4.200.0", "win32", "arm64")).toThrow(
      "Windows code-server builds only support x64"
    );
  });
});

describe("getCodeServerExecutablePath", () => {
  it("returns bin/code-server for unix platforms", () => {
    expect(getCodeServerExecutablePath("darwin")).toBe("bin/code-server");
    expect(getCodeServerExecutablePath("linux")).toBe("bin/code-server");
  });

  it("returns bin/code-server.cmd for Windows", () => {
    expect(getCodeServerExecutablePath("win32")).toBe("bin/code-server.cmd");
  });
});
