/**
 * Tests for binary version constants and URL generation.
 */

import { describe, it, expect } from "vitest";
import { CODE_SERVER_VERSION, OPENCODE_VERSION, BINARY_CONFIGS } from "./versions";
import type { SupportedArch, SupportedPlatform } from "./types";

describe("version constants", () => {
  it("CODE_SERVER_VERSION is a valid semver string", () => {
    expect(CODE_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("OPENCODE_VERSION is a valid semver string", () => {
    expect(OPENCODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("code-server URL generation", () => {
  const config = BINARY_CONFIGS["code-server"];

  it("generates correct URL for darwin-x64", () => {
    const url = config.getUrl("darwin", "x64");
    expect(url).toBe(
      `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-macos-amd64.tar.gz`
    );
  });

  it("generates correct URL for darwin-arm64", () => {
    const url = config.getUrl("darwin", "arm64");
    expect(url).toBe(
      `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-macos-arm64.tar.gz`
    );
  });

  it("generates correct URL for linux-x64", () => {
    const url = config.getUrl("linux", "x64");
    expect(url).toBe(
      `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-amd64.tar.gz`
    );
  });

  it("generates correct URL for linux-arm64", () => {
    const url = config.getUrl("linux", "arm64");
    expect(url).toBe(
      `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-arm64.tar.gz`
    );
  });

  it("generates correct URL for win32-x64", () => {
    const url = config.getUrl("win32", "x64");
    expect(url).toBe(
      `https://github.com/stefanhoelzl/codehydra/releases/download/code-server-windows-v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-win32-x64.zip`
    );
  });

  it("throws on win32-arm64", () => {
    expect(() => config.getUrl("win32", "arm64")).toThrow(
      "Windows code-server builds only support x64"
    );
  });
});

describe("opencode URL generation", () => {
  const config = BINARY_CONFIGS["opencode"];

  it("generates correct URL for darwin-x64", () => {
    const url = config.getUrl("darwin", "x64");
    expect(url).toBe(
      `https://github.com/sst/opencode/releases/download/v${OPENCODE_VERSION}/opencode-darwin-x64.zip`
    );
  });

  it("generates correct URL for darwin-arm64", () => {
    const url = config.getUrl("darwin", "arm64");
    expect(url).toBe(
      `https://github.com/sst/opencode/releases/download/v${OPENCODE_VERSION}/opencode-darwin-arm64.zip`
    );
  });

  it("generates correct URL for linux-x64", () => {
    const url = config.getUrl("linux", "x64");
    expect(url).toBe(
      `https://github.com/sst/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz`
    );
  });

  it("generates correct URL for linux-arm64", () => {
    const url = config.getUrl("linux", "arm64");
    expect(url).toBe(
      `https://github.com/sst/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-arm64.tar.gz`
    );
  });

  it("generates correct URL for win32-x64", () => {
    const url = config.getUrl("win32", "x64");
    expect(url).toBe(
      `https://github.com/sst/opencode/releases/download/v${OPENCODE_VERSION}/opencode-windows-x64.zip`
    );
  });

  it("throws on win32-arm64", () => {
    expect(() => config.getUrl("win32", "arm64")).toThrow(
      "Windows opencode builds only support x64"
    );
  });
});

describe("extractedBinaryPath", () => {
  describe("code-server", () => {
    const config = BINARY_CONFIGS["code-server"];

    it("returns bin/code-server for unix platforms", () => {
      expect(config.extractedBinaryPath("darwin")).toBe("bin/code-server");
      expect(config.extractedBinaryPath("linux")).toBe("bin/code-server");
    });

    it("returns bin/code-server.cmd for Windows", () => {
      expect(config.extractedBinaryPath("win32")).toBe("bin/code-server.cmd");
    });
  });

  describe("opencode", () => {
    const config = BINARY_CONFIGS["opencode"];

    it("returns opencode for unix platforms", () => {
      expect(config.extractedBinaryPath("darwin")).toBe("opencode");
      expect(config.extractedBinaryPath("linux")).toBe("opencode");
    });

    it("returns opencode.exe for Windows", () => {
      expect(config.extractedBinaryPath("win32")).toBe("opencode.exe");
    });
  });
});

describe("BINARY_CONFIGS", () => {
  it("has entries for both binary types", () => {
    expect(BINARY_CONFIGS["code-server"]).toBeDefined();
    expect(BINARY_CONFIGS["opencode"]).toBeDefined();
  });

  it("has correct type values", () => {
    expect(BINARY_CONFIGS["code-server"].type).toBe("code-server");
    expect(BINARY_CONFIGS["opencode"].type).toBe("opencode");
  });

  it("has version matching constants", () => {
    expect(BINARY_CONFIGS["code-server"].version).toBe(CODE_SERVER_VERSION);
    expect(BINARY_CONFIGS["opencode"].version).toBe(OPENCODE_VERSION);
  });

  it("generates URLs for all valid platform/arch combinations", () => {
    const platforms: SupportedPlatform[] = ["darwin", "linux", "win32"];
    const archs: SupportedArch[] = ["x64", "arm64"];

    for (const binary of Object.values(BINARY_CONFIGS)) {
      for (const platform of platforms) {
        for (const arch of archs) {
          // Skip unsupported Windows ARM64
          if (platform === "win32" && arch === "arm64") {
            expect(() => binary.getUrl(platform, arch)).toThrow();
            continue;
          }
          // Should not throw for valid combinations
          const url = binary.getUrl(platform, arch);
          expect(url).toMatch(/^https:\/\//);
        }
      }
    }
  });
});
