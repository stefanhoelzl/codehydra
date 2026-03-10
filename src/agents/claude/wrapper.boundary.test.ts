// @vitest-environment node
/**
 * Boundary tests for the compiled Claude wrapper (dist/bin/ch-claude.cjs).
 *
 * Tests the script with real Node.js execution and a fake claude binary.
 * These tests verify:
 * - Environment variable validation (SETTINGS, MCP_CONFIG)
 * - Claude binary discovery (findSystemClaude)
 * - Argument construction (permissions, --ide, initial prompt)
 * - Session resume (--continue retry logic)
 * - Exit code propagation
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { join, resolve, dirname, delimiter } from "node:path";
import { writeFile, mkdir, chmod, access } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { createTempDir } from "../../services/test-utils";
import { executeScript } from "../wrapper-boundary-test-utils";

const isWindows = process.platform === "win32";

/**
 * Path to the compiled ch-claude.cjs script.
 * Built by `pnpm build:wrappers`.
 */
const COMPILED_SCRIPT_PATH = resolve(__dirname, "../../../dist/bin/ch-claude.cjs");

/**
 * Output from the fake claude binary.
 */
interface FakeClaudeOutput {
  args: string[];
  env: {
    CLAUDECODE: string | null;
  };
}

/**
 * Parse the last JSON output from the fake claude binary.
 * In retry scenarios, multiple JSON lines may be present — returns the last one.
 */
function parseFakeClaudeOutput(stdout: string): FakeClaudeOutput | null {
  const lines = stdout
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("{"));
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]!) as FakeClaudeOutput;
  } catch {
    return null;
  }
}

/**
 * Parse all JSON outputs from the fake claude binary.
 * Used for retry tests where multiple invocations occur.
 */
function parseAllFakeClaudeOutputs(stdout: string): FakeClaudeOutput[] {
  return stdout
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as FakeClaudeOutput);
}

/**
 * Create a fake claude binary for testing.
 * Outputs JSON with received args and selected env vars, exits with configurable code.
 *
 * Supports per-invocation exit codes via CLAUDE_EXIT_CODES env var (comma-separated)
 * and CLAUDE_COUNTER_FILE for tracking invocation count across calls.
 */
async function createFakeClaudeBinary(binDir: string): Promise<string> {
  await mkdir(binDir, { recursive: true });

  const fakeScriptPath = join(binDir, "fake-claude.cjs");
  const fakeNodeContent = `#!/usr/bin/env node
const fs = require("node:fs");

// Always succeed for --version (used by findSystemClaude discovery)
if (process.argv.includes("--version")) {
  console.log("fake-claude 1.0.0");
  process.exit(0);
}

const output = {
  args: process.argv.slice(2),
  env: {
    CLAUDECODE: process.env.CLAUDECODE ?? null,
  },
};

// Track invocation count for multi-call tests
const counterFile = process.env.CLAUDE_COUNTER_FILE;
let callIndex = 0;
if (counterFile) {
  try {
    callIndex = parseInt(fs.readFileSync(counterFile, "utf-8"), 10);
  } catch { /* first call */ }
  fs.writeFileSync(counterFile, String(callIndex + 1));
}

// Support per-invocation exit codes: "1,0" means first exits 1, second exits 0
const exitCodes = process.env.CLAUDE_EXIT_CODES;
let exitCode = 0;
if (exitCodes) {
  const codes = exitCodes.split(",").map(Number);
  exitCode = codes[callIndex] ?? codes[codes.length - 1] ?? 0;
} else {
  exitCode = parseInt(process.env.CLAUDE_EXIT_CODE || "0", 10);
}

console.log(JSON.stringify(output));
process.exit(isNaN(exitCode) ? 0 : exitCode);
`;
  await writeFile(fakeScriptPath, fakeNodeContent);

  // Create platform-specific wrapper named "claude"
  const fakeClaudePath = join(binDir, isWindows ? "claude.cmd" : "claude");

  if (isWindows) {
    const nodePath = process.execPath;
    const batchContent = `@echo off\n"${nodePath}" "%~dp0fake-claude.cjs" %*\nexit /b %ERRORLEVEL%\n`;
    await writeFile(fakeClaudePath, batchContent);
  } else {
    // Use ${0%/*} instead of $(dirname "$0") to avoid needing dirname on PATH
    const shellContent = `#!/bin/sh\nexec node "\${0%/*}/fake-claude.cjs" "$@"\n`;
    await writeFile(fakeClaudePath, shellContent);
    await chmod(fakeClaudePath, 0o755);
  }

  return binDir;
}

