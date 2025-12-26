/**
 * Tests for OpenCode config generator.
 *
 * Note: The config generator has been moved to bin-scripts.ts as it's now
 * generated during VS Code setup preflight instead of at runtime.
 * These tests verify the generateOpencodeConfigContent function.
 */

import { describe, it, expect } from "vitest";
import { generateOpencodeConfigContent } from "../vscode-setup/bin-scripts";

/**
 * Parse environment variable substitutions from OpenCode config.
 * Helper function for testing.
 */
function extractEnvVarReferences(configText: string): string[] {
  const regex = /\{env:([A-Z_][A-Z0-9_]*)\}/g;
  const vars: string[] = [];
  let match;

  while ((match = regex.exec(configText)) !== null) {
    const varName = match[1];
    if (varName) {
      vars.push(varName);
    }
  }

  return [...new Set(vars)]; // Dedupe
}

describe("generateOpencodeConfigContent", () => {
  it("generates valid JSON", () => {
    const config = generateOpencodeConfigContent();
    expect(() => JSON.parse(config)).not.toThrow();
  });

  it("includes port env var reference in URL", () => {
    const config = generateOpencodeConfigContent();
    const parsed = JSON.parse(config);

    expect(parsed.mcp.codehydra.url).toBe("http://127.0.0.1:{env:CODEHYDRA_MCP_PORT}/mcp");
  });

  it("includes X-Workspace-Path header with env var reference", () => {
    const config = generateOpencodeConfigContent();
    const parsed = JSON.parse(config);

    expect(parsed.mcp.codehydra.headers["X-Workspace-Path"]).toBe("{env:CODEHYDRA_WORKSPACE_PATH}");
  });

  it("sets type to remote", () => {
    const config = generateOpencodeConfigContent();
    const parsed = JSON.parse(config);

    expect(parsed.mcp.codehydra.type).toBe("remote");
  });

  it("sets enabled to true", () => {
    const config = generateOpencodeConfigContent();
    const parsed = JSON.parse(config);

    expect(parsed.mcp.codehydra.enabled).toBe(true);
  });

  it("sets default_agent to plan", () => {
    const config = generateOpencodeConfigContent();
    const parsed = JSON.parse(config);

    expect(parsed.default_agent).toBe("plan");
  });

  it("includes JSON schema reference", () => {
    const config = generateOpencodeConfigContent();
    const parsed = JSON.parse(config);

    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
  });

  it("produces correctly formatted JSON with indentation", () => {
    const config = generateOpencodeConfigContent();

    // Check it's pretty-printed
    expect(config).toContain("\n");
    expect(config).toContain("  "); // 2-space indentation
  });

  it("uses env var substitution for both port and workspace path", () => {
    const config = generateOpencodeConfigContent();
    const refs = extractEnvVarReferences(config);

    expect(refs).toContain("CODEHYDRA_MCP_PORT");
    expect(refs).toContain("CODEHYDRA_WORKSPACE_PATH");
    expect(refs.length).toBe(2);
  });
});
