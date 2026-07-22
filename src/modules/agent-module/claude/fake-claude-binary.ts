import { createFakeAgentBinary } from "../wrapper-boundary-test-utils";

/**
 * Create the fake claude binary used by wrapper.boundary.test.ts.
 * Outputs JSON with received args and selected env vars, exits with configurable code.
 *
 * Supports per-invocation exit codes via CLAUDE_EXIT_CODES env var (comma-separated)
 * and CLAUDE_COUNTER_FILE for tracking invocation count across calls.
 *
 * Lives outside the test file so the boundary project's globalSetup
 * (src/test/global-setup-boundary.ts) can compile it once per run without
 * importing the test file (which would execute its describe blocks).
 */
export async function createFakeClaudeBinary(binDir: string): Promise<string> {
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
    CLAUDE_CODE_CHILD_SESSION: process.env.CLAUDE_CODE_CHILD_SESSION ?? null,
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
  // Real .exe on Windows so shell:false works (no cmd.exe involvement)
  return createFakeAgentBinary({
    dir: binDir,
    binaryName: "claude",
    scriptBody: fakeNodeContent,
    windowsMode: "exe",
  });
}