/**
 * Build a PATH that includes the fake binary dir and node's directory.
 */
function buildPath(fakeBinDir: string): string {
  return `${fakeBinDir}${delimiter}${dirname(process.execPath)}`;
}

describe("ch-claude.cjs boundary tests", () => {
  let tempDir: { path: string; cleanup: () => Promise<void> };
  let fakeBinDir: string;

  beforeAll(async () => {
    try {
      await access(COMPILED_SCRIPT_PATH, constants.R_OK);
    } catch {
      throw new Error(
        `Compiled script not found at ${COMPILED_SCRIPT_PATH}. Run 'pnpm build:wrappers' first.`
      );
    }
  });

  beforeEach(async () => {
    tempDir = await createTempDir();
    fakeBinDir = await createFakeClaudeBinary(join(tempDir.path, "bin"));
  });

  afterEach(async () => {
    await tempDir.cleanup();
  });

  describe("environment variable validation", () => {
    it("errors when _CH_CLAUDE_SETTINGS is not set", async () => {
      const result = await executeScript(
        COMPILED_SCRIPT_PATH,
        {
          _CH_CLAUDE_MCP_CONFIG: "/tmp/mcp.json",
          PATH: buildPath(fakeBinDir),
        },
        tempDir.path
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("CodeHydra Claude configuration not set");
      expect(result.stderr).toContain("Make sure you're in a CodeHydra workspace terminal");
    });

    it("errors when _CH_CLAUDE_MCP_CONFIG is not set", async () => {
      const result = await executeScript(
        COMPILED_SCRIPT_PATH,
        {
          _CH_CLAUDE_SETTINGS: "/tmp/settings.json",
          PATH: buildPath(fakeBinDir),
        },
        tempDir.path
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("CodeHydra Claude configuration not set");
      expect(result.stderr).toContain("Make sure you're in a CodeHydra workspace terminal");
    });
  });

  describe("binary not found", () => {
    it("exits with code 3 when claude is not on PATH", async () => {
      const result = await executeScript(
        COMPILED_SCRIPT_PATH,
        {
          _CH_CLAUDE_SETTINGS: "/tmp/settings.json",
          _CH_CLAUDE_MCP_CONFIG: "/tmp/mcp.json",
          // PATH only includes node dir — no fake claude binary
          PATH: dirname(process.execPath),
        },
        tempDir.path
      );

      expect(result.status).toBe(3);
      expect(result.stderr).toContain("Claude CLI not found");
    });
  });

  describe("binary spawning", () => {
    it("spawns claude with correct base args", async () => {
      const result = await executeScript(
        COMPILED_SCRIPT_PATH,
        {
          _CH_CLAUDE_SETTINGS: "/tmp/settings.json",
          _CH_CLAUDE_MCP_CONFIG: "/tmp/mcp.json",
          PATH: buildPath(fakeBinDir),
        },
        tempDir.path
      );

      expect(result.status).toBe(0);
      const output = parseFakeClaudeOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.args).toContain("--ide");
      expect(output!.args).toContain("--settings");
      expect(output!.args).toContain("/tmp/settings.json");
      expect(output!.args).toContain("--mcp-config");
      expect(output!.args).toContain("/tmp/mcp.json");
      expect(output!.args).toContain("--dangerously-skip-permissions");
    });

    it("deletes CLAUDECODE env var before spawning", async () => {
      const result = await executeScript(
        COMPILED_SCRIPT_PATH,
        {
          _CH_CLAUDE_SETTINGS: "/tmp/settings.json",
          _CH_CLAUDE_MCP_CONFIG: "/tmp/mcp.json",
          PATH: buildPath(fakeBinDir),
          CLAUDECODE: "1",
        },
        tempDir.path
      );

      expect(result.status).toBe(0);
      const output = parseFakeClaudeOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.env.CLAUDECODE).toBeNull();
    });

    it("propagates exit code from claude binary", async () => {
      const counterFile = join(tempDir.path, "exit-counter");

      const result = await executeScript(
        COMPILED_SCRIPT_PATH,
        {
          _CH_CLAUDE_SETTINGS: "/tmp/settings.json",
          _CH_CLAUDE_MCP_CONFIG: "/tmp/mcp.json",
          PATH: buildPath(fakeBinDir),
          // Both --continue attempt and retry exit 42
          CLAUDE_EXIT_CODE: "42",
          CLAUDE_COUNTER_FILE: counterFile,
        },
        tempDir.path
      );

      expect(result.status).toBe(42);
    });
  });

  describe("initial prompt", () => {
    it("passes prompt as first argument", async () => {
      const promptDir = join(tempDir.path, "prompt-dir");
      await mkdir(promptDir, { recursive: true });
      const promptFile = join(promptDir, "initial-prompt.json");
      await writeFile(promptFile, JSON.stringify({ prompt: "Hello world" }));

      const result = await executeScript(
        COMPILED_SCRIPT_PATH,
        {
          _CH_CLAUDE_SETTINGS: "/tmp/settings.json",
          _CH_CLAUDE_MCP_CONFIG: "/tmp/mcp.json",
          _CH_INITIAL_PROMPT_FILE: promptFile,
          PATH: buildPath(fakeBinDir),
        },
        tempDir.path
      );

      expect(result.status).toBe(0);
      const output = parseFakeClaudeOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.args).toContain("Hello world");
    });

    it("deletes prompt file after reading", async () => {
      const promptDir = join(tempDir.path, "prompt-dir");
      await mkdir(promptDir, { recursive: true });
      const promptFile = join(promptDir, "initial-prompt.json");
      await writeFile(promptFile, JSON.stringify({ prompt: "test" }));

      await executeScript(
        COMPILED_SCRIPT_PATH,
        {
          _CH_CLAUDE_SETTINGS: "/tmp/settings.json",
          _CH_CLAUDE_MCP_CONFIG: "/tmp/mcp.json",
          _CH_INITIAL_PROMPT_FILE: promptFile,
          PATH: buildPath(fakeBinDir),
        },
        tempDir.path
      );

      expect(existsSync(promptFile)).toBe(false);
    });

    it("preserves multi-line prompt and all flags", async () => {
      const promptDir = join(tempDir.path, "prompt-dir");
      await mkdir(promptDir, { recursive: true });
      const promptFile = join(promptDir, "initial-prompt.json");
      const multiLinePrompt =
        "Please review these changes:\n\n- Fix the login bug\n- Update the tests\n\nFocus on error handling.";
      await writeFile(
        promptFile,
        JSON.stringify({ prompt: multiLinePrompt, agent: "plan" })
      );

      const result = await executeScript(
        COMPILED_SCRIPT_PATH,
        {
          _CH_CLAUDE_SETTINGS: "/tmp/settings.json",
          _CH_CLAUDE_MCP_CONFIG: "/tmp/mcp.json",
          _CH_INITIAL_PROMPT_FILE: promptFile,
          PATH: buildPath(fakeBinDir),
        },
        tempDir.path
      );

      expect(result.status).toBe(0);
      const output = parseFakeClaudeOutput(result.stdout);
      expect(output).not.toBeNull();
      // Verify full multi-line prompt is received as a single argument
      expect(output!.args).toContain(multiLinePrompt);
      // Verify all CLI flags are present (not lost due to newline splitting)
      expect(output!.args).toContain("--ide");
      expect(output!.args).toContain("--settings");
      expect(output!.args).toContain("/tmp/settings.json");
      expect(output!.args).toContain("--mcp-config");
      expect(output!.args).toContain("/tmp/mcp.json");
      expect(output!.args).toContain("--allow-dangerously-skip-permissions");
      expect(output!.args).toContain("--permission-mode");
      expect(output!.args).toContain("plan");
    });

    it("has no prompt args when no prompt file is set", async () => {
      const result = await executeScript(
        COMPILED_SCRIPT_PATH,
        {
          _CH_CLAUDE_SETTINGS: "/tmp/settings.json",
          _CH_CLAUDE_MCP_CONFIG: "/tmp/mcp.json",
          PATH: buildPath(fakeBinDir),
        },
        tempDir.path
      );

      expect(result.status).toBe(0);
      const output = parseFakeClaudeOutput(result.stdout);
      expect(output).not.toBeNull();
      // Without initial prompt, first non-continue arg should be a flag, not a prompt string
      const firstNonContinueArg = output!.args.find((a) => a !== "--continue");
      expect(firstNonContinueArg).toBe("--dangerously-skip-permissions");
    });
  });

  describe("permission modes", () => {
    it("uses --dangerously-skip-permissions when no agent is set", async () => {
      const result = await executeScript(
        COMPILED_SCRIPT_PATH,
        {
          _CH_CLAUDE_SETTINGS: "/tmp/settings.json",
          _CH_CLAUDE_MCP_CONFIG: "/tmp/mcp.json",
          PATH: buildPath(fakeBinDir),
        },
        tempDir.path
      );

      expect(result.status).toBe(0);
      const output = parseFakeClaudeOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.args).toContain("--dangerously-skip-permissions");
      expect(output!.args).not.toContain("--allow-dangerously-skip-permissions");
    });

    it("uses plan permission mode when agent is 'plan'", async () => {
      const promptDir = join(tempDir.path, "prompt-dir");
      await mkdir(promptDir, { recursive: true });
      const promptFile = join(promptDir, "initial-prompt.json");
      await writeFile(promptFile, JSON.stringify({ prompt: "test", agent: "plan" }));

      const result = await executeScript(
        COMPILED_SCRIPT_PATH,
        {
          _CH_CLAUDE_SETTINGS: "/tmp/settings.json",
          _CH_CLAUDE_MCP_CONFIG: "/tmp/mcp.json",
          _CH_INITIAL_PROMPT_FILE: promptFile,
          PATH: buildPath(fakeBinDir),
        },
        tempDir.path
      );

      expect(result.status).toBe(0);
      const output = parseFakeClaudeOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.args).toContain("--allow-dangerously-skip-permissions");
      expect(output!.args).toContain("--permission-mode");
      expect(output!.args).toContain("plan");
      expect(output!.args).not.toContain("--dangerously-skip-permissions");
    });
  });

  describe("session resume (--continue)", () => {
    it("prepends --continue on first attempt", async () => {
      const result = await executeScript(
        COMPILED_SCRIPT_PATH,
        {
          _CH_CLAUDE_SETTINGS: "/tmp/settings.json",
          _CH_CLAUDE_MCP_CONFIG: "/tmp/mcp.json",
          PATH: buildPath(fakeBinDir),
        },
        tempDir.path
      );

      expect(result.status).toBe(0);
      const output = parseFakeClaudeOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.args[0]).toBe("--continue");
    });

    it("retries without --continue when first attempt fails", async () => {
      const counterFile = join(tempDir.path, "call-counter");

      const result = await executeScript(
        COMPILED_SCRIPT_PATH,
        {
          _CH_CLAUDE_SETTINGS: "/tmp/settings.json",
          _CH_CLAUDE_MCP_CONFIG: "/tmp/mcp.json",
          PATH: buildPath(fakeBinDir),
          CLAUDE_EXIT_CODES: "1,0",
          CLAUDE_COUNTER_FILE: counterFile,
        },
        tempDir.path
      );

      expect(result.status).toBe(0);
      const outputs = parseAllFakeClaudeOutputs(result.stdout);
      expect(outputs).toHaveLength(2);
      // First call has --continue
      expect(outputs[0]!.args[0]).toBe("--continue");
      // Second call does not have --continue
      expect(outputs[1]!.args[0]).not.toBe("--continue");
    });

    it("skips --continue when no-session marker exists", async () => {
      const markerPath = join(tempDir.path, "no-session-marker");
      await writeFile(markerPath, "");

      const result = await executeScript(
        COMPILED_SCRIPT_PATH,
        {
          _CH_CLAUDE_SETTINGS: "/tmp/settings.json",
          _CH_CLAUDE_MCP_CONFIG: "/tmp/mcp.json",
          _CH_CLAUDE_NO_SESSION_MARKER_PATH: markerPath,
          PATH: buildPath(fakeBinDir),
        },
        tempDir.path
      );

      expect(result.status).toBe(0);
      const output = parseFakeClaudeOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.args[0]).not.toBe("--continue");
    });
  });
});
