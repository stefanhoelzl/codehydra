/**
 * MCP Server module exports.
 */

// Types
export type {
  McpWorkspacePath,
  ResolvedWorkspace,
  McpErrorCode,
  McpError,
  McpToolResult,
  IDisposable,
  IMcpServer,
  McpContext,
  OpenCodeSpawnEnv,
} from "./types";

// Workspace resolver
export { resolveWorkspace } from "./workspace-resolver";
export type { WorkspaceLookup } from "./workspace-resolver";

// MCP Server
export { McpServer, createDefaultMcpServer } from "./mcp-server";
export type { McpServerFactory } from "./mcp-server";

// MCP Server Manager
export { McpServerManager } from "./mcp-server-manager";
export type { McpServerManagerConfig } from "./mcp-server-manager";

// Test utilities (re-exported for consumer convenience)
export {
  createMockMcpServer,
  createMockMcpContext,
  createMockResolvedWorkspace,
  createMcpSuccess,
  createMcpError,
  createTestMcpClient,
  TestMcpClient,
} from "./test-utils";
export type { MockMcpServer, TestMcpClientOptions } from "./test-utils";
