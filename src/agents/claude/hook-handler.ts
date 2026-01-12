#!/usr/bin/env node
/**
 * Claude Code Hook Handler - Platform-independent script for processing Claude Code hooks.
 *
 * This script is invoked by Claude Code hooks. It:
 * 1. Reads the hook payload from stdin (JSON)
 * 2. Adds workspacePath from environment variable
 * 3. POSTs to the bridge server
 *
 * Key requirements:
 * - Must be .js not .ts (runs standalone, not compiled)
 * - No external dependencies (uses built-in fetch from Node 18+)
 * - Silent on success (no console output)
 * - Handles errors gracefully (don't crash Claude)
 *
 * Environment variables:
 * - CODEHYDRA_BRIDGE_PORT: Port of the bridge server
 * - CODEHYDRA_WORKSPACE_PATH: Workspace path to include in payload
 *
 * Usage (by Claude Code hooks):
 *   node /path/to/hook-handler.js SessionStart < payload.json
 */

const hookName = process.argv[2];
const bridgePort = process.env.CODEHYDRA_BRIDGE_PORT;
const workspacePath = process.env.CODEHYDRA_WORKSPACE_PATH;

// Validate required arguments and environment variables
if (!hookName) {
  // Silent exit - don't interrupt Claude
  process.exit(0);
}

if (!bridgePort || !workspacePath) {
  // Silent exit - environment not set up (running outside CodeHydra)
  process.exit(0);
}

// Read JSON from stdin
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", async () => {
  try {
    // Parse the hook payload
    const payload = input.trim() ? JSON.parse(input) : {};

    // Add workspace path for routing
    payload.workspacePath = workspacePath;

    // POST to bridge server
    await fetch(`http://127.0.0.1:${bridgePort}/hook/${hookName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // Silent exit on success
  } catch {
    // Silent exit on error - don't interrupt Claude
    // Errors can happen if bridge server is not running, which is fine
  }
});

// Handle stdin errors gracefully
process.stdin.on("error", () => {
  // Silent exit
  process.exit(0);
});
