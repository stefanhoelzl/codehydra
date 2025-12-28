// @vitest-environment node
/**
 * Unit tests for bin-scripts utility module.
 */

import { describe, it, expect } from "vitest";
import { Script } from "node:vm";
import {
  generateScript,
  generateScripts,
  generateOpencodeScript,
  generateOpencodeNodeScript,
} from "./bin-scripts";
import { createMockPlatformInfo } from "../platform/platform-info.test-utils";
import type { BinTargetPaths } from "./types";

describe("generateScript", () => {
  describe("Unix (Linux/macOS)", () => {
    it("starts with shebang", () => {
      const script = generateScript("code", "/path/to/code-cli.sh", false);

      expect(script.content).toMatch(/^#!/);
      expect(script.content.startsWith("#!/bin/sh\n")).toBe(true);
    });

    it("uses exec command", () => {
      const script = generateScript("code", "/path/to/code-cli.sh", false);

      expect(script.content).toContain("exec ");
    });

    it("passes arguments with $@", () => {
      const script = generateScript("code", "/path/to/code-cli.sh", false);

      expect(script.content).toContain('"$@"');
    });

    it("wraps path in single quotes", () => {
      const script = generateScript("code", "/path/to/binary", false);

      expect(script.content).toContain("'/path/to/binary'");
    });

    it("escapes single quotes in path", () => {
      const script = generateScript("code", "/path/to/user's/binary", false);

      // Single quotes in path should be escaped: ' -> '\''
      expect(script.content).toContain("'\\''");
    });

    it("has needsExecutable = true", () => {
      const script = generateScript("code", "/path/to/binary", false);

      expect(script.needsExecutable).toBe(true);
    });

    it("filename has no extension", () => {
      const script = generateScript("code", "/path/to/binary", false);

      expect(script.filename).toBe("code");
    });
  });

  describe("Windows", () => {
    it("starts with @echo off", () => {
      const script = generateScript("code", "C:/path/to/code.exe", true);

      expect(script.content.startsWith("@echo off")).toBe(true);
    });

    it("uses .cmd extension", () => {
      const script = generateScript("code", "C:/path/to/code.exe", true);

      expect(script.filename).toBe("code.cmd");
    });

    it("wraps path in double quotes", () => {
      const script = generateScript("code", "C:/path/to/code.exe", true);

      expect(script.content).toContain('"C:\\path\\to\\code.exe"');
    });

    it("converts forward slashes to backslashes", () => {
      const script = generateScript("code", "C:/Program Files/Code/code.exe", true);

      expect(script.content).toContain("C:\\Program Files\\Code\\code.exe");
    });

    it("passes arguments with %*", () => {
      const script = generateScript("code", "C:/path/to/code.exe", true);

      expect(script.content).toContain("%*");
    });

    it("has needsExecutable = false", () => {
      const script = generateScript("code", "C:/path/to/code.exe", true);

      expect(script.needsExecutable).toBe(false);
    });
  });

  describe("paths with spaces", () => {
    it("handles Unix paths with spaces", () => {
      const script = generateScript("code", "/path/with spaces/to/binary", false);

      expect(script.content).toContain("'/path/with spaces/to/binary'");
    });

    it("handles Windows paths with spaces", () => {
      const script = generateScript("code", "C:/Program Files/Code/code.exe", true);

      expect(script.content).toContain('"C:\\Program Files\\Code\\code.exe"');
    });
  });
});

describe("generateOpencodeNodeScript", () => {
  const TEST_VERSION = "1.0.163";

  it("generates valid JavaScript syntax", () => {
    const content = generateOpencodeNodeScript(TEST_VERSION);

    // Should parse without errors using vm.Script
    expect(() => new Script(content)).not.toThrow();
  });

  it("uses CommonJS require for child_process", () => {
    const content = generateOpencodeNodeScript(TEST_VERSION);

    expect(content).toContain('require("child_process")');
  });

  it("uses CommonJS require for path", () => {
    const content = generateOpencodeNodeScript(TEST_VERSION);

    expect(content).toContain('require("path")');
  });

  it("uses CommonJS require for http module", () => {
    const content = generateOpencodeNodeScript(TEST_VERSION);

    expect(content).toContain('require("http")');
  });

  it("uses fs.existsSync for Windows .cmd fallback", () => {
    const content = generateOpencodeNodeScript(TEST_VERSION);

    // On Windows, the script needs to check if .exe exists, fallback to .cmd
    // This is needed because tests create .cmd files (batch scripts can't be .exe)
    expect(content).toContain('require("fs")');
    expect(content).toContain("existsSync");
  });

  it("uses path.join for binary path construction", () => {
    const content = generateOpencodeNodeScript(TEST_VERSION);

    // Should use join() for paths (from path module)
    expect(content).toContain("const { join, normalize } = require");
    // Should use join with __dirname as first argument
    expect(content).toMatch(/join\(\s*__dirname/);
    // Should NOT use string concatenation for paths
    expect(content).not.toMatch(/__dirname\s*\+/);
  });

  it("contains the opencode version", () => {
    const content = generateOpencodeNodeScript(TEST_VERSION);

    expect(content).toContain(`OPENCODE_VERSION = "${TEST_VERSION}"`);
  });

  it("reads CODEHYDRA_OPENCODE_PORT env var", () => {
    const content = generateOpencodeNodeScript(TEST_VERSION);

    expect(content).toContain("process.env.CODEHYDRA_OPENCODE_PORT");
  });

  it("validates port is numeric and in valid range", () => {
    const content = generateOpencodeNodeScript(TEST_VERSION);

    expect(content).toContain("parseInt(portStr, 10)");
    expect(content).toContain("isNaN(port)");
    expect(content).toContain("port <= 0");
    expect(content).toContain("port > 65535");
  });

  it("uses spawnSync with stdio inherit", () => {
    const content = generateOpencodeNodeScript(TEST_VERSION);

    expect(content).toContain("spawnSync");
    expect(content).toContain('stdio: "inherit"');
  });

  it("propagates exit code from child process", () => {
    const content = generateOpencodeNodeScript(TEST_VERSION);

    expect(content).toContain("process.exit(result.status");
  });

  it("uses correct error message when env var not set", () => {
    const content = generateOpencodeNodeScript(TEST_VERSION);

    expect(content).toContain("Error: CODEHYDRA_OPENCODE_PORT not set.");
    expect(content).toContain("Make sure you're in a CodeHydra workspace terminal.");
  });

  it("uses correct error message when port is invalid", () => {
    const content = generateOpencodeNodeScript(TEST_VERSION);

    expect(content).toContain("Error: Invalid CODEHYDRA_OPENCODE_PORT:");
  });

  it("uses correct error message for spawn failure", () => {
    const content = generateOpencodeNodeScript(TEST_VERSION);

    expect(content).toContain("Error: Failed to start opencode:");
  });

  it("uses attach command with HTTP URL", () => {
    const content = generateOpencodeNodeScript(TEST_VERSION);

    expect(content).toContain("attach");
    expect(content).toContain("http://127.0.0.1:");
  });

  it("generates identical output for same inputs", () => {
    const content1 = generateOpencodeNodeScript(TEST_VERSION);
    const content2 = generateOpencodeNodeScript(TEST_VERSION);

    expect(content1).toBe(content2);
  });

  it("does not reference ports.json", () => {
    const content = generateOpencodeNodeScript(TEST_VERSION);

    expect(content).not.toContain("ports.json");
  });

  it("does not use git commands", () => {
    const content = generateOpencodeNodeScript(TEST_VERSION);

    expect(content).not.toContain("git rev-parse");
    expect(content).not.toContain("gitRoot");
  });

  describe("session restoration", () => {
    it("includes httpGet function", () => {
      const content = generateOpencodeNodeScript(TEST_VERSION);

      expect(content).toContain("function httpGet(url, timeout)");
      expect(content).toContain("http.get(url,");
      expect(content).toContain("resolve(null)");
    });

    it("includes timeout constant for session list", () => {
      const content = generateOpencodeNodeScript(TEST_VERSION);

      expect(content).toContain("SESSION_LIST_TIMEOUT_MS = 3000");
      // Note: MESSAGE_LIST_TIMEOUT_MS was removed since agent restoration is not supported
      expect(content).not.toContain("MESSAGE_LIST_TIMEOUT_MS");
    });

    it("includes normalizePath function", () => {
      const content = generateOpencodeNodeScript(TEST_VERSION);

      expect(content).toContain("function normalizePath(p)");
      expect(content).toContain("normalize(p)");
    });

    it("handles Windows paths in normalizePath (case-insensitive)", () => {
      const content = generateOpencodeNodeScript(TEST_VERSION);

      // Should lowercase on Windows for case-insensitive comparison
      expect(content).toContain("isWindows ? normalized.toLowerCase()");
    });

    it("includes findMatchingSession function", () => {
      const content = generateOpencodeNodeScript(TEST_VERSION);

      expect(content).toContain("function findMatchingSession(sessions, directory)");
    });

    it("excludes sessions with parentID (sub-agents)", () => {
      const content = generateOpencodeNodeScript(TEST_VERSION);

      expect(content).toContain("s.parentID !== null");
      expect(content).toContain("s.parentID !== undefined");
    });

    it("sorts sessions by time.updated", () => {
      const content = generateOpencodeNodeScript(TEST_VERSION);

      expect(content).toContain("a.time?.updated ?? 0");
      expect(content).toContain("b.time?.updated ?? 0");
      expect(content).toContain("timeB - timeA");
    });

    it("handles missing time.updated gracefully (treats as 0)", () => {
      const content = generateOpencodeNodeScript(TEST_VERSION);

      // Uses ?? 0 to handle undefined/null
      expect(content).toContain("a.time?.updated ?? 0");
    });

    it("does not include findAgentFromMessages function (agent restoration removed)", () => {
      const content = generateOpencodeNodeScript(TEST_VERSION);

      // Agent restoration was removed because `opencode attach` doesn't support --agent flag
      expect(content).not.toContain("function findAgentFromMessages");
      expect(content).not.toContain("findAgentFromMessages(");
    });

    it("uses async IIFE pattern", () => {
      const content = generateOpencodeNodeScript(TEST_VERSION);

      expect(content).toContain("(async () => {");
      expect(content).toContain("})();");
    });

    it("includes try/catch error handling", () => {
      const content = generateOpencodeNodeScript(TEST_VERSION);

      expect(content).toContain("try {");
      expect(content).toContain("} catch (error) {");
      expect(content).toContain("error instanceof Error ? error.message : error");
    });

    it("includes --session flag logic", () => {
      const content = generateOpencodeNodeScript(TEST_VERSION);

      expect(content).toContain('args.push("--session", sessionId)');
    });

    it("does not include --agent flag logic (not supported by opencode attach)", () => {
      const content = generateOpencodeNodeScript(TEST_VERSION);

      // Agent restoration was removed because `opencode attach` doesn't support --agent flag
      expect(content).not.toContain('"--agent"');
    });

    it("includes session fetch fallback (null on error)", () => {
      const content = generateOpencodeNodeScript(TEST_VERSION);

      // httpGet returns null on error, and code checks for truthy sessions
      expect(content).toContain("if (sessions)");
    });

    it("only checks for session (no agent variable)", () => {
      const content = generateOpencodeNodeScript(TEST_VERSION);

      // Only checks for session, no separate agent check
      expect(content).toContain("if (sessionId) args.push");
      expect(content).not.toContain("if (agent)");
    });
  });
});

describe("generateOpencodeScript", () => {
  const TEST_VERSION = "1.0.163";
  const BUNDLED_NODE_PATH = "/app/code-server/lib/node";
  const BIN_DIR = "/app/bin";

  describe("returns array of scripts", () => {
    it("returns exactly 2 scripts", () => {
      const scripts = generateOpencodeScript(false, TEST_VERSION, BUNDLED_NODE_PATH, BIN_DIR);

      expect(scripts).toHaveLength(2);
    });

    it("first script is the Node.js script (.cjs)", () => {
      const scripts = generateOpencodeScript(false, TEST_VERSION, BUNDLED_NODE_PATH, BIN_DIR);
      const nodeScript = scripts[0];

      expect(nodeScript).toBeDefined();
      expect(nodeScript!.filename).toBe("opencode.cjs");
      expect(nodeScript!.needsExecutable).toBe(false);
    });

    it("second script is platform wrapper (Unix)", () => {
      const scripts = generateOpencodeScript(false, TEST_VERSION, BUNDLED_NODE_PATH, BIN_DIR);
      const wrapper = scripts[1];

      expect(wrapper).toBeDefined();
      expect(wrapper!.filename).toBe("opencode");
      expect(wrapper!.needsExecutable).toBe(true);
    });

    it("second script is platform wrapper (Windows)", () => {
      const scripts = generateOpencodeScript(true, TEST_VERSION, BUNDLED_NODE_PATH, BIN_DIR);
      const wrapper = scripts[1];

      expect(wrapper).toBeDefined();
      expect(wrapper!.filename).toBe("opencode.cmd");
      expect(wrapper!.needsExecutable).toBe(false);
    });
  });

  describe("Unix thin wrapper", () => {
    it("starts with shebang", () => {
      const scripts = generateOpencodeScript(false, TEST_VERSION, BUNDLED_NODE_PATH, BIN_DIR);
      const wrapper = scripts[1]!;

      expect(wrapper.content.startsWith("#!/bin/sh\n")).toBe(true);
    });

    it("uses exec to invoke Node", () => {
      const scripts = generateOpencodeScript(false, TEST_VERSION, BUNDLED_NODE_PATH, BIN_DIR);
      const wrapper = scripts[1]!;

      expect(wrapper.content).toContain("exec ");
    });

    it("references the bundled Node path", () => {
      const scripts = generateOpencodeScript(false, TEST_VERSION, BUNDLED_NODE_PATH, BIN_DIR);
      const wrapper = scripts[1]!;

      expect(wrapper.content).toContain(BUNDLED_NODE_PATH);
    });

    it("references the opencode.cjs script", () => {
      const scripts = generateOpencodeScript(false, TEST_VERSION, BUNDLED_NODE_PATH, BIN_DIR);
      const wrapper = scripts[1]!;

      expect(wrapper.content).toContain("opencode.cjs");
    });
  });

  describe("Windows thin wrapper", () => {
    const WIN_BUNDLED_NODE_PATH = "C:/app/code-server/lib/node.exe";
    const WIN_BIN_DIR = "C:/app/bin";

    it("starts with @echo off", () => {
      const scripts = generateOpencodeScript(
        true,
        TEST_VERSION,
        WIN_BUNDLED_NODE_PATH,
        WIN_BIN_DIR
      );
      const wrapper = scripts[1]!;

      expect(wrapper.content.startsWith("@echo off")).toBe(true);
    });

    it("references the bundled Node path", () => {
      const scripts = generateOpencodeScript(
        true,
        TEST_VERSION,
        WIN_BUNDLED_NODE_PATH,
        WIN_BIN_DIR
      );
      const wrapper = scripts[1]!;

      // Should convert to backslashes
      expect(wrapper.content).toContain("C:\\app\\code-server\\lib\\node.exe");
    });

    it("references the opencode.cjs script", () => {
      const scripts = generateOpencodeScript(
        true,
        TEST_VERSION,
        WIN_BUNDLED_NODE_PATH,
        WIN_BIN_DIR
      );
      const wrapper = scripts[1]!;

      expect(wrapper.content).toContain("opencode.cjs");
    });

    it("exits with error level", () => {
      const scripts = generateOpencodeScript(
        true,
        TEST_VERSION,
        WIN_BUNDLED_NODE_PATH,
        WIN_BIN_DIR
      );
      const wrapper = scripts[1]!;

      expect(wrapper.content).toContain("exit /b %ERRORLEVEL%");
    });
  });

  describe("Node.js script content", () => {
    it("contains version from parameter", () => {
      const scripts = generateOpencodeScript(false, TEST_VERSION, BUNDLED_NODE_PATH, BIN_DIR);
      const nodeScript = scripts[0]!;

      expect(nodeScript.content).toContain(TEST_VERSION);
    });

    it("reads CODEHYDRA_OPENCODE_PORT env var", () => {
      const scripts = generateOpencodeScript(false, TEST_VERSION, BUNDLED_NODE_PATH, BIN_DIR);
      const nodeScript = scripts[0]!;

      expect(nodeScript.content).toContain("process.env.CODEHYDRA_OPENCODE_PORT");
    });

    it("does not reference ports.json or git", () => {
      const scripts = generateOpencodeScript(false, TEST_VERSION, BUNDLED_NODE_PATH, BIN_DIR);
      const nodeScript = scripts[0]!;

      expect(nodeScript.content).not.toContain("ports.json");
      expect(nodeScript.content).not.toContain("git rev-parse");
    });
  });
});

describe("generateScripts", () => {
  const TEST_VERSION = "1.0.163";
  const BIN_DIR = "/app/bin";

  // Path format matches what BinaryDownloadService produces: <dataRoot>/opencode/<version>/opencode
  const createTargetPaths = (
    opencodePath: string | null = `/app/opencode/${TEST_VERSION}/opencode`
  ): BinTargetPaths => ({
    codeRemoteCli: "/app/code-server/lib/vscode/bin/remote-cli/code-linux.sh",
    opencodeBinary: opencodePath,
    bundledNodePath: "/app/code-server/lib/node",
  });

  describe("platform detection", () => {
    it("uses Unix template on Linux", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const scripts = generateScripts(platformInfo, createTargetPaths(), BIN_DIR);

      // Filter out .cjs files (which don't need executable)
      const shellScripts = scripts.filter((s) => !s.filename.endsWith(".cjs"));
      expect(shellScripts.every((s) => !s.filename.endsWith(".cmd"))).toBe(true);
      expect(shellScripts.every((s) => s.needsExecutable)).toBe(true);
    });

    it("uses Unix template on macOS", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const scripts = generateScripts(platformInfo, createTargetPaths(), BIN_DIR);

      const shellScripts = scripts.filter((s) => !s.filename.endsWith(".cjs"));
      expect(shellScripts.every((s) => !s.filename.endsWith(".cmd"))).toBe(true);
      expect(shellScripts.every((s) => s.needsExecutable)).toBe(true);
    });

    it("uses Windows template on Windows", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const scripts = generateScripts(platformInfo, createTargetPaths(), BIN_DIR);

      const shellScripts = scripts.filter((s) => !s.filename.endsWith(".cjs"));
      expect(shellScripts.every((s) => s.filename.endsWith(".cmd"))).toBe(true);
      expect(shellScripts.every((s) => !s.needsExecutable)).toBe(true);
    });
  });

  describe("script generation", () => {
    it("generates consistent set per platform (Linux)", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const scripts = generateScripts(platformInfo, createTargetPaths(), BIN_DIR);

      const filenames = scripts.map((s) => s.filename);
      expect(filenames).toContain("code");
      expect(filenames).toContain("opencode");
      expect(filenames).toContain("opencode.cjs");
      expect(scripts).toHaveLength(3);
    });

    it("generates consistent set per platform (Windows)", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const scripts = generateScripts(platformInfo, createTargetPaths(), BIN_DIR);

      const filenames = scripts.map((s) => s.filename);
      expect(filenames).toContain("code.cmd");
      expect(filenames).toContain("opencode.cmd");
      expect(filenames).toContain("opencode.cjs");
      expect(scripts).toHaveLength(3);
    });

    it("skips opencode when null", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const scripts = generateScripts(platformInfo, createTargetPaths(null), BIN_DIR);

      const filenames = scripts.map((s) => s.filename);
      expect(filenames).toContain("code");
      expect(filenames).not.toContain("opencode");
      expect(filenames).not.toContain("opencode.cjs");
      expect(scripts).toHaveLength(1);
    });

    it("skips opencode when version cannot be extracted from path", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      // A path without proper structure - just a filename without parent dir
      const scripts = generateScripts(platformInfo, createTargetPaths("opencode"), BIN_DIR);

      const filenames = scripts.map((s) => s.filename);
      expect(filenames).toContain("code");
      expect(filenames).not.toContain("opencode");
      expect(filenames).not.toContain("opencode.cjs");
      expect(scripts).toHaveLength(1);
    });

    it("extracts version from Windows-style path", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const targetPaths: BinTargetPaths = {
        codeRemoteCli: "C:\\app\\code-server\\bin\\code-server.cmd",
        opencodeBinary: `C:\\app\\opencode\\${TEST_VERSION}\\opencode.exe`,
        bundledNodePath: "C:\\app\\code-server\\lib\\node.exe",
      };
      const scripts = generateScripts(platformInfo, targetPaths, BIN_DIR);

      const nodeScript = scripts.find((s) => s.filename === "opencode.cjs");
      expect(nodeScript?.content).toContain(TEST_VERSION);
    });

    it("includes correct target path in code script", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const targetPaths = createTargetPaths();
      const scripts = generateScripts(platformInfo, targetPaths, BIN_DIR);

      const codeScript = scripts.find((s) => s.filename === "code");

      expect(codeScript?.content).toContain(targetPaths.codeRemoteCli);
    });

    it("opencode.cjs script reads env var and spawns attach", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const scripts = generateScripts(platformInfo, createTargetPaths(), BIN_DIR);

      const nodeScript = scripts.find((s) => s.filename === "opencode.cjs");

      expect(nodeScript?.content).toContain("process.env.CODEHYDRA_OPENCODE_PORT");
      expect(nodeScript?.content).toContain("spawnSync");
      expect(nodeScript?.content).toContain("attach");
    });
  });
});
